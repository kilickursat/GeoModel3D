import {describe,expect,it} from "vitest";
import {acceptCoreRun,calculateCoreRun,coreDepthAt,corePieceBox,validateCorePhotos} from "../src/corePhoto";
import type {CoreCollection,CorePiece,CoreRow,CoreRun} from "../src/corePhoto";
import type {GeoProject} from "../src/schema";
import {changeEvidenceField,validateEvidence} from "../src/evidence";

const PNG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYh8AAAAASUVORK5CYII=";
const piece=(id:string,end:number,breakAfter:CorePiece["breakAfter"]="natural",sound:CorePiece["sound"]="sound"):CorePiece=>({id,end,sound,breakAfter,unit:"rock",description:"Reviewed granite"});
const row=(id:string,from:number,to:number,pieces:CorePiece[]):CoreRow=>({id,from,to,box:{x0:0.1,y0:0.1,x1:0.9,y1:0.3},direction:"ltr",registrationReviewed:true,pieces});
function run():CoreRun{
  return {id:"run-1",boreholeId:"BH1",sourceId:"photo-1",from:10,to:11,rows:[row("row-1",10,10.6,[piece("p1",10.1),piece("p2",10.15,"mechanical"),piece("p3",10.2),piece("p4",10.5,"natural","unsound"),piece("p5",10.6,"end")])],lossReviewed:true,status:"draft"};
}
const collection=(r=run()):CoreCollection=>({version:1,runs:[r]});
function project(r=run()):GeoProject{
  return {name:"Synthetic photo test",units:[{id:"rock",name:"Granite",color:"#778899"},{id:"fill",name:"Fill",color:"#bb9977"}],
    boreholes:[{id:"BH1",x:0,y:0,z:100,depth:12,intervals:[{from:0,to:12,unit:"fill",name:"Previous logged material"}],tests:[{depth:10.5,property:"RQD",value:70}]}],
    evidence:{version:1,sources:[{id:"photo-1",name:"Synthetic core.png",pages:[{page:1,width:1000,height:400,image:PNG}],sha256:"a".repeat(64)}],records:[]},corePhotos:collection(r)};
}

