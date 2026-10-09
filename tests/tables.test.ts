import {describe,it,expect} from "vitest";
import {tablesFromProject,projectFromTables,emptyTables,exampleTables,fillUnits,crsFromText,tableCsv} from "../src/tables";
import {importFiles} from "../src/io";
import {sakaeProject,valleyProject,rotterdamProject} from "../src/geology";
import {buildGeologicalModel} from "../src/model";
import {readFileSync} from "node:fs";

describe("data editor tables",()=>{
  it("round-trip real and synthetic projects, keeping what the tables do not show",()=>{
    for(const p of [valleyProject,sakaeProject,rotterdamProject]){
      const {project,warnings}=projectFromTables(tablesFromProject(p),p);
      expect(project.boreholes).toEqual(p.boreholes);
      expect(project.units).toEqual(p.units);
      expect([project.name,project.crsCode,project.rules,project.terrain]).toEqual([p.name,p.crsCode,p.rules,p.terrain]);
      expect(warnings.filter(w=>!/outside .* check the units|not a known one/.test(w))).toEqual([]);
    }
  });

  it("builds a project typed in from scratch, with positions by latitude and longitude",()=>{
    const t=emptyTables();
    t.project={...t.project,name:"Typed site",crs:"EPSG:32654",groundwaterDepth:"1.5"};
    t.rows.boreholes=[["A","","","35.0","139.0","20",""],["B","","","35.001","139.0","21",""],["C","","","35.0","139.001","19.5",""]];
    t.rows.logs=[["A","0","2","","Soft brown CLAY"],["A","2","12","","Dense SAND"],["B","0","3","","Firm CLAY"],["B","3","10","","SAND"],["C","0","1.5","","Clay"],["C","1.5","9","","Gravelly SAND"]];
    t.rows.tests=[["A","1","","w","42"],["A","1","","Bulk unit weight","17.5"]];
    t.rows.spt=[["A","5","50","120"]];
    t.rows.units=[];
    expect(fillUnits(t)).toBe(6);
    expect(t.rows.logs.map(r=>r[3])).toEqual(["Clay","Sand","Clay","Sand","Clay","Sand"]);
    const {project,warnings}=projectFromTables(t);
    expect(project.name).toBe("Typed site");
    expect(project.crsCode).toBe("EPSG:32654");
    expect(project.groundwaterDepth).toBe(1.5);
    expect(project.boreholes[0]).toMatchObject({id:"A",z:20,lat:35,lon:139,tests:[{depth:1,property:"w",value:42},{depth:1,property:"gamma",value:17.5}],spt:[{depth:5,blows:50,penetration:120}]});
    // 139° E is 2° west of the zone's central meridian.
    expect(project.boreholes[0].x).toBeCloseTo(317483.9,0);
    expect(warnings.join(" ")).toMatch(/3 collar positions converted from latitude and longitude to WGS 84 \/ UTM zone 54N/);
  });

  it("reads coordinate systems by code, name or PROJ definition, and keeps other names as local grids",()=>{
    expect(crsFromText("Belgian Lambert 72")!.code).toBe("EPSG:31370");
    expect(crsFromText("28992")!.code).toBe("EPSG:28992");
    expect(crsFromText("Atlantis grid")).toBeUndefined();
    const t=tablesFromProject(valleyProject);
    expect(projectFromTables(t,valleyProject).warnings).toContain("Coordinate system “Local grid (m)” is not a known one: the model is not georeferenced (no terrain or map). Type an EPSG code or paste a PROJ definition to place it");
  });

  it("writes each table as CSV the importer reads back",()=>{
    const t=tablesFromProject(valleyProject);
    const back=importFiles([{name:"b.csv",text:tableCsv(t,"boreholes")},{name:"l.csv",text:tableCsv(t,"logs")},{name:"u.csv",text:tableCsv(t,"units")}]).project;
    expect(back.boreholes).toEqual(valleyProject.boreholes);
    expect(back.units.map(u=>[u.id,u.color,u.gamma])).toEqual(valleyProject.units.map(u=>[u.id,u.color,u.gamma]));
  });

  it("model a single borehole typed without a position or ground level, with the extent and K0 given",()=>{
    const t=emptyTables();
    t.project={...t.project,name:"One log",groundwaterDepth:"1.5",margin:"25"};
    t.rows.logs=[["BH-01","0","4.5","Soft clay",""],["BH-01","4.5","15","Dense sand",""]];
    t.rows.units=[["Soft clay","","","","16","16.5","","","25","","","0.6",""]];
    const {project,warnings}=projectFromTables(t);
    expect(warnings).toEqual(["Units logged but not in the unit table were appended at the bottom of the column: Dense sand",
      "BH-01: no position given; placed at 0, 0 on a local grid","BH-01: no ground level given; 0 m used, so elevations are minus depths"]);
    expect(project.boreholes[0]).toMatchObject({id:"BH-01",x:0,y:0,z:0});
    expect(project).toMatchObject({margin:25,groundwaterDepth:1.5});
    expect(project.units.map(u=>u.id)).toEqual(["Soft clay","Dense sand"]);
    expect(project.units[0]).toMatchObject({gamma:16,gammaSat:16.5,params:{su:25,K0:0.6}});
    const m=buildGeologicalModel(project);
    expect(m.warnings).toEqual([]);
    expect(m.horizons.map(h=>Math.max(...h.z))).toEqual([0,-4.5,-15]);
    expect(Math.max(...m.nodes.map(p=>Math.hypot(p.x,p.y)))).toBeCloseTo(25,9);
    // The Units table keeps K0 and the extent on the way back.
    const back=tablesFromProject(project);
    expect(back.project.margin).toBe("25");
    expect(back.rows.units[0][11]).toBe("0.6");
  });

  it("include a worked example that builds without warnings",()=>{
    const {project,warnings}=projectFromTables(exampleTables());
    expect(warnings).toEqual([]);
    expect(project.boreholes.length).toBe(4);
    expect(project.units.map(u=>u.id)).toEqual(["Fill","Soft clay","Sand","Stiff clay"]);
    expect(project.units.every(u=>u.params?.K0!==undefined&&u.gamma!==undefined)).toBe(true);
    const m=buildGeologicalModel(project);
    expect(m.warnings).toEqual([]);
    expect(m.water?.source).toMatch(/water levels logged in 4 of 4 boreholes/);
    // BH-04 logs no soft clay: it pinches out at that borehole.
    expect(m.horizons[1].z[3]).toBeCloseTo(m.horizons[2].z[3],9);
  });

  it("report project values that are not numbers",()=>{
    const t=exampleTables();
    t.project={...t.project,groundwaterDepth:"about 2",margin:"10"};
    const {project,warnings}=projectFromTables(t);
    expect(warnings).toEqual(["Assumed groundwater depth: “about 2” is not a number and was ignored"]);
    expect(project.groundwaterDepth).toBeUndefined();
    expect(project.margin).toBe(10);
  });
});

