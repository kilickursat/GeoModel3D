// One complete workspace per browser origin. IndexedDB commits the replacement atomically: a failed save leaves
// the previous document intact. Storage failures reach the caller, which can keep editing and offer an export.
import {COLUMNS,emptyTables,TableName} from "./tables";
import {WorkspaceDocument,createWorkspace,parseWorkspace,toWorkspaceJson} from "./workspace";

export interface WorkspaceStore {
  load():Promise<WorkspaceDocument|null>;
  save(document:WorkspaceDocument):Promise<void>;
}

// A serialized-document backend, also usable by tests without a browser or an IndexedDB polyfill. A write must
// replace its old value atomically and reject on failure; it must not clear the old value before writing.
export interface WorkspaceBackend {
  read():Promise<string|null>;
  write(json:string):Promise<void>;
}
export interface WorkspaceStoreOptions {
  backend?:WorkspaceBackend;
  // null disables legacy migration. The browser storage is accessed only after no workspace was found.
  legacyStorage?:Pick<Storage,"getItem">|null;
}

export const LEGACY_WORKSPACE_KEY="geomodel3d.input.v1";
const DATABASE="geomodel3d-workspace",STORE="documents",KEY="current";

function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==="object"&&!Array.isArray(value)}
function legacyCell(value:unknown):string{
  if(value===undefined||value===null)return "";
  if(typeof value==="string"||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value))return String(value);
  throw new Error("The saved legacy draft contains a cell that cannot be recovered as text.");
}

// Older drafts may predate columns or project fields. Pad those with current defaults, without interpreting or
// discarding unfinished cell text. Invalid structures reject instead of quietly replacing a recoverable draft.
export function migrateLegacyWorkspace(value:unknown):WorkspaceDocument{
  if(!record(value)||!record(value.tables)||!record(value.tables.project)||!record(value.tables.rows))
    throw new Error("The saved legacy draft is not a valid set of input tables.");
  const tables=emptyTables(),project=value.tables.project,rows=value.tables.rows;
  for(const key of Object.keys(tables.project) as Array<keyof typeof tables.project>)
    if(project[key]!==undefined)tables.project[key]=legacyCell(project[key]);
  for(const name of Object.keys(COLUMNS) as TableName[]){
    const source=rows[name]??[];
    if(!Array.isArray(source))throw new Error(`The saved legacy ${name} table is not a list of rows.`);
    tables.rows[name]=source.map(row=>{
      if(!Array.isArray(row))throw new Error(`The saved legacy ${name} table contains an invalid row.`);
      if(row.length>COLUMNS[name].length&&row.slice(COLUMNS[name].length).some(cell=>legacyCell(cell)!==""))
        throw new Error(`The saved legacy ${name} table contains extra columns; export it before migrating.`);
      return COLUMNS[name].map((_,column)=>legacyCell(row[column]));
    });
  }
  const document=createWorkspace(tables);
  if(typeof value.savedAt==="string"&&Number.isFinite(Date.parse(value.savedAt)))
    document.savedAt=new Date(value.savedAt).toISOString();
  return document;
}

export function createIndexedDbBackend(factory?:IDBFactory):WorkspaceBackend{
  function open():Promise<IDBDatabase>{
    return new Promise((resolve,reject)=>{
      // Access can itself throw when browser storage is blocked. Promise converts that to a rejection.
      const indexed=factory??globalThis.indexedDB;
      if(!indexed)throw new Error("IndexedDB is unavailable. Keep this page open and export your workspace to save it.");
      const request=indexed.open(DATABASE,1);
      let failed=false;
      const fail=(error:unknown)=>{failed=true;reject(error)};
      request.onupgradeneeded=()=>{
        if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);
      };
      request.onerror=()=>fail(request.error??new Error("The workspace database could not be opened."));
      request.onblocked=()=>fail(new Error("The workspace database is blocked by another open tab. Close that tab and retry."));
      request.onsuccess=()=>{
        const db=request.result;
        if(failed){db.close();return}
        db.onversionchange=()=>db.close();
        resolve(db);
      };
    });
  }
  async function transact(json?:string):Promise<string|null>{
    const db=await open();
    return new Promise((resolve,reject)=>{
      let transaction:IDBTransaction|undefined,result:string|null=null;
      const fail=(error:unknown)=>{db.close();reject(error)};
      try{
        transaction=db.transaction(STORE,json===undefined?"readonly":"readwrite");
        // A successful put request is not yet a committed save: quota/disk errors can still abort the transaction.
        transaction.oncomplete=()=>{db.close();resolve(result)};
        transaction.onabort=()=>fail(transaction!.error??new Error("The workspace transaction was aborted; the previous save is unchanged."));
        transaction.onerror=()=>fail(transaction!.error??new Error("The workspace transaction failed; the previous save is unchanged."));
        const store=transaction.objectStore(STORE);
        if(json===undefined){
          const request=store.get(KEY);
          request.onsuccess=()=>{
            if(request.result!==undefined&&typeof request.result!=="string"){
              transaction!.abort();fail(new Error("The saved workspace has an invalid storage format."));return;
            }
            result=request.result??null;
          };
        }else store.put(json,KEY);
      }catch(error){
        try{transaction?.abort()}catch{/* Already complete/aborted; the original error is the useful one. */}
        fail(error);
      }
    });
  }
  return {read:()=>transact(),write:async json=>{await transact(json)}};
}

export function createWorkspaceStore(options:WorkspaceStoreOptions={}):WorkspaceStore{
  const backend=options.backend??createIndexedDbBackend();
  // Order autosaves and initial migration. Failed operations do not poison subsequent retries, and their original
  // promises still reject. Each save captures a snapshot immediately, before later edits can mutate the document.
  let pending:Promise<unknown>=Promise.resolve();
  const enqueue=<T>(action:()=>Promise<T>):Promise<T>=>{
    const operation=pending.then(action);
    pending=operation.then(()=>undefined,()=>undefined);
    return operation;
  };
  return {
    load:()=>enqueue(async()=>{
      const json=await backend.read();
      if(json!==null)return parseWorkspace(JSON.parse(json));
      const legacy=options.legacyStorage===undefined?globalThis.localStorage:options.legacyStorage;
      const old=legacy?.getItem(LEGACY_WORKSPACE_KEY);
      if(old===undefined||old===null)return null;
      const document=migrateLegacyWorkspace(JSON.parse(old));
      await backend.write(toWorkspaceJson(document));
      // Keep the legacy copy as a recovery source. It is never consulted once an IndexedDB document exists.
      return document;
    }),
    save:async document=>{
      const json=toWorkspaceJson(document);
      await enqueue(()=>backend.write(json));
    }
  };
}
