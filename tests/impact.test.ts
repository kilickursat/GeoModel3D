import {describe,it,expect} from "vitest";
import {reviewDataImpact,impactCsv} from "../src/impact";
import type {Borehole,Cpt,GeoProject} from "../src/schema";
import {parseCsv} from "../src/io";

function hole(id="NEW",x=5,y=5,contact=4):Borehole{
  return {id,x,y,z:10,depth:10,intervals:[{from:0,to:contact,unit:"clay"},{from:contact,to:10,unit:"sand"}],water:[{depth:2}]};
}
function project():GeoProject{
  return {name:"Before",crs:"Local grid",base:-10,
    units:[{id:"clay",name:"Clay",color:"#aa8866"},{id:"sand",name:"Sand",color:"#ccbb77"}],
    boreholes:[[0,0],[10,0],[10,10],[0,10]].map(([x,y],k)=>hole(`BH${k}`,x,y,2))};
}
function withNew(before=project(),added=hole()):GeoProject{return {...structuredClone(before),name:"After",boreholes:[...structuredClone(before.boreholes),added]}}
const sand=(r:ReturnType<typeof reviewDataImpact>)=>r.additions[0].contacts.find(c=>c.unitId==="sand")!;
const cpt=(id="CPT1"):Cpt=>({id,x:2,y:2,z:10,depth:[1,2],qc:[3,4],fs:[20,30],layers:[{from:1,to:2,unit:"sand"}],layersSource:"reviewed"});