describe("depth registration and reviewed core quality",()=>{
  it("uses the full drilled run denominator and the 100 mm centerline threshold",()=>{
    // A 1 m run: 0.1 m sound, 0.05 + 0.05 m sound with a mechanical break, 0.3 m unsound,
    // 0.1 m sound, then 0.4 m missing. Recovery = 60%; reviewed RQD = (0.1 + 0.1 + 0.1)/1 = 30%.
    const result=calculateCoreRun(run());
    expect(result.issues).toEqual([]);expect(result.recoveredLength).toBeCloseTo(0.6,10);
    expect(result.missingLength).toBeCloseTo(0.4,10);expect(result.recoveryPercent).toBeCloseTo(60,9);
    expect(result.qualifiedLength).toBeCloseTo(0.3,10);expect(result.rqdPercent).toBeCloseTo(30,9);
    expect(result.pieces.map(p=>[p.from,p.to])).toEqual([[10,10.1],[10.1,10.15],[10.15,10.2],[10.2,10.5],[10.5,10.6]]);
  });

  it("excludes sound pieces shorter than 100 mm, without combining natural breaks",()=>{
    const r=run();r.from=0;r.to=0.3;r.rows=[row("a",0,0.3,[piece("a1",0.099),piece("a2",0.199),piece("a3",0.3,"end")])];
    const result=calculateCoreRun(r);expect(result.rqdPercent).toBeCloseTo(100*0.201/0.3,10);
    r.rows[0].pieces[0].breakAfter="mechanical";
    expect(calculateCoreRun(r).rqdPercent).toBeCloseTo(100,10);
  });

  it("can rejoin contiguous core across a tray row only after its mechanical break is reviewed",()=>{
    const r=run();r.from=0;r.to=0.2;
    r.rows=[row("a",0,0.06,[piece("a1",0.06,"mechanical")]),row("b",0.06,0.12,[piece("b1",0.12,"end")])];
    r.rows[1].box.y0=0.4;r.rows[1].box.y1=0.6;
    expect(calculateCoreRun(r).rqdPercent).toBeCloseTo(60);
    r.rows.reverse();expect(calculateCoreRun(r).rqdPercent).toBeCloseTo(60);
    r.rows[1].pieces[0].breakAfter="end";
    expect(calculateCoreRun(r).issues.join(" ")).toContain("segment boundary");
    expect(calculateCoreRun(r).rqdPercent).toBeUndefined();
  });

  it("keeps an intact core length across a lithology logging boundary without inventing a fracture",()=>{
    const r=run();r.from=0;r.to=0.2;r.rows=[row("a",0,0.12,[piece("a1",0.06,"continuous"),piece("a2",0.12,"end")])];
    r.rows[0].pieces[1].unit="fill";
    expect(calculateCoreRun(r).rqdPercent).toBeCloseTo(60);
    r.rows[0].pieces[1].breakAfter="continuous";
    expect(calculateCoreRun(r).issues.join(" ")).toContain("continuous join cannot cross missing");
  });

  it("never joins across missing or unsound core, while retaining adjacent sound lengths",()=>{
    const r=run();r.from=0;r.to=0.3;
    r.rows=[row("a",0,0.06,[piece("a1",0.06,"mechanical")]),row("b",0.2,0.26,[piece("b1",0.26,"end")])];
    r.rows[1].box.y0=0.4;r.rows[1].box.y1=0.6;
    expect(calculateCoreRun(r).issues.join(" ")).toContain("cannot cross missing");
    r.rows[0].pieces[0].breakAfter="end";expect(calculateCoreRun(r).rqdPercent).toBe(0);
    r.rows=[row("a",0,0.2,[piece("a1",0.12,"mechanical"),piece("a2",0.2,"end","unsound")])];
    expect(calculateCoreRun(r).rqdPercent).toBeCloseTo(40);
    r.rows=[row("a",0,0.2,[piece("a1",0.06,"mechanical"),piece("a2",0.14,"mechanical","unsound"),piece("a3",0.2,"end")])];
    expect(calculateCoreRun(r).rqdPercent).toBe(0);
  });

  it("withholds RQD until registration, soundness, breaks and missing-core accounting are reviewed",()=>{
    for(const edit of [(r:CoreRun)=>{r.lossReviewed=false},(r:CoreRun)=>{r.rows[0].registrationReviewed=false},(r:CoreRun)=>{r.rows[0].pieces[0].sound="unknown"},(r:CoreRun)=>{r.rows[0].pieces[0].breakAfter="unknown"}]){
      const r=run();edit(r);const result=calculateCoreRun(r);expect(result.rqdPercent).toBeUndefined();expect(result.issues.length).toBeGreaterThan(0);
    }
    const empty=run();empty.rows=[];expect(calculateCoreRun(empty).rqdPercent).toBeUndefined();
    empty.rows=[row("empty",10,11,[])];expect(calculateCoreRun(empty).rqdPercent).toBeUndefined();
  });

  it("maps right-to-left photo rows without reversing depth or stretching across missing intervals",()=>{
    const a=row("a",2,3,[piece("a1",3,"end")]);
    expect(coreDepthAt(a,0.1)).toBe(2);expect(coreDepthAt(a,0.9)).toBe(3);
    expect(coreDepthAt(a,-1)).toBe(2);expect(coreDepthAt(a,2)).toBe(3);
    expect(corePieceBox(a,2,2.25)).toEqual({x0:0.1,y0:0.1,x1:0.30000000000000004,y1:0.3});
    a.direction="rtl";expect(coreDepthAt(a,0.1)).toBe(3);expect(coreDepthAt(a,0.9)).toBe(2);
    const box=corePieceBox(a,2,2.25);expect(box.x0).toBeCloseTo(0.7);expect(box.x1).toBeCloseTo(0.9);
  });

  it("withholds RQD when the same photographed core is assigned to different depths",()=>{
    const r=run();r.rows=[row("a",10,10.4,[piece("a1",10.4)]),row("b",10.4,10.8,[piece("b1",10.8,"end")])];
    expect(calculateCoreRun(r).issues.join(" ")).toContain("boxes overlap");expect(calculateCoreRun(r).rqdPercent).toBeUndefined();
  });
});

