import {describe,it,expect} from "vitest";
import {validateDisagreement,validationCsv} from "../src/disagreementValidation";
import type {DisagreementCase} from "../src/disagreement";
import type {GeoProject} from "../src/schema";
import {parseCsv} from "../src/io";

function project(contact=2,centreContact=contact):GeoProject{
  return {name:"Reference observations",crs:"Local grid",base:-10,
    units:[{id:"fill",name:"Fill",color:"#888"},{id:"sand",name:"Sand",color:"#db8"}],
    boreholes:[0,20,40].flatMap((y,r)=>[0,20,40].map((x,c)=>({id:`BH-${r}-${c}`,x,y,z:10,
      intervals:[{from:0,to:r===1&&c===1?centreContact:contact,unit:"fill"},
        {from:r===1&&c===1?centreContact:contact,to:12,unit:"sand"}]})))};
}
const cases=(first=project(),last=project(4)):DisagreementCase[]=>[{id:"reference",label:"Reference",project:first},{id:"alternative",label:"Alternative",project:last}];
const centre=(p:GeoProject)=>p.boreholes.find(b=>b.id==="BH-1-1")!;
const middle=(r:ReturnType<typeof validateDisagreement>)=>r.rows.find(b=>b.id==="BH-1-1")!;
const selected={unitId:"sand",maxHoldouts:1};

