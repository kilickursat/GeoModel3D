import {describe,expect,it} from "vitest";
import {applyBedAssignments,parseBedAssignments,type BedAssignment} from "../src/bedAssignments";
import {changeEvidenceField} from "../src/evidence";
import {buildGeologicalModel} from "../src/model";
import {auditCollarAgreement} from "../src/correlation";
import type {GeoProject} from "../src/schema";
import {importFiles,toProjectJson} from "../src/io";
import {tablesFromProject,projectFromTables} from "../src/tables";
import {createWorkspace,parseWorkspace,toWorkspaceJson} from "../src/workspace";

const hash="a".repeat(64);
function site():GeoProject{
  return {name:"Repeated clay",units:[{id:"clay",name:"Clay",color:"#ac9876",erosive:true,gamma:19,params:{phi:23,K0:0.5}},
    {id:"sand",name:"Sand",color:"#ffcc88"},{id:"rock",name:"Rock",color:"#667788"}],
    boreholes:["A","B","C"].map((id,i)=>({id,x:i===1?10:0,y:i===2?10:0,z:10,intervals:[
      {from:0,to:1,unit:"clay",name:"Clay"},{from:1,to:3,unit:"sand",name:"Sand"},
      {from:3,to:5,unit:"clay",name:"Stiff clay",...(i===0?{evidenceId:"a3"}:{})},{from:5,to:6,unit:"rock",name:"Rock"}]})),
    evidence:{version:1,sources:[{id:"source",name:"A.pdf",sha256:hash,pages:[{page:1,width:200,height:200}]}],
      records:[{id:"a3",sourceId:"source",method:"pdf-text",fields:{unit:{original:"clay",current:"clay",status:"unreviewed",
        boxes:[{page:1,x0:0,y0:0,x1:0.25,y1:0.25,text:"Stiff clay"}],events:[]}}}]}};
}
const lower:BedAssignment={holeId:"A",from:3,to:5,materialId:"clay",expectedBed:"clay",bedId:"Lower clay",rank:3,rationale:"Matches the contact below sand on A, page 1.",sourceSha256:hash};
const manual=(id:string):BedAssignment=>{const {sourceSha256,...row}=lower;return {...row,holeId:id,rationale:`Logged below the sand in ${id}.`}};