describe("core photo import boundary",()=>{
  it("returns detached, bounded drafts and validates references when their context is supplied",()=>{
    const p=project(),copy=validateCorePhotos(p.corePhotos,p);
    expect(copy).toEqual(p.corePhotos);copy.runs[0].rows[0].pieces[0].description="Changed";
    expect(p.corePhotos!.runs[0].rows[0].pieces[0].description).toBe("Reviewed granite");
    const r=run();r.rows=[];expect(validateCorePhotos(collection(r)).runs[0].rows).toEqual([]);
    r.rows=[row("empty",10,11,[])];expect(validateCorePhotos(collection(r)).runs[0].rows[0].pieces).toEqual([]);
    expect(()=>validateCorePhotos(collection(),{evidence:{version:1,sources:[],records:[]}})).toThrow(/photograph/);
    expect(()=>validateCorePhotos(collection(),{boreholes:[]})).toThrow(/borehole/);
    // An unfinished unit assignment is allowed in a draft, but acceptance is stricter.
    expect(validateCorePhotos(collection(),{units:[]}).runs).toHaveLength(1);
  });

  it("rejects invalid numeric spans, overlapping rows, duplicate IDs and incomplete piece partitions",()=>{
    const edits:Array<(r:CoreRun)=>void>=[
      r=>{r.from=-1},r=>{r.to=NaN},r=>{r.rows[0].to=12},r=>{r.rows[0].pieces[0].end=10},
      r=>{r.rows[0].pieces[1].id="p1"},r=>{r.rows[0].pieces.at(-1)!.end=10.59},
      r=>{r.rows.push(row("extra",10.4,10.7,[piece("extra-p",10.7,"end")]))},
      r=>{r.rows[0].box.x0=-0.1},r=>{r.rows[0].box.x1=r.rows[0].box.x0}
    ];
    for(const edit of edits){const r=run();edit(r);expect(()=>validateCorePhotos(collection(r))).toThrow(/Invalid core photographs/)}
  });

  it("rejects foreign keys, executable image references, prototype payloads, sparse and oversized collections",()=>{
    expect(()=>validateCorePhotos({version:1,runs:[],image:"https://attacker.test/a"})).toThrow(/not supported/);
    expect(()=>validateCorePhotos(JSON.parse('{"version":1,"runs":[],"__proto__":{"polluted":true}}'))).toThrow(/not supported/);
    expect(()=>validateCorePhotos({version:1,runs:new Array(1)})).toThrow(/must not be missing/);
    expect(()=>validateCorePhotos({version:1,runs:new Array(1001).fill(run())})).toThrow(/at most 1000/);
    const r=run();r.rows[0].pieces[0].description="x".repeat(4097);expect(()=>validateCorePhotos(collection(r))).toThrow(/4096/);
  });

  it("does not trust accepted status without a complete review and evidence reference",()=>{
    const r=run();r.status="accepted";expect(()=>validateCorePhotos(collection(r))).toThrow(/reviewer/);
    const accepted=acceptCoreRun(project(),"run-1",{reviewer:"Reviewer",replaceExisting:true});
    expect(validateCorePhotos(accepted.corePhotos,accepted)).toEqual(accepted.corePhotos);
    accepted.corePhotos!.runs[0].rows[0].pieces[0].sound="unknown";
    expect(()=>validateCorePhotos(accepted.corePhotos,accepted)).toThrow(/marked accepted/);
  });

  it("rejects modified accepted annotations, while preserving ordinary table corrections separately",()=>{
    const accepted=acceptCoreRun(project(),"run-1",{reviewer:"Reviewer",replaceExisting:true});
    for(const edit of [(r:CoreRun)=>{r.rows[0].pieces[0].sound="unsound"},(r:CoreRun)=>{r.rows[0].pieces[0].unit="fill"},(r:CoreRun)=>{r.rows[0].box.x0=0.05},(r:CoreRun)=>{r.reviewedBy="Someone else"},(r:CoreRun)=>{r.rows[0].pieces[0].description="Unreviewed replacement"}]){
      const altered=structuredClone(accepted);edit(altered.corePhotos!.runs[0]);
      expect(()=>validateCorePhotos(altered.corePhotos,altered)).toThrow(/original accepted/);
    }
    const evidence=accepted.evidence!,record=evidence.records.find(r=>r.id===accepted.boreholes[0].intervals[1].evidenceId)!;
    changeEvidenceField(record,"unit","fill","Later interpretation in input tables");
    expect(validateCorePhotos(accepted.corePhotos,accepted)).toEqual(accepted.corePhotos);
  });
});