describe("held-out selected-interpretation envelopes",()=>{
  it("reports a known +2 m reference error against a genuinely held-out zero-width envelope",()=>{
    const input=cases(project(2,4),project()),original=structuredClone(input);
    const result=validateDisagreement(input,selected),row=middle(result);
    expect(row).toMatchObject({logged:6,min:8,max:8,rangeWidth:0,referencePrediction:8,referenceError:2,covered:false,extrapolated:false,missingCaseIds:[]});
    expect(result.summary).toEqual({nScored:1,nCovered:0,empiricalCoverage:0,mae:2,rmse:2,bias:2,meanRangeWidth:0});
    expect(result.interior).toEqual(result.summary);expect(result.extrapolation).toEqual({nScored:0,nCovered:0});
    expect(input).toEqual(original);expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("counts observed range coverage with explicit denominators and separate missing-footprint rows",()=>{
    const result=validateDisagreement(cases(project(2,6)),{unitId:"sand"}),row=middle(result);
    expect(row).toMatchObject({logged:4,min:6,max:8,rangeWidth:2,referenceError:4,covered:false});
    expect(result).toMatchObject({availableLocations:9,eligibleLocations:9,selectedLocations:9,omittedLocations:0});
    expect(result.summary.nScored).toBe(5);expect(result.summary.nCovered).toBe(4);
    expect(result.summary.empiricalCoverage).toBeCloseTo(.8);expect(result.summary.mae).toBeCloseTo(.8);
    expect(result.summary.rmse).toBeCloseTo(Math.sqrt(16/5));expect(result.summary.meanRangeWidth).toBeCloseTo(2);
    const corner=result.rows.find(r=>r.id==="BH-0-0")!;
    expect(corner.logged).toBe(8);expect(corner.covered).toBeUndefined();expect(corner.min).toBeUndefined();
    expect(corner.missingCaseIds).toEqual(["reference","alternative"]);expect(corner.extrapolated).toBe(true);
    expect(result.notes.join(" ")).toMatch(/not a calibrated probability/);
  });

  it("counts inclusive boundary coverage and exact planar predictions without inventing positive range",()=>{
    const input=cases(project(),project());
    const result=validateDisagreement(input,{unitId:"sand"});
    expect(result.summary.nScored).toBe(5);expect(result.summary.nCovered).toBe(5);expect(result.summary.empiricalCoverage).toBe(1);
    expect(result.summary.mae).toBeCloseTo(0,10);expect(result.summary.meanRangeWidth).toBeCloseTo(0,10);
    const wide=validateDisagreement(cases(project(2,3)),selected);
    expect(middle(wide)).toMatchObject({logged:7,min:6,max:8,covered:true,referenceError:1});
  });

  it("withholds tops after gaps, partial starts, repeated units and overlaps instead of validating inferred contacts",()=>{
    for(const intervals of [
      [{from:0,to:2,unit:"fill"},{from:4,to:12,unit:"sand"}],
      [{from:2,to:12,unit:"sand"}],
      [{from:0,to:2,unit:"fill"},{from:2,to:4,unit:"sand"},{from:4,to:6,unit:"fill"},{from:6,to:12,unit:"sand"}],
      [{from:0,to:4,unit:"fill"},{from:2,to:12,unit:"sand"}]
    ]){
      const p=project();centre(p).intervals=intervals;
      const result=validateDisagreement(cases(p),selected),row=middle(result);
      expect(row.logged).toBeUndefined();expect(row.covered).toBeUndefined();expect(row.predictions).toEqual([]);
      expect(row.unavailableReason).toBeTruthy();expect(result.summary).toEqual({nScored:0,nCovered:0});
      expect(result.eligibleLocations).toBe(8);
    }
  });

  it("does not score missing eroded-unit tops or out-of-order raw intervals",()=>{
    const p=project();p.units[0].erosive=true;p.units.splice(1,0,{id:"silt",name:"Silt",color:"#a87"});
    const missing=validateDisagreement(cases(p,p),{unitId:"silt",maxHoldouts:1});
    expect(middle(missing).unavailableReason).toMatch(/not logged/);expect(missing.summary.nScored).toBe(0);
    const q=project();centre(q).intervals=[{from:0,to:2,unit:"sand"},{from:2,to:12,unit:"fill"}];
    const order=validateDisagreement(cases(q,q),{unitId:"fill",maxHoldouts:1});
    expect(middle(order).unavailableReason).toMatch(/out of stratigraphic order/);
  });

  it("removes every co-located raw borehole/CPT before folds, including initially discarded duplicates",()=>{
    const p=project(2,6),q=project(4),input=cases(p,q);
    for(const c of input){
      c.project.cptLayers=true;
      c.project.cpts=[{id:"CPT-centre",x:20.0004,y:20.0004,z:10,depth:[1,2],qc:[2,4],layersSource:"reviewed",
        layers:[{from:0,to:6,unit:"fill"},{from:6,to:12,unit:"sand"}]}];
      c.project.boreholes.push({...structuredClone(centre(c.project)),id:"duplicate-at-centre"});
    }
    const result=validateDisagreement(input,selected),row=middle(result);
    expect(result.availableLocations).toBe(9);
    expect(row).toMatchObject({logged:4,min:6,max:8,covered:false});
    expect(row.predictions.every(p=>p.removedBoreholes===2&&p.removedCpts===1)).toBe(true);
  });

  it("removes matching held-out record IDs across interpretations when collars have moved",()=>{
    const p=project(2,6),q=project(4);
    centre(q).x=21;centre(q).y=21;centre(q).intervals=[{from:0,to:6,unit:"fill"},{from:6,to:12,unit:"sand"}];
    const row=middle(validateDisagreement(cases(p,q),selected));
    expect(row).toMatchObject({min:6,max:8,covered:false});
    expect(row.predictions[1].removedBoreholes).toBe(1);
    expect(row.predictions[1].prediction).toBeCloseTo(6,10);
  });

  it("also removes co-located records at a moved held-out observation's position",()=>{
    const p=project(2,6),q=project(4);q.cptLayers=true;
    centre(q).x=21;centre(q).y=21;
    q.cpts=[{id:"CPT-at-moved-hole",x:21,y:21,z:10,depth:[1,2],qc:[2,4],layersSource:"reviewed",
      layers:[{from:0,to:6,unit:"fill"},{from:6,to:12,unit:"sand"}]}];
    const row=middle(validateDisagreement(cases(p,q),selected));
    expect(row).toMatchObject({min:6,max:8,covered:false});
    expect(row.predictions[1]).toMatchObject({removedBoreholes:1,removedCpts:1,prediction:6});
  });

  it("separates extrapolated checks from observations inside every remaining log hull",()=>{
    const p=project(),q=project(4);p.margin=15;q.margin=15;
    const result=validateDisagreement(cases(p,q),{unitId:"sand"});
    expect(result.summary.nScored).toBe(9);expect(result.interior.nScored).toBe(5);expect(result.extrapolation.nScored).toBe(4);
    expect(result.rows.find(row=>row.id==="BH-0-0")!.extrapolated).toBe(true);
    expect(middle(result).extrapolated).toBe(false);
  });

  it("does not count automatic extents of one or two collinear training logs as observation-hull support",()=>{
    const p=project();p.boreholes=p.boreholes.filter(b=>b.y===20);
    const result=validateDisagreement(cases(p,p),{unitId:"sand"});
    expect(result.summary.nScored).toBe(1);expect(result.interior.nScored).toBe(0);expect(result.extrapolation.nScored).toBe(1);
    expect(result.rows.every(row=>row.extrapolated)).toBe(true);
  });

  it("reports units absent from training and empty folds as unavailable, never as zero predictions",()=>{
    const p=project();p.units.splice(1,0,{id:"peat",name:"Peat",color:"#554"});
    centre(p).intervals=[{from:0,to:2,unit:"fill"},{from:2,to:4,unit:"peat"},{from:4,to:12,unit:"sand"}];
    const unique=validateDisagreement(cases(p,p),{unitId:"peat",maxHoldouts:1});
    expect(middle(unique).logged).toBe(8);expect(middle(unique).covered).toBeUndefined();
    expect(middle(unique).predictions.every(p=>p.unavailableReason?.includes("absent"))).toBe(true);
    const one=project();one.boreholes=[centre(one)];
    const empty=validateDisagreement(cases(one,one),selected);
    expect(empty.summary).toEqual({nScored:0,nCovered:0});
    expect(middle(empty).predictions.every(p=>p.unavailableReason?.includes("No admitted training"))).toBe(true);
    const none=project();none.boreholes=[];
    expect(validateDisagreement(cases(none,none),selected)).toMatchObject({availableLocations:0,selectedLocations:0,rows:[],summary:{nScored:0,nCovered:0}});
  });

  it("regenerates automatic CPT layers without the held-out water observation and withholds failed folds",()=>{
    const p=project();p.groundwater={mode:"as-of",date:"2026-01-02"};
    centre(p).water=[{depth:1,date:"2026-01-01"}];
    p.cpts=[{id:"CPT-other",x:10,y:10,z:10,depth:[1,2,3],qc:[2,3,4],fs:[30,40,50],layersSource:"automatic"}];
    const result=validateDisagreement(cases(p,p),selected),row=middle(result);
    expect(row.logged).toBe(8);expect(row.covered).toBeUndefined();
    expect(row.predictions.every(p=>/groundwater/i.test(p.unavailableReason??""))).toBe(true);
  });

  it("refits terrain collar corrections after removing held-out ground elevations",()=>{
    const p=project();centre(p).z=12;
    p.terrain={x0:0,y0:0,dx:20,dy:20,ncols:3,nrows:3,z:Array(9).fill(10)};
    const row=middle(validateDisagreement(cases(p,p),{unitId:"fill",maxHoldouts:1}));
    expect(row).toMatchObject({logged:12,min:10,max:10,referencePrediction:10,referenceError:-2,covered:false});
    expect(p.terrain.z).toEqual(Array(9).fill(10));expect(centre(p).z).toBe(12);
  });

  it("chooses a bounded deterministic spatial subset independent of reference array order",()=>{
    const p=project(),q=project(4),first=validateDisagreement(cases(p,q),{unitId:"sand",maxHoldouts:3});
    p.boreholes.reverse();q.boreholes.reverse();
    const second=validateDisagreement(cases(p,q),{unitId:"sand",maxHoldouts:3});
    expect(second.rows).toEqual(first.rows);expect(first).toMatchObject({selectedLocations:3,omittedLocations:6});
    expect(first.notes.join(" ")).toMatch(/does not cover omitted locations/);
    expect(first.rows.some(r=>r.id==="BH-1-1")).toBe(true);
  });

  it("exports signed errors, per-case holdout counts and blank unavailable values in CSV",()=>{
    const result=validateDisagreement(cases(project(2,6)),{unitId:"sand"}),rows=parseCsv(validationCsv(result)),head=rows[0];
    const row=rows.find(r=>r[head.indexOf("borehole_id")]==="BH-1-1")!;
    expect(Number(row[head.indexOf("reference_error_m")])).toBe(4);expect(row[head.indexOf("covered")]).toBe("false");
    expect(JSON.parse(row[head.indexOf("predictions")])[0].removedBoreholes).toBe(1);
    expect(JSON.parse(row[head.indexOf("case_ids")])).toEqual(["reference","alternative"]);
    const outside=rows.find(r=>r[head.indexOf("borehole_id")]==="BH-0-0")!;
    expect(outside[head.indexOf("min_elevation_m")]).toBe("");expect(outside[head.indexOf("covered")]).toBe("");
    const p=project();p.boreholes=[];const empty=parseCsv(validationCsv(validateDisagreement(cases(p,p),selected)));
    expect(empty).toHaveLength(2);expect(empty[1][empty[0].indexOf("unit_id")]).toBe("sand");
  });

  it("rejects ambiguous IDs, coordinate systems and invalid limits",()=>{
    const p=project(),input=cases();
    for(const maxHoldouts of [0,-1,1.5,25,NaN])expect(()=>validateDisagreement(input,{unitId:"sand",maxHoldouts})).toThrow(/location limit/);
    expect(()=>validateDisagreement(input,{unitId:""})).toThrow(/unit ID/);
    expect(()=>validateDisagreement(input.slice(0,1),selected)).toThrow(/two to six/);
    expect(()=>validateDisagreement([input[0],input[0]],selected)).toThrow(/unique/);
    expect(()=>validateDisagreement(cases(p,{...p,crs:"Other grid"}),selected)).toThrow(/different local grids/);
    const duplicate=project();duplicate.boreholes.push(duplicate.boreholes[0]);
    expect(()=>validateDisagreement(cases(duplicate),selected)).toThrow(/Borehole IDs/);
    const units=project();units.units.push(units.units[0]);expect(()=>validateDisagreement(cases(units),selected)).toThrow(/Unit IDs/);
  });
});
