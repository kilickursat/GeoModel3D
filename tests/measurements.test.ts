import {describe,it,expect} from "vitest";
import {importFiles,toProjectJson,toTestsCsv,toBoreholeCsv} from "../src/io";
import {applyUnitRules,lithologyRules} from "../src/rules";
import {propertyFromHeader,unitStatistics,measuredProperties,boreholeTests,formatValue,propertyLabel} from "../src/properties";
import {Borehole} from "../src/geology";

const collars="Hole ID,E,N,Ground level,Water depth (m)\nA,0,0,10,1.5\nB,40,0,11,\nC,0,40,9,2.2";
const intervals="Hole ID,From,To,Unit,Description\nA,0,3,Clay,Soft grey CLAY\nA,3,12,Sand,Dense SAND\nB,0,4,Clay,Firm CLAY\nB,4,10,Sand,Medium dense SAND\nC,0,2,Clay,Soft CLAY\nC,2,8,Sand,Dense SAND";

describe("test results from CSV tables",()=>{
  it("reads a wide test table, converting the units given in the headers",()=>{
    const tests="Hole ID,Depth (m),w (%),Bulk density (Mg/m3),Su (MPa),LL,PI,SPT N\nA,1.5,45.2,1.75,0.025,62,35,\nA,6,,,,,,28\nB,2,38,1.8,,,,\nC,1,52,1.68,0.018,,,";
    const {project,warnings}=importFiles([{name:"collars.csv",text:collars},{name:"intervals.csv",text:intervals},{name:"lab.csv",text:tests}]);
    expect(warnings).toEqual([]);
    const a=project.boreholes.find(b=>b.id==="A")!;
    expect(a.tests).toEqual([
      {depth:1.5,property:"w",value:45.2},{depth:1.5,property:"gamma",value:expect.closeTo(17.16,2)},{depth:1.5,property:"su",value:25},
      {depth:1.5,property:"LL",value:62},{depth:1.5,property:"PI",value:35}
    ]);
    expect(a.spt).toEqual([{depth:6,blows:28,penetration:300}]);
    // "E" and "N" in a collar table are coordinates, and the water depth column gives a water level.
    expect([a.x,a.y,a.z]).toEqual([0,0,10]);
    expect(a.water).toEqual([{depth:1.5}]);
    expect(project.boreholes.find(b=>b.id==="B")!.water).toBeUndefined();
    expect(a.intervals[0]).toEqual({from:0,to:3,unit:"Clay",name:"Soft grey CLAY"});
  });

  it("reads long test tables, SPT tables with blows and penetration, and water readings",()=>{
    const long="hole_id,depth,to,property,value,unit\nA,2,2.5,Water content,41,%\nA,2,2.5,phi,28,deg\nB,3,,cu,30,kPa\nB,3,,E,0.012,GPa";
    const spt="hole_id,depth,blows,penetration_mm\nA,4.5,50,120\nC,3,18,";
    const water="hole_id,water_level,date\nB,1.9,2024-05-01\nB,1.7,2024-06-01";
    const {project}=importFiles([{name:"collars.csv",text:collars},{name:"intervals.csv",text:intervals},{name:"long.csv",text:long},{name:"spt.csv",text:spt},{name:"water.csv",text:water}]);
    const [a,b,c]=["A","B","C"].map(id=>project.boreholes.find(h=>h.id===id)!);
    expect(a.tests).toEqual([{depth:2,to:2.5,property:"w",value:41},{depth:2,to:2.5,property:"phi",value:28}]);
    expect(b.tests).toEqual([{depth:3,property:"su",value:30},{depth:3,property:"E",value:12}]);
    expect(a.spt).toEqual([{depth:4.5,blows:50,penetration:120}]);
    expect(c.spt).toEqual([{depth:3,blows:18,penetration:300}]);
    expect(b.water).toEqual([{depth:1.9,date:"2024-05-01"},{depth:1.7,date:"2024-06-01"}]);
  });

  it("groups intervals that carry only descriptions by their principal soil",()=>{
    const log="hole_id,x,y,z,from,to,description\nA,0,0,10,0,1,MADE GROUND: brick and concrete\nA,1,4,Soft grey slightly sandy CLAY with shells\nA,4,9,Dense gravelly SAND\nB,30,0,11,0,5,Firm brown CLAY\nB,5,8,Medium dense SAND and GRAVEL\nC,0,30,9,0,3,Clay\nC,3,6,Sand";
    const fixed=log.replace("\nA,1,4,","\nA,0,0,10,1,4,").replace("\nA,4,9,","\nA,0,0,10,4,9,").replace("\nB,5,8,","\nB,30,0,11,5,8,").replace("\nC,3,6,","\nC,0,30,9,3,6,");
    const {project,warnings}=importFiles([{name:"logs.csv",text:fixed}]);
    expect(warnings).toEqual([]);
    expect(project.units.map(u=>u.id)).toEqual(["Made ground","Clay","Sand"]);
    expect(project.rules).toBe(lithologyRules);
    expect(project.boreholes[0].intervals.map(i=>i.unit)).toEqual(["Made ground","Clay","Sand"]);
  });

  it("names the accepted tables when the columns are not recognised",()=>{
    expect(()=>importFiles([{name:"x.csv",text:"foo,bar\n1,2"}])).toThrow(/test \(hole id, depth and a column per property/);
  });
});

describe("lithology rules",()=>{
  const classify=(...names:string[])=>{
    const b:Borehole={id:"X",x:0,y:0,z:0,intervals:names.map((name,i)=>({from:i,to:i+1,unit:"",name}))};
    return applyUnitRules([b],lithologyRules).boreholes[0].intervals.map(i=>i.unit);
  };
  it("takes the first soil noun of English descriptions, ignoring adjectives",()=>{
    expect(classify("Firm brown slightly sandy CLAY with occasional gravel","Silty SAND with gravel (SM)","Gravelly SAND","Sandy GRAVEL",
      "Lean CLAY with sand (CL)","Soft dark brown PEAT","Peaty CLAY","Clayey SILT","SAND and GRAVEL","Made ground: clayey sand with brick",
      "Weathered MUDSTONE recovered as clay","Grey fine to medium SANDSTONE","CHALK","Sand, slightly silty, with gravel","Clay, strongly sandy","Peat, clayey"))
      .toEqual(["Clay","Sand","Sand","Gravel","Clay","Peat","Clay","Silt","Sand","Made ground","Mudstone and siltstone","Sandstone","Limestone and chalk","Sand","Clay","Peat"]);
  });
  it("reads Dutch descriptions the same way",()=>{
    expect(classify("zand, matig fijn, kleiig","klei, zwak zandig","veen, kleiig","grind, zandig","puin")).toEqual(["Sand","Clay","Peat","Gravel","Made ground"]);
  });
});

describe("test results from AGS4",()=>{
  const ags=[
    '"GROUP","LOCA"','"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN","LOCA_GREF","LOCA_GL"','"UNIT","","m","m","","m"','"TYPE","ID","2DP","2DP","PA","2DP"',
    '"DATA","BH1","523145.00","178456.00","OSGB","21.50"','"DATA","BH2","523190.00","178460.00","OSGB","21.10"','"DATA","BH3","523160.00","178500.00","OSGB","21.80"','',
    '"GROUP","GEOL"','"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"','"UNIT","","m","m",""','"TYPE","ID","2DP","2DP","X"',
    '"DATA","BH1","0.00","1.20","MADE GROUND of brick and concrete"','"DATA","BH1","1.20","9.50","Stiff grey fissured CLAY"','"DATA","BH1","9.50","15.00","Dense SAND"',
    '"DATA","BH2","0.00","8.00","Stiff grey CLAY"','"DATA","BH2","8.00","12.00","Dense grey SAND"','"DATA","BH3","0.00","10.00","Firm CLAY"','',
    '"GROUP","ISPT"','"HEADING","LOCA_ID","ISPT_TOP","ISPT_NVAL"','"UNIT","","m",""','"TYPE","ID","2DP","0DP"','"DATA","BH1","10.00","42"','"DATA","BH2","9.00","38"','',
    '"GROUP","WSTG"','"HEADING","LOCA_ID","WSTG_DPTH"','"UNIT","","m"','"TYPE","ID","2DP"','"DATA","BH1","9.60"','"DATA","BH2","8.50"','',
    '"GROUP","WSTD"','"HEADING","LOCA_ID","WSTG_DPTH","WSTD_NMIN","WSTD_POST"','"UNIT","","m","min","m"','"TYPE","ID","2DP","0DP","2DP"','"DATA","BH1","9.60","20","7.40"','',
    '"GROUP","LNMC"','"HEADING","LOCA_ID","SAMP_TOP","SAMP_REF","SAMP_TYPE","SAMP_ID","SPEC_REF","SPEC_DPTH","LNMC_MC"','"UNIT","","m","","","","","m","%"','"TYPE","ID","2DP","X","PA","ID","X","2DP","1DP"',
    '"DATA","BH1","3.00","1","U","S1","1","3.10","28.5"','"DATA","BH2","4.00","2","U","S2","1","","31.0"','',
    '"GROUP","LDEN"','"HEADING","LOCA_ID","SAMP_TOP","SPEC_DPTH","LDEN_BDEN"','"UNIT","","m","m","Mg/m3"','"TYPE","ID","2DP","2DP","2DP"','"DATA","BH1","3.00","3.10","1.95"','',
    '"GROUP","TRIT"','"HEADING","LOCA_ID","SAMP_TOP","SPEC_DPTH","TRIT_CU"','"UNIT","","m","m","kPa"','"TYPE","ID","2DP","2DP","0DP"','"DATA","BH1","3.00","3.10","85"','"DATA","BH1","3.00","3.10","92"'
  ].join("\r\n");
  it("reads SPT, water strikes and laboratory groups, and groups GEOL_DESC when there are no unit codes",()=>{
    const {project,warnings}=importFiles([{name:"site.ags",text:ags}]);
    expect(warnings).toEqual([]);
    expect(project.units.map(u=>u.id)).toEqual(["Made ground","Clay","Sand"]);
    const [b1,b2]=project.boreholes;
    expect(b1.spt).toEqual([{depth:10,blows:42,penetration:300}]);
    expect(b1.water).toEqual([{depth:7.4}]);
    expect(b2.water).toEqual([{depth:8.5}]);
    expect(b1.tests).toEqual([{depth:3.1,property:"w",value:28.5},{depth:3.1,property:"gamma",value:expect.closeTo(19.12,2)},{depth:3.1,property:"su",value:85},{depth:3.1,property:"su",value:92}]);
    expect(b2.tests).toEqual([{depth:4,property:"w",value:31}]);
    expect(b1.intervals[1].name).toBe("Stiff grey fissured CLAY");
  });
});

describe("test statistics and project files",()=>{
  const lab="hole_id,depth,w,gamma,su,k\nA,1,45,17,20,1e-9\nA,2,55,16.5,24,1e-8\nB,2,40,17.5,30,\nA,6,22,19.5,,1e-4\nC,1,1400,,,";
  const {project,warnings}=importFiles([{name:"collars.csv",text:collars},{name:"intervals.csv",text:intervals},{name:"lab.csv",text:lab}]);
  it("summarises the values measured in each unit, with geometric means for conductivity",()=>{
    expect(warnings).toEqual([]);
    const s=unitStatistics(project.boreholes,project.units);
    expect(s.get("Clay")!.get("w")).toMatchObject({n:4,min:40,max:1400});
    expect(s.get("Clay")!.get("su")!.mean).toBeCloseTo(24.67,2);
    expect(s.get("Clay")!.get("k")!.mean).toBeCloseTo(Math.sqrt(1e-17),20);
    expect(s.get("Sand")!.get("gamma")).toMatchObject({n:1,mean:19.5});
    expect(measuredProperties(project.boreholes)).toEqual(["w","gamma","su","k"]);
    expect(boreholeTests(project.boreholes[0]).length).toBe(11);
  });
  it("reports values outside the plausible range of a property",()=>{
    const r=importFiles([{name:"collars.csv",text:collars},{name:"intervals.csv",text:intervals},{name:"lab.csv",text:"hole_id,depth,gamma,phi\nA,1,1.8,65"}]);
    expect(r.warnings).toEqual([expect.stringMatching(/A: Bulk unit weight 1.8 kN\/m³ at 1 m is outside 8–30/),expect.stringMatching(/A: Effective friction angle 65 ° at 1 m/)]);
  });
  it("round-trips tests, unit parameters and the assumed groundwater depth through project JSON and CSV",()=>{
    const withParams={...project,groundwaterDepth:2,units:project.units.map(u=>u.id==="Clay"?{...u,gamma:17,gammaSat:18,params:{c:5,phi:24,su:25},source:"Lab report"}:u)};
    const back=importFiles([{name:"p.json",text:toProjectJson(withParams)}]).project;
    expect(back.boreholes).toEqual(withParams.boreholes);
    expect(back.units).toEqual(withParams.units);
    expect(back.groundwaterDepth).toBe(2);
    const csv=importFiles([{name:"b.csv",text:toBoreholeCsv(project)},{name:"t.csv",text:toTestsCsv(project)}]).project;
    expect(csv.boreholes.map(b=>[b.id,b.water,b.tests,b.intervals])).toEqual(project.boreholes.map(b=>[b.id,b.water,b.tests,b.intervals]));
  });
  it("recognises property columns and labels them",()=>{
    expect(propertyFromHeader("Density (kg/m3)")).toEqual({key:"gamma",scale:expect.closeTo(0.00980665,8)});
    expect(propertyFromHeader("Dry density [Mg/m³]")!.key).toBe("gammaDry");
    expect(propertyFromHeader("φ′ (°)")!.key).toBe("phi");
    expect(propertyFromHeader("UCS (kPa)")).toEqual({key:"ucs",scale:0.001});
    expect(propertyFromHeader("Remarks")).toBeUndefined();
    expect(propertyLabel("su")).toBe("Undrained shear strength su (kPa)");
    expect(formatValue("k",3e-8)).toBe("3.0e-8");
    expect(formatValue("w",45.25)).toBe("45.3");
  });
});
