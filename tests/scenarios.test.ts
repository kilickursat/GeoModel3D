import {describe,it,expect} from "vitest";
import type {GeoProject} from "../src/schema";
import type {EvidenceCollection} from "../src/evidence";
import {emptyTables,tablesFromProject} from "../src/tables";
import {checkpoint,createScenario,createWorkspace,parseWorkspace,renameScenario,restoreRevision,switchScenario,toWorkspaceJson,updateDraft} from "../src/workspace";

const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBLkAAAAASUVORK5CYII=";
const site=():GeoProject=>({name:"Scenario site",groundwaterDepth:2,units:[{id:"clay",name:"Clay",color:"#998877",params:{custom:42}}],
  boreholes:[{id:"BH-1",x:0,y:0,z:10,intervals:[{from:0,to:8,unit:"clay"}],water:[{depth:2,date:"2026-11-01"}]}],
  terrain:{x0:0,y0:0,dx:10,dy:10,ncols:2,nrows:2,z:[10,10,10,NaN]},
  alignments:[{name:"Tunnel",points:[{x:0,y:0},{x:10,y:0}]}],
  cpts:[{id:"CPT-1",x:0,y:0,z:10,depth:[1,2],qc:[1,NaN],layers:[{from:0,to:2,unit:"clay"}],layersSource:"reviewed"}]});
const built=()=>{const p=site();return checkpoint(createWorkspace(tablesFromProject(p),p),p,"Baseline build")};
const wire=(document:ReturnType<typeof createWorkspace>)=>JSON.parse(toWorkspaceJson(document));

