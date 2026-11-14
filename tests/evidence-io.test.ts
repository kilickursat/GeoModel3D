import {describe,it,expect} from "vitest";
import {GeoProject} from "../src/schema";
import {EvidenceCollection} from "../src/evidence";
import {importFiles,toProjectJson,toCsv} from "../src/io";
import {tablesFromProject,projectFromTables,tableCsv} from "../src/tables";
import {checkpoint,createWorkspace,parseWorkspace,restoreRevision,toWorkspaceJson} from "../src/workspace";

function evidence(ids:string[]):EvidenceCollection{
  return {version:1,sources:[{id:"source",name:"Reviewed log.pdf",pages:[]}],records:ids.map(id=>({
    id,sourceId:"source",method:"manual",fields:{text:{original:id,current:id,boxes:[],status:"unreviewed",events:[]}}
  }))};
}
function project():GeoProject{
  return {name:"Evidence site",units:[{id:"clay",name:"Clay",color:"#778899"},{id:"sand",name:"Sand",color:"#aabbcc"}],
    boreholes:[{id:"A",x:0,y:0,z:10,evidenceId:"collar",intervals:[
      {from:0,to:3,unit:"clay",name:"Clay",evidenceId:"upper"},
      {from:3,to:8,unit:"sand",name:"Sand",evidenceId:"lower"}
    ],water:[{depth:2,date:"2026-11-01",evidenceId:"water"}]}],
    evidence:evidence(["collar","upper","lower","water","duplicate","invalid","blank"])};
}

describe("source evidence through editor tables",()=>{
  it("recovers a recorded final depth omitted as redundant without changing the rebuilt borehole",()=>{
    const p=project();
    p.evidence!.records[0].fields.depth={original:"8,00",current:"8,00",boxes:[],status:"accepted",
      events:[{at:"2026-11-14T00:00:00.000Z",action:"accepted",value:"8,00"}]};
    expect(p.boreholes[0].depth).toBeUndefined();
    const tables=tablesFromProject(p);
    expect(tables.rows.boreholes[0][6]).toBe("8,00");
    expect(projectFromTables(tables,p).project.boreholes).toEqual(p.boreholes);
  });

  it("never injects a stale or unrecorded evidence depth into the input tables",()=>{
    const p=project(),record=p.evidence!.records[0];
    record.fields.depth={original:"99",current:"99",boxes:[],status:"unreviewed",events:[]};
    expect(tablesFromProject(p).rows.boreholes[0][6]).toBe("");
    record.fields.depth={original:"",current:"8",boxes:[],status:"corrected",
      events:[{at:"2026-11-14T00:00:00.000Z",action:"corrected",value:"8",previous:""}]};
    expect(tablesFromProject(p).rows.boreholes[0][6]).toBe("");
    delete p.evidence;delete p.boreholes[0].evidenceId;
    expect(tablesFromProject(p).rows.boreholes[0][6]).toBe("");
  });

  it("preserves IDs when a borehole is renamed and edited logs are reordered",()=>{
    const p=project(),tables=tablesFromProject(p);
    tables.rows.boreholes[0][0]="Renamed";
    for(const row of [...tables.rows.logs,...tables.rows.water])row[0]="Renamed";
    // Move the original upper interval below the original lower interval. The importer sorts on depth, not source.
    tables.rows.logs[0][1]="4";tables.rows.logs[0][2]="9";
    tables.rows.logs[1][1]="0";tables.rows.logs[1][2]="4";
    const out=projectFromTables(tables,p).project,b=out.boreholes[0];
    expect(b.id).toBe("Renamed");expect(b.evidenceId).toBe("collar");
    expect(b.intervals.map(i=>[i.from,i.evidenceId])).toEqual([[0,"lower"],[4,"upper"]]);
    expect(b.water![0].evidenceId).toBe("water");
    expect(out.evidence).toEqual(p.evidence);
    out.evidence!.sources[0].name="Changed returned source";
    expect(tables.evidence!.sources[0].name).toBe("Reviewed log.pdf");
    expect(p.evidence!.sources[0].name).toBe("Reviewed log.pdf");
  });

  it("keeps source IDs on surviving rows after blank, invalid and duplicate rows are discarded",()=>{
    const tables=tablesFromProject(project());
    tables.rows.boreholes.push(["A","999","999","","","999",""]);
    tables.evidenceRows!.boreholes!.push("duplicate");
    tables.rows.logs.unshift(["","","","",""]);
    tables.evidenceRows!.logs!.unshift("blank");
    tables.rows.logs.splice(2,0,["A","nonsense","7","sand",""]);
    tables.evidenceRows!.logs!.splice(2,0,"invalid");
    tables.rows.water.unshift(["A","nonsense",""]);
    tables.evidenceRows!.water!.unshift("invalid");
    const result=projectFromTables(tables),b=result.project.boreholes[0];
    expect(b.x).toBe(0);expect(b.evidenceId).toBe("collar");
    expect(b.intervals.map(i=>i.evidenceId)).toEqual(["upper","lower"]);
    expect(b.water!.map(w=>w.evidenceId)).toEqual(["water"]);
    expect(result.warnings.some(w=>w.includes("duplicate collar A"))).toBe(true);
    expect(result.warnings.some(w=>w.includes("incomplete or inverted"))).toBe(true);
  });

  it("does not invent evidence for new rows or infer IDs from matching names or depths",()=>{
    const tables=tablesFromProject(project());
    tables.rows.logs[0][3]="sand";
    tables.rows.logs.push(["A","8","10","sand","New observation"]);
    tables.evidenceRows!.logs!.push(null);
    const result=projectFromTables(tables).project;
    expect(result.boreholes[0].intervals.map(i=>i.evidenceId)).toEqual(["upper","lower",undefined]);
    // Dropping the explicit association does not recover it by matching the original values.
    delete tables.evidenceRows;
    const detached=projectFromTables(tables,project()).project.boreholes[0];
    expect(detached.evidenceId).toBeUndefined();
    expect(detached.intervals.every(i=>i.evidenceId===undefined)).toBe(true);
    expect(detached.water![0].evidenceId).toBeUndefined();
  });

  it("rejects misaligned or dangling row associations rather than guessing a match",()=>{
    const tables=tablesFromProject(project());
    tables.evidenceRows!.logs!.pop();
    expect(()=>projectFromTables(tables)).toThrow("do not match the editor rows");
    tables.evidenceRows!.logs!.push("missing");
    expect(()=>projectFromTables(tables)).toThrow("does not name a record");
  });

  it("leaves ordinary table downloads and projects without evidence unchanged",()=>{
    const tables=tablesFromProject(project());
    expect(tableCsv(tables,"logs")).not.toContain("evidence_id");
    const p=project();delete p.evidence;
    for(const b of p.boreholes){delete b.evidenceId;for(const i of b.intervals)delete i.evidenceId;for(const w of b.water??[])delete w.evidenceId}
    const plain=tablesFromProject(p);
    expect(plain.evidence).toBeUndefined();expect(plain.evidenceRows).toBeUndefined();
    expect(projectFromTables(plain).project.boreholes).toEqual(p.boreholes);
  });
});

