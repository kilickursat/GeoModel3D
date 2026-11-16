import {describe,it,expect} from "vitest";
import type {GeoProject} from "../src/schema";
import {acceptCoreRun} from "../src/corePhoto";
import {importFiles,toProjectJson} from "../src/io";
import {tablesFromProject,projectFromTables,projectForCorePhotos,emptyTables} from "../src/tables";
import {buildGeologicalModel} from "../src/model";
import {checkpoint,createWorkspace,createScenario,parseWorkspace,restoreRevision,switchScenario,toWorkspaceJson,updateDraft,expandWorkspaceParts} from "../src/workspace";

// Generated one-pixel PNG: a source-image transport fixture, not a geological observation.
const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBLkAAAAASUVORK5CYII=";
function project():GeoProject{
  return {name:"Core registration fixture",units:[{id:"rock",name:"Rock",color:"#998877"}],
    boreholes:[{id:"BH-1",x:0,y:0,z:10,intervals:[{from:0,to:5,unit:"rock",name:"Existing log"}],tests:[{depth:2,property:"qu",value:40}]}],
    evidence:{version:1,sources:[{id:"photo",name:"Core box.png",sha256:"a".repeat(64),size:68,pages:[{page:1,width:1,height:1,image:png}]}],records:[]},
    corePhotos:{version:1,runs:[{id:"run",boreholeId:"BH-1",sourceId:"photo",from:1,to:3,lossReviewed:true,status:"draft",rows:[{
      id:"row",box:{x0:0.1,y0:0.2,x1:0.9,y1:0.4},from:1,to:2.8,direction:"rtl",registrationReviewed:true,pieces:[
        {id:"piece-1",end:1.5,sound:"sound",breakAfter:"natural",unit:"rock",description:"Sound recovered core"},
        {id:"piece-2",end:2.8,sound:"unsound",breakAfter:"end",unit:"rock",description:"Weathered recovered core"}
      ]
    }]}]}};
}
const load=(p:GeoProject)=>importFiles([{name:"photo.geomodel3d.json",text:toProjectJson(p)}]).project;
const wire=(value:ReturnType<typeof createWorkspace>)=>expandWorkspaceParts(JSON.parse(toWorkspaceJson(value)));
const accepted=()=>acceptCoreRun(project(),"run",{reviewer:"Fixture reviewer",replaceExisting:true});

