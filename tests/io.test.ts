import {describe,it,expect} from "vitest";
import {parseCsv,importFiles,inferUnitOrder,toProjectJson,toBoreholeCsv,parseAgs4} from "../src/io";
import {buildGeologicalModel} from "../src/model";
import {valleyProject,Borehole} from "../src/geology";

describe("CSV parsing",()=>{
  it("handles quotes, escaped quotes, embedded delimiters and line breaks",()=>{
    const rows=parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","line\nbreak"\r\n\r\n1,2,3');
    expect(rows).toEqual([["a","b","c"],["x, y",'say "hi"',"line\nbreak"],["1","2","3"]]);
  });
  it("detects semicolon and tab delimiters",()=>{
    expect(parseCsv("a;b;c\n1;2;3")).toEqual([["a","b","c"],["1","2","3"]]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([["a","b"],["1","2"]]);
  });
});

const combined=`Hole ID,Easting,Northing,Elevation,Depth From,Depth To,Lithology
BH1,1000,2000,50,0,3,Alluvium
BH1,1000,2000,50,3,10,Sandstone
BH1,1000,2000,50,10,20,Granite
BH2,1100,2000,48,0,5,Alluvium
BH2,1100,2000,48,5,18,Granite
BH3,1050,2090,52,0,2,Alluvium
BH3,1050,2090,52,2,9,Sandstone
`;

describe("CSV import",()=>{
  it("reads a combined borehole table and infers the stratigraphic column",()=>{
    const {project,warnings}=importFiles([{name:"site.csv",text:combined}]);
    expect(warnings).toEqual([]);
    expect(project.name).toBe("site");
    expect(project.units.map(u=>u.id)).toEqual(["Alluvium","Sandstone","Granite"]);
    expect(project.units.find(u=>u.id==="Sandstone")!.color).toBe("#b9925c");
    expect(project.boreholes.map(b=>[b.id,b.x,b.y,b.z,b.intervals.length])).toEqual([["BH1",1000,2000,50,3],["BH2",1100,2000,48,2],["BH3",1050,2090,52,2]]);
    const m=buildGeologicalModel(project);
    expect(m.warnings).toEqual([]);
    expect(m.triangles.length).toBe(1);
  });

  it("joins collar, interval and unit tables and reports what it could not place",()=>{
    const collars="hole_id;x;y;z;final_depth\nA;0;0;10,5;12\nB;30;0;11;\nC;0;40;9;\nD;50;50;9;";
    const intervals="hole_id,from,to,unit\nA,0,4,clay\nA,4,9,rock\nB,0,6,clay\nB,6,8,rock\nC,0,2,clay\nC,2,7,rock\nE,0,3,clay\nC,7,5,rock";
    const units="unit,name,colour\nclay,Soft clay,#aa7744\nrock,Bedrock,446677";
    const {project,warnings}=importFiles([{name:"collars.csv",text:collars},{name:"intervals.csv",text:intervals},{name:"units.csv",text:units}]);
    expect(project.units).toEqual([{id:"clay",name:"Soft clay",color:"#aa7744"},{id:"rock",name:"Bedrock",color:"#446677"}]);
    const a=project.boreholes.find(b=>b.id==="A")!;
    expect([a.z,a.depth]).toEqual([10.5,12]);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^E: no collar/),expect.stringMatching(/^D: collar without intervals/),expect.stringMatching(/^C: interval 7–5 m \(rock\) is incomplete or inverted/)
    ]));
  });

  it("explains unrecognised columns",()=>{
    expect(()=>importFiles([{name:"x.csv",text:"foo,bar\n1,2"}])).toThrow(/unrecognised columns \(foo, bar\)/);
  });
});