describe("new data impact",()=>{
  it("checks unchanged baseline predictions against a genuinely new log and separately records the update",()=>{
    const before=project(),after=withNew(before),original=structuredClone([before,after]),r=reviewDataImpact(before,after);
    expect(r.boreholes).toEqual({added:["NEW"],removed:[],modified:[],unchanged:["BH0","BH1","BH2","BH3"]});
    expect(sand(r)).toEqual({unitId:"sand",unitName:"Sand",logged:6,before:8,after:6,predictionError:2,modelShift:-2});
    expect(r.additions[0]).toMatchObject({beforeInside:true,afterInside:true,loggedLength:10,comparedLength:10,matchingLength:8,maxAbsContactError:2});
    expect(r.summary).toEqual({addedBoreholes:1,reviewedBoreholes:1,outsideBefore:0,comparedContacts:2,maxAbsContactError:2,loggedLength:10,comparedLength:10,matchingLength:8});
    expect(r.additions[0].ground).toMatchObject({logged:10,before:10,after:10,predictionError:0,modelShift:0});
    expect(r.notes.join(" ")).toMatch(/Only boreholes were added/);
    expect([before,after]).toEqual(original);expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it("reports unavailable baseline prediction outside its fixed footprint, while showing the updated sample",()=>{
    const before=project(),r=reviewDataImpact(before,withNew(before,hole("OUT",15,5)));
    expect(r.summary).toMatchObject({outsideBefore:1,reviewedBoreholes:0,comparedContacts:0,comparedLength:0});
    expect(r.summary.maxAbsContactError).toBeUndefined();
    expect(r.additions[0]).toMatchObject({beforeInside:false,afterInside:true,loggedLength:10,matchingLength:0});
    expect(sand(r)).toMatchObject({logged:6,after:6,unavailableReason:expect.stringMatching(/Outside the before model/)});
    expect(sand(r).before).toBeUndefined();expect(sand(r).predictionError).toBeUndefined();expect(sand(r).modelShift).toBeUndefined();
  });

  it("matches stable unit IDs and never claims an earlier prediction for a newly introduced unit",()=>{
    const before=project(),after=withNew(before);
    after.units.splice(1,0,{id:"peat",name:"Peat",color:"#775544"});
    after.boreholes.at(-1)!.intervals=[{from:0,to:2,unit:"clay"},{from:2,to:4,unit:"peat"},{from:4,to:10,unit:"sand"}];
    const r=reviewDataImpact(before,after),peat=r.additions[0].contacts.find(c=>c.unitId==="peat")!;
    expect(peat).toMatchObject({logged:8,after:8,unavailableReason:expect.stringMatching(/absent from the before/)});
    expect(peat.before).toBeUndefined();expect(peat.predictionError).toBeUndefined();
    expect(sand(r)).toMatchObject({logged:6,before:8,predictionError:2});
    expect(r.otherChanges).toContain("Unit definitions or stratigraphic order");
    expect(r.notes.join(" ")).toMatch(/cannot be attributed solely/);
  });

  it("lists modified and removed existing IDs separately rather than treating them as held-out observations",()=>{
    const before=project(),after=structuredClone(before);
    after.boreholes[0].z=11;after.boreholes.pop();
    const r=reviewDataImpact(before,after);
    expect(r.boreholes).toEqual({added:[],removed:["BH3"],modified:["BH0"],unchanged:["BH1","BH2"]});
    expect(r.additions).toEqual([]);expect(r.summary.comparedContacts).toBe(0);
    expect(r.notes.join(" ")).toMatch(/No new borehole IDs/);
  });

  it("ignores input list order, interval order, object key order and source-evidence changes",()=>{
    const before=project(),after=structuredClone(before);
    before.boreholes[0].tests=[{depth:1,property:"gamma",value:18},{depth:2,property:"w",value:20}];
    after.boreholes[0].tests=[{value:20,property:"w",depth:2},{value:18,depth:1,property:"gamma"}];
    after.boreholes.reverse();after.boreholes.forEach(b=>{b.intervals.reverse();b.evidenceId="updated-evidence";b.intervals.forEach(i=>{i.evidenceId="new-review"});b.water![0].evidenceId="water-review"});
    before.cpts=[cpt()];after.cpts=[{...cpt(),layers:[{from:1,to:2,unit:"sand",evidenceId:"review"}]}];
    const r=reviewDataImpact(before,after);
    expect(r.boreholes.unchanged).toHaveLength(4);expect(r.boreholes.modified).toEqual([]);
    expect(r.cpts.unchanged).toEqual(["CPT1"]);expect(r.otherChanges).toEqual(["Borehole/CPT model input order"]);
  });

  it("preserves CPT sampling order and distinguishes added, modified and removed CPTs",()=>{
    const before=project(),after=structuredClone(before);
    before.cpts=[cpt("REMOVE"),cpt("CHANGE"),cpt("SAME")];after.cpts=[cpt("CHANGE"),cpt("SAME"),cpt("ADD")];
    after.cpts[0].qc.reverse();
    const r=reviewDataImpact(before,after);
    expect(r.cpts).toEqual({added:["ADD"],removed:["REMOVE"],modified:["CHANGE"],unchanged:["SAME"]});
    expect(r.notes.join(" ")).toMatch(/not predictions against CPT-derived/);
  });

  it("registers modeling and design assumptions, retaining stratigraphic and rule precedence",()=>{
    const before=project(),after=withNew(before);
    after.base=-20;after.margin=10;after.cptLayers=true;after.groundwater={mode:"assumed-depth",depth:3};
    after.rules=[{match:"sand",unit:"sand"}];after.cptRules=[{match:"clay",unit:"clay"}];
    after.alignments=[{name:"Road",points:[{x:0,y:5},{x:10,y:5}],design:[{chainage:0,top:7}]}];
    let r=reviewDataImpact(before,after);
    expect(r.otherChanges).toEqual(expect.arrayContaining(["Model base elevation","Model extent (margin)","CPT layers in model","Groundwater policy or fallback depth","Unit assignment rules","CPT layer rules","Reference alignments or design levels"]));
    const p=project();p.rules=[{match:"a",unit:"clay"},{match:"b",unit:"sand"}];
    const q=structuredClone(p);q.rules!.reverse();q.units.reverse();
    r=reviewDataImpact(p,q);expect(r.otherChanges).toContain("Unit definitions or stratigraphic order");expect(r.otherChanges).toContain("Unit assignment rules");
  });

  it("does not invent contacts at partial starts or through log gaps",()=>{
    const before=project(),added=hole();added.intervals=[{from:1,to:2,unit:"clay"},{from:4,to:10,unit:"sand"}];
    const r=reviewDataImpact(before,withNew(before,added));
    expect(r.additions[0].contacts[0].unavailableReason).toMatch(/begins below/);
    expect(sand(r).unavailableReason).toMatch(/Unlogged gap/);
    expect(sand(r).predictionError).toBeUndefined();expect(sand(r).modelShift).toBeUndefined();
    expect(r.summary).toMatchObject({loggedLength:7,comparedLength:7,matchingLength:7,comparedContacts:0});
  });

  it("coalesces adjacent intervals of one unit and withholds repeated or out-of-order tops",()=>{
    const before=project(),added=hole();added.intervals=[{from:0,to:1,unit:"clay"},{from:1,to:2,unit:"clay"},{from:2,to:5,unit:"sand"},{from:5,to:10,unit:"clay"}];
    const r=reviewDataImpact(before,withNew(before,added)),contacts=r.additions[0].contacts;
    expect(contacts).toHaveLength(3);expect(contacts[2].unavailableReason).toMatch(/Repeated or out-of-order/);
    expect(contacts[2].predictionError).toBeUndefined();
  });

  it("recognizes out-of-order unit tops across intervening undeclared intervals",()=>{
    const before=project(),added=hole();added.intervals=[{from:0,to:1,unit:"sand"},{from:1,to:2,unit:"unknown"},{from:2,to:10,unit:"clay"}];
    const r=reviewDataImpact(before,withNew(before,added)),clay=r.additions[0].contacts.find(c=>c.unitId==="clay")!;
    expect(clay.unavailableReason).toMatch(/out-of-order/);expect(clay.predictionError).toBeUndefined();
  });

  it("does not double count overlapping logs or infer agreement for invalid intervals",()=>{
    const before=project(),added=hole();added.intervals=[{from:0,to:4,unit:"clay"},{from:3,to:10,unit:"sand"}];
    const r=reviewDataImpact(before,withNew(before,added));
    expect(r.summary).toMatchObject({loggedLength:0,comparedLength:0,matchingLength:0,comparedContacts:0});
    expect(r.additions[0].contacts.every(c=>c.unavailableReason?.includes("Overlapping"))).toBe(true);
  });

  it("compares only known logged units and the shared baseline vertical extent",()=>{
    const before=project(),added=hole();added.intervals=[{from:0,to:4,unit:"clay"},{from:4,to:8,unit:"mystery"},{from:8,to:30,unit:"sand"}];
    const r=reviewDataImpact(before,withNew(before,added));
    expect(r.summary.loggedLength).toBe(30);expect(r.summary.comparedLength).toBe(16);expect(r.summary.matchingLength).toBe(14);
    const unknown=r.additions[0].contacts.find(c=>c.unitId==="mystery")!;
    expect(unknown.predictionError).toBeUndefined();expect(unknown.unavailableReason).toMatch(/not declared/);
  });

  it("reports a coincident added borehole skipped by the updated model",()=>{
    const before=project(),r=reviewDataImpact(before,withNew(before,hole("DUPLICATE_POSITION",0,0)));
    expect(r.additions[0].notes.join(" ")).toMatch(/did not use this borehole/);
    expect(sand(r)).toMatchObject({logged:6,before:8,after:8,modelShift:0});
    expect(sand(r).predictionError).toBeUndefined();expect(r.additions[0].previouslyObserved).toBe(true);
    expect(r.summary).toMatchObject({reviewedBoreholes:0,comparedContacts:0,comparedLength:0,matchingLength:0});
  });

  it("withholds predictive metrics for a renamed baseline log while retaining its interpretation shift",()=>{
    const before=project(),after=structuredClone(before);after.boreholes[0]=hole("RENAMED",0,0,4);
    const r=reviewDataImpact(before,after);
    expect(r.boreholes).toMatchObject({added:["RENAMED"],removed:["BH0"]});
    expect(r.additions[0]).toMatchObject({previouslyObserved:true,beforeInside:true,comparedLength:0});
    expect(sand(r)).toMatchObject({before:8,after:6,modelShift:-2});
    expect(sand(r).predictionError).toBeUndefined();
  });

  it("keeps unavailable predictions for an empty baseline instead of fabricating zero",()=>{
    const before=project();before.boreholes=[];
    const r=reviewDataImpact(before,withNew(before));
    expect(r.summary).toMatchObject({reviewedBoreholes:0,outsideBefore:1,comparedContacts:0});
    expect(sand(r).before).toBeUndefined();
  });

  it("exports signed measurements, deltas and empty unavailable values in ordinary CSV",()=>{
    const before=project(),after=withNew(before);after.boreholes.push(hole("OUT",15,5));
    const result=reviewDataImpact(before,after),rows=parseCsv(impactCsv(result)),header=rows[0],idx=(key:string)=>header.indexOf(key);
    const measured=rows.find(row=>row[idx("borehole_id")]==="NEW"&&row[idx("unit_id")]==="sand")!;
    expect(Number(measured[idx("prediction_error_m")])).toBe(2);expect(Number(measured[idx("model_shift_m")])).toBe(-2);
    const outside=rows.find(row=>row[idx("borehole_id")]==="OUT"&&row[idx("unit_id")]==="sand")!;
    expect(outside[idx("before_elevation_m")]).toBe("");expect(outside[idx("prediction_error_m")]).toBe("");expect(outside[idx("model_shift_m")]).toBe("");
    expect(rows.length).toBe(7);
  });

  it("keeps the change register and method notes in CSV even when there are no added boreholes",()=>{
    const before=project(),after=structuredClone(before);after.boreholes[0].z=11;
    const rows=parseCsv(impactCsv(reviewDataImpact(before,after))),header=rows[0],value=(key:string)=>rows[1][header.indexOf(key)];
    expect(rows).toHaveLength(2);expect(value("before_project")).toBe("Before");
    expect(JSON.parse(value("modified_boreholes_ids"))).toEqual(["BH0"]);
    expect(JSON.parse(value("review_notes")).join(" ")).toMatch(/cannot be attributed solely/);
    expect(value("prediction_error_m")).toBe("");
  });

  it("rejects incompatible coordinate systems and ambiguous IDs",()=>{
    const before=project();
    expect(()=>reviewDataImpact(before,{...before,crs:"Other grid"})).toThrow(/different local grids/);
    expect(()=>reviewDataImpact(before,{...before,crsCode:"EPSG:32631"})).toThrow(/different coordinate systems/);
    const duplicate=withNew(before);duplicate.boreholes.push(hole());
    expect(()=>reviewDataImpact(before,duplicate)).toThrow(/borehole IDs must be unique/);
    const repeatedCpt=project();repeatedCpt.cpts=[cpt(),cpt()];
    expect(()=>reviewDataImpact(before,repeatedCpt)).toThrow(/CPT IDs must be unique/);
    const units=project();units.units.push(units.units[0]);
    expect(()=>reviewDataImpact(before,units)).toThrow(/unit IDs must be unique/);
  });
});
