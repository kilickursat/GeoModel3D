import {describe,it,expect} from "vitest";
import type {GeoProject} from "../src/schema";
import type {EvidenceCollection,EvidenceField} from "../src/evidence";
import {acceptEvidenceField,changeEvidenceField} from "../src/evidence";
import {tablesFromProject,emptyTables} from "../src/tables";
import {checkpoint,createWorkspace,parseWorkspace,restoreRevision,toWorkspaceJson,updateDraft} from "../src/workspace";

const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBLkAAAAASUVORK5CYII=";
const field=(value:string):EvidenceField=>({original:value,current:value,boxes:[{page:2,x0:0.1,y0:0.2,x1:0.8,y1:0.3,text:`Source ${value}`}],status:"unreviewed",events:[]});
function project():GeoProject{
  const evidence:EvidenceCollection={version:1,sources:[{id:"doc-1",name:"Log report.pdf",sha256:"a".repeat(64),size:1234,pages:[{page:2,width:100,height:200,image:png}]}],
    records:[{id:"header",sourceId:"doc-1",method:"pdf-text",fields:{id:field("BH-1"),z:field("10")}},
      {id:"layer",sourceId:"doc-1",method:"ocr",fields:{from:field("0"),to:field("4"),unit:field("clay"),description:field("Clay")}},
      {id:"water",sourceId:"doc-1",method:"pdf-text",fields:{depth:field("2")}}]};
  changeEvidenceField(evidence.records[1],"to","5","Compared with the depth scale");
  acceptEvidenceField(evidence.records[0],"z");
  return {name:"Reviewed site",units:[{id:"clay",name:"Clay",color:"#998877"}],
    boreholes:[{id:"BH-1",x:0,y:0,z:10,evidenceId:"header",intervals:[{from:0,to:5,unit:"clay",name:"Clay",evidenceId:"layer"}],water:[{depth:2,date:"2026-11-01",evidenceId:"water"}]}],evidence};
}