describe("AGS4 import",()=>{
  const ags=[
    '"GROUP","PROJ"','"HEADING","PROJ_ID","PROJ_NAME"','"UNIT","",""','"TYPE","ID","X"','"DATA","P1","Riverside test"','',
    '"GROUP","LOCA"','"HEADING","LOCA_ID","LOCA_TYPE","LOCA_NATE","LOCA_NATN","LOCA_GREF","LOCA_GL","LOCA_FDEP"','"UNIT","","","m","m","","m","m"','"TYPE","ID","PA","2DP","2DP","PA","2DP","2DP"',
    '"DATA","BH1","CP","523145.00","178456.00","OSGB","21.50","15.00"','"DATA","BH2","CP","523190.00","178460.00","OSGB","21.10","12.00"','"DATA","BH3","CP","523160.00","178500.00","OSGB","","10.00"','"DATA","BH4","CP","523170.00","178520.00","OSGB","22.00","9.00"','',
    '"GROUP","GEOL"','"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC","GEOL_LEG","GEOL_GEOL"','"UNIT","","m","m","","",""','"TYPE","ID","2DP","2DP","X","PA","PA"',
    '"DATA","BH1","0.00","1.20","Brown sandy CLAY with brick (MADE GROUND)","101","MG"','"DATA","BH1","1.20","9.50","Stiff grey fissured CLAY","201","LC"','"DATA","BH1","9.50","15.00","Dense SAND","301","LMB"',
    '"DATA","BH2","0.00","8.00","Stiff grey CLAY","201","LC"','"DATA","BH2","8.00","12.00","Dense SAND","301","LMB"',
    '"DATA","BH3","0.00","10.00","Stiff grey CLAY","201","LC"','"DATA","BH4","0.00","0.80","Fill","101","MG"','"DATA","BH4","0.80","9.00","Stiff CLAY","201","LC"','',
    '"GROUP","ABBR"','"HEADING","ABBR_HDNG","ABBR_CODE","ABBR_DESC"','"UNIT","","",""','"TYPE","X","X","X"',
    '"DATA","GEOL_GEOL","MG","Made Ground"','"DATA","GEOL_GEOL","LC","London Clay"','"DATA","GEOL_GEOL","LMB","Lambeth Group"'
  ].join("\r\n");

  it("reads LOCA and GEOL, names units from ABBR and orders them from the logs",()=>{
    expect(parseAgs4(ags).get("GEOL")!.length).toBe(8);
    const {project,warnings}=importFiles([{name:"site.ags",text:ags}]);
    expect(project.name).toBe("Riverside test");
    // LOCA_GREF "OSGB" is recognised as the British National Grid, which georeferences the model.
    expect([project.crs,project.crsCode]).toEqual(["OSGB36 / British National Grid","EPSG:27700"]);
    expect(project.units.map(u=>[u.id,u.name])).toEqual([["MG","Made Ground"],["LC","London Clay"],["LMB","Lambeth Group"]]);
    expect(project.boreholes.map(b=>b.id)).toEqual(["BH1","BH2","BH4"]);
    expect(warnings).toEqual([expect.stringMatching(/^BH3: no collar position and elevation/)]);
    expect(project.boreholes[0]).toMatchObject({x:523145,y:178456,z:21.5});
    expect(buildGeologicalModel(project).warnings).toEqual([]);
  });

  it("refuses AGS 3",()=>{
    expect(()=>importFiles([{name:"old.ags",text:'"**PROJ"\n"*PROJ_ID"\n"P1"'}])).toThrow(/AGS 3/);
  });
});

describe("Georeport3D extraction import",()=>{
  const extraction={
    document_id:"report-7",
    boreholes:[
      {borehole_id:"BH-07",collar:{easting:456732.21,northing:3987210.64,elevation:124.6,crs:"EPSG:6677"},total_depth:35,intervals:[
        {depth_from:0,depth_to:3.2,lithology:"fill"},{depth_from:3.2,depth_to:20,lithology:"mudstone"}]},
      {borehole_id:"BH-08",collar:{easting:null,northing:3987260,elevation:125,crs:"EPSG:6677"},total_depth:20,intervals:[{depth_from:0,depth_to:5,lithology:"fill"}]},
      {borehole_id:"BH-09",collar:{easting:456790,northing:3987180,elevation:122.1,crs:"EPSG:6677"},total_depth:null,intervals:[{depth_from:0,depth_to:12,lithology:"mudstone"}]}
    ],contacts:[],sections:[],notes:[],extraction_confidence:0.9
  };
  it("places only boreholes with complete collars and keeps the final depth",()=>{
    const {project,warnings}=importFiles([{name:"extraction.json",text:JSON.stringify(extraction)}]);
    expect(project.name).toBe("Georeport3D: report-7");
    expect(project.crs).toBe("EPSG:6677");
    expect(project.boreholes.map(b=>b.id)).toEqual(["BH-07","BH-09"]);
    expect(project.boreholes[0].depth).toBe(35);
    expect(project.units.map(u=>u.id)).toEqual(["fill","mudstone"]);
    expect(warnings).toEqual([expect.stringMatching(/^BH-08: collar easting not in the extraction; not placed \(coordinates are never invented\)/)]);
  });
});

