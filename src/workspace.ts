// A saved editing draft and immutable build checkpoints. Projects remain compatible with the existing project
// JSON format; workspace files add history without changing that format or making the model depend on the editor.
import pkg from "../package.json";
import {GeoProject} from "./schema";
import {COLUMNS,EditorTables,emptyTables,tablesFromProject} from "./tables";
import {importFiles,toProjectJson} from "./io";
import {alignmentProblem} from "./alignment";
import {parseGroundwater} from "./groundwater";
import {EvidenceCollection,validateEvidence,EVIDENCE_MAX_IMAGE_BYTES,EVIDENCE_MAX_PAGE_IMAGE_BYTES} from "./evidence";

export interface WorkspaceRevision {
  id:string; parentId?:string; createdAt:string; reason:string; engineVersion:string; project:GeoProject; scenarioId?:string;
}
export interface WorkspaceDraft { tables:EditorTables;base?:GeoProject }
export interface WorkspaceScenario {
  id:string; name:string; createdAt:string; parentScenarioId?:string; fromRevisionId?:string; headRevisionId?:string;
  // Only inactive scenarios store a draft here. The active one lives in WorkspaceDocument.draft.
  draft?:WorkspaceDraft;
}
export interface WorkspaceDocument {
  format:"geomodel3d-workspace"; version:3; id:string; savedAt:string;
  draft:WorkspaceDraft; revisions:WorkspaceRevision[]; activeRevisionId?:string;
  scenarios:WorkspaceScenario[]; activeScenarioId:string;
}

