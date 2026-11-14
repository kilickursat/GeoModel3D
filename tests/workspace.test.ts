import {describe,it,expect} from "vitest";
import {GeoProject} from "../src/schema";
import {sampleProjects} from "../src/geology";
import {buildGeologicalModel} from "../src/model";
import {emptyTables,tablesFromProject} from "../src/tables";
import {importFiles,toProjectJson} from "../src/io";
import {checkpoint,createWorkspace,parseWorkspace,restoreRevision,toWorkspaceJson,updateDraft} from "../src/workspace";

function site():GeoProject{
  return {
    name:"Complete case",description:"A saved interpretation",source:"Local records",crs:"Site grid",base:-20,groundwaterDepth:2,margin:10,
    units:[{id:"clay",name:"Clay",color:"#887766",gamma:18,gammaSat:20,params:{su:35,custom:7},source:"Tests"},
      {id:"rock",name:"Rock",color:"#446688",erosive:true}],
    rules:[{match:"clay",unit:"clay"},{match:"rock",unit:"rock"}],
    boreholes:[{id:"BH1",x:0,y:0,z:10,depth:12,intervals:[{from:0,to:5,unit:"clay",name:"Clay"},{from:5,to:12,unit:"rock",name:"Rock"}],
      water:[{depth:2,date:"2026-10-01"}],spt:[{depth:3,blows:12,penetration:300}],tests:[{depth:3,to:3.2,property:"su",value:35}]}],
    terrain:{x0:0,y0:0,dx:10,dy:10,ncols:2,nrows:2,z:[10,11,NaN,10],source:"Survey"},
    alignments:[{name:"Tunnel",source:"Design",start:100,points:[{x:0,y:0},{x:10,y:10}],design:[{chainage:100,top:5,bottom:1},{chainage:114,top:4,bottom:0}]}],
    cpts:[{id:"CPT1",x:5,y:5,z:10,depth:[1,2,3],qc:[2,NaN,4],fs:[20,30,NaN],u2:[NaN,5,10],rf:[1,NaN,NaN],qt:[2.1,NaN,4.2],a:0.8,predrill:0.5,date:"2026-10-02",layers:[{from:1,to:3,unit:"clay",name:"Clay"}]}],
    cptLayers:true,cptRules:[{match:"clay",unit:"clay",minN:0,maxN:20}]
  };
}