describe("named workspace scenarios",()=>{
  it("starts with a stable Baseline and a detached editable draft",()=>{
    const tables=emptyTables(),p=site(),document=createWorkspace(tables,p);
    expect(document.version).toBe(3);
    expect(document.scenarios).toEqual([{id:document.id+":baseline",name:"Baseline",createdAt:document.savedAt}]);
    expect(document.activeScenarioId).toBe(document.scenarios[0].id);
    expect(document.activeRevisionId).toBeUndefined();
    expect(document.scenarios[0]).not.toHaveProperty("draft");
    tables.rows.boreholes[0][0]="changed";p.boreholes[0].z=99;
    expect(document.draft.tables.rows.boreholes[0][0]).toBe("BH-01");
    expect(document.draft.base!.boreholes[0].z).toBe(10);
  });

  it("creates from the current unfinished draft and keeps independent drafts across switches",()=>{
    let document=built();const baseline=document.activeScenarioId,revision=document.activeRevisionId;
    const tables=structuredClone(document.draft.tables);tables.rows.logs[0][2]="awaiting survey";
    document=updateDraft(document,tables,document.draft.base);
    const alternative=createScenario(document,"  High water  "),alt=alternative.activeScenarioId;
    expect(alternative.scenarios[1].name).toBe("High water");
    expect(alternative.scenarios[1].parentScenarioId).toBe(baseline);
    expect(alternative.scenarios[1].fromRevisionId).toBe(revision);
    expect(alternative.scenarios[1].headRevisionId).toBe(revision);
    expect(alternative.scenarios[1]).not.toHaveProperty("draft");
    expect(alternative.draft.tables.rows.logs[0][2]).toBe("awaiting survey");
    expect(()=>{alternative.scenarios[0].draft!.tables.rows.logs[0][2]="bad"}).toThrow();
    alternative.draft.tables.project.name="Alternative unfinished";
    const back=switchScenario(alternative,baseline);
    expect(back.draft.tables.project.name).toBe("Scenario site");
    expect(back.draft.tables.rows.logs[0][2]).toBe("awaiting survey");
    expect(back.scenarios[0]).not.toHaveProperty("draft");
    expect(back.scenarios[1].draft!.tables.project.name).toBe("Alternative unfinished");
    back.draft.base!.cpts![0].qc[0]=55;
    const again=switchScenario(back,alt);
    expect(again.draft.base!.cpts![0].qc[0]).toBe(1);
    expect(again.draft.tables.project.name).toBe("Alternative unfinished");
    expect(document.draft.base!.cpts![0].qc[0]).toBe(1);
    expect(parseWorkspace(wire(again))).toEqual(again);
  });

  it("preserves unfinished groundwater policy text independently of valid model snapshots",()=>{
    const initial=built(),tables=structuredClone(initial.draft.tables);
    tables.groundwaterDraft={mode:"as-of",depth:"survey pending",date:"date pending",includeUndated:false};
    const edited=updateDraft(initial,tables,initial.draft.base),alternative=createScenario(edited,"Incomplete water case");
    expect(parseWorkspace(wire(alternative))).toEqual(alternative);
    const back=switchScenario(alternative,initial.activeScenarioId);
    expect(back.draft.tables.groundwaterDraft).toEqual(tables.groundwaterDraft);
    const invalid=wire(alternative);invalid.scenarios[0].draft.tables.groundwaterDraft.includeUndated="yes";
    expect(()=>parseWorkspace(invalid)).toThrow(/groundwaterDraft.includeUndated/);
  });

  it("can seed an exact checkpoint while preserving the previous invalid draft",()=>{
    let document=built();const baseline=document.activeScenarioId,revision=document.activeRevisionId!;
    document.draft.tables.rows.logs[0][2]="not yet measured";
    document=createScenario(document,"Exact baseline",revision);
    expect(document.draft.tables.rows.logs[0][2]).toBe("8");
    expect(document.draft.base).toEqual(document.revisions[0].project);
    expect(document.scenarios[0].draft!.tables.rows.logs[0][2]).toBe("not yet measured");
    const back=switchScenario(document,baseline);
    expect(back.draft.tables.rows.logs[0][2]).toBe("not yet measured");
    expect(()=>createScenario(document,"Missing","unknown")).toThrow(/checkpoint/);
  });

  it("updates only the active scenario head, deduplicates builds and branches restored revisions",()=>{
    const first=built(),baseline=first.activeScenarioId,original=first.activeRevisionId!;
    let alternative=createScenario(first,"Alternative"),alt=alternative.activeScenarioId;
    alternative=checkpoint(alternative,alternative.draft.base!,"Unchanged");
    expect(alternative.revisions).toHaveLength(1);
    const changed={...alternative.draft.base!,name:"Alternative ground",groundwater:{mode:"assumed-depth" as const,depth:0.5}};
    alternative=checkpoint(alternative,changed,"High water");const later=alternative.activeRevisionId!;
    expect(alternative.revisions[1].scenarioId).toBe(alt);
    expect(alternative.revisions[1].parentId).toBe(original);
    expect(alternative.scenarios.find(s=>s.id===baseline)!.headRevisionId).toBe(original);
    expect(alternative.scenarios.find(s=>s.id===alt)!.headRevisionId).toBe(later);
    const restored=restoreRevision(alternative,original);
    expect(restored.scenarios.find(s=>s.id===alt)!.headRevisionId).toBe(original);
    expect(restored.scenarios.find(s=>s.id===baseline)!.headRevisionId).toBe(original);
    const branch=checkpoint(restored,{...site(),name:"Another alternative"},"Alternative branch");
    expect(branch.revisions).toHaveLength(3);
    expect(branch.revisions[2].parentId).toBe(original);
    expect(branch.revisions[2].scenarioId).toBe(alt);
    expect(branch.revisions[1].id).toBe(later);
    expect(switchScenario(branch,baseline).activeRevisionId).toBe(original);
    expect(parseWorkspace(wire(branch))).toEqual(branch);
  });

  it("supports an unbuilt active scenario while other scenarios have saved revisions",()=>{
    const initial=createWorkspace(emptyTables()),baseline=initial.activeScenarioId;
    const alternative=createScenario(initial,"Built later"),builtAlt=checkpoint(alternative,site(),"First model");
    const back=switchScenario(builtAlt,baseline);
    expect(back.revisions).toHaveLength(1);
    expect(back.activeRevisionId).toBeUndefined();
    expect(back.scenarios[0].headRevisionId).toBeUndefined();
    expect(parseWorkspace(wire(back))).toEqual(back);
  });

  it("renames without switching or mutating other drafts and rejects ambiguous names",()=>{
    const first=createScenario(built(),"Alternative"),baseline=first.scenarios[0].id,alt=first.activeScenarioId;
    const renamed=renameScenario(first,baseline,"  Original interpretation  ");
    expect(renamed.activeScenarioId).toBe(alt);
    expect(renamed.scenarios[0].name).toBe("Original interpretation");
    expect(first.scenarios[0].name).toBe("Baseline");
    expect(renamed.scenarios[1]).toBe(first.scenarios[1]);
    for(const name of [""," ","x".repeat(101)," ALTERNATIVE "]){
      expect(()=>renameScenario(first,baseline,name)).toThrow(/scenario/);
      expect(()=>createScenario(first,name)).toThrow(/scenario/);
    }
    expect(()=>renameScenario(first,"missing","Valid")).toThrow(/not in this workspace/);
    expect(()=>switchScenario(first,"missing")).toThrow(/not in this workspace/);
  });

  it("pools page previews that exist only in an inactive unfinished draft",()=>{
    const evidence:EvidenceCollection={version:1,sources:[{id:"source",name:"Log.pdf",pages:[{page:1,width:100,height:200,image:png}]}],records:[]};
    const tables=emptyTables();tables.evidence=evidence;
    let document=createScenario(createWorkspace(tables),"Without preview");
    document=updateDraft(document,emptyTables());
    const json=toWorkspaceJson(document),encoded=JSON.parse(json);
    expect(json.split(png)).toHaveLength(2);
    expect(Object.values(encoded.evidenceImages)).toEqual([png]);
    expect(encoded.scenarios[0].draft.tables.evidence.sources[0].pages[0].image).toMatch(/^workspace-image:/);
    const restored=parseWorkspace(encoded);
    expect(restored).toEqual(document);
    expect(restored.scenarios[0].draft!.tables.evidence!.sources[0].pages[0].image).toBe(png);
    const changed=renameScenario(document,document.activeScenarioId,"Renamed active");
    expect(parseWorkspace(wire(changed))).toEqual(changed);
  });
});

