import {describe,it,expect} from "vitest";
import {analyzeCorridor,corridorCsv,CorridorReport} from "../src/corridor";
import type {Alignment,GeoProject} from "../src/schema";
import {parseCsv} from "../src/io";

function project():GeoProject{
  return {name:"Flat study",crs:"Local grid",base:-10,
    units:[{id:"clay",name:"Clay",color:"#a98"},{id:"sand",name:"Sand",color:"#db8"}],
    boreholes:[[0,0],[10,0],[10,10],[0,10]].map(([x,y],i)=>({id:`BH${i}`,x,y,z:10,
      intervals:[{from:0,to:4,unit:"clay"},{from:4,to:20,unit:"sand"}],water:[{depth:2,date:"2026-01-01"}]}))};
}
function line():Alignment{return {name:"Tunnel",points:[{x:-5,y:5,chainage:100},{x:15,y:5,chainage:120}],design:[{chainage:100,top:5,bottom:0},{chainage:120,top:5,bottom:0}]}}
const station=(r:CorridorReport,c:number)=>r.stations.find(s=>Math.abs(s.chainage-c)<1e-6)!;

describe("corridor station screening",()=>{
  it("gives analytic cover, water head, geological units and nearest-log distance",()=>{
    const p=project(),a=line(),before=structuredClone([p,a]);
    const r=analyzeCorridor(p,a,{step:5,minCover:6,maxSupportDistance:4}),s=station(r,110);
    expect(s).toMatchObject({x:5,y:5,inside:true,ground:10,water:8,top:5,bottom:0,cover:5,waterHead:3,
      topPosition:"inside",bottomPosition:"inside",unitTop:{id:"sand",name:"Sand"},unitBottom:{id:"sand"}});
    expect(s.nearestLog).toMatchObject({id:"BH0",kind:"borehole"});expect(s.nearestLog!.distance).toBeCloseTo(Math.sqrt(50),10);
    expect(s.flags).toEqual(["low-cover","water-above-design","distant-support"]);
    expect(r.summary).toMatchObject({insideCount:3,designCount:r.stations.length,minCover:{value:5},maxWaterHead:{value:3}});
    expect(r.summary.counts["low-cover"]).toBe(3);
    expect([p,a]).toEqual(before);expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it("keeps outside endpoints and model-entry boundaries, without inventing ground or head",()=>{
    const r=analyzeCorridor(project(),line(),{step:20});
    expect(r.stations[0].chainage).toBe(100);expect(r.stations.at(-1)!.chainage).toBe(120);
    for(const c of [100,102.5,117.5,120]){
      const s=station(r,c);expect(s.inside).toBe(false);expect(s.flags).toContain("outside-model");
      expect(s).toMatchObject({top:5,bottom:0,topPosition:"outside-model",bottomPosition:"outside-model"});
      expect(s.ground).toBeUndefined();expect(s.water).toBeUndefined();expect(s.cover).toBeUndefined();expect(s.waterHead).toBeUndefined();
    }
    expect(station(r,105).inside).toBe(true);expect(station(r,115).inside).toBe(true);
  });

  it("retains an explicit outside point when the alignment leaves the model and returns",()=>{
    const a:Alignment={name:"Out and back",points:[{x:5,y:5,chainage:100},{x:15,y:5,chainage:110},{x:5,y:6,chainage:120}]};
    const r=analyzeCorridor(project(),a,{step:100});
    expect(station(r,100).inside).toBe(true);expect(station(r,110).inside).toBe(false);expect(station(r,120).inside).toBe(true);
    expect(r.stations.some(s=>s.chainage>105&&s.chainage<115&&!s.inside)).toBe(true);
    expect(r.stations.every(s=>s.top===undefined&&s.cover===undefined)).toBe(true);
  });

  it("keeps missing design distinct from zero cover or a successful screen",()=>{
    const a=line();delete a.design;
    const r=analyzeCorridor(project(),a,{step:5,minCover:5});
    expect(r.summary.designCount).toBe(0);expect(r.summary.minCover).toBeUndefined();expect(r.summary.maxWaterHead).toBeUndefined();
    expect(r.stations.every(s=>s.flags.includes("missing-design")&&s.top===undefined&&s.cover===undefined)).toBe(true);
    expect(r.summary.counts["low-cover"]).toBe(0);
  });

  it("does not extrapolate design beyond its knots and retains in-range design changes",()=>{
    const a=line();a.design=[{chainage:108,top:8,bottom:4},{chainage:112,top:4,bottom:0}];
    const r=analyzeCorridor(project(),a,{step:20});
    expect(station(r,100).top).toBeUndefined();expect(station(r,120).top).toBeUndefined();
    expect(station(r,108).top).toBe(8);expect(station(r,112).bottom).toBe(0);
    expect(r.summary.designCount).toBe(2);
  });

  it("withholds unknown as-of water instead of treating it as dry",()=>{
    const p=project();p.groundwater={mode:"as-of",date:"2025-12-31"};
    const r=analyzeCorridor(p,line(),{step:5}),s=station(r,110);
    expect(s.water).toBeUndefined();expect(s.waterHead).toBeUndefined();expect(s.flags).toContain("water-unknown");
    expect(s.flags).not.toContain("water-above-design");expect(r.summary.maxWaterHead).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/rather than assuming a dry/);
  });

  it("classifies contact and final-base boundaries consistently with chainage tables",()=>{
    const a=line();a.design=[{chainage:100,top:6,bottom:-10},{chainage:120,top:6,bottom:-10}];
    const s=station(analyzeCorridor(project(),a,{step:5}),110);
    expect(s.unitTop!.id).toBe("clay");expect(s.unitBottom!.id).toBe("sand");expect(s.flags).not.toContain("below-model");
    a.design=[{chainage:100,top:12,bottom:-11},{chainage:120,top:12,bottom:-11}];
    const outside=station(analyzeCorridor(project(),a,{step:5}),110);
    expect(outside).toMatchObject({topPosition:"above-ground",bottomPosition:"below-model",cover:-2});
    expect(outside.unitTop).toBeUndefined();expect(outside.unitBottom).toBeUndefined();
    expect(outside.flags).toContain("above-ground");expect(outside.flags).toContain("below-model");
  });

  it("shows unit transitions as the design changes elevation",()=>{
    const a:Alignment={name:"Sloping level",points:[{x:0,y:5},{x:10,y:5}],design:[{chainage:0,top:9},{chainage:10,top:3}]};
    const r=analyzeCorridor(project(),a,{step:5});
    expect(station(r,0).unitTop!.id).toBe("clay");expect(station(r,5).unitTop!.id).toBe("clay");expect(station(r,10).unitTop!.id).toBe("sand");
    expect(r.summary.minCover).toEqual({chainage:0,value:1});
  });

  it("distinguishes disabled thresholds from explicit zero thresholds",()=>{
    const p=project(),a=line();
    const disabled=analyzeCorridor(p,a,{step:5});expect(disabled.summary.counts["low-cover"]).toBe(0);expect(disabled.summary.counts["distant-support"]).toBe(0);
    const zero=analyzeCorridor(p,a,{step:5,minCover:0,maxSupportDistance:0});
    expect(zero.summary.counts["low-cover"]).toBe(0);expect(zero.summary.counts["distant-support"]).toBe(zero.stations.length);
    expect(zero.options).toMatchObject({minCover:0,maxSupportDistance:0});
    a.design=[{chainage:100,top:11},{chainage:120,top:11}];
    expect(station(analyzeCorridor(p,a,{step:5,minCover:0}),110).flags).toContain("low-cover");
  });

  it("only counts admitted CPT layer logs as nearest support",()=>{
    const p=project();p.cpts=[{id:"CPT-mid",x:5,y:5,z:10,depth:[1,2],qc:[2,4],layersSource:"reviewed",layers:[{from:0,to:4,unit:"clay"},{from:4,to:20,unit:"sand"}]}];
    const ignored=station(analyzeCorridor(p,line(),{step:5}),110);
    expect(ignored.nearestLog!.kind).toBe("borehole");expect(ignored.nearestLog!.distance).toBeGreaterThan(7);
    p.cptLayers=true;
    expect(station(analyzeCorridor(p,line(),{step:5}),110).nearestLog).toEqual({id:"CPT-mid",kind:"cpt",distance:0});
  });

  it("uses supplied chainages without treating them as plan distance",()=>{
    const a:Alignment={name:"Custom chainage",points:[{x:0,y:5,chainage:1000},{x:10,y:5,chainage:1200}]};
    const r=analyzeCorridor(project(),a,{step:50});
    expect(r.stations.map(s=>s.chainage)).toEqual([1000,1050,1100,1150,1200]);
    expect(station(r,1050).x).toBeCloseTo(2.5,10);expect(r.range.actualStep).toBe(50);
    expect(r.notes.join(" ")).toMatch(/may differ from physical distance/);
  });

  it("preserves distinct section values with a large absolute start chainage",()=>{
    const p=project();p.boreholes.forEach(b=>{b.z=10+b.x});
    const a:Alignment={name:"Long datum",points:[{x:0,y:5,chainage:1e9},{x:10,y:5,chainage:1e9+20}],design:[{chainage:1e9,top:5},{chainage:1e9+20,top:5}]};
    const r=analyzeCorridor(p,a,{step:5});
    expect(r.stations.map(s=>s.ground)).toEqual([10,12.5,15,17.5,20]);expect(r.summary.insideCount).toBe(5);
  });

  it("bounds a tiny requested step without losing model gaps or design knots",()=>{
    const r=analyzeCorridor(project(),line(),{step:1e-12,maxSamples:11});
    expect(r.stations).toHaveLength(11);expect(r.range.actualStep).toBeGreaterThan(1);
    expect(r.notes.join(" ")).toMatch(/regular chainage spacing increased/);
    for(const c of [100,102.5,105,115,117.5,120])expect(station(r,c)).toBeDefined();
    expect(()=>analyzeCorridor(project(),line(),{step:1,maxSamples:2})).toThrow(/too small/);
  });

  it("supports absent coverage and absent ground models with unavailable rows",()=>{
    const a:Alignment={name:"Remote",points:[{x:100,y:5},{x:120,y:5}],design:[{chainage:0,top:5},{chainage:20,top:5}]};
    const r=analyzeCorridor(project(),a,{step:10});
    expect(r.summary.insideCount).toBe(0);expect(r.summary.minCover).toBeUndefined();expect(r.stations.every(s=>s.ground===undefined&&s.flags.includes("outside-model"))).toBe(true);
    const p=project();p.boreholes=[];
    const empty=analyzeCorridor(p,a,{step:10});
    expect(empty.stations.every(s=>s.nearestLog===undefined&&s.flags.includes("no-support"))).toBe(true);expect(empty.summary.maxLogDistance).toBeUndefined();
  });

  it("does not claim usable ground where a line only touches the footprint at one point",()=>{
    const a:Alignment={name:"Touches corner",points:[{x:-5,y:5},{x:5,y:-5}]};
    const r=analyzeCorridor(project(),a,{step:1});
    expect(r.summary.insideCount).toBe(0);expect(r.stations.every(s=>s.ground===undefined)).toBe(true);
  });

  it("exports blank unavailable measurements, signs and complete sampling metadata",()=>{
    const r=analyzeCorridor(project(),line(),{step:5,minCover:6}),rows=parseCsv(corridorCsv(r)),head=rows[0],at=(row:string[],key:string)=>row[head.indexOf(key)];
    const inside=rows.slice(1).find(row=>at(row,"chainage_m")==="110")!,outside=rows[1];
    expect(at(inside,"cover_m")).toBe("5");expect(at(inside,"water_head_above_design_m")).toBe("3");
    expect(at(inside,"unit_top_id")).toBe("sand");expect(at(inside,"flags")).toContain("low-cover");
    expect(at(outside,"ground_m")).toBe("");expect(at(outside,"cover_m")).toBe("");expect(at(outside,"design_top_m")).toBe("5");
    expect(at(inside,"min_cover_screen_m")).toBe("6");expect(at(inside,"max_support_distance_screen_m")).toBe("");
    expect(at(inside,"alignment_start_m")).toBe("100");expect(at(inside,"alignment_end_m")).toBe("120");expect(at(inside,"max_samples")).toBe("2001");
    expect(JSON.parse(at(inside,"alignment_geometry"))).toEqual(r.alignment.points);
    expect(JSON.parse(at(inside,"review_notes")).join(" ")).toMatch(/not a continuous risk assessment/);
    expect(rows).toHaveLength(r.stations.length+1);
  });

  it("rejects invalid spacing, limits, thresholds, ambiguous units and invalid alignments",()=>{
    const p=project(),a=line();
    for(const step of [0,-1,NaN,Infinity])expect(()=>analyzeCorridor(p,a,{step})).toThrow(/spacing/);
    for(const maxSamples of [1,2.5,2002,NaN])expect(()=>analyzeCorridor(p,a,{maxSamples})).toThrow(/station limit/);
    for(const n of [-1,NaN,Infinity])for(const key of ["minCover","maxSupportDistance"] as const)expect(()=>analyzeCorridor(p,a,{[key]:n})).toThrow(/threshold/);
    expect(()=>analyzeCorridor(p,{...a,points:[a.points[0]]})).toThrow(/at least two/);
    p.units.push(p.units[0]);expect(()=>analyzeCorridor(p,a)).toThrow(/IDs must be unique/);
  });
});