describe("workspace drafts and checkpoints",()=>{
  it("roundtrips all project attachments, history, and an unfinished draft without changing legacy exports",()=>{
    const p=site(),legacy=toProjectJson(p),tables=tablesFromProject(p);
    let doc=checkpoint(createWorkspace(tables,p),p,"First build");
    tables.rows.logs[0][2]="still editing";
    doc=updateDraft(doc,tables,p);
    const serialized=toWorkspaceJson(doc),loaded=parseWorkspace(JSON.parse(serialized));
    expect(loaded).toEqual(doc);
    expect(loaded.draft.tables.rows.logs[0][2]).toBe("still editing");
    expect(loaded.draft.base).toEqual(p);
    expect(Number.isNaN(loaded.revisions[0].project.cpts![0].qc[1])).toBe(true);
    expect(Number.isNaN(loaded.draft.base!.terrain!.z[2])).toBe(true);
    expect(serialized).not.toContain("NaN");
    expect(toProjectJson(p)).toBe(legacy);
    expect(JSON.parse(legacy).format).toBe("geomodel3d-project");
    expect(importFiles([{name:"legacy.json",text:legacy}]).project.cpts![0].qc[1]).toBeNaN();
  });

  it("detaches editable data while sharing deeply immutable history",()=>{
    const p=site(),tables=tablesFromProject(p),start=createWorkspace(tables,p);
    p.cpts![0].qc[0]=99;tables.rows.logs[0][2]="99";
    expect(start.draft.base!.cpts![0].qc[0]).toBe(2);
    expect(start.draft.tables.rows.logs[0][2]).toBe("5");
    const built=checkpoint(start,start.draft.base!,"Build");
    built.draft.base!.cpts![0].qc[0]=77;
    expect(built.revisions[0].project.cpts![0].qc[0]).toBe(2);
    const updated=updateDraft(built,built.draft.tables,built.draft.base);
    expect(updated.revisions).toBe(built.revisions);
    expect(()=>{updated.revisions[0].project.terrain!.z[0]=123}).toThrow(TypeError);
    expect(()=>{updated.revisions[0].reason="overwritten"}).toThrow(TypeError);
    expect(()=>updated.revisions.pop()).toThrow(TypeError);
    expect(built.revisions[0].project.terrain!.z[0]).toBe(10);
    const parsed=parseWorkspace(built);
    expect(()=>{parsed.revisions[0].project.cpts![0].qc[0]=99}).toThrow(TypeError);
    parsed.draft.tables.rows.logs[0][1]="changed";
    expect(built.draft.tables.rows.logs[0][1]).toBe("0");
  });

  it("restores a full snapshot and forks the next checkpoint without changing later history",()=>{
    const p=site();let doc=checkpoint(createWorkspace(tablesFromProject(p),p),p,"Original");
    const first=doc.activeRevisionId!;
    const changed=structuredClone(p);changed.boreholes[0].z=11;
    doc=checkpoint(doc,changed,"Higher collar");const second=doc.activeRevisionId!;
    const restored=restoreRevision(doc,first);
    expect(restored.draft.base).toEqual(p);
    expect(restored.draft.tables.rows.boreholes[0][5]).toBe("10");
    expect(restored.revisions).toBe(doc.revisions);
    restored.draft.base!.terrain!.z[0]=12;
    expect(restored.revisions[0].project.terrain!.z[0]).toBe(10);
    expect(doc.activeRevisionId).toBe(second);
    const alternative=structuredClone(p);alternative.groundwaterDepth=3;
    const branch=checkpoint(restored,alternative,"Alternative water level");
    expect(branch.revisions).toHaveLength(3);
    expect(branch.revisions[2].parentId).toBe(first);
    expect(branch.revisions[1].parentId).toBe(first);
    expect(branch.revisions[1].project.boreholes[0].z).toBe(11);
    expect(parseWorkspace(JSON.parse(toWorkspaceJson(branch)))).toEqual(branch);
    expect(()=>restoreRevision(doc,"missing")).toThrow(/not in this workspace/);
  });

  it("deduplicates only the active snapshot, including NaNs and differing object-key order",()=>{
    const p=site(),first=checkpoint(createWorkspace(tablesFromProject(p)),p,"First");
    const reordered={...p,units:p.units.map(u=>({...u,params:u.params?{custom:7,su:35}:undefined}))};
    const same=checkpoint(first,reordered,"No content change");
    expect(same.revisions).toHaveLength(1);expect(same.activeRevisionId).toBe(first.activeRevisionId);
    const changed={...p,name:"Another interpretation"};
    const next=checkpoint(first,changed,"Renamed"),back=checkpoint(next,p,"Back to original");
    expect(back.revisions).toHaveLength(3);expect(back.revisions[2].parentId).toBe(next.activeRevisionId);
  });

  it("accepts an empty draft before any model can be built",()=>{
    const doc=createWorkspace(emptyTables());
    expect(parseWorkspace(JSON.parse(toWorkspaceJson(doc)))).toEqual(doc);
    expect(updateDraft(doc,emptyTables()).draft.base).toBeUndefined();
  });

  it("keeps accepted project warnings and original interpretations instead of repairing them on reopen",()=>{
    const p=site();
    p.boreholes[0].intervals[1].from=4; // An overlap for the engineer to review, not a malformed file.
    p.units[0].gamma=9; // Implausible unit weight is also an existing importer warning.
    p.cpts![0].z=NaN; // A CPT may have no surveyed start level yet.
    const doc=checkpoint(createWorkspace(tablesFromProject(p),p),p,"Needs review");
    expect(parseWorkspace(JSON.parse(toWorkspaceJson(doc)))).toEqual(doc);
  });

  it("roundtrips patterns that the existing rule interpreter treats as literal text",()=>{
    const p=site();p.rules![0].match="[";p.cptRules![0].match="a(";
    const doc=checkpoint(createWorkspace(tablesFromProject(p),p),p,"Literal rules");
    expect(parseWorkspace(JSON.parse(toWorkspaceJson(doc)))).toEqual(doc);
  });

  it("detaches untrusted mutable history and never reuses stale serialization for it",()=>{
    const built=checkpoint(createWorkspace(tablesFromProject(site())),site(),"Build");
    const mutable=structuredClone(built),first=toWorkspaceJson(mutable);
    mutable.revisions[0].project.name="Changed by caller";
    expect(toWorkspaceJson(mutable)).not.toBe(first);
    const updated=updateDraft(mutable,mutable.draft.tables,mutable.draft.base);
    expect(Object.isFrozen(mutable.revisions)).toBe(false);
    mutable.revisions[0].project.name="Changed again";
    expect(updated.revisions[0].project.name).toBe("Changed by caller");
    const changed=updateDraft(built,emptyTables());
    expect(parseWorkspace(JSON.parse(toWorkspaceJson(changed)))).toEqual(changed);
  });
});