describe("scenario workspace migration and validation",()=>{
  it.each([1,2])("migrates workspace version %s to a stable Baseline without changing draft/model data",version=>{
    const document=built();
    const old=version===1?JSON.parse(JSON.stringify(document)):wire(document);
    old.version=version;delete old.scenarios;delete old.activeScenarioId;
    if(version===1)delete old.evidenceImages;
    for(const r of old.revisions)delete r.scenarioId;
    const migrated=parseWorkspace(old);
    expect(migrated.version).toBe(3);
    expect(migrated.id).toBe(document.id);
    expect(migrated.draft).toEqual(document.draft);
    expect(migrated.activeRevisionId).toBe(document.activeRevisionId);
    expect(migrated.revisions[0].project).toEqual(document.revisions[0].project);
    expect(migrated.scenarios).toEqual([{id:document.id+":baseline",name:"Baseline",createdAt:document.revisions[0].createdAt,headRevisionId:document.activeRevisionId}]);
    expect(migrated.activeScenarioId).toBe(migrated.scenarios[0].id);
    expect(parseWorkspace(wire(migrated))).toEqual(migrated);
  });

  it.each([1,2])("rejects a mislabeled version-%s envelope rather than discarding inactive scenarios",version=>{
    const document=createScenario(built(),"Do not lose this draft"),encoded=wire(document);
    encoded.version=version;
    if(version===1)delete encoded.evidenceImages;
    expect(()=>parseWorkspace(encoded)).toThrow(/legacy format.*scenario metadata/);
    const onlyActive={...encoded};delete onlyActive.scenarios;
    expect(()=>parseWorkspace(onlyActive)).toThrow(/legacy format.*scenario metadata/);
    const onlyScenarios={...encoded};delete onlyScenarios.activeScenarioId;
    expect(()=>parseWorkspace(onlyScenarios)).toThrow(/legacy format.*scenario metadata/);
  });

  const document=()=>wire(createScenario(built(),"Alternative"));
  it.each([
    ["activeScenarioId",(d:any)=>{d.activeScenarioId="missing"}],
    ["duplicate IDs",(d:any)=>{d.scenarios[0].id=d.scenarios[1].id}],
    ["duplicates",(d:any)=>{d.scenarios[0].name=" alternative "}],
    ["characters",(d:any)=>{d.scenarios[0].name="x".repeat(101)}],
    ["active scenario",(d:any)=>{d.scenarios[1].draft=structuredClone(d.draft)}],
    ["inactive scenario",(d:any)=>{delete d.scenarios[0].draft}],
    ["headRevisionId",(d:any)=>{d.scenarios[0].headRevisionId="missing"}],
    ["active scenario head",(d:any)=>{delete d.scenarios[1].headRevisionId}],
    ["fromRevisionId",(d:any)=>{d.scenarios[1].fromRevisionId="missing"}],
    ["unknown parent",(d:any)=>{d.scenarios[1].parentScenarioId="missing"}],
    ["cycle",(d:any)=>{d.scenarios[0].parentScenarioId=d.scenarios[1].id}],
    ["scenarioId",(d:any)=>{d.revisions[0].scenarioId="missing"}],
    ["cells",(d:any)=>{d.scenarios[0].draft.tables.rows.logs[0].pop()}],
    ["finite",(d:any)=>{d.scenarios[0].draft.base.boreholes[0].x=null}],
    ["groundwater",(d:any)=>{d.scenarios[0].draft.base.groundwater={mode:"as-of",date:"not a date"}}],
    ["layersSource",(d:any)=>{d.scenarios[0].draft.base.cpts[0].layersSource="unknown"}]
  ])("rejects malformed %s without replacing any saved draft",(message,edit)=>{
    const value=document();(edit as (d:any)=>void)(value);expect(()=>parseWorkspace(value)).toThrow(message as string);
  });
});
