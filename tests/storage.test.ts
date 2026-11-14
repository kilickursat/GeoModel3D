import {describe,it,expect,vi} from "vitest";
import {createIndexedDbBackend,createWorkspaceStore,LEGACY_WORKSPACE_KEY,migrateLegacyWorkspace,WorkspaceBackend} from "../src/storage";
import {createWorkspace,toWorkspaceJson} from "../src/workspace";
import {emptyTables,tablesFromProject} from "../src/tables";
import {GeoProject} from "../src/schema";

const base:GeoProject={name:"Site",units:[{id:"clay",name:"Clay",color:"#999999"}],
  boreholes:[{id:"A",x:0,y:0,z:10,intervals:[{from:0,to:5,unit:"clay"}]}],
  terrain:{x0:0,y0:0,dx:10,dy:10,ncols:2,nrows:2,z:[10,10,10,10]},
  alignments:[{name:"Tunnel",points:[{x:0,y:0},{x:10,y:10}]}],
  cpts:[{id:"C",x:2,y:2,z:10,depth:[1,2],qc:[2,3]}],
  rules:[{match:"clay",unit:"clay"}],cptRules:[{match:"clay",unit:"clay"}],cptLayers:true};

function memory(initial:string|null=null){
  let stored=initial;
  const backend:WorkspaceBackend={read:async()=>stored,write:async value=>{stored=value}};
  return {backend,value:()=>stored};
}
const legacy=(value:unknown)=>({getItem:(key:string)=>key===LEGACY_WORKSPACE_KEY?JSON.stringify(value):null});

describe("browser workspace persistence",()=>{
  it("round-trips incomplete draft text and the project's terrain, CPTs, rules and alignments",async()=>{
    const tables=tablesFromProject(base);
    tables.rows.logs[0][2]="still measuring";
    const document=createWorkspace(tables,base),saved=memory();
    const store=createWorkspaceStore({backend:saved.backend,legacyStorage:null});
    await store.save(document);
    const restored=await store.load();
    expect(restored).toEqual(document);
    expect(restored!.draft.base).toEqual(base);
    expect(restored!.draft.tables.rows.logs[0][2]).toBe("still measuring");
  });

  it("migrates older short rows, converts scalar values and supplies missing fields",async()=>{
    const old={tables:{project:{name:"Old site"},rows:{boreholes:[["A",12,null]],logs:[["A",0,"unfinished","Clay"]]}},savedAt:"2026-10-01T12:00:00Z"};
    const saved=memory(),source=legacy(old),store=createWorkspaceStore({backend:saved.backend,legacyStorage:source});
    const document=(await store.load())!;
    expect(document.savedAt).toBe("2026-10-01T12:00:00.000Z");
    expect(document.draft.tables.project).toEqual({...emptyTables().project,name:"Old site"});
    expect(document.draft.tables.rows.boreholes).toEqual([["A","12","","","","",""]]);
    expect(document.draft.tables.rows.logs).toEqual([["A","0","unfinished","Clay",""]]);
    expect(document.draft.tables.rows.tests).toEqual([]);
    expect(saved.value()).toBe(toWorkspaceJson(document));
    expect(source.getItem(LEGACY_WORKSPACE_KEY)).toBe(JSON.stringify(old));
    expect(await store.load()).toEqual(document);
  });

  it("prefers an existing workspace without accessing legacy storage",async()=>{
    const document=createWorkspace(emptyTables(),base),saved=memory(toWorkspaceJson(document));
    const store=createWorkspaceStore({backend:saved.backend,legacyStorage:{getItem:()=>{throw new Error("Legacy storage blocked")}}});
    expect(await store.load()).toEqual(document);
  });

  it("rejects failed migration, keeps the legacy draft, and allows retry",async()=>{
    const old={tables:emptyTables(),savedAt:"2026-10-01T00:00:00.000Z"},source=legacy(old),saved=memory();
    let full=true;
    const store=createWorkspaceStore({backend:{read:saved.backend.read,write:async value=>{
      if(full)throw new Error("Quota exceeded");
      await saved.backend.write(value);
    }},legacyStorage:source});
    await expect(store.load()).rejects.toThrow("Quota exceeded");
    expect(saved.value()).toBeNull();
    expect(source.getItem(LEGACY_WORKSPACE_KEY)).toBe(JSON.stringify(old));
    full=false;
    expect((await store.load())!.draft.tables).toEqual(old.tables);
  });

  it("reports corrupted current data instead of replacing it with an older draft",async()=>{
    const saved=memory("broken json"),store=createWorkspaceStore({backend:saved.backend,legacyStorage:legacy({tables:emptyTables()})});
    await expect(store.load()).rejects.toThrow();
    expect(saved.value()).toBe("broken json");
  });

  it("rejects invalid legacy rows and non-text objects without discarding them",()=>{
    expect(()=>migrateLegacyWorkspace({tables:{project:{},rows:{logs:[null]}}})).toThrow("invalid row");
    expect(()=>migrateLegacyWorkspace({tables:{project:{},rows:{water:[["A",{}]]}}})).toThrow("cannot be recovered as text");
    expect(()=>migrateLegacyWorkspace({tables:{project:{},rows:{water:[["A",1,"date","extra"]]}}})).toThrow("extra columns");
  });

  it("captures each save immediately, serializes writes, and recovers after a failed save",async()=>{
    const saved=memory(),writes:string[]=[],gates:Array<()=>void>=[];
    const store=createWorkspaceStore({legacyStorage:null,backend:{read:saved.backend.read,write:async value=>{
      writes.push(value);
      await new Promise<void>(resolve=>gates.push(resolve));
      if(JSON.parse(value).draft.tables.project.name==="fail")throw new Error("Disk full");
      await saved.backend.write(value);
    }}});
    const document=createWorkspace(emptyTables());
    document.draft.tables.project.name="first";
    const first=store.save(document);
    document.draft.tables.project.name="fail";
    const failed=store.save(document),failure=expect(failed).rejects.toThrow("Disk full");
    document.draft.tables.project.name="last";
    const last=store.save(document);
    document.draft.tables.project.name="later unsaved edit";
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    gates.shift()!();await first;await Promise.resolve();
    expect(JSON.parse(saved.value()!).draft.tables.project.name).toBe("first");
    gates.shift()!();await failure;await Promise.resolve();
    expect(JSON.parse(saved.value()!).draft.tables.project.name).toBe("first");
    gates.shift()!();await last;
    expect((await store.load())!.draft.tables.project.name).toBe("last");
    expect(writes.map(json=>JSON.parse(json).draft.tables.project.name)).toEqual(["first","fail","last"]);
  });

  it("returns null for an empty store and exposes read and legacy-access failures",async()=>{
    expect(await createWorkspaceStore({backend:memory().backend,legacyStorage:null}).load()).toBeNull();
    const broken={read:async()=>{throw new Error("Read denied")},write:async()=>{}};
    await expect(createWorkspaceStore({backend:broken,legacyStorage:null}).load()).rejects.toThrow("Read denied");
    await expect(createWorkspaceStore({backend:memory().backend,legacyStorage:{getItem:()=>{throw new Error("Storage denied")}}}).load()).rejects.toThrow("Storage denied");
  });
});