describe("reviewed occurrence assignments",()=>{
  it("keeps original fields, source boxes and evidence history while preserving unreviewed occurrences",()=>{
    const p=site(),before=structuredClone(p);
    const result=applyBedAssignments(p,[lower,manual("B")]);
    expect(p).toEqual(before);
    expect(result.units.map(u=>u.id)).toEqual(["clay","sand","Lower clay","rock"]);
    expect(result.units[2]).toEqual({...p.units[0],id:"Lower clay",name:"Lower clay",materialId:"clay"});
    expect(result.boreholes[0].intervals[2]).toEqual({...p.boreholes[0].intervals[2],unit:"Lower clay"});
    expect(result.boreholes[2]).toBe(p.boreholes[2]);
    expect(result.evidence?.sources).toBe(p.evidence?.sources);
    const field=result.evidence!.records[0].fields.unit;
    expect(field.original).toBe("clay");expect(field.current).toBe("Lower clay");
    expect(field.boxes).toEqual(p.evidence!.records[0].fields.unit.boxes);
    expect(field.events).toMatchObject([{previous:"clay",value:"Lower clay",reason:lower.rationale}]);
    expect(result.bedAssignments).toEqual([lower,manual("B")]);
    const audit=auditCollarAgreement(buildGeologicalModel(result));
    expect(audit.discrepancies.map(d=>d.holeId)).toEqual(["C"]);
    const final=applyBedAssignments(result,[manual("C")]);
    expect(auditCollarAgreement(buildGeologicalModel(final)).discrepancies).toEqual([]);
  });

  it("retains exactly applied PDF and manual decisions across draft, workspace and project round trips",()=>{
    const input=site(),rows=[lower,manual("B")];
    const p=applyBedAssignments(input,rows);
    const data=toProjectJson(p),q=importFiles([{name:"review.json",text:data}]).project;
    const tables=tablesFromProject(q),ws=parseWorkspace(JSON.parse(toWorkspaceJson(createWorkspace(tables,q))));
    const draft=projectFromTables(ws.draft.tables,ws.draft.base).project;
    for(const project of [p,q,draft]){
      expect(project.bedAssignments).toEqual(rows);
      expect(applyBedAssignments(project,rows)).toBe(project);
      expect(project.evidence!.records[0].fields.unit.events).toHaveLength(1);
      expect(()=>applyBedAssignments(project,[{...lower,rationale:"A different instruction with a stale starting bed."}])).toThrow(/changed/);
    }
    expect(toProjectJson(input)).not.toContain('"bedAssignments"');
  });

  it("records a reason for intentional same-bed assignment without changing measured evidence",()=>{
    const p=site(),row={...lower,from:0,to:1,expectedBed:"clay",bedId:"clay",rank:1,sourceSha256:undefined};
    const q=applyBedAssignments(p,[row]);
    expect(q.bedAssignments).toEqual([row]);expect(q.boreholes[0].intervals[0]).toEqual(p.boreholes[0].intervals[0]);
    expect(q.evidence).toBe(p.evidence);expect(applyBedAssignments(q,[row])).toBe(q);
  });

  it("attaches a same-bed rationale once to its existing unit evidence",()=>{
    const p=site();p.boreholes[0].intervals.splice(0,2);
    const row={...lower,bedId:"clay",rank:1};
    const output=applyBedAssignments(p,[row]);
    expect(output.evidence!.records[0].fields.unit.events).toMatchObject([{action:"accepted",value:"clay",reason:row.rationale}]);
    expect(applyBedAssignments(output,[row])).toBe(output);
  });

  it("requires an explicit existing definition when source beds would provide different unit properties",()=>{
    const p=site(),bed={...p.units[0],id:"deep clay",name:"Deep clay",materialId:"clay",gamma:21};
    p.units.splice(2,0,bed);p.boreholes[1].intervals[2].unit=bed.id;
    const rows=[lower,{...manual("B"),expectedBed:bed.id}];
    expect(()=>applyBedAssignments(p,rows)).toThrow(/different properties/);
    expect(()=>applyBedAssignments(p,[...rows].reverse())).toThrow(/different properties/);
    p.units.splice(2,0,{...bed,id:lower.bedId,name:lower.bedId,gamma:20});
    expect(applyBedAssignments(p,rows).units[2].gamma).toBe(20);
  });

  it("requires a matching source hash when present and a matching record ID for evidence without a hash",()=>{
    const p=site();
    for(const row of [{...lower,sourceSha256:undefined},{...lower,evidenceId:"stale"},{...lower,sourceSha256:"b".repeat(64)}])
      expect(()=>applyBedAssignments(p,[row])).toThrow(/evidence/);
    const q=site();delete q.evidence!.sources[0].sha256;
    expect(()=>applyBedAssignments(q,[{...lower,sourceSha256:undefined}])).toThrow(/evidence/);
    expect(applyBedAssignments(q,[{...lower,sourceSha256:undefined,evidenceId:"a3"}]).boreholes[0].intervals[2].unit).toBe("Lower clay");
  });

  it("rejects conflicting ranks, duplicate rows, wrong materials and changed source intervals atomically",()=>{
    const p=site(),before=structuredClone(p),right=manual("B");
    for(const row of [{...right,from:2.5},{...right,materialId:"sand"},{...right,expectedBed:"rock"},
      {...right,rank:4},{...right,bedId:"Other clay"},{...right,bedId:"sand",rank:2}]){
      expect(()=>applyBedAssignments(p,[lower,row])).toThrow();expect(p).toEqual(before);
    }
    expect(()=>applyBedAssignments(p,[lower,lower])).toThrow(/repeats/);
    expect(()=>applyBedAssignments(p,[{...lower,rank:8}])).toThrow(/rank/);
    expect(()=>applyBedAssignments(p,[{...lower,rank:1}])).toThrow(/order/);
    expect(()=>parseBedAssignments([{...lower,rationale:" "}])).toThrow(/rationale/);
  });

  it("rejects overlapping source intervals and a single bed submitted on both sides of an unlogged gap",()=>{
    const p=site();p.boreholes[0].intervals[1].to=3.2;
    expect(()=>applyBedAssignments(p,[lower])).toThrow(/overlap/);
    const gap=site();gap.boreholes[1].intervals=[{from:0,to:1,unit:"clay"},{from:2,to:3,unit:"clay"}];
    const shared={...manual("B"),bedId:"shallow clay",rank:1};
    expect(()=>applyBedAssignments(gap,[{...shared,from:0,to:1},{...shared,from:2,to:3}])).toThrow(/separate occurrence/);
    gap.boreholes[1].intervals[0].to=2;
    expect(applyBedAssignments(gap,[{...shared,from:0,to:2},{...shared,from:2,to:3}]).boreholes[1].intervals.map(i=>i.unit)).toEqual(["shallow clay","shallow clay"]);
  });

  it("protects the ranked bed and source occurrence from an earlier review on a different hole",()=>{
    const p=site(),sand:BedAssignment={...manual("B"),from:1,to:3,materialId:"sand",expectedBed:"sand",bedId:"sand",rank:2};
    const reviewed=applyBedAssignments(p,[sand]);
    expect(()=>applyBedAssignments(reviewed,[{...lower,rank:2}])).toThrow(/ranks/);
    const after=applyBedAssignments(reviewed,[lower]);
    expect(after.units[1].id).toBe("sand");expect(applyBedAssignments(after,[sand])).toBe(after);
    // Preserve the sand's slot, but moving clay beneath it would still contradict the earlier measured B interval.
    const deepClay={...manual("C"),bedId:"clay",rank:3};
    expect(()=>applyBedAssignments(reviewed,[deepClay])).toThrow(/order/);
  });

  it("keeps a stale decision historical and rejects attempts to silently revive it through unrelated reordering",()=>{
    const p=applyBedAssignments(site(),[lower]);
    const moved={...p,units:[p.units[0],p.units[1],p.units[3],p.units[2]]};
    const explicitRock={...manual("B"),from:5,to:6,expectedBed:"rock",materialId:"rock",bedId:"rock",rank:4};
    expect(()=>applyBedAssignments(moved,[explicitRock])).toThrow(/stale/);
    const edited=structuredClone(p);edited.boreholes[0].intervals[2].unit="clay";
    expect(()=>applyBedAssignments(edited,[lower])).toThrow(/changed/);
    for(const bedId of ["unresolved","LOCAL ONLY"])expect(()=>applyBedAssignments(p,[{...lower,bedId}])).toThrow(/specific interpreted bed/);
  });

  it("requires a new review after a later correction restored the previous bed ID",()=>{
    const p=applyBedAssignments(site(),[lower]),record=p.evidence!.records[0];
    changeEvidenceField(record,"unit","clay","Returned to original material.");
    changeEvidenceField(record,"unit",lower.bedId,"Assigned independently by the editor.");
    expect(()=>applyBedAssignments(p,[lower])).toThrow(/changed/);
    const updated={...lower,expectedBed:lower.bedId,rationale:"Reviewed the current interpretation again."};
    expect(applyBedAssignments(p,[updated]).evidence!.records[0].fields.unit.events.at(-1)).toMatchObject({action:"accepted",reason:updated.rationale});
  });

  it("rejects changed bed position, ambiguous evidence and mismatched current unit before replay",()=>{
    const p=applyBedAssignments(site(),[lower]);[p.units[1],p.units[2]]=[p.units[2],p.units[1]];
    expect(()=>applyBedAssignments(p,[lower])).toThrow(/position/);
    const q=site();q.boreholes[1].intervals[2].evidenceId="a3";
    expect(()=>applyBedAssignments(q,[lower])).toThrow(/evidence/);
    const r=site();r.evidence!.records[0].fields.unit.current="rock";
    expect(()=>applyBedAssignments(r,[lower])).toThrow(/changed/);
  });
});