describe("project files",()=>{
  it("round-trips a project through JSON and CSV",()=>{
    const fromJson=importFiles([{name:"p.json",text:toProjectJson(valleyProject)}]);
    expect(fromJson.warnings).toEqual([]);
    expect(fromJson.project.units).toEqual(valleyProject.units);
    expect(fromJson.project.boreholes).toEqual(valleyProject.boreholes);
    const fromCsv=importFiles([{name:"p.csv",text:toBoreholeCsv(valleyProject)}]);
    expect(fromCsv.project.boreholes).toEqual(valleyProject.boreholes);
    expect(fromCsv.project.units.map(u=>u.id)).toEqual(valleyProject.units.map(u=>u.id));
  });
  it("reads only the first structured file of a multi-file drop",()=>{
    const r=importFiles([{name:"p.json",text:toProjectJson(valleyProject)},{name:"extra.csv",text:combined}]);
    expect(r.warnings[0]).toMatch(/Only p.json was read/);
  });
});

describe("unit properties and terrain",()=>{
  it("reads erosive flags, unit weights and their source from a unit table",()=>{
    const units="unit,name,colour,erosive,unit_weight,gamma_sat,source\nclay,Clay,#aa7744,,18.5,19.2,Lab report 7\nrock,Rock,#446677,no,240,,\ngravel,Gravel,,yes,,,";
    const collars="hole_id,x,y,z\nA,0,0,10\nB,30,0,11\nC,0,40,9";
    const intervals="hole_id,from,to,unit\nA,0,2,gravel\nA,2,4,clay\nA,4,9,rock\nB,0,6,clay\nB,6,8,rock\nC,0,2,clay\nC,2,7,rock";
    const {project,warnings}=importFiles([{name:"units.csv",text:units},{name:"collars.csv",text:collars},{name:"intervals.csv",text:intervals}]);
    expect(project.units.find(u=>u.id==="clay")).toEqual({id:"clay",name:"Clay",color:"#aa7744",gamma:18.5,gammaSat:19.2,source:"Lab report 7"});
    expect(project.units.find(u=>u.id==="gravel")!.erosive).toBe(true);
    expect(project.units.find(u=>u.id==="rock")!.erosive).toBeUndefined();
    expect(warnings).toEqual([expect.stringMatching(/Rock: unit weight 240 kN\/m³ is outside 10–30/)]);
  });

  it("attaches a terrain grid to the current project or to boreholes imported with it",()=>{
    const asc="ncols 4\nnrows 3\nxllcenter 0\nyllcenter 0\ncellsize 20\n1 2 3 4\n5 6 7 8\n9 10 11 12\n";
    const alone=importFiles([{name:"dem.asc",text:asc}],valleyProject);
    expect(alone.project.boreholes).toBe(valleyProject.boreholes);
    expect(alone.project.terrain).toMatchObject({x0:0,y0:0,dx:20,ncols:4,nrows:3});
    expect(alone.warnings[0]).toMatch(/Terrain from dem.asc: 4 × 3 cells of 20 × 20 m/);
    const together=importFiles([{name:"site.csv",text:combined},{name:"dem.asc",text:asc}]);
    expect(together.project.boreholes.length).toBe(3);
    expect(together.project.terrain!.z[0]).toBe(9);
    expect(()=>importFiles([{name:"dem.asc",text:asc}])).toThrow(/before adding a terrain grid/);
  });

  it("round-trips terrain cells without data through project JSON",()=>{
    const t={...valleyProject.terrain!,z:valleyProject.terrain!.z.map((v,i)=>i===5?NaN:v)};
    const json=toProjectJson({...valleyProject,terrain:t});
    expect(json).toMatch(/"z":\[[^\]]*null/);
    const back=importFiles([{name:"p.json",text:json}]).project.terrain!;
    expect(back.z[5]).toBeNaN();
    expect(back.z.slice(0,5)).toEqual(t.z.slice(0,5));
    expect(back.ncols*back.nrows).toBe(t.z.length);
  });
});

describe("unit order inference",()=>{
  const hole=(id:string,...units:string[]):Borehole=>({id,x:0,y:0,z:0,intervals:units.map((unit,i)=>({from:i,to:i+1,unit}))});
  it("assembles the column from partial logs",()=>{
    expect(inferUnitOrder([hole("1","A","C"),hole("2","B","C"),hole("3","A","B")])).toEqual({order:["A","B","C"],conflicts:[]});
  });
  it("reports logs that disagree",()=>{
    const r=inferUnitOrder([hole("1","A","B","A"),hole("2","B","C")]);
    expect(r.order).toEqual(["A","B","C"]);
    expect(r.conflicts[0]).toMatch(/disagree on the order of A, B \(e.g. 1: B above A\)/);
  });
});
