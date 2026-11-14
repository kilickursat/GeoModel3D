import {describe,it,expect} from "vitest";
import {calibrateDisagreement,calibrationCsv,conformalExpansion} from "../src/calibration";
import type {CalibrationOptions} from "../src/calibration";
import type {DisagreementCase} from "../src/disagreement";
import type {GeoProject} from "../src/schema";
import {parseCsv} from "../src/io";

function project(size=6,contact=4):GeoProject{
  return {name:"Calibration study",crs:"Local grid",base:-20,margin:100,
    units:[{id:"fill",name:"Fill",color:"#888"},{id:"sand",name:"Sand",color:"#db8"}],
    boreholes:Array.from({length:size*size},(_,i)=>({id:`BH-${String(i).padStart(3,"0")}`,x:(i%size)*20,y:Math.floor(i/size)*20,z:20,
      intervals:[{from:0,to:contact,unit:"fill"},{from:contact,to:30,unit:"sand"}]}))};
}
const cases=(first=project(),last=structuredClone(first)):DisagreementCase[]=>[{id:"reference",project:first},{id:"alternative",project:last}];
const settings:CalibrationOptions={unitId:"sand",mode:"section",azimuth:0,gridSize:3,step:40,seed:1729};
function setContact(p:GeoProject,id:string,depth:number){const hole=p.boreholes.find(b=>b.id===id)!;hole.intervals[0].to=depth;hole.intervals[1].from=depth}

describe("finite-sample conformal expansion",()=>{
  it("uses the corrected order statistic without clamping unsupported ranks",()=>{
    expect(conformalExpansion([0,1,2,3,4,5,6,7,8],.9)).toEqual({n:9,finiteCount:9,rank:9,quantile:8});
    const tooSmall=conformalExpansion([0,1,2,3,4,5,6,7],.9);
    expect(tooSmall).toMatchObject({n:8,finiteCount:8,rank:9});expect(tooSmall.quantile).toBeUndefined();expect(tooSmall.unavailableReason).toMatch(/rank 9 exceeds 8/);
    expect(conformalExpansion([0,1,2,3,4,5,6,7,8,9],.5)).toMatchObject({rank:6,quantile:5});
    expect(conformalExpansion(Array(19).fill(2),.95)).toMatchObject({rank:19,quantile:2});
    expect(conformalExpansion(Array(24).fill(2),.56)).toMatchObject({rank:14,quantile:2});
    expect(conformalExpansion([2],.5000000000000001)).toMatchObject({rank:2,n:1});
    expect(conformalExpansion([2],.5000000000000001).quantile).toBeUndefined();
  });
  it("retains missing predictions as unbounded scores and preserves genuine zero expansion",()=>{
    expect(conformalExpansion([0,0,0,0,0,0,0,0,0],.9).quantile).toBe(0);
    const unbounded=conformalExpansion([0,1,2,3,4,5,6,7,undefined],.9);
    expect(unbounded).toMatchObject({rank:9,n:9,finiteCount:8});expect(unbounded.quantile).toBeUndefined();expect(unbounded.unavailableReason).toMatch(/unbounded/);
    expect(conformalExpansion([1,2,3,4,5,6,7,8,9,10,undefined],.5)).toMatchObject({rank:6,n:11,finiteCount:10,quantile:6});
    for(const coverage of [0,.49,1,NaN])expect(()=>conformalExpansion([1],coverage)).toThrow(/coverage/);
    expect(()=>conformalExpansion([-1],.9)).toThrow(/nonnegative/);
    expect(()=>conformalExpansion([Infinity],.9)).toThrow(/explicitly unbounded/);
  });
});

