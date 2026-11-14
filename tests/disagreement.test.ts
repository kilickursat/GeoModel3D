import {describe,it,expect} from "vitest";
import {buildDisagreement,disagreementCsv,prepareDisagreementModels,sampleDisagreement,DisagreementCase} from "../src/disagreement";
import type {Alignment,GeoProject} from "../src/schema";
import {parseCsv} from "../src/io";

function project(name="Reference",contactDepth=4,xOffset=0):GeoProject{
  return {name,crs:"Local grid",base:-10,units:[{id:"clay",name:"Clay",color:"#aa8866"},{id:"sand",name:"Sand",color:"#ddcc99"}],
    boreholes:[[0,0],[10,0],[10,10],[0,10]].map(([x,y],i)=>({id:`BH${i}`,x:x+xOffset,y,z:10,
      intervals:[{from:0,to:contactDepth,unit:"clay"},{from:contactDepth,to:20,unit:"sand"}]}))};
}
const cases=():DisagreementCase[]=>[{id:"reference",label:"Baseline",project:project()},{id:"alternative",label:"Deeper sand",project:project("Alternative",6)}];
const options={unitId:"sand",mode:"section" as const,azimuth:90,offset:0,step:2,gridSize:3};

describe("selected-interpretation disagreement",()=>{
  it("returns a known two-metre envelope and identifiable reference at the same world coordinates",()=>{
    const source=cases(),copy=structuredClone(source),r=buildDisagreement(source,options);
    expect(r.cases).toEqual([{id:"reference",label:"Baseline",name:"Reference"},{id:"alternative",label:"Deeper sand",name:"Alternative"}]);
    expect(r.surface).toEqual({unitId:"sand",name:"Sand"});expect(r.grid.points).toHaveLength(9);
    for(const p of [...r.grid.points,...r.points]){
      expect(p).toMatchObject({count:2,total:2,complete:true,reference:6,min:4,max:6,width:2,missingCaseIds:[]});
      expect(p.values).toEqual([{caseId:"reference",elevation:6},{caseId:"alternative",elevation:4}]);
    }
    expect(r.summary).toMatchObject({completeGridCount:9,maxGridWidth:2,maxPathWidth:2});
    expect(source).toEqual(copy);expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(r.notes.join(" ")).toMatch(/not a confidence interval/);
  });

  it("preserves a genuine zero-width range instead of treating zero as missing",()=>{
    const source=cases();source[1].project=structuredClone(source[0].project);
    const r=buildDisagreement(source,options);
    expect(r.summary.maxGridWidth).toBe(0);expect(r.summary.maxPathWidth).toBe(0);
    expect(r.grid.points.every(p=>p.complete&&p.min===6&&p.max===6&&p.width===0)).toBe(true);
  });

  it("pairs stable unit IDs through renamed and introduced units",()=>{
    const source=cases(),after=source[1].project;
    after.units.unshift({id:"fill",name:"Fill",color:"#999"});after.units[2].name="Renamed dense sand";
    after.boreholes.forEach(b=>{b.intervals=[{from:0,to:1,unit:"fill"},{from:1,to:6,unit:"clay"},{from:6,to:20,unit:"sand"}]});
    const r=buildDisagreement(source,options);
    expect(r.grid.points[4]).toMatchObject({min:4,max:6,width:2});
    expect(r.surfaces.find(s=>s.unitId==="fill")).toEqual({unitId:"fill",name:"Fill",presentCaseIds:["alternative"]});
    const missing=buildDisagreement(source,{...options,unitId:"fill"});
    expect(missing.grid.points[4]).toMatchObject({count:1,total:2,complete:false,missingCaseIds:["reference"]});
    expect(missing.grid.points[4].width).toBeUndefined();expect(missing.grid.points[4].reference).toBeUndefined();
  });

  it("treats declared but unmodelled contacts as unavailable",()=>{
    const source=cases();source.forEach(c=>c.project.units.push({id:"peat",name:"Peat",color:"#775533"}));
    const r=buildDisagreement(source,{...options,unitId:"peat"});
    expect(r.surfaces.find(s=>s.unitId==="peat")!.presentCaseIds).toEqual([]);
    expect(r.grid.points.every(p=>p.count===0&&!p.complete&&p.min===undefined&&p.width===undefined)).toBe(true);
    expect(r.summary.completeGridCount).toBe(0);expect(r.summary.maxGridWidth).toBeUndefined();
  });

  it("extends the same reference line across footprints without recentering or filling missing members",()=>{
    const source=cases();source[1].project=project("Shifted",6,5);
    const r=buildDisagreement(source,options);
    expect(r.path.origin!.x).toBe(5);expect(r.path.origin!.y).toBe(5);
    expect(r.points[0].x).toBeCloseTo(0,10);expect(r.points.at(-1)!.x).toBeCloseTo(15,10);
    expect(r.points.every(p=>Math.abs(p.y-5)<1e-8)).toBe(true);
    const beforeOnly=r.points.find(p=>p.x<5)!,afterOnly=r.points.find(p=>p.x>10)!;
    expect(beforeOnly).toMatchObject({reference:6,count:1,complete:false,missingCaseIds:["alternative"]});
    expect(beforeOnly.min).toBeUndefined();expect(beforeOnly.max).toBeUndefined();expect(beforeOnly.width).toBeUndefined();
    expect(afterOnly.reference).toBeUndefined();expect(afterOnly.width).toBeUndefined();
    expect(r.points.filter(p=>p.complete).every(p=>p.x>=5-1e-8&&p.x<=10+1e-8&&p.width===2)).toBe(true);
    expect(r.grid).toMatchObject({minX:0,maxX:15,minY:0,maxY:10});
  });

  it("requires every selected member, including a missing third interpretation",()=>{
    const source=cases();source.push({id:"third",project:project("Far third",4,100)});
    const prepared=prepareDisagreementModels(source),sample=sampleDisagreement(prepared,5,5,"sand");
    expect(sample).toMatchObject({count:2,total:3,complete:false,reference:6,missingCaseIds:["third"]});
    expect(sample.width).toBeUndefined();
  });

  it("keeps unusable individual interpretations as missing rather than silently removing them",()=>{
    const source=cases();source[1].project.boreholes=[];
    const prepared=prepareDisagreementModels(source),sample=sampleDisagreement(prepared,5,5,"sand");
    expect(sample).toMatchObject({count:1,total:2,complete:false,missingCaseIds:["alternative"]});
    const r=buildDisagreement(source,options);expect(r.summary.completeGridCount).toBe(0);
    source[0].project.boreholes=[];
    expect(()=>buildDisagreement(source,options)).toThrow(/no usable model footprints/);
  });

  it("retains an alignment's geometry, supplied chainages and missing reentry gap",()=>{
    const alignment:Alignment={name:"Leaves and returns",points:[{x:1,y:5,chainage:100},{x:15,y:5,chainage:114},{x:1,y:6,chainage:128}],design:[{chainage:110,top:5}]};
    const copy=structuredClone(alignment),r=buildDisagreement(cases(),{...options,mode:"alignment",alignment,step:50});
    expect(r.path).toMatchObject({mode:"alignment",axisLabel:"Chainage (m)",start:100,end:128,alignment});
    expect(r.points[0]).toMatchObject({distance:100,x:1,y:5});expect(r.points.at(-1)).toMatchObject({distance:128,x:1,y:6});
    expect(r.points.some(p=>p.distance===110)).toBe(true);expect(r.points.some(p=>p.distance===114&&p.count===0)).toBe(true);
    expect(r.points.some(p=>p.complete)).toBe(true);expect(alignment).toEqual(copy);
  });

  it("retains large absolute and nonphysical chainage scales",()=>{
    const alignment:Alignment={name:"Scaled",points:[{x:-5,y:5,chainage:1e9},{x:15,y:5,chainage:1e9+200}]};
    const r=buildDisagreement(cases(),{...options,mode:"alignment",alignment,step:20});
    const middle=r.points.find(p=>Math.abs(p.distance-(1e9+100))<1e-8)!;
    expect(middle.x).toBeCloseTo(5,9);expect(middle.y).toBeCloseTo(5,9);expect(middle.width).toBe(2);
    expect(r.path.start).toBe(1e9);expect(r.path.end).toBe(1e9+200);
  });

  it("bounds work and explains increased regular spacing",()=>{
    const r=buildDisagreement(cases(),{...options,step:1e-15,maxSamples:11,gridSize:25});
    expect(r.grid.points).toHaveLength(625);expect(r.points).toHaveLength(11);expect(r.path.actualStep).toBe(1);
    expect(r.notes.join(" ")).toMatch(/spacing increased/);
    const source=cases();source[1].project=project("Shifted",6,5);
    expect(()=>buildDisagreement(source,{...options,maxSamples:2})).toThrow(/sample limit is too small/);
  });

  it("can explicitly show an alignment with no shared model coverage",()=>{
    const alignment:Alignment={name:"Outside",points:[{x:0,y:100},{x:10,y:100}]};
    const r=buildDisagreement(cases(),{...options,mode:"alignment",alignment});
    expect(r.points.every(p=>p.count===0&&p.width===undefined)).toBe(true);expect(r.summary.completePathCount).toBe(0);
    expect(r.notes.join(" ")).toMatch(/No reference-path locations/);
  });

  it("exports per-case values, settings and blank unavailable envelopes in ordinary CSV",()=>{
    const source=cases();source[1].project=project("Shifted",6,5);
    const r=buildDisagreement(source,options),rows=parseCsv(disagreementCsv(r)),header=rows[0],at=(key:string)=>header.indexOf(key);
    const outside=rows.slice(1).find(row=>row[at("sample_type")]==="map"&&row[at("x_m")]==="0"&&row[at("y_m")]==="0")!;
    expect(outside[at("reference_elevation_m")]).toBe("6");expect(outside[at("min_elevation_m")]).toBe("");expect(outside[at("range_width_m")]).toBe("");
    expect(JSON.parse(outside[at("missing_case_ids")])).toEqual(["alternative"]);
    expect(outside[at("case_alternative_elevation_m")]).toBe("");expect(outside[at("unit_id")]).toBe("sand");
    expect(JSON.parse(outside[at("selected_cases")])).toEqual(r.cases);
    expect(JSON.parse(outside[at("path_settings")])).toEqual(r.path);
    const complete=rows.slice(1).find(row=>row[at("complete")]==="true")!;
    expect(complete[at("range_width_m")]).toBe("2");expect(rows.length).toBe(r.grid.points.length+r.points.length+1);
  });
});

