import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {GeoProject} from "../src/schema";
import {tablesFromProject} from "../src/tables";
import {checkpoint,createWorkspace,expandWorkspaceParts,parseWorkspace,toWorkspaceJson,updateDraft} from "../src/workspace";
import type {WorkspaceDocument} from "../src/workspace";

// A project with every pooled slot: boreholes, CPTs, an alignment, a terrain grid and a borehole with water.
function site():GeoProject{
  return {
    name:"Pooled case",units:[{id:"clay",name:"Clay",color:"#887766"},{id:"rock",name:"Rock",color:"#446688"}],
    rules:[{match:"clay",unit:"clay"}],
    boreholes:[0,1,2].map(i=>({id:`BH${i}`,x:i*20,y:i*7,z:10+i,depth:12,water:[{depth:2}],
      intervals:[{from:0,to:4+i,unit:"clay"},{from:4+i,to:12,unit:"rock"}]})),
    cpts:[{id:"CPT1",x:5,y:5,z:10,depth:Array.from({length:400},(_,i)=>0.02*(i+1)),qc:Array.from({length:400},(_,i)=>i%7?1+i/100:NaN),
      fs:Array.from({length:400},(_,i)=>10+i/50)}],
    terrain:{x0:-10,y0:-10,dx:5,dy:5,ncols:20,nrows:20,z:Array.from({length:400},(_,i)=>10+Math.sin(i))},
    alignments:[{name:"Tunnel",points:[{x:0,y:0},{x:40,y:14}],design:[{chainage:0,top:5,bottom:1},{chainage:42,top:4,bottom:0}]}]
  };
}
// Successive builds, each moving one collar slightly, as an editing session does.
function history(builds:number,base=site()):WorkspaceDocument{
  let doc=createWorkspace(tablesFromProject(base),base);
  for(let i=1;i<=builds;i++){const p=structuredClone(base);p.boreholes[i%3].z+=0.01*i;doc=checkpoint(doc,p,"Build")}
  return doc;
}