describe("workspace validation",()=>{
  const document=()=>JSON.parse(toWorkspaceJson(checkpoint(createWorkspace(tablesFromProject(site()),site()),site(),"Build")));
  it.each([
    ["format",(d:any)=>{d.format="geomodel3d-project"}],
    ["version",(d:any)=>{d.version=99}],
    ["id",(d:any)=>{d.id=""}],
    ["savedAt",(d:any)=>{d.savedAt="yesterday"}],
    ["activeRevisionId",(d:any)=>{d.activeRevisionId="missing"}],
    ["activeRevisionId",(d:any)=>{delete d.activeRevisionId}],
    ["duplicate",(d:any)=>{d.revisions.push(structuredClone(d.revisions[0]))}],
    ["unknown parent",(d:any)=>{d.revisions[0].parentId="missing"}],
    ["cycle",(d:any)=>{d.revisions[0].parentId=d.revisions[0].id}],
    ["cells",(d:any)=>{d.draft.tables.rows.logs[0].pop()}],
    ["string",(d:any)=>{d.draft.tables.rows.logs[0][1]=3}],
    ["finite",(d:any)=>{d.revisions[0].project.boreholes[0].x=null}],
    ["duplicate",(d:any)=>{d.revisions[0].project.boreholes.push(structuredClone(d.revisions[0].project.boreholes[0]))}],
    ["depths",(d:any)=>{d.revisions[0].project.boreholes[0].intervals[0].to=-1}],
    ["value for each depth",(d:any)=>{d.revisions[0].project.cpts[0].qc.pop()}],
    ["finite",(d:any)=>{d.revisions[0].project.cpts[0].qc[0]="bad"}],
    ["increase",(d:any)=>{d.revisions[0].project.cpts[0].depth=[1,1,3]}],
    ["grid dimensions",(d:any)=>{d.revisions[0].project.terrain.ncols=3}],
    ["two points",(d:any)=>{d.revisions[0].project.alignments[0].points.pop()}]
  ])("rejects malformed %s without repairing it",(message,edit)=>{
    const d=document();(edit as (d:any)=>void)(d);expect(()=>parseWorkspace(d)).toThrow(message as string);
  });

  it("rejects multi-node cycles even if every referenced ID exists",()=>{
    const d=document(),r=structuredClone(d.revisions[0]);r.id="second";r.parentId=d.revisions[0].id;
    d.revisions[0].parentId=r.id;d.revisions.push(r);
    expect(()=>parseWorkspace(d)).toThrow(/cycle/);
  });
});

// Public reference sites exercise real importer metadata, CPT gaps, erosion and terrain rather than only a toy schema.
describe("bundled project compatibility",()=>{
  for(const project of sampleProjects)it(`preserves the model of ${project.name}`,()=>{
    const doc=checkpoint(createWorkspace(tablesFromProject(project),project),project,"Reference site");
    const restored=parseWorkspace(JSON.parse(toWorkspaceJson(doc))).revisions[0].project;
    // Bundled JSON carries file-envelope fields and null gaps; compare its canonical project representation.
    expect(JSON.parse(toProjectJson(restored))).toEqual(JSON.parse(toProjectJson(project)));
    const before=buildGeologicalModel(project),after=buildGeologicalModel(restored);
    expect(after.horizons).toEqual(before.horizons);
    expect(after.water).toEqual(before.water);
    expect(after.warnings).toEqual(before.warnings);
  });
});