describe("evidence import and serialization",()=>{
  it("treats evidence_id as reserved metadata, including in a table with numeric test properties",()=>{
    const {project:p}=importFiles([
      {name:"collars.csv",text:"hole_id,x,y,z,evidence_id\nA,0,0,10,collar\n"},
      {name:"logs.csv",text:"hole_id,from,to,unit,evidence_id\nA,3,8,sand,lower\nA,0,3,clay,upper\n"},
      {name:"water.csv",text:"hole_id,water_depth,evidence_id\nA,2,water\n"},
      {name:"tests.csv",text:"hole_id,depth,su,evidence_id\nA,1,25,123\n"}
    ]);
    expect(p.boreholes[0].evidenceId).toBe("collar");
    expect(p.boreholes[0].intervals.map(i=>i.evidenceId)).toEqual(["upper","lower"]);
    expect(p.boreholes[0].water![0].evidenceId).toBe("water");
    expect(p.boreholes[0].tests).toEqual([{depth:1,property:"su",value:25}]);
  });

  it("keeps opaque CSV IDs through quoting and metric normalization",()=>{
    const id='source, record "two"',text=toCsv([
      ["hole_id","x","y","z","from (cm)","to (cm)","unit","evidence_id"],
      ["A",0,0,10,0,300,"clay",id]
    ]);
    const p=importFiles([{name:"combined.csv",text}]).project;
    expect(p.boreholes[0].evidenceId).toBe(id);
    expect(p.boreholes[0].intervals[0]).toEqual({from:0,to:3,unit:"clay",evidenceId:id});
  });

  it("round-trips the evidence collection and every supported reference in project JSON",()=>{
    const p=project(),encoded=toProjectJson(p),out=importFiles([{name:"site.json",text:encoded}]).project;
    expect(out.boreholes).toEqual(p.boreholes);expect(out.evidence).toEqual(p.evidence);
    out.evidence!.records[0].fields.text.current="Separate copy";
    expect(p.evidence!.records[0].fields.text.current).toBe("collar");
  });

  it("never reassigns references when duplicate JSON borehole names select the last record",()=>{
    const p=project(),second=structuredClone(p.boreholes[0]);
    second.evidenceId="duplicate";second.x=12;
    second.intervals=[{from:0,to:6,unit:"sand",evidenceId:"lower"}];
    second.water=[{depth:1,evidenceId:"water"}];p.boreholes.push(second);
    const out=importFiles([{name:"duplicate.json",text:toProjectJson(p)}]).project;
    expect(out.boreholes).toHaveLength(1);
    expect(out.boreholes[0]).toEqual(second);
  });

  it("rejects invalid collections and dangling or non-string references",()=>{
    const p=project(),doc=JSON.parse(toProjectJson(p));
    doc.evidence.version=99;
    expect(()=>importFiles([{name:"invalid.json",text:JSON.stringify(doc)}])).toThrow();
    for(const ref of ["missing",3,null]){
      const doc=JSON.parse(toProjectJson(p));doc.boreholes[0].intervals[0].evidenceId=ref;
      expect(()=>importFiles([{name:"invalid.json",text:JSON.stringify(doc)}])).toThrow("does not name a record");
    }
    delete p.evidence;
    expect(()=>importFiles([{name:"dangling.json",text:toProjectJson(p)}])).toThrow("does not name a record");
  });

  it("keeps evidence and stable row associations through workspace revisions and restoration",()=>{
    const p=project(),tables=tablesFromProject(p),doc=checkpoint(createWorkspace(tables,p),p,"Reviewed source");
    const loaded=parseWorkspace(JSON.parse(toWorkspaceJson(doc))),restored=restoreRevision(loaded,loaded.activeRevisionId!);
    expect(restored.draft.tables.evidence).toEqual(p.evidence);
    expect(restored.draft.tables.evidenceRows).toEqual(tables.evidenceRows);
    const built=projectFromTables(restored.draft.tables,restored.draft.base).project;
    expect(built.boreholes).toEqual(p.boreholes);expect(built.evidence).toEqual(p.evidence);
  });
});