describe("core-photo persistence",()=>{
  it("round-trips unfinished annotations without treating them as measured tests",()=>{
    const p=project();p.corePhotos!.runs[0].lossReviewed=false;
    p.corePhotos!.runs[0].rows[0].pieces[0].sound="unknown";
    p.corePhotos!.runs[0].rows[0].pieces[0].unit="Unassigned draft unit";
    const before=structuredClone(p),parsed=load(p);
    expect(parsed.corePhotos).toEqual(p.corePhotos);expect(parsed.evidence).toEqual(p.evidence);
    expect(parsed.boreholes[0].tests).toEqual([{depth:2,property:"qu",value:40}]);
    parsed.corePhotos!.runs[0].rows[0].pieces[0].description="Edited imported draft";
    expect(p).toEqual(before);
  });

  it("keeps accepted annotations, source highlights and photo RQD separate from lab values",()=>{
    const p=accepted(),parsed=load(p),tables=tablesFromProject(parsed),rebuilt=projectFromTables(tables,parsed).project;
    expect(parsed.corePhotos).toEqual(p.corePhotos);expect(rebuilt.corePhotos).toEqual(p.corePhotos);
    expect(rebuilt.evidence).toEqual(p.evidence);
    expect(rebuilt.boreholes[0].intervals).toEqual(p.boreholes[0].intervals);
    expect(rebuilt.boreholes[0].tests).toEqual(p.boreholes[0].tests);
    expect(p.corePhotos!.runs[0].status).toBe("accepted");
    expect(p.evidence!.records.some(r=>Object.values(r.fields).some(f=>f.boxes.length>0))).toBe(true);
    tables.corePhotos!.runs[0].rows[0].pieces[0].description="Edited table draft";
    expect(parsed.corePhotos).toEqual(p.corePhotos);expect(rebuilt.corePhotos).toEqual(p.corePhotos);
  });

  it("pools one photograph across revisions, independent scenario drafts and restored history",()=>{
    const p=accepted(),tables=tablesFromProject(p);
    let doc=checkpoint(createWorkspace(tables,p),p,"Reviewed core");
    const baseline=doc.activeScenarioId,revision=doc.activeRevisionId!;
    doc=createScenario(doc,"Alternative interpretation",revision);
    const alternative=doc.activeScenarioId;
    const edited=structuredClone(doc.draft.tables),run=edited.corePhotos!.runs[0];
    run.status="draft";delete run.reviewedBy;delete run.acceptedAt;
    run.rows[0].pieces[0].description="Alternative, not accepted";
    doc=updateDraft(doc,edited,doc.draft.base);
    doc=switchScenario(doc,baseline);
    const json=toWorkspaceJson(doc),stored=expandWorkspaceParts(JSON.parse(json)),parsed=parseWorkspace(JSON.parse(json));
    expect(Object.values(stored.evidenceImages)).toEqual([png]);expect(json.split(png)).toHaveLength(2);
    expect(parsed).toEqual(doc);
    expect(parsed.draft.tables.corePhotos!.runs[0].status).toBe("accepted");
    const active=switchScenario(parsed,alternative);
    expect(active.draft.tables.corePhotos!.runs[0].rows[0].pieces[0].description).toBe("Alternative, not accepted");
    expect(active.revisions[0].project.corePhotos).toEqual(p.corePhotos);
    const restored=restoreRevision(active,revision);
    expect(restored.draft.tables.corePhotos).toEqual(p.corePhotos);
    expect(restored.draft.base!.evidence).toEqual(p.evidence);
  });

  it("preserves unfinished borehole renames for later repair and rejects stale links at build",()=>{
    const p=accepted(),tables=tablesFromProject(p);
    tables.rows.boreholes[0][0]="Renamed";
    for(const rows of [tables.rows.logs,tables.rows.tests])for(const row of rows)row[0]="Renamed";
    const doc=createWorkspace(tables,p),parsed=parseWorkspace(wire(doc));
    expect(parsed.draft.tables).toEqual(tables);
    expect(()=>projectFromTables(parsed.draft.tables,parsed.draft.base)).toThrow(/borehole/i);
    expect(projectForCorePhotos(parsed.draft.tables,parsed.draft.base).boreholes[0].id).toBe("Renamed");
    const run=parsed.draft.tables.corePhotos!.runs[0];
    run.boreholeId="Renamed";run.status="draft";delete run.reviewedBy;delete run.acceptedAt;delete run.reviewEvidenceId;
    expect(projectFromTables(parsed.draft.tables,parsed.draft.base).project.corePhotos!.runs[0].boreholeId).toBe("Renamed");
  });

  it("starts from unlogged collars without creating artificial observations",()=>{
    const tables=emptyTables();tables.rows.units=[["rock","Rock","#998877","","","","","","","","","",""]];
    const p=projectForCorePhotos(tables);
    expect(p.boreholes).toEqual([{id:"BH-01",x:0,y:0,z:0,intervals:[]}]);
    expect(p.units[0].id).toBe("rock");
    expect(p.corePhotos).toBeUndefined();
    expect(buildGeologicalModel(p).boreholes).toHaveLength(0);
    expect(tables.rows.logs).toEqual([["BH-01","0","","",""]]);
    p.evidence=project().evidence;p.corePhotos=project().corePhotos;
    p.corePhotos!.runs[0].boreholeId="BH-01";
    const withPhotos=tablesFromProject(p),rebuilt=projectFromTables(withPhotos,p).project;
    expect(rebuilt.boreholes[0].intervals).toEqual([]);
    expect(load(p).boreholes).toEqual(p.boreholes);
    const doc=checkpoint(createWorkspace(withPhotos,p),p,"Registered photo before logging");
    expect(parseWorkspace(wire(doc))).toEqual(doc);
    const logged=acceptCoreRun(p,"run",{reviewer:"Fixture reviewer"});
    expect(logged.boreholes[0].intervals).toHaveLength(2);
    expect(buildGeologicalModel(logged).boreholes).toHaveLength(1);
  });

  it("keeps photo-reviewed unit assignments when importing a project with automatic description rules",()=>{
    const p=accepted();
    p.units.push({id:"automatic",name:"Automatic grouping",color:"#aabbcc"});
    p.rules=[{match:"core",unit:"automatic"},{match:"Existing",unit:"rock"}];
    const parsed=load(p);
    expect(parsed.boreholes[0].intervals).toEqual(p.boreholes[0].intervals);
    expect(parsed.corePhotos).toEqual(p.corePhotos);
    expect(parsed.rules).toEqual(p.rules);
    expect(projectFromTables(tablesFromProject(parsed),parsed).project.boreholes[0].intervals).toEqual(p.boreholes[0].intervals);
  });

  it("uses surveyed coordinates for photo-first collars and retains only referenced empty collars after import",()=>{
    const tables=tablesFromProject(project());tables.project.crs="EPSG:28992";
    tables.rows.boreholes=[["BH-1","","","52.1551744","5.38720621","12","6"]];
    tables.rows.logs=[];tables.evidenceRows={logs:[]};
    const p=projectForCorePhotos(tables);
    expect(p.boreholes[0].x).toBeCloseTo(155000,0);expect(p.boreholes[0].y).toBeCloseTo(463000,0);
    expect(p.boreholes[0].z).toBe(12);expect(p.boreholes[0].depth).toBe(6);
    expect(p.boreholes[0].intervals).toEqual([]);
    p.boreholes.push({id:"Unrelated empty collar",x:0,y:0,z:0,intervals:[]});
    const imported=load(p);
    expect(imported.boreholes.map(b=>b.id)).toEqual(["BH-1"]);
    expect(imported.boreholes[0]).toEqual(p.boreholes[0]);
    expect(imported.corePhotos).toEqual(p.corePhotos);
  });

  it("rejects missing photo sources in both project files and unfinished drafts",()=>{
    const p=project();delete p.evidence;
    expect(()=>load(p)).toThrow(/source|photo|evidence/i);
    const tables=tablesFromProject(project());delete tables.evidence;
    expect(()=>parseWorkspace(wire(createWorkspace(tables)))).toThrow(/draft.tables.corePhotos/);
    const bad=wire(checkpoint(createWorkspace(tablesFromProject(project()),project()),project(),"Core draft"));
    bad.revisions[0].project.corePhotos.runs[0].sourceId="missing";
    expect(()=>parseWorkspace(bad)).toThrow(/revisions\[0\].project.corePhotos/);
  });

  it("rejects unsupported geometry in all saved scopes without silently dropping the registration",()=>{
    const p=project();p.corePhotos!.runs[0].rows[0].box.x1=2;
    expect(()=>load(p)).toThrow(/core|box|coordinate/i);
    const doc=createWorkspace(tablesFromProject(project()),project()),bad=wire(doc);
    bad.draft.base.corePhotos.runs[0].rows[0].pieces[0].end=-1;
    expect(()=>parseWorkspace(bad)).toThrow(/draft.base.corePhotos/);
    const unsafe=wire(doc);unsafe.draft.tables.corePhotos.runs[0].url="https://example.com/remote-photo";
    expect(()=>parseWorkspace(unsafe)).toThrow(/draft.tables.corePhotos/);
  });

  it("makes a new immutable checkpoint when only core annotations change",()=>{
    const p=project(),doc=checkpoint(createWorkspace(tablesFromProject(p),p),p,"Initial registration");
    const edited=structuredClone(p);edited.corePhotos!.runs[0].rows[0].pieces[0].description="A revised observation";
    const next=checkpoint(doc,edited,"Corrected observation");
    expect(next.revisions).toHaveLength(2);
    expect(next.revisions[0].project.corePhotos).toEqual(p.corePhotos);
    expect(next.revisions[1].project.corePhotos).toEqual(edited.corePhotos);
    expect(Object.isFrozen(next.revisions[0].project.corePhotos!.runs[0].rows)).toBe(true);
    expect(parseWorkspace(wire(next))).toEqual(next);
  });

  it("reads pre-photo archives without inventing core data",()=>{
    const p=project();delete p.corePhotos;delete p.evidence;
    expect(load(p).corePhotos).toBeUndefined();
    expect(projectFromTables(tablesFromProject(p),p).project.corePhotos).toBeUndefined();
    const doc=createWorkspace(emptyTables());
    expect(parseWorkspace(wire(doc))).toEqual(doc);
    expect(parseWorkspace(wire(doc)).draft.tables.corePhotos).toBeUndefined();
  });
});
