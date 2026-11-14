import {describe,it,expect} from "vitest";
import {compareProjects,comparisonCsv} from "../src/comparison";
import {Alignment,GeoProject} from "../src/schema";
import {parseCsv} from "../src/io";
import {findCrs} from "../src/crs";

function project(name="Before",xOffset=0):GeoProject{
  return {name,crs:"Local grid",base:-10,
    units:[{id:"clay",name:"Clay",color:"#aa8866",gamma:18,gammaSat:20,params:{K0:0.5}},
      {id:"sand",name:"Sand",color:"#ccbb77",gamma:19,gammaSat:21,params:{K0:0.4}}],
    boreholes:[[0,0],[10,0],[10,10],[0,10]].map(([x,y],i)=>({id:`BH${i}`,x:x+xOffset,y,z:10,
      intervals:[{from:0,to:4,unit:"clay"},{from:4,to:20,unit:"sand"}],water:[{depth:2}]}))};
}
const section={mode:"section" as const,azimuth:90,offset:0,step:2};
const line:Alignment={name:"Fixed tunnel",points:[{x:-5,y:5,chainage:100},{x:15,y:5,chainage:120}]};

describe("project comparison",()=>{
  it("gives analytic top-contact, groundwater, unit and stress differences at identical locations",()=>{
    const before=project(),after=project("After");
    after.boreholes.forEach(b=>{b.intervals[0].to=6;b.intervals[1].from=6;b.water=[{depth:1}]});
    const original=structuredClone([before,after]);
    const result=compareProjects(before,after,{...section,elevation:5});
    expect(result.surfaces.find(s=>s.unitId==="sand")).toMatchObject({status:"shared",minDelta:-2,maxDelta:-2,meanDelta:-2});
    expect(result.summary.ground).toMatchObject({minDelta:0,maxDelta:0});
    expect(result.summary.water.meanDelta).toBeCloseTo(1,10);
    expect(result.summary.maxWaterDelta).toBeCloseTo(1,10);
    expect(result.summary.changedUnitSamples).toBe(result.summary.comparedUnitSamples);
    for(const p of result.points){
      expect(p.y).toBeCloseTo(5,10);
      expect(p.before!.contacts.sand).toBeCloseTo(6,10);expect(p.after!.contacts.sand).toBeCloseTo(4,10);
      expect(p.before!.unitIdAtLevel).toBe("sand");expect(p.after!.unitIdAtLevel).toBe("clay");
      expect(p.before!.stress!.sv).toBeCloseTo(97,10);expect(p.before!.stress!.u).toBeCloseTo(29.43,10);
      expect(p.after!.stress!.sv).toBeCloseTo(98,10);expect(p.after!.stress!.u).toBeCloseTo(39.24,10);
      expect(p.after!.stress!.sh).toBeCloseTo(0.5*(98-39.24),10);
    }
    expect([before,after]).toEqual(original);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("pairs stable unit IDs through renamed and introduced units instead of comparing array indices",()=>{
    const before=project(),after=project("New fill");
    after.units.unshift({id:"fill",name:"New fill",color:"#999999"});
    after.units[2].name="Dense sand, renamed";
    after.boreholes.forEach(b=>{b.intervals=[{from:0,to:1,unit:"fill"},{from:1,to:4,unit:"clay"},{from:4,to:20,unit:"sand"}]});
    const result=compareProjects(before,after,section);
    expect(result.surfaces.find(s=>s.unitId==="sand")).toMatchObject({status:"shared",beforeName:"Sand",afterName:"Dense sand, renamed",meanDelta:0});
    expect(result.surfaces.find(s=>s.unitId==="clay")!.meanDelta).toBeCloseTo(-1,10);
    expect(result.surfaces.find(s=>s.unitId==="fill")).toEqual({unitId:"fill",status:"introduced",afterName:"New fill",afterColor:"#999999",count:0});
    const reverse=compareProjects(after,before,section);
    expect(reverse.surfaces.find(s=>s.unitId==="fill")).toMatchObject({status:"removed",count:0});
    expect(reverse.surfaces.find(s=>s.unitId==="fill")!.meanDelta).toBeUndefined();
  });

  it("pins the world line to the before model and distinguishes footprint additions and removals",()=>{
    const before=project(),after=project("Shifted",5);
    // A planar ground trend makes recentering the after section detectable.
    for(const p of [before,after])p.boreholes.forEach(b=>{b.z=10+b.x/10});
    const result=compareProjects(before,after,section);
    expect(result.points[0].x).toBeCloseTo(0,10);expect(result.points.at(-1)!.x).toBeCloseTo(15,10);
    expect(result.summary.beforeOnlySamples).toBeGreaterThan(0);expect(result.summary.afterOnlySamples).toBeGreaterThan(0);
    expect(result.summary.overlapSamples).toBeGreaterThan(0);
    expect(result.summary.maxGroundDelta).toBeCloseTo(0,10);
    for(const p of result.points){
      expect(p.y).toBeCloseTo(5,10);
      if(p.x<5-1e-8){expect(p.before).toBeDefined();expect(p.after).toBeUndefined()}
      if(p.x>10+1e-8){expect(p.before).toBeUndefined();expect(p.after).toBeDefined()}
    }
  });

  it("uses the same supplied chainages for both models and retains missing gaps",()=>{
    const path:Alignment={name:"Leaves the site",points:[{x:1,y:5,chainage:100},{x:15,y:5,chainage:114},{x:1,y:6,chainage:128}]};
    const before=project(),after=project("After"),copy=structuredClone(path);
    const result=compareProjects(before,after,{mode:"alignment",alignment:path,step:20});
    expect(result.axisLabel).toBe("Chainage (m)");expect(result.path).toMatchObject({start:100,end:128,alignmentName:path.name});
    expect(result.points.some(p=>!p.before&&!p.after)).toBe(true);
    expect(result.points.filter(p=>p.before&&p.after).length).toBeGreaterThan(1);
    expect(path).toEqual(copy);
    expect(result.points[0]).toMatchObject({distance:100,x:1,y:5});
    expect(result.points.at(-1)).toMatchObject({distance:128,x:1,y:6});
  });

  it("does not manufacture water, stress, units or contact deltas for unavailable data",()=>{
    const before=project(),after=project("Dry unknown");after.boreholes.forEach(b=>{delete b.water});
    const result=compareProjects(before,after,{...section,elevation:5});
    expect(result.summary.water).toEqual({count:0});expect(result.summary.maxWaterDelta).toBeUndefined();
    expect(result.points.every(p=>p.after!.water===undefined&&p.after!.stress===undefined)).toBe(true);
    expect(result.notes.join(" ")).toMatch(/groundwater is unknown/);
    const above=compareProjects(before,before,{...section,elevation:11});
    expect(above.summary.comparedUnitSamples).toBe(0);expect(above.summary.changedUnitSamples).toBe(0);
    expect(above.points.every(p=>p.before!.unitIdAtLevel===undefined&&p.before!.stress===undefined)).toBe(true);
    const noK0=project();delete noK0.units[1].params;
    expect(compareProjects(noK0,noK0,{...section,elevation:5}).points[0].before!.stress!.sh).toBeUndefined();
  });

  it("uses assumed or measured weights only with explanatory notes",()=>{
    const p=project();delete p.units[0].gamma;delete p.units[0].gammaSat;
    let result=compareProjects(p,p,{...section,elevation:7});
    expect(result.notes.join(" ")).toMatch(/assumed unit weights/);
    p.boreholes.forEach(b=>{b.tests=[{depth:1,property:"gamma",value:16}]});
    result=compareProjects(p,p,{...section,elevation:7});
    expect(result.points[0].before!.stress!.sv).toBeCloseTo(3*16,10);
    expect(result.notes.join(" ")).toMatch(/mean measured unit weight/);
  });

  it("bounds work when a very small step is requested and explains coarsening",()=>{
    const result=compareProjects(project(),project(),{...section,step:1e-12,maxSamples:11});
    expect(result.points.length).toBeLessThanOrEqual(11);expect(result.points.length).toBe(11);
    expect(result.path.step).toBe(1);expect(result.notes.join(" ")).toMatch(/spacing increased/);
    expect(result.points[0].distance).toBeCloseTo(-5,10);expect(result.points.at(-1)!.distance).toBeCloseTo(5,10);
  });

  it("exports signed deltas and blank unavailable values in ordinary CSV",()=>{
    const before=project(),after=project("After",5);after.boreholes.forEach(b=>{delete b.water;b.z+=2});
    const result=compareProjects(before,after,{...section,elevation:5}),rows=parseCsv(comparisonCsv(result)),header=rows[0];
    const col=(key:string)=>header.indexOf(key),shared=rows.slice(1).find(r=>r[col("before_inside")]==="true"&&r[col("after_inside")]==="true")!;
    expect(Number(shared[col("delta_ground_m")])).toBeCloseTo(2,10);
    expect(shared[col("after_water_m")]).toBe("");expect(shared[col("delta_u_kPa")]).toBe("");
    expect(header).toContain("delta_top_sand_m");
    const outside=rows.slice(1).find(r=>r[col("before_inside")]==="false")!;
    expect(outside[col("before_ground_m")]).toBe("");expect(outside[col("delta_ground_m")]).toBe("");
    expect(rows).toHaveLength(result.points.length+1);
  });
});

describe("comparison validation",()=>{
  it("rejects incompatible local grids, known CRSs and conflicting explicit definitions",()=>{
    const p=project();
    expect(()=>compareProjects(p,{...p,crs:"Other grid"},section)).toThrow(/different local grids/);
    expect(()=>compareProjects({...p,crsCode:"EPSG:32631"},{...p,crsCode:"EPSG:32632"},section)).toThrow(/different coordinate systems/);
    expect(()=>compareProjects({...p,crsCode:"EPSG:32631"},{...p,crsCode:"EPSG:32631",crsProj4:"+proj=utm +zone=32 +datum=WGS84 +units=m"},section)).toThrow(/different coordinate systems/);
    expect(()=>compareProjects({...p,crsProj4:"+proj=utm +zone=31 +zone=32"},{...p,crsProj4:"+proj=utm +zone=32 +zone=31"},section)).toThrow(/different coordinate systems/);
    const definition=findCrs("EPSG:32631")!.proj4;
    expect(compareProjects({...p,crsCode:"EPSG:32631"},{...p,crsProj4:definition.split(/\s+/).reverse().join(" ")},section).summary.maxGroundDelta).toBeCloseTo(0,10);
  });

  it("rejects invalid steps, sample caps, section values and alignment geometry",()=>{
    const p=project();
    for(const step of [0,-1,NaN,Infinity])expect(()=>compareProjects(p,p,{...section,step})).toThrow(/sampling step/);
    for(const maxSamples of [0,1,2.5,2002,NaN])expect(()=>compareProjects(p,p,{...section,maxSamples})).toThrow(/sample limit/);
    expect(()=>compareProjects(p,p,{...section,elevation:Infinity})).toThrow(/elevation/);
    expect(()=>compareProjects(p,p,{...section,azimuth:NaN})).toThrow(/azimuth/);
    expect(()=>compareProjects(p,p,{mode:"alignment"})).toThrow(/explicit reference/);
    expect(()=>compareProjects(p,p,{mode:"alignment",alignment:{name:"Zero",points:[{x:1,y:1},{x:1,y:1}]}})).toThrow(/same place/);
  });

  it("rejects disjoint or point-only overlap and lines outside the reference model",()=>{
    const p=project();
    expect(()=>compareProjects(p,project("Disjoint",20),section)).toThrow(/no overlapping model coverage/);
    expect(()=>compareProjects(p,project("Touching",10),section)).toThrow(/no overlapping model coverage/);
    expect(()=>compareProjects(p,p,{...section,offset:100})).toThrow(/does not cross/);
    expect(()=>compareProjects(p,project("Disjoint",20),{mode:"alignment",alignment:line})).toThrow(/no overlapping model coverage/);
    expect(()=>compareProjects({...p,boreholes:[]},p,section)).toThrow(/usable footprint/);
  });
});