describe("group-separated contact calibration",()=>{
  it("calibrates a hand-computed fixed envelope and never trains on calibration or audit observations",()=>{
    const input=cases(),initial=calibrateDisagreement(input,settings);
    expect(initial.partition).toMatchObject({trainingCount:18,calibrationCount:10,auditCount:8});
    const calibration=initial.partition.groups.filter(group=>group.role==="calibration");
    calibration.forEach((group,index)=>setContact(input[0].project,group.referenceId,4+index));
    const original=structuredClone(input),result=calibrateDisagreement(input,settings);
    expect(result).toMatchObject({rank:10,nCalibration:10,finiteCalibration:10,quantile:9});
    result.rows.filter(row=>row.role==="calibration").map(row=>row.score).sort((a,b)=>a!-b!).forEach((score,index)=>expect(score).toBeCloseTo(index,10));
    for(const removal of result.partition.removals){
      expect(removal.boreholeIds).toHaveLength(18);expect(removal.remainingBoreholes).toBe(18);
      expect(new Set(removal.boreholeIds)).toEqual(new Set(result.partition.groups.filter(group=>group.role!=="training").map(group=>group.referenceId)));
    }
    for(const point of [...result.intervals.grid,...result.intervals.path].filter(point=>point.complete)){
      expect(point.baseMin).toBeCloseTo(16);expect(point.baseMax).toBeCloseTo(16);
      expect(point.lower).toBeCloseTo(7);expect(point.upper).toBeCloseTo(25);expect(point.width).toBeCloseTo(18);
    }
    expect(result.audit.all).toMatchObject({nTotal:8,nScored:8,nCovered:8,nUnavailable:0,empiricalCoverage:1,meanWidth:18});
    expect(input).toEqual(original);expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("keeps audit truth independent of the fitted map and calibration quantile",()=>{
    const input=cases(),before=calibrateDisagreement(input,settings);
    const audit=before.partition.groups.filter(group=>group.role==="audit");
    for(const group of audit)for(const item of input)setContact(item.project,group.referenceId,14);
    const after=calibrateDisagreement(input,settings);
    expect(before.quantile).toBeCloseTo(0,10);expect(after.quantile).toBe(before.quantile);
    expect(after.partition.groups).toEqual(before.partition.groups);expect(after.report).toEqual(before.report);
    expect(after.intervals).toEqual(before.intervals);expect(after.rows.filter(row=>row.role==="calibration")).toEqual(before.rows.filter(row=>row.role==="calibration"));
    expect(after.audit.all).toMatchObject({nTotal:8,nScored:8,nCovered:0,empiricalCoverage:0});
  });

  it("removes co-located duplicates, moved matching IDs and linked CPTs from all fitted interpretations",()=>{
    const input=cases(),initial=calibrateDisagreement(input,settings),group=initial.partition.groups.find(group=>group.role==="calibration")!;
    const reference=input[0].project,alternative=input[1].project,hole=reference.boreholes.find(b=>b.id===group.referenceId)!,moved=alternative.boreholes.find(b=>b.id===hole.id)!;
    reference.boreholes.push({...structuredClone(hole),id:"duplicate-reference"});
    moved.x+=.1;moved.y+=.1;alternative.cptLayers=true;
    alternative.cpts=[{id:"CPT-linked-moved",x:moved.x,y:moved.y,z:20,depth:[1,2],qc:[2,4],layersSource:"reviewed",layers:[{from:0,to:14,unit:"fill"},{from:14,to:30,unit:"sand"}]}];
    const result=calibrateDisagreement(input,settings),linked=result.partition.groups.find(g=>g.memberReferenceIds.includes("duplicate-reference"))!;
    expect(linked.role).toBe("calibration");expect(linked.positions).toHaveLength(2);expect(linked.boreholeIds).toEqual([hole.id,"duplicate-reference"].sort());expect(linked.cptIds).toEqual(["CPT-linked-moved"]);
    expect(result.partition.removals[0].boreholeIds).toContain("duplicate-reference");
    expect(result.partition.removals[1].boreholeIds).toContain(hole.id);expect(result.partition.removals[1].cptIds).toContain("CPT-linked-moved");
    expect(result.quantile).toBeCloseTo(0,9);
  });

  it("uses one representative per physical group and deterministic seeded partitions independent of input order",()=>{
    const input=cases(),first=calibrateDisagreement(input,settings);
    for(const item of input)item.project.boreholes.reverse();
    const reordered=calibrateDisagreement(input,settings);
    expect(reordered.partition.groups).toEqual(first.partition.groups);expect(reordered.rows).toEqual(first.rows);
    const different=calibrateDisagreement(input,{...settings,seed:1730});
    expect(different.partition.groups.map(group=>group.role)).not.toEqual(first.partition.groups.map(group=>group.role));
    const p=project();p.boreholes.push({...structuredClone(p.boreholes[0]),id:"second-same-location"});
    const duplicate=calibrateDisagreement(cases(p),settings);
    expect(duplicate.partition.groups).toHaveLength(36);expect(duplicate.partition.groups.find(group=>group.memberReferenceIds.includes("second-same-location"))!.memberReferenceIds).toHaveLength(2);
  });

  it("withholds finite intervals at small n and never silently discards missing calibration predictions",()=>{
    const small=calibrateDisagreement(cases(project(3)),settings);
    expect(small.nCalibration).toBe(2);expect(small.quantile).toBeUndefined();expect(small.unavailableReason).toMatch(/rank 3 exceeds 2/);
    expect(small.intervals.path.every(point=>!point.complete&&point.lower===undefined)).toBe(true);
    const p=project(),q=project();q.boreholes.forEach(hole=>{hole.intervals=[{from:0,to:30,unit:"fill"}]});
    const missing=calibrateDisagreement(cases(p,q),settings);
    expect(missing.nCalibration).toBe(10);expect(missing.finiteCalibration).toBe(0);expect(missing.quantile).toBeUndefined();
    expect(missing.rows.filter(row=>row.role==="calibration").every(row=>row.scoreUnbounded&&row.score===undefined&&row.missingCaseIds.includes("alternative"))).toBe(true);
    expect(missing.unavailableReason).toMatch(/unbounded/);expect(JSON.stringify(missing)).not.toMatch(/Infinity|NaN/);
    const none=project();none.boreholes=[];
    const empty=calibrateDisagreement(cases(none),settings);
    expect(empty.partition.groups).toEqual([]);expect(empty.quantile).toBeUndefined();expect(empty.unavailableReason).toMatch(/no observed reference groups/);
  });

  it("keeps unavailable audit checks in the overall denominator and reports extrapolation separately",()=>{
    const input=cases();let split=calibrateDisagreement(input,settings),seed=settings.seed!;
    for(let candidate=0;split.partition.groups.find(group=>group.referenceId==="BH-000")!.role!=="audit"&&candidate<100;candidate++){
      seed=candidate;split=calibrateDisagreement(input,{...settings,seed});
    }
    expect(split.partition.groups.find(group=>group.referenceId==="BH-000")!.role).toBe("audit");
    // The alternative keeps the original position, so its identity link preserves the group's canonical key and role.
    // Its reference truth is now far outside the fixed models' footprint, while all calibration locations are unchanged.
    input[0].project.boreholes.find(hole=>hole.id==="BH-000")!.y=10000;
    const result=calibrateDisagreement(input,{...settings,seed});
    expect(result.quantile).toBeDefined();expect(result.partition.groups.find(group=>group.referenceId==="BH-000")!.role).toBe("audit");
    const unavailable=result.rows.filter(row=>row.role==="audit"&&row.covered===undefined).length;
    expect(unavailable).toBe(1);expect(result.audit.all.nUnavailable).toBe(1);
    expect(result.audit.all.empiricalCoverage).toBe(result.audit.all.nCovered/result.audit.all.nTotal);
    expect(result.audit.interior.nTotal+result.audit.extrapolation.nTotal).toBe(result.audit.all.nTotal);
  });

  it("does not infer validation truth from missing or ambiguous contact tops",()=>{
    const p=project();p.boreholes[0].intervals=[{from:0,to:2,unit:"fill"},{from:4,to:30,unit:"sand"}];
    const result=calibrateDisagreement(cases(p),settings);
    expect(result.partition.excludedReferenceCount).toBe(1);expect(result.partition.excludedReferences[0].reason).toMatch(/unlogged gap/);
    expect(result.partition.groups.some(group=>group.referenceId===p.boreholes[0].id)).toBe(false);
  });

  it("exports the split, quantile, audited contacts and training-only map/path intervals without nonfinite JSON",()=>{
    const result=calibrateDisagreement(cases(),settings),rows=parseCsv(calibrationCsv(result)),head=rows[0],column=(name:string)=>head.indexOf(name);
    expect(rows.slice(1).every(row=>row.length===head.length)).toBe(true);
    const audit=rows.find(row=>row[column("record_type")]==="audit")!;
    expect(audit[column("target_coverage")]).toBe("0.9");expect(audit[column("split_seed")]).toBe("1729");expect(Number(audit[column("expansion_m")])).toBeCloseTo(0,10);
    const metadata=rows.find(row=>row[column("record_type")]==="metadata")!;
    expect(rows[1]).toBe(metadata);expect(JSON.parse(metadata[column("partition")])).toEqual(result.partition);
    expect(JSON.parse(metadata[column("review_notes")])).toEqual(result.notes);
    expect(rows.slice(2).every(row=>row[column("partition")]===""&&row[column("review_notes")]==="")).toBe(true);
    expect(rows.some(row=>row[column("record_type")]==="map")).toBe(true);expect(rows.some(row=>row[column("record_type")]==="path")).toBe(true);
    const empty=project();empty.boreholes=[];const exported=parseCsv(calibrationCsv(calibrateDisagreement(cases(empty),settings)));
    expect(exported).toHaveLength(2);expect(exported[1][exported[0].indexOf("unit_id")]).toBe("sand");
  });

  it("rejects invalid settings, duplicate identities and mismatched coordinate systems",()=>{
    for(const invalid of [{coverage:1},{seed:-1},{seed:.5},{seed:4294967296},{trainingFraction:0},{calibrationFraction:.5,trainingFraction:.5}])expect(()=>calibrateDisagreement(cases(),{...settings,...invalid})).toThrow();
    expect(()=>calibrateDisagreement(cases().slice(0,1),settings)).toThrow(/two to six/);
    const input=cases();input[1].id=input[0].id;expect(()=>calibrateDisagreement(input,settings)).toThrow(/unique/);
    const p=project();p.boreholes.push(p.boreholes[0]);expect(()=>calibrateDisagreement(cases(p),settings)).toThrow(/Borehole IDs/);
    const q=project();q.crs="Other grid";expect(()=>calibrateDisagreement(cases(project(),q),settings)).toThrow(/different local grids/);
  });
});