describe("acceptance into the model",()=>{
  it("requires deliberate replacement of existing logs and a named reviewer",()=>{
    expect(()=>acceptCoreRun(project(),"run-1",{reviewer:"Reviewer"})).toThrow(/explicitly choose/);
    expect(()=>acceptCoreRun(project(),"run-1",{reviewer:" "})).toThrow(/reviewer's name/);
    const p=project();p.corePhotos!.runs[0].rows[0].pieces[0].unit="missing";
    expect(()=>acceptCoreRun(p,"run-1",{reviewer:"Reviewer",replaceExisting:true})).toThrow(/Assign every/);
  });

  it("replaces only the run, preserves gaps and measured tests, and leaves its input untouched",()=>{
    const p=project(),before=structuredClone(p),accepted=acceptCoreRun(p,"run-1",{reviewer:"Engineer",replaceExisting:true});
    expect(p).toEqual(before);
    const hole=accepted.boreholes[0];expect(hole.tests).toEqual(p.boreholes[0].tests);
    expect(hole.intervals[0]).toEqual({from:0,to:10,unit:"fill",name:"Previous logged material"});
    expect(hole.intervals.at(-1)).toEqual({from:11,to:12,unit:"fill",name:"Previous logged material"});
    expect(hole.intervals.filter(i=>i.from>=10&&i.to<=11)).toHaveLength(5);
    expect(hole.intervals.some(i=>i.from<11&&i.to>10.6)).toBe(false);
    expect(hole.depth).toBe(12);
    expect(accepted.corePhotos!.runs[0]).toMatchObject({status:"accepted",reviewedBy:"Engineer"});
    expect(accepted.evidence!.sources).toEqual(p.evidence!.sources);
    expect(accepted.evidence!.records).toHaveLength(6);
    expect(validateEvidence(accepted.evidence)).toEqual(accepted.evidence);
    const first=accepted.evidence!.records.find(r=>r.id===hole.intervals[1].evidenceId)!;
    expect(first.method).toBe("manual");expect(first.fields.soundness.current).toBe("sound");
    expect(first.fields.unit.boxes[0].x0).toBeCloseTo(0.1);expect(first.fields.unit.boxes[0].x1).toBeCloseTo(0.1+0.8/6);
    expect(first.fields.reviewer.events[0].reason).toBe("Reviewed by Engineer");
    const summary=accepted.evidence!.records.find(r=>r.id===accepted.corePhotos!.runs[0].reviewEvidenceId)!;
    expect(Number(summary.fields.RQD.current)).toBeCloseTo(30);
    expect(summary.fields.method.current).toContain("Missing core remains in the denominator");
  });

  it("retains old acceptance evidence when an edited run is reviewed again",()=>{
    const first=acceptCoreRun(project(),"run-1",{reviewer:"First reviewer",replaceExisting:true}),before=structuredClone(first.evidence);
    const edit=structuredClone(first),r=edit.corePhotos!.runs[0];r.status="draft";delete r.acceptedAt;delete r.reviewedBy;delete r.reviewEvidenceId;
    r.rows[0].pieces[0].description="Corrected granite";
    const second=acceptCoreRun(edit,"run-1",{reviewer:"Second reviewer",replaceExisting:true});
    expect(second.evidence!.records.slice(0,6)).toEqual(before!.records);expect(second.evidence!.records).toHaveLength(12);
    expect(second.corePhotos!.runs[0].reviewEvidenceId).not.toBe(first.corePhotos!.runs[0].reviewEvidenceId);
    expect(first.boreholes[0].intervals[1].name).toBe("Reviewed granite");
    expect(second.boreholes[0].intervals[1].name).toBe("Corrected granite");
  });

  it("appends a reviewed run and extends a shorter final depth without disturbing other boreholes",()=>{
    const p=project();p.boreholes[0].intervals=[];p.boreholes[0].depth=9;p.boreholes.push({id:"BH2",x:1,y:1,z:100,intervals:[]});
    const accepted=acceptCoreRun(p,"run-1",{reviewer:"Reviewer"});
    expect(accepted.boreholes[0].depth).toBe(11);expect(accepted.boreholes[1]).toEqual(p.boreholes[1]);
    expect(accepted.boreholes[0].tests).toEqual(p.boreholes[0].tests);
  });
});