describe("disagreement validation",()=>{
  it("rejects incompatible grids and ambiguous case/unit identities",()=>{
    const source=cases();source[1].project.crs="Another grid";
    expect(()=>buildDisagreement(source,options)).toThrow(/different local grids/);
    expect(()=>prepareDisagreementModels(cases().slice(0,1))).toThrow(/two to six/);
    expect(()=>prepareDisagreementModels(Array.from({length:7},(_,i)=>({id:String(i),project:project()})))).toThrow(/two to six/);
    const duplicate=cases();duplicate[1].id=duplicate[0].id;expect(()=>prepareDisagreementModels(duplicate)).toThrow(/unique/);
    const units=cases();units[0].project.units.push(units[0].project.units[0]);expect(()=>prepareDisagreementModels(units)).toThrow(/unit IDs must be unique/);
  });

  it("rejects invalid controls and nonfinite direct samples",()=>{
    for(const step of [0,-1,NaN,Infinity])expect(()=>buildDisagreement(cases(),{...options,step})).toThrow(/spacing/);
    for(const gridSize of [1,2.5,26,NaN])expect(()=>buildDisagreement(cases(),{...options,gridSize})).toThrow(/grid size/);
    for(const maxSamples of [1,2.5,502,NaN])expect(()=>buildDisagreement(cases(),{...options,maxSamples})).toThrow(/sample limit/);
    expect(()=>buildDisagreement(cases(),{...options,unitId:"absent"})).toThrow(/not declared/);
    expect(()=>buildDisagreement(cases(),{...options,azimuth:Infinity})).toThrow(/azimuth/);
    expect(()=>buildDisagreement(cases(),{...options,offset:NaN})).toThrow(/offset/);
    expect(()=>buildDisagreement(cases(),{...options,mode:"alignment"})).toThrow(/explicit reference/);
    expect(()=>buildDisagreement(cases(),{...options,mode:"alignment",alignment:{name:"Invalid",points:[{x:0,y:0},{x:0,y:0}]}})).toThrow(/same place/);
    expect(()=>sampleDisagreement(prepareDisagreementModels(cases()),NaN,0,"sand")).toThrow(/coordinates must be finite/);
    expect(()=>buildDisagreement(cases(),{...options,offset:100})).toThrow(/reference section does not cross/);
  });
});
