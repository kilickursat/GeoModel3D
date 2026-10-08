import {describe,it,expect} from "vitest";
import {tablesFromProject,projectFromTables,emptyTables,fillUnits,crsFromText,tableCsv} from "../src/tables";
import {importFiles} from "../src/io";
import {sakaeProject,valleyProject,rotterdamProject} from "../src/geology";

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
});