describe("workspace project parts (format 4)",()=>{
  it("keeps a saved history proportional to the changes, not to the number of builds",()=>{
    const one=toWorkspaceJson(history(1)).length,forty=toWorkspaceJson(history(40)).length;
    const project=JSON.stringify(site()).length;
    // Forty builds that each move one collar add far less than one project's worth of content per build.
    expect(forty-one).toBeLessThan(project*4);
    expect(forty).toBeLessThan(one*6);
  });

  it("shares unchanged parts between consecutive revisions in memory and copies only what changed",()=>{
    const doc=history(2),[first,second]=doc.revisions.map(r=>r.project);
    expect(second.cpts![0]).toBe(first.cpts![0]);
    expect(second.terrain).toBe(first.terrain);
    expect(second.alignments![0]).toBe(first.alignments![0]);
    expect(second.boreholes[0]).toBe(first.boreholes[0]);
    // Each build starts from the site again and moves one collar: build 1 moved BH1, build 2 moves BH2.
    expect(second.boreholes[1]).not.toBe(first.boreholes[1]);
    expect(second.boreholes[2]).not.toBe(first.boreholes[2]);
    expect(second.boreholes[2].z).toBeCloseTo(first.boreholes[2].z+0.02,9);
    expect(Object.isFrozen(second.cpts![0])).toBe(true);
  });

  it("stores each distinct part once and restores complete, shared, frozen projects",()=>{
    const doc=history(5),json=toWorkspaceJson(doc),wire=JSON.parse(json);
    expect(wire.version).toBe(4);
    expect(json.split('"CPT1"')).toHaveLength(2);
    for(const r of wire.revisions)for(const ref of r.project.boreholes)expect(ref).toMatch(/^workspace-part:part-/);
    const loaded=parseWorkspace(JSON.parse(json));
    expect(loaded).toEqual(doc);
    const projects=loaded.revisions.map(r=>r.project);
    for(const p of projects.slice(1)){expect(p.cpts![0]).toBe(projects[0].cpts![0]);expect(p.terrain).toBe(projects[0].terrain)}
    expect(Number.isNaN(projects[0].cpts![0].qc[0])).toBe(true);
    expect(Object.isFrozen(projects[3].terrain)).toBe(true);
    // The editable draft is never one of the shared, frozen revision objects.
    expect(Object.isFrozen(loaded.draft.base!.cpts![0])).toBe(false);
  });

  it("does not share a part whose content differs only in a missing value",()=>{
    const base=site(),changed=structuredClone(base);changed.cpts![0].qc[1]=NaN;
    const doc=checkpoint(checkpoint(createWorkspace(tablesFromProject(base),base),base,"First"),changed,"Second");
    const [a,b]=doc.revisions.map(r=>r.project);
    expect(b.cpts![0]).not.toBe(a.cpts![0]);
    expect(parseWorkspace(JSON.parse(toWorkspaceJson(doc)))).toEqual(doc);
  });

  it("rejects missing, unused and unsupported part references",()=>{
    const json=toWorkspaceJson(history(2));
    const missing=JSON.parse(json);missing.revisions[0].project.boreholes[0]="workspace-part:part-missing";
    expect(()=>parseWorkspace(missing)).toThrow(/does not name a workspace project part/);
    const unused=JSON.parse(json);unused.projectParts["part-extra"]={id:"hidden"};
    expect(()=>parseWorkspace(unused)).toThrow(/is not used by any project/);
    const unsafe=JSON.parse(JSON.stringify(JSON.parse(json)).replace('"projectParts":{','"projectParts":{"__proto__":{},'));
    expect(()=>parseWorkspace(unsafe)).toThrow(/invalid part ID/);
    const notObject=JSON.parse(json),[id]=Object.keys(notObject.projectParts);notObject.projectParts[id]="text";
    expect(()=>parseWorkspace(notObject)).toThrow(/must be an object/);
    const older=expandWorkspaceParts<Record<string,unknown>>(JSON.parse(json));older.version=3;
    expect(()=>parseWorkspace({...older,projectParts:{}})).toThrow(/not supported by workspace version 3/);
    const reference=JSON.parse(json),legacy:Record<string,any>={...expandWorkspaceParts(reference),version:3};
    legacy.revisions[0].project.terrain=reference.revisions[0].project.terrain;
    expect(()=>parseWorkspace(legacy)).toThrow(/part reference unsupported/);
  });

  it("expands part references into a valid file with complete projects, and still reads format 3",()=>{
    const doc=history(3),json=toWorkspaceJson(doc);
    const expanded=expandWorkspaceParts<Record<string,any>>(JSON.parse(json));
    expect(expanded.projectParts).toBeUndefined();
    expect(expanded.revisions[2].project.cpts[0].id).toBe("CPT1");
    expect(expanded.draft.base.terrain.ncols).toBe(20);
    expect(parseWorkspace(expanded)).toEqual(doc);
    expect(parseWorkspace({...expanded,version:3})).toEqual(doc);
  });

  it("keeps concurrent workspace caches independent when their histories grow",()=>{
    const first=history(3),firstJson=toWorkspaceJson(first),other=site();
    other.name="Another workspace";other.cpts![0].qc[1]=42;other.terrain!.z[0]=99;
    const second=history(2,other),secondJson=toWorkspaceJson(second);
    const changed=structuredClone(first.revisions.at(-1)!.project);changed.boreholes[0].z+=1;
    const next=checkpoint(first,changed,"New collar");
    expect(parseWorkspace(JSON.parse(toWorkspaceJson(next)))).toEqual(next);
    // Serializing another workspace or a new history must not invalidate cached snapshots or leak its parts.
    expect(toWorkspaceJson(first)).toBe(firstJson);expect(toWorkspaceJson(second)).toBe(secondJson);
    expect(parseWorkspace(JSON.parse(firstJson))).toEqual(first);
    expect(parseWorkspace(JSON.parse(secondJson))).toEqual(second);
    expect(next.revisions.at(-1)!.project.cpts![0]).toBe(first.revisions.at(-1)!.project.cpts![0]);
  });

  it("keeps autosaves after a long history fast and small on a sample site",()=>{
    const base=JSON.parse(readFileSync("src/data/rotterdam-site.json","utf8")) as GeoProject;
    let doc=history(30,base);
    const before=performance.now();
    for(let i=0;i<5;i++)doc=updateDraft(doc,doc.draft.tables,doc.draft.base);
    const json=toWorkspaceJson(doc),elapsed=performance.now()-before,project=JSON.stringify(base).length;
    expect(json.length).toBeLessThan(project*3);
    // Generous bound for slow CI machines; before format 4 this history serialized to ~40 MB.
    expect(elapsed).toBeLessThan(10000);
  },60000);
});