describe("CSV templates in docs/templates",()=>{
  const read=(f:string)=>({name:f,text:readFileSync(new URL(`../docs/templates/${f}`,import.meta.url),"utf8")});
  it("import together into a model with units, water, SPT and tests",()=>{
    const {project,warnings}=importFiles(["boreholes.csv","logs.csv","units.csv","water.csv","spt.csv","tests.csv"].map(read));
    expect(warnings).toEqual([]);
    expect(project.boreholes.map(b=>b.id)).toEqual(["BH-01","BH-02","BH-03"]);
    expect(project.units.map(u=>u.id)).toEqual(["MG","CLAY","SAND","ROCK"]);
    expect(project.units[1]).toMatchObject({gamma:16.5,gammaSat:17.5,params:{c:2,phi:24,su:20,E:4,k:1e-9,K0:0.6}});
    expect(project.boreholes[0].spt!.at(-1)).toEqual({depth:20,blows:50,penetration:120});
    expect(project.boreholes[1].tests).toEqual([{depth:3,to:3.4,property:"w",value:51}]);
    expect(buildGeologicalModel(project).warnings).toEqual([]);
    const wide=importFiles(["boreholes.csv","logs.csv","tests-wide.csv"].map(read)).project;
    expect(wide.boreholes[0].tests![1]).toEqual({depth:2.5,property:"gamma",value:expect.closeTo(16.77,2)});
  });
  it("include a single combined borehole table",()=>{
    const {project,warnings}=importFiles([read("boreholes-combined.csv")]);
    expect(warnings).toEqual([]);
    expect(project.boreholes.length).toBe(3);
    expect(project.boreholes[0].intervals[1]).toEqual({from:1.5,to:8.2,unit:"CLAY",name:"Soft grey silty CLAY"});
  });
});