describe("workspace source evidence",()=>{
  it("keeps page snapshots, binding IDs, original extraction and review history through saved drafts and revisions",()=>{
    const p=project(),tables=tablesFromProject(p);
    expect(tables.evidenceRows).toEqual({boreholes:["header"],logs:["layer"],water:["water"]});
    let document=checkpoint(createWorkspace(tables,p),p,"Reviewed PDF");
    tables.rows.logs[0][2]="survey pending";
    document=updateDraft(document,tables,p);
    const restored=parseWorkspace(JSON.parse(toWorkspaceJson(document)));
    expect(restored).toEqual(document);
    expect(restored.draft.tables.rows.logs[0][2]).toBe("survey pending");
    expect(restored.draft.tables.evidence!.sources[0].pages[0].image).toBe(png);
    expect(restored.revisions[0].project.evidence!.records[1].fields.to.original).toBe("4");
    expect(restored.revisions[0].project.evidence!.records[1].fields.to.events[0].reason).toBe("Compared with the depth scale");
    const selected=restoreRevision(restored,restored.activeRevisionId!);
    expect(selected.draft.tables.evidenceRows).toEqual(tables.evidenceRows);
    expect(selected.draft.tables.evidence).toEqual(p.evidence);
    expect(selected.draft.base!.boreholes[0].water![0].evidenceId).toBe("water");
  });

  it("records evidence-only revisions without allowing edits to rewrite a frozen earlier review",()=>{
    const p=project(),first=checkpoint(createWorkspace(tablesFromProject(p),p),p,"First review"),earlier=first.revisions[0];
    const revised=structuredClone(p);
    acceptEvidenceField(revised.evidence!.records[1],"to");
    const second=checkpoint(first,revised,"Accepted corrected depth");
    expect(second.revisions).toHaveLength(2);
    expect(earlier.project.evidence!.records[1].fields.to.status).toBe("corrected");
    expect(second.revisions[1].project.evidence!.records[1].fields.to.status).toBe("accepted");
    expect(()=>{earlier.project.evidence!.records[1].fields.to.current="999"}).toThrow();
    const restored=restoreRevision(second,earlier.id);
    changeEvidenceField(restored.draft.tables.evidence!.records[1],"to","6");
    expect(earlier.project.evidence!.records[1].fields.to.current).toBe("5");
  });

  it("rejects dangling or structurally misaligned input-row bindings rather than guessing a source",()=>{
    const p=project(),document=checkpoint(createWorkspace(tablesFromProject(p),p),p,"Review");
    for(const bindings of [{logs:["missing"]},{logs:[]},{unexpected:["layer"]},{logs:[1]}]){
      const invalid=JSON.parse(toWorkspaceJson(document));invalid.draft.tables.evidenceRows=bindings;
      expect(()=>parseWorkspace(invalid)).toThrow(/draft.tables.evidenceRows/);
    }
    const missingCollection=JSON.parse(toWorkspaceJson(document));delete missingCollection.draft.tables.evidence;
    expect(()=>parseWorkspace(missingCollection)).toThrow(/draft.tables.evidenceRows/);
  });

  it("validates each borehole, interval and water reference in revision and base-project snapshots",()=>{
    const p=project(),document=checkpoint(createWorkspace(tablesFromProject(p),p),p,"Review");
    for(const branch of ["revision","base"]){
      for(const target of ["header","layer","water"]){
        const invalid=JSON.parse(toWorkspaceJson(document));
        const saved=branch==="revision"?invalid.revisions[0].project:invalid.draft.base;
        if(target==="header")saved.boreholes[0].evidenceId="missing";
        if(target==="layer")saved.boreholes[0].intervals[0].evidenceId="missing";
        if(target==="water")saved.boreholes[0].water[0].evidenceId="missing";
        expect(()=>parseWorkspace(invalid)).toThrow(/evidenceId.*does not name/);
      }
    }
    const invalid=JSON.parse(toWorkspaceJson(document));delete invalid.revisions[0].project.evidence;
    expect(()=>parseWorkspace(invalid)).toThrow(/evidenceId/);
  });

  it("rejects malformed source history and unsafe images at workspace import",()=>{
    const p=project(),document=checkpoint(createWorkspace(tablesFromProject(p),p),p,"Review");
    const invalidImage=JSON.parse(toWorkspaceJson(document));
    invalidImage.draft.tables.evidence.sources[0].pages[0].image="https://example.com/leak.png";
    expect(()=>parseWorkspace(invalidImage)).toThrow(/draft.tables.evidence/);
    const invalidBox=JSON.parse(toWorkspaceJson(document));
    invalidBox.revisions[0].project.evidence.records[0].fields.z.boxes[0].page=99;
    expect(()=>parseWorkspace(invalidBox)).toThrow(/revisions\[0\].project.evidence/);
    const invalidHistory=JSON.parse(toWorkspaceJson(document));
    invalidHistory.draft.base.evidence.records[1].fields.to.current="100";
    expect(()=>parseWorkspace(invalidHistory)).toThrow(/draft.base.evidence/);
  });

  it("stores each page PNG once across tables, base projects and multiple revisions",()=>{
    const p=project(),first=checkpoint(createWorkspace(tablesFromProject(p),p),p,"First");
    const renamed={...p,name:"Second interpretation"};
    const document=checkpoint(first,renamed,"Second");
    const json=toWorkspaceJson(document),wire=JSON.parse(json);
    expect(wire.version).toBe(3);
    expect(Object.values(wire.evidenceImages)).toEqual([png]);
    expect(json.split(png)).toHaveLength(2);
    expect(wire.draft.tables.evidence.sources[0].pages[0].image).toMatch(/^workspace-image:/);
    expect(wire.draft.base.evidence.sources[0].pages[0].image).toBe(wire.revisions[0].project.evidence.sources[0].pages[0].image);
    expect(parseWorkspace(wire)).toEqual(document);
  });

  it("migrates version-1 inline images without treating evidence text as image references",()=>{
    const p=project();p.evidence!.records[0].fields.id.note="workspace-image:missing-is-only-text";
    const document=checkpoint(createWorkspace(tablesFromProject(p),p),p,"Legacy evidence");
    const legacy=JSON.parse(JSON.stringify({...document,version:1}));delete legacy.scenarios;delete legacy.activeScenarioId;
    const migrated=parseWorkspace(legacy);
    expect(migrated.draft).toEqual(document.draft);
    expect(migrated.revisions).toEqual(document.revisions);
    expect(migrated.activeRevisionId).toBe(document.activeRevisionId);
    expect(migrated.scenarios).toHaveLength(1);
    expect(migrated.scenarios[0].name).toBe("Baseline");
    expect(migrated.version).toBe(3);
    expect(migrated.draft.tables.evidence!.records[0].fields.id.note).toBe("workspace-image:missing-is-only-text");
    expect(JSON.parse(toWorkspaceJson(migrated)).evidenceImages).toBeDefined();
  });

  it("rejects missing pool references, unsafe unused pool entries and version-1 pooled references",()=>{
    const p=project(),document=checkpoint(createWorkspace(tablesFromProject(p),p),p,"Review");
    const missing=JSON.parse(toWorkspaceJson(document));missing.evidenceImages={};
    expect(()=>parseWorkspace(missing)).toThrow(/does not name a pooled workspace image/);
    const unsafe=JSON.parse(toWorkspaceJson(document));unsafe.evidenceImages.unused="https://example.com/leak.png";
    expect(()=>parseWorkspace(unsafe)).toThrow(/PNG data URL/);
    const legacy=JSON.parse(toWorkspaceJson(document));legacy.version=1;delete legacy.evidenceImages;delete legacy.scenarios;delete legacy.activeScenarioId;
    expect(()=>parseWorkspace(legacy)).toThrow(/image reference unsupported by workspace version 1/);
  });

  it("bounds the complete image pool before attempting PNG decoding",()=>{
    const wire=JSON.parse(toWorkspaceJson(createWorkspace(emptyTables())));
    // Deliberately hostile payloads: their collective length alone must reject before decoding any image.
    for(let i=0;i<17;i++)wire.evidenceImages[`large-${i}`]="data:image/png;base64,"+"A".repeat(2_796_196)+String(i).padStart(4,"0");
    expect(()=>parseWorkspace(wire)).toThrow(/32 MiB unique image limit/);
  });

  it("keeps cached revision image references stable when a later draft introduces another image",()=>{
    // Add a valid ancillary PNG chunk so the second image is a different byte sequence without changing pixels.
    const raw=atob(png.slice("data:image/png;base64,".length)),data="Comment\0Later snapshot",type="tEXt";
    const uint=(n:number)=>String.fromCharCode(n>>>24,(n>>>16)&255,(n>>>8)&255,n&255);
    let crc=0xffffffff;
    for(const c of type+data){crc^=c.charCodeAt(0);for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
    const other="data:image/png;base64,"+btoa(raw.slice(0,-12)+uint(data.length)+type+data+uint((crc^0xffffffff)>>>0)+raw.slice(-12));
    const p=project(),document=checkpoint(createWorkspace(tablesFromProject(p),p),p,"Cached first image");
    const before=JSON.parse(toWorkspaceJson(document));
    const tables=tablesFromProject(p);tables.evidence!.sources[0].pages[0].image=other;
    const changed=updateDraft(document,tables,p),wire=JSON.parse(toWorkspaceJson(changed));
    expect(Object.values(wire.evidenceImages)).toHaveLength(2);
    expect(wire.revisions[0].project.evidence.sources[0].pages[0].image).toBe(before.revisions[0].project.evidence.sources[0].pages[0].image);
    const parsed=parseWorkspace(wire);
    expect(parsed.draft.tables.evidence!.sources[0].pages[0].image).toBe(other);
    expect(parsed.revisions[0].project.evidence!.sources[0].pages[0].image).toBe(png);
    expect(parsed).toEqual(changed);
  });

  it("still reads earlier workspaces with no fabricated evidence",()=>{
    const tables=emptyTables(),document=createWorkspace(tables);
    const restored=parseWorkspace(JSON.parse(toWorkspaceJson(document)));
    expect(restored).toEqual(document);
    expect(restored.draft.tables.evidence).toBeUndefined();
    expect(restored.draft.tables.evidenceRows).toBeUndefined();
  });
});