const clone=<T>(value:T):T=>structuredClone(value);
// Only history created or validated here is shared. A caller-supplied mutable history is detached before freezing.
// Walking the same large terrain/CPT arrays on every keystroke would make typing depend on the history's length.
const frozen=new WeakSet<object>();
function freeze<T>(value:T):T{
  if(value&&typeof value==="object"&&!frozen.has(value)){
    for(const child of Object.values(value))freeze(child);
    Object.freeze(value);frozen.add(value);
  }
  return value;
}
const history=(revisions:WorkspaceRevision[])=>frozen.has(revisions)?revisions:freeze(clone(revisions));
const scenarioHistory=(scenarios:WorkspaceScenario[])=>frozen.has(scenarios)?scenarios:freeze(clone(scenarios));
const now=()=>new Date().toISOString();
// randomUUID requires a secure context in some browsers; the standalone file can still make local identifiers.
const identifier=()=>globalThis.crypto?.randomUUID?.()??`local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

export function createWorkspace(tables:EditorTables,base?:GeoProject):WorkspaceDocument{
  const id=identifier(),at=now(),baseline=id+":baseline";
  return {format:"geomodel3d-workspace",version:3,id,savedAt:at,
    draft:{tables:clone(tables),...(base?{base:clone(base)}:{})},revisions:freeze([]),
    scenarios:freeze([{id:baseline,name:"Baseline",createdAt:at}]),activeScenarioId:baseline};
}

export function updateDraft(doc:WorkspaceDocument,tables:EditorTables,base?:GeoProject):WorkspaceDocument{
  return {...doc,version:3,savedAt:now(),revisions:history(doc.revisions),scenarios:scenarioHistory(doc.scenarios),
    draft:{tables:clone(tables),...(base?{base:clone(base)}:{})}};
}
function setActiveHead(doc:WorkspaceDocument,id:string|undefined){
  if(id===undefined)delete doc.activeRevisionId;else doc.activeRevisionId=id;
  doc.scenarios=freeze(doc.scenarios.map(s=>{
    if(s.id!==doc.activeScenarioId)return s;
    const next={...s};delete next.draft;
    if(id===undefined)delete next.headRevisionId;else next.headRevisionId=id;
    return next;
  }));
}
function scenarioName(name:string,scenarios:WorkspaceScenario[],except?:string):string{
  if(typeof name!=="string")throw new Error("A scenario name must be text.");
  const value=name.trim();
  if(!value||value.length>100)throw new Error("A scenario name must contain 1 to 100 characters.");
  if(scenarios.some(s=>s.id!==except&&s.name.toLowerCase()===value.toLowerCase()))throw new Error("A scenario with that name already exists.");
  return value;
}
export function createScenario(doc:WorkspaceDocument,name:string,fromRevisionId?:string):WorkspaceDocument{
  const next=updateDraft(doc,doc.draft.tables,doc.draft.base),label=scenarioName(name,next.scenarios);
  const revision=fromRevisionId===undefined?undefined:next.revisions.find(r=>r.id===fromRevisionId);
  if(fromRevisionId!==undefined&&!revision)throw new Error("That checkpoint is not in this workspace.");
  let id=identifier();while(next.scenarios.some(s=>s.id===id))id=identifier();
  const draft=revision?{tables:tablesFromProject(revision.project),base:clone(revision.project)}:clone(next.draft);
  const head=revision?.id??next.activeRevisionId;
  const scenario:WorkspaceScenario={id,name:label,createdAt:now(),parentScenarioId:next.activeScenarioId,
    ...(head?{fromRevisionId:head,headRevisionId:head}:{})};
  next.scenarios=freeze([...next.scenarios.map(s=>s.id===next.activeScenarioId?{...s,draft:freeze(next.draft)}:s),scenario]);
  next.activeScenarioId=id;next.draft=draft;
  if(head===undefined)delete next.activeRevisionId;else next.activeRevisionId=head;
  return next;
}
export function switchScenario(doc:WorkspaceDocument,id:string):WorkspaceDocument{
  const next=updateDraft(doc,doc.draft.tables,doc.draft.base),target=next.scenarios.find(s=>s.id===id);
  if(!target)throw new Error("That scenario is not in this workspace.");
  if(id===next.activeScenarioId)return next;
  if(!target.draft)throw new Error("That inactive scenario has no saved draft.");
  const draft=clone(target.draft);
  next.scenarios=freeze(next.scenarios.map(s=>{
    if(s.id===next.activeScenarioId)return {...s,draft:freeze(next.draft)};
    if(s.id===id){const active={...s};delete active.draft;return active}
    return s;
  }));
  next.activeScenarioId=id;next.draft=draft;
  if(target.headRevisionId===undefined)delete next.activeRevisionId;else next.activeRevisionId=target.headRevisionId;
  return next;
}
export function renameScenario(doc:WorkspaceDocument,id:string,name:string):WorkspaceDocument{
  if(!doc.scenarios.some(s=>s.id===id))throw new Error("That scenario is not in this workspace.");
  const next=updateDraft(doc,doc.draft.tables,doc.draft.base),label=scenarioName(name,next.scenarios,id);
  next.scenarios=freeze(next.scenarios.map(s=>s.id===id?{...s,name:label}:s));
  return next;
}

// Compare project content, not object insertion order. JSON's null representation is intentional for missing CPT
// readings and terrain cells. Array order (including the stratigraphic column) remains significant.
function ordered(value:unknown):unknown{
  if(Array.isArray(value))return value.map(ordered);
  if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered((value as Record<string,unknown>)[k])]));
  return value;
}
const fingerprint=(p:GeoProject)=>JSON.stringify(ordered(JSON.parse(toProjectJson(p))));

export function checkpoint(doc:WorkspaceDocument,project:GeoProject,reason:string):WorkspaceDocument{
  const next=updateDraft(doc,doc.draft.tables,project),active=next.revisions.find(r=>r.id===next.activeRevisionId);
  if(active&&fingerprint(active.project)===fingerprint(project))return next;
  let id=identifier();
  while(next.revisions.some(r=>r.id===id))id=identifier();
  next.revisions=freeze([...next.revisions,{id,...(active?{parentId:active.id}:{}),createdAt:now(),reason,
    engineVersion:pkg.version,project:clone(project),scenarioId:next.activeScenarioId}]);
  setActiveHead(next,id);
  return next;
}

export function restoreRevision(doc:WorkspaceDocument,id:string):WorkspaceDocument{
  const revision=doc.revisions.find(r=>r.id===id);
  if(!revision)throw new Error("That checkpoint is not in this workspace.");
  const next=updateDraft(doc,tablesFromProject(revision.project),revision.project);
  setActiveHead(next,id);
  return next;
}

type RecordValue=Record<string,unknown>;
function invalid(path:string,why:string):never{throw new Error(`Invalid workspace: ${path} ${why}.`)}
function record(v:unknown,path:string):RecordValue{
  if(!v||typeof v!=="object"||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))invalid(path,"must be an object");
  return v as RecordValue;
}
function list(v:unknown,path:string):unknown[]{if(!Array.isArray(v))invalid(path,"must be an array");return v}
function text(v:unknown,path:string,nonempty=false):string{
  if(typeof v!=="string"||(nonempty&&!v.trim()))invalid(path,nonempty?"must be a nonempty string":"must be a string");
  return v;
}
function number(v:unknown,path:string,missing=false):number{
  if(missing&&(v===null||typeof v==="number"&&Number.isNaN(v)))return NaN;
  if(typeof v!=="number"||!Number.isFinite(v))invalid(path,"must be a finite number");
  return v;
}
function date(v:unknown,path:string):string{
  const s=text(v,path,true);
  if(!Number.isFinite(Date.parse(s))||new Date(s).toISOString()!==s)invalid(path,"must be an ISO timestamp");
  return s;
}
function optionalStrings(o:RecordValue,keys:string[],path:string){for(const k of keys)if(o[k]!==undefined)text(o[k],`${path}.${k}`)}
function optionalNumbers(o:RecordValue,keys:string[],path:string){for(const k of keys)if(o[k]!==undefined)number(o[k],`${path}.${k}`)}
function optionalBoolean(o:RecordValue,key:string,path:string){if(o[key]!==undefined&&typeof o[key]!=="boolean")invalid(`${path}.${key}`,"must be a boolean")}
function records(v:unknown,path:string){return list(v,path).map((x,i)=>record(x,`${path}[${i}]`))}
function unique(items:RecordValue[],key:string,path:string){
  const seen=new Set<string>();
  items.forEach((o,i)=>{const id=text(o[key],`${path}[${i}].${key}`,true);if(seen.has(id))invalid(path,`has duplicate ${key} ${id}`);seen.add(id)});
}

type ImageResolver=(value:unknown,path:string)=>unknown;
// Transform only evidence source-page image slots. A raw description that happens to contain an image-reference
// string is data, and must never be interpreted or changed by the workspace format.
function mapEvidenceImages(value:unknown,image:ImageResolver,path:string):unknown{
  if(!value||typeof value!=="object"||Array.isArray(value))return value;
  const collection=value as RecordValue;
  if(!Array.isArray(collection.sources))return value;
  return {...collection,sources:collection.sources.map((source,i)=>{
    if(!source||typeof source!=="object"||Array.isArray(source))return source;
    const s=source as RecordValue;
    if(!Array.isArray(s.pages))return source;
    return {...s,pages:s.pages.map((page,j)=>{
      if(!page||typeof page!=="object"||Array.isArray(page))return page;
      const p=page as RecordValue;
      return p.image===undefined?page:{...p,image:image(p.image,`${path}.sources[${i}].pages[${j}].image`)};
    })};
  })};
}
function evidenceCollection(value:unknown,path:string,image:ImageResolver):EvidenceCollection{
  try{return validateEvidence(mapEvidenceImages(value,image,path))}catch(error){invalid(path,(error as Error).message)}
}
const IMAGE_REFERENCE="workspace-image:",PNG_PREFIX="data:image/png;base64,";
function imageByteSize(value:string):number{
  const payload=value.slice(PNG_PREFIX.length);
  return payload.length/4*3-(payload.endsWith("==")?2:payload.endsWith("=")?1:0);
}
function workspaceImageResolver(d:RecordValue):ImageResolver{
  if(d.version===1&&d.evidenceImages!==undefined)invalid("evidenceImages","is not supported by workspace version 1");
  const pool=d.evidenceImages===undefined?{}:record(d.evidenceImages,"evidenceImages");
  const seen=new Set<string>();let bytes=0;
  const account=(value:unknown,path:string)=>{
    if(typeof value!=="string"||!value.startsWith(PNG_PREFIX))invalid(path,"must contain a PNG data URL");
    const size=imageByteSize(value);
    if(size>EVIDENCE_MAX_PAGE_IMAGE_BYTES)invalid(path,"exceeds the 2 MiB page image limit");
    if(!seen.has(value)){seen.add(value);bytes+=size}
    if(bytes>EVIDENCE_MAX_IMAGE_BYTES)invalid("evidenceImages","exceeds the 32 MiB unique image limit");
    return value;
  };
  for(const [id,value] of Object.entries(pool)){
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||["__proto__","constructor","prototype"].includes(id))invalid("evidenceImages","contains an invalid image ID");
    account(value,`evidenceImages.${id}`);
  }
  // Validate unused pool values too: arbitrary payloads must not hide in an otherwise valid workspace. Split into
  // source-sized groups so the established per-source page limit does not become a smaller workspace pool limit.
  const images=[...seen],sources=[];
  for(let i=0;i<images.length;i+=2000)sources.push({id:`pool-${i}`,name:"Workspace images",pages:images.slice(i,i+2000).map((image,j)=>({page:j+1,width:1,height:1,image}))});
  if(images.length)try{validateEvidence({version:1,sources,records:[]})}catch(error){invalid("evidenceImages",(error as Error).message)}
  return (value,path)=>{
    if(typeof value==="string"&&value.startsWith(IMAGE_REFERENCE)){
      if(d.version===1)invalid(path,"contains an image reference unsupported by workspace version 1");
      const id=value.slice(IMAGE_REFERENCE.length);
      if(!Object.hasOwn(pool,id))invalid(path,"does not name a pooled workspace image");
      return pool[id];
    }
    // Direct typed documents can contain expanded images; old version-1 saves also used that representation.
    return account(value,path);
  };
}
function evidenceReference(value:unknown,ids:ReadonlySet<string>,path:string){
  if(value===undefined)return;
  const id=text(value,`${path}.evidenceId`,true);
  if(!ids.has(id))invalid(`${path}.evidenceId`,"does not name an evidence record in this project");
}

function parseTables(value:unknown,image:ImageResolver,path="draft.tables"):EditorTables{
  const t=record(value,path),p=record(t.project,`${path}.project`),rows=record(t.rows,`${path}.rows`);
  for(const key of Object.keys(emptyTables().project))text(p[key],`${path}.project.${key}`);
  for(const [name,columns] of Object.entries(COLUMNS)){
    list(rows[name],`${path}.rows.${name}`).forEach((row,i)=>{
      const cells=list(row,`${path}.rows.${name}[${i}]`);
      if(cells.length!==columns.length)invalid(`${path}.rows.${name}[${i}]`,`must have ${columns.length} cells`);
      cells.forEach((cell,j)=>text(cell,`${path}.rows.${name}[${i}][${j}]`));
    });
  }
  if(t.groundwaterDraft!==undefined){
    const policy=record(t.groundwaterDraft,`${path}.groundwaterDraft`);
    if(policy.mode!=="observed"&&policy.mode!=="assumed-depth"&&policy.mode!=="as-of")invalid(`${path}.groundwaterDraft.mode`,"must be observed, assumed-depth or as-of");
    text(policy.depth,`${path}.groundwaterDraft.depth`);text(policy.date,`${path}.groundwaterDraft.date`);
    if(typeof policy.includeUndated!=="boolean")invalid(`${path}.groundwaterDraft.includeUndated`,"must be a boolean");
  }
  const parsed=clone(t) as unknown as EditorTables;
  if(t.evidence!==undefined)parsed.evidence=evidenceCollection(t.evidence,`${path}.evidence`,image);
  const ids=new Set(parsed.evidence?.records.map(r=>r.id)??[]);
  if(t.evidenceRows!==undefined){
    const bindings=record(t.evidenceRows,`${path}.evidenceRows`);
    for(const [name,value] of Object.entries(bindings)){
      if(!Object.hasOwn(COLUMNS,name))invalid(`${path}.evidenceRows.${name}`,"is not an input table");
      const refs=list(value,`${path}.evidenceRows.${name}`);
      if(refs.length!==(rows[name] as unknown[]).length)invalid(`${path}.evidenceRows.${name}`,"must have one binding for each row");
      refs.forEach((ref,i)=>{
        if(ref===null)return;
        const id=text(ref,`${path}.evidenceRows.${name}[${i}]`,true);
        if(!ids.has(id))invalid(`${path}.evidenceRows.${name}[${i}]`,"does not name an evidence record in these tables");
      });
    }
  }
  return parsed;
}

function intervals(value:unknown,path:string,allowUnassigned=false,evidenceIds:ReadonlySet<string>=new Set()){
  for(const [i,row] of records(value,path).entries()){
    const at=`${path}[${i}]`,from=number(row.from,`${at}.from`),to=number(row.to,`${at}.to`);
    if(from<0||to<=from)invalid(at,"has inverted or negative depths");
    text(row.unit,`${at}.unit`,!allowUnassigned);optionalStrings(row,["name"],at);
    evidenceReference(row.evidenceId,evidenceIds,at);
  }
}
function rules(value:unknown,path:string){
  for(const [i,r] of records(value,path).entries()){
    const at=`${path}[${i}]`;text(r.match,`${at}.match`);text(r.unit,`${at}.unit`,true);
    optionalNumbers(r,["minN","maxN","minZ","maxZ"],at);
    // rulePattern in rules.ts deliberately treats invalid regular expressions as literal text.
  }
}

// A workspace is a lossless checkpoint, not an opportunity to repair or silently omit bad records. Validate before
// invoking the ordinary importer, which intentionally accepts much looser standalone project files.
function parseProject(value:unknown,path:string,image:ImageResolver):GeoProject{
  const p=clone(record(value,path));
  if(p.format!==undefined&&p.format!=="geomodel3d-project")invalid(`${path}.format`,"must be geomodel3d-project");
  if(p.version!==undefined&&p.version!==1)invalid(`${path}.version`,"is not supported");
  delete p.format;delete p.version;
  text(p.name,`${path}.name`,true);optionalStrings(p,["description","source","crs","crsCode","crsProj4"],path);
  optionalNumbers(p,["base","groundwaterDepth","margin"],path);optionalBoolean(p,"cptLayers",path);
  if(p.groundwater!==undefined)try{p.groundwater=parseGroundwater(p.groundwater)}catch(error){invalid(`${path}.groundwater`,(error as Error).message)}
  if(p.evidence!==undefined)p.evidence=evidenceCollection(p.evidence,`${path}.evidence`,image);
  const evidenceIds=new Set((p.evidence as EvidenceCollection|undefined)?.records.map(r=>r.id)??[]);
  const units=records(p.units,`${path}.units`),holes=records(p.boreholes,`${path}.boreholes`);
  unique(units,"id",`${path}.units`);unique(holes,"id",`${path}.boreholes`);
  for(const [i,u] of units.entries()){
    const at=`${path}.units[${i}]`;text(u.name,`${at}.name`);text(u.color,`${at}.color`);
    optionalStrings(u,["source"],at);optionalNumbers(u,["gamma","gammaSat"],at);optionalBoolean(u,"erosive",at);
    if(u.params!==undefined)for(const [key,v] of Object.entries(record(u.params,`${at}.params`)))number(v,`${at}.params.${key}`);
  }
  for(const [i,b] of holes.entries()){
    const at=`${path}.boreholes[${i}]`;
    for(const k of ["x","y","z"])number(b[k],`${at}.${k}`);
    optionalNumbers(b,["depth","lon","lat"],at);evidenceReference(b.evidenceId,evidenceIds,at);
    intervals(b.intervals,`${at}.intervals`,false,evidenceIds);
    if(!(b.intervals as unknown[]).length)invalid(`${at}.intervals`,"must contain a log");
    for(const [key,required,optional] of [["spt",["depth","blows","penetration"],[]],["water",["depth"],[]],["tests",["depth","value"],["to"]]] as const){
      if(b[key]===undefined)continue;
      for(const [j,r] of records(b[key],`${at}.${key}`).entries()){
        const loc=`${at}.${key}[${j}]`;
        for(const k of required)number(r[k],`${loc}.${k}`);
        optionalNumbers(r,[...optional],loc);
        if(key==="water"){optionalStrings(r,["date"],loc);evidenceReference(r.evidenceId,evidenceIds,loc)}
        if(key==="tests")text(r.property,`${loc}.property`,true);
      }
    }
  }
  for(const key of ["rules","cptRules"])if(p[key]!==undefined)rules(p[key],`${path}.${key}`);
  if(p.alignments!==undefined){
    const lines=records(p.alignments,`${path}.alignments`);unique(lines,"name",`${path}.alignments`);
    for(const [i,a] of lines.entries()){
      const at=`${path}.alignments[${i}]`;optionalStrings(a,["source"],at);optionalNumbers(a,["start"],at);
      for(const q of records(a.points,`${at}.points`)){number(q.x,`${at}.points.x`);number(q.y,`${at}.points.y`);optionalNumbers(q,["chainage"],at)}
      if(a.design!==undefined)for(const q of records(a.design,`${at}.design`)){number(q.chainage,`${at}.design.chainage`);number(q.top,`${at}.design.top`);optionalNumbers(q,["bottom"],at)}
      const problem=alignmentProblem(a as unknown as NonNullable<GeoProject["alignments"]>[number]);
      if(problem)invalid(at,problem);
    }
  }
  if(p.cpts!==undefined){
    const cpts=records(p.cpts,`${path}.cpts`);unique(cpts,"id",`${path}.cpts`);
    for(const [i,c] of cpts.entries()){
      const at=`${path}.cpts[${i}]`;
      number(c.x,`${at}.x`);number(c.y,`${at}.y`);c.z=number(c.z,`${at}.z`,true);
      optionalNumbers(c,["lon","lat","a","predrill"],at);optionalStrings(c,["date"],at);
      if(c.layersSource!==undefined&&c.layersSource!=="automatic"&&c.layersSource!=="reviewed")invalid(`${at}.layersSource`,"must be automatic or reviewed");
      const depth=list(c.depth,`${at}.depth`).map((d,j)=>number(d,`${at}.depth[${j}]`));
      if(!depth.length||depth.some((d,j)=>d<0||j>0&&d<=depth[j-1]))invalid(`${at}.depth`,"must increase from a nonnegative depth");
      for(const key of ["qc","fs","u2","rf","qt"]){
        if(key!=="qc"&&c[key]===undefined)continue;
        const values=list(c[key],`${at}.${key}`);
        if(values.length!==depth.length)invalid(`${at}.${key}`,"must have one value for each depth");
        c[key]=values.map((v,j)=>number(v,`${at}.${key}[${j}]`,true));
      }
      if(c.layers!==undefined)intervals(c.layers,`${at}.layers`,true,evidenceIds);
    }
  }
  if(p.terrain!==undefined){
    const g=record(p.terrain,`${path}.terrain`),at=`${path}.terrain`;
    for(const k of ["x0","y0","dx","dy","ncols","nrows"])number(g[k],`${at}.${k}`);
    if((g.dx as number)<=0||(g.dy as number)<=0||![g.ncols,g.nrows].every(n=>Number.isSafeInteger(n)&&(n as number)>0))invalid(at,"has invalid grid dimensions");
    const z=list(g.z,`${at}.z`);
    if(z.length!==(g.ncols as number)*(g.nrows as number))invalid(`${at}.z`,"does not match its grid dimensions");
    g.z=z.map((v,i)=>number(v,`${at}.z[${i}]`,true));optionalStrings(g,["source"],at);
  }
  const project=p as unknown as GeoProject;
  // Let the established parser check project compatibility. Its normalisations (e.g. reapplying interpretation
  // rules or dropping a redundant final depth) must not rewrite the original saved checkpoint.
  const parsed=importFiles([{name:"checkpoint.geomodel3d.json",text:toProjectJson(project)}]).project;
  if(parsed.boreholes.length!==holes.length||(parsed.cpts?.length??0)!==(project.cpts?.length??0)||(parsed.alignments?.length??0)!==(project.alignments?.length??0))invalid(path,"contains records the project importer cannot read");
  return project;
}

function parseDraft(value:unknown,image:ImageResolver,path:string):WorkspaceDraft{
  const draft=record(value,path);
  return {tables:parseTables(draft.tables,image,`${path}.tables`),...(draft.base===undefined?{}:{base:parseProject(draft.base,`${path}.base`,image)})};
}
export function parseWorkspace(value:unknown):WorkspaceDocument{
  const d=record(value,"document");
  if(d.format!=="geomodel3d-workspace")invalid("format","must be geomodel3d-workspace");
  if(d.version!==1&&d.version!==2&&d.version!==3)invalid("version","is not supported");
  const legacy=d.version!==3;
  if(legacy&&(Object.hasOwn(d,"scenarios")||Object.hasOwn(d,"activeScenarioId")))invalid("version","cannot declare a legacy format while containing scenario metadata");
  const image=workspaceImageResolver(d),id=text(d.id,"id",true),savedAt=date(d.savedAt,"savedAt"),baseline=id+":baseline";
  const revisions=records(d.revisions,"revisions").map((r,i):WorkspaceRevision=>{
    const at=`revisions[${i}]`;
    return {id:text(r.id,`${at}.id`,true),...(r.parentId===undefined?{}:{parentId:text(r.parentId,`${at}.parentId`,true)}),
      createdAt:date(r.createdAt,`${at}.createdAt`),reason:text(r.reason,`${at}.reason`),engineVersion:text(r.engineVersion,`${at}.engineVersion`,true),
      project:parseProject(r.project,`${at}.project`,image),
      ...(legacy?{scenarioId:baseline}:r.scenarioId===undefined?{}:{scenarioId:text(r.scenarioId,`${at}.scenarioId`,true)})};
  });
  const byId=new Map(revisions.map(r=>[r.id,r]));
  if(byId.size!==revisions.length)invalid("revisions","contains duplicate IDs");
  for(const r of revisions)if(r.parentId!==undefined&&!byId.has(r.parentId))invalid(`revision ${r.id}`,"has an unknown parent");
  // Iterative traversal avoids recursion limits for long, valid histories.
  const complete=new Set<string>();
  for(const revision of revisions){
    const visiting=new Set<string>();let r:WorkspaceRevision|undefined=revision;
    while(r&&!complete.has(r.id)){
      if(visiting.has(r.id))invalid("revisions","contains a cycle");
      visiting.add(r.id);r=r.parentId?byId.get(r.parentId):undefined;
    }
    for(const id of visiting)complete.add(id);
  }
  const active=d.activeRevisionId===undefined?undefined:text(d.activeRevisionId,"activeRevisionId",true);
  if(active!==undefined&&!byId.has(active))invalid("activeRevisionId","does not name a checkpoint");
  if(legacy&&revisions.length&&active===undefined)invalid("activeRevisionId","is required when checkpoints exist");
  const draft=parseDraft(d.draft,image,"draft");
  let scenarios:WorkspaceScenario[],activeScenarioId:string;
  if(legacy){
    activeScenarioId=baseline;
    scenarios=[{id:baseline,name:"Baseline",createdAt:revisions[0]?.createdAt??savedAt,...(active?{headRevisionId:active}:{})}];
  }else{
    const names=new Set<string>();
    activeScenarioId=text(d.activeScenarioId,"activeScenarioId",true);
    const inputs=records(d.scenarios,"scenarios"),scenarioIds=inputs.map((s,i)=>text(s.id,`scenarios[${i}].id`,true));
    if(new Set(scenarioIds).size!==scenarioIds.length)invalid("scenarios","contains duplicate IDs");
    if(!scenarioIds.includes(activeScenarioId))invalid("activeScenarioId","does not name a scenario");
    scenarios=inputs.map((s,i):WorkspaceScenario=>{
      const at=`scenarios[${i}]`,scenarioId=text(s.id,`${at}.id`,true),name=text(s.name,`${at}.name`,true).trim();
      if(!name||name.length>100)invalid(`${at}.name`,"must contain 1 to 100 characters");
      if(names.has(name.toLowerCase()))invalid(`${at}.name`,"duplicates another scenario name");names.add(name.toLowerCase());
      const head=s.headRevisionId===undefined?undefined:text(s.headRevisionId,`${at}.headRevisionId`,true);
      if(head!==undefined&&!byId.has(head))invalid(`${at}.headRevisionId`,"does not name a checkpoint");
      const from=s.fromRevisionId===undefined?undefined:text(s.fromRevisionId,`${at}.fromRevisionId`,true);
      if(from!==undefined&&!byId.has(from))invalid(`${at}.fromRevisionId`,"does not name a checkpoint");
      const isActive=scenarioId===activeScenarioId;
      if(isActive&&Object.hasOwn(s,"draft"))invalid(`${at}.draft`,"must be omitted for the active scenario");
      if(!isActive&&s.draft===undefined)invalid(`${at}.draft`,"is required for an inactive scenario");
      return {id:scenarioId,name,createdAt:date(s.createdAt,`${at}.createdAt`),
        ...(s.parentScenarioId===undefined?{}:{parentScenarioId:text(s.parentScenarioId,`${at}.parentScenarioId`,true)}),
        ...(from===undefined?{}:{fromRevisionId:from}),...(head===undefined?{}:{headRevisionId:head}),
        ...(isActive?{}:{draft:freeze(parseDraft(s.draft,image,`${at}.draft`))})};
    });
    const byScenario=new Map(scenarios.map(s=>[s.id,s]));
    if(byScenario.size!==scenarios.length)invalid("scenarios","contains duplicate IDs");
    const selected=byScenario.get(activeScenarioId);
    if(!selected)invalid("activeScenarioId","does not name a scenario");
    if(selected.headRevisionId!==active)invalid("activeRevisionId","does not match the active scenario head");
    for(const scenario of scenarios)if(scenario.parentScenarioId!==undefined&&!byScenario.has(scenario.parentScenarioId))invalid(`scenario ${scenario.id}`,"has an unknown parent");
    const completeScenarios=new Set<string>();
    for(const scenario of scenarios){
      const visiting=new Set<string>();let s:WorkspaceScenario|undefined=scenario;
      while(s&&!completeScenarios.has(s.id)){
        if(visiting.has(s.id))invalid("scenarios","contains a cycle");
        visiting.add(s.id);s=s.parentScenarioId?byScenario.get(s.parentScenarioId):undefined;
      }
      for(const id of visiting)completeScenarios.add(id);
    }
    for(const revision of revisions)if(revision.scenarioId!==undefined&&!byScenario.has(revision.scenarioId))invalid(`revision ${revision.id}.scenarioId`,"does not name a scenario");
  }
  return {format:"geomodel3d-workspace",version:3,id,savedAt,draft,revisions:freeze(revisions),
    scenarios:freeze(scenarios),activeScenarioId,...(active===undefined?{}:{activeRevisionId:active})};
}

// Content IDs are deterministic pool keys, not security fingerprints. A detected collision rejects the save
// instead of aliasing two different images. Source-document SHA-256 digests remain separate evidence metadata.
function imageId(image:string):string{
  let a=0x811c9dc5,b=0x9e3779b9;
  for(let i=0;i<image.length;i++){
    const c=image.charCodeAt(i);a=Math.imul(a^c,0x01000193);b=Math.imul(b^c,0x85ebca6b);
  }
  return `png-${image.length.toString(36)}-${(a>>>0).toString(16)}-${(b>>>0).toString(16)}`;
}
interface PackedImages {
  values:Map<string,string>;
  add(image:unknown,path:string):string;
  include(id:string,image:string):void;
}
function packedImages():PackedImages{
  const values=new Map<string,string>(),byImage=new Map<string,string>();let bytes=0;
  const include=(id:string,image:string)=>{
    const existing=values.get(id);
    if(existing!==undefined){if(existing!==image)throw new Error("Workspace image ID collision; the workspace was not saved.");return}
    if(!image.startsWith(PNG_PREFIX))throw new Error("A workspace page preview must be a PNG data URL.");
    const size=imageByteSize(image);
    if(size>EVIDENCE_MAX_PAGE_IMAGE_BYTES)throw new Error("A workspace page preview exceeds the 2 MiB image limit.");
    if(!byImage.has(image))bytes+=size;
    if(bytes>EVIDENCE_MAX_IMAGE_BYTES)throw new Error("Workspace page previews exceed the 32 MiB unique image limit.");
    values.set(id,image);byImage.set(image,id);
  };
  return {values,include,add(image,path){
    if(typeof image!=="string")throw new Error(`Workspace ${path} must be a PNG data URL.`);
    const known=byImage.get(image);if(known!==undefined)return IMAGE_REFERENCE+known;
    const id=imageId(image);include(id,image);return IMAGE_REFERENCE+id;
  }};
}
function packedProject(p:GeoProject,pool:PackedImages):unknown{
  return JSON.parse(toProjectJson(p.evidence?{...p,evidence:mapEvidenceImages(p.evidence,pool.add,"project.evidence") as EvidenceCollection}:p));
}
function packedDraft(draft:WorkspaceDraft,pool:PackedImages,path:string):unknown{
  const tables=draft.tables.evidence?{...draft.tables,evidence:mapEvidenceImages(draft.tables.evidence,pool.add,`${path}.tables.evidence`)}:draft.tables;
  return {tables,...(draft.base?{base:packedProject(draft.base,pool)}:{})};
}
interface PackedSnapshot { json:string;images:Map<string,string> }
const revisionJson=new WeakMap<WorkspaceRevision,PackedSnapshot>(),scenarioJson=new WeakMap<WorkspaceScenario,PackedSnapshot>();
export function toWorkspaceJson(doc:WorkspaceDocument):string{
  // Page PNGs are pooled once across active/inactive drafts and immutable revisions. Cached immutable JSON keeps
  // large CPT/terrain histories out of the autosave hot path even after an engineer adds more scenarios.
  const pool=packedImages();
  const metadata={format:doc.format,version:3,id:doc.id,savedAt:doc.savedAt,activeScenarioId:doc.activeScenarioId,
    ...(doc.activeRevisionId===undefined?{}:{activeRevisionId:doc.activeRevisionId})};
  const draft=packedDraft(doc.draft,pool,"draft");
  const revisions=doc.revisions.map(r=>{
    let packed=revisionJson.get(r);
    if(packed===undefined){
      const images=packedImages();
      packed={json:JSON.stringify({...r,project:packedProject(r.project,images)},null,1),images:images.values};
      if(frozen.has(r))revisionJson.set(r,packed);
    }
    for(const [id,image] of packed.images)pool.include(id,image);
    return packed.json;
  });
  const scenarios=doc.scenarios.map(s=>{
    let packed=scenarioJson.get(s);
    if(packed===undefined){
      const images=packedImages();
      packed={json:JSON.stringify({...s,...(s.draft?{draft:packedDraft(s.draft,images,`scenario ${s.id}.draft`)}:{})},null,1),images:images.values};
      if(frozen.has(s))scenarioJson.set(s,packed);
    }
    for(const [id,image] of packed.images)pool.include(id,image);
    return packed.json;
  });
  return `${JSON.stringify(metadata,null,1).slice(0,-2)},\n "evidenceImages": ${JSON.stringify(Object.fromEntries(pool.values))},\n "draft": ${JSON.stringify(draft,null,1)},\n "revisions": [${revisions.length?`\n${revisions.join(",\n")}\n`:""}],\n "scenarios": [${scenarios.length?`\n${scenarios.join(",\n")}\n`:""}]\n}\n`;
}