// A controlled transaction adapter: request success and transaction completion are independent events, as in IDB.
// The staged write becomes durable only on commit; an abort must leave the previous committed value untouched.
function controlledIndexedDb(initial:string){
  let stored=initial;
  type Control={requestSuccess():void;complete():void;abort(error:Error):void};
  const waiting:Array<(control:Control)=>void>=[],ready:Control[]=[];
  const factory={open:()=>{
    const opening={onsuccess:null as (()=>void)|null,result:{
      close:()=>{},onversionchange:null,
      transaction:()=>{
        let staged:string|undefined;
        const request={onsuccess:null as (()=>void)|null,result:stored};
        const transaction={oncomplete:null as (()=>void)|null,onabort:null as (()=>void)|null,onerror:null,error:null as Error|null,
          objectStore:()=>({get:()=>request,put:(value:string)=>{staged=value;return request}}),
          abort:()=>control.abort(new Error("Aborted"))};
        const control:Control={requestSuccess:()=>request.onsuccess?.(),complete:()=>{if(staged!==undefined)stored=staged;transaction.oncomplete?.()},
          abort:error=>{transaction.error=error;transaction.onabort?.()}};
        const notify=waiting.shift();if(notify)notify(control);else ready.push(control);
        return transaction;
      }
    }};
    queueMicrotask(()=>opening.onsuccess?.());
    return opening;
  }} as unknown as IDBFactory;
  return {factory,value:()=>stored,next:()=>new Promise<Control>(resolve=>{const control=ready.shift();if(control)resolve(control);else waiting.push(resolve)})};
}

describe("IndexedDB commit boundary",()=>{
  it("rejects unavailable or denied browser storage instead of claiming a save",async()=>{
    vi.stubGlobal("indexedDB",undefined);
    try{
      await expect(createIndexedDbBackend().read()).rejects.toThrow("IndexedDB is unavailable");
      await expect(createIndexedDbBackend().write("draft")).rejects.toThrow("IndexedDB is unavailable");
    }finally{vi.unstubAllGlobals()}
    const denied={open:()=>{throw new Error("Storage access denied")}} as unknown as IDBFactory;
    await expect(createIndexedDbBackend(denied).write("draft")).rejects.toThrow("Storage access denied");
  });

  it("does not resolve a save on request success and retains the previous document after a late abort",async()=>{
    const database=controlledIndexedDb("previous"),backend=createIndexedDbBackend(database.factory);
    let resolved=false;
    const save=backend.write("replacement").then(()=>{resolved=true}),failure=expect(save).rejects.toThrow("Quota exceeded");
    const transaction=await database.next();
    transaction.requestSuccess();await Promise.resolve();
    expect(resolved).toBe(false);expect(database.value()).toBe("previous");
    transaction.abort(new Error("Quota exceeded"));await failure;
    expect(database.value()).toBe("previous");
  });

  it("resolves writes and reads only after transaction completion",async()=>{
    const database=controlledIndexedDb("previous"),backend=createIndexedDbBackend(database.factory);
    const save=backend.write("replacement"),write=await database.next();
    write.requestSuccess();write.complete();await save;
    expect(database.value()).toBe("replacement");
    let resolved=false;
    const read=backend.read().then(value=>{resolved=true;return value}),transaction=await database.next();
    transaction.requestSuccess();await Promise.resolve();expect(resolved).toBe(false);
    transaction.complete();expect(await read).toBe("replacement");
  });
});
