// A saved editing draft and immutable build checkpoints. Projects remain compatible with the existing project
// JSON format; workspace files add history without changing that format or making the model depend on the editor.
import pkg from "../package.json";
import {GeoProject} from "./schema";
import {COLUMNS,EditorTables,emptyTables,tablesFromProject} from "./tables";
import {importFiles,toProjectJson} from "./io";
import {alignmentProblem} from "./alignment";

export interface WorkspaceRevision {
  id:string; parentId?:string; createdAt:string; reason:string; engineVersion:string; project:GeoProject;
}
export interface WorkspaceDocument {
  format:"geomodel3d-workspace"; version:1; id:string; savedAt:string;
  draft:{tables:EditorTables;base?:GeoProject}; revisions:WorkspaceRevision[]; activeRevisionId?:string;
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
const now=()=>new Date().toISOString();
// randomUUID requires a secure context in some browsers; the standalone file can still make local identifiers.
const identifier=()=>globalThis.crypto?.randomUUID?.()??`local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

export function createWorkspace(tables:EditorTables,base?:GeoProject):WorkspaceDocument{
  return {format:"geomodel3d-workspace",version:1,id:identifier(),savedAt:now(),
    draft:{tables:clone(tables),...(base?{base:clone(base)}:{})},revisions:freeze([])};
}

export function updateDraft(doc:WorkspaceDocument,tables:EditorTables,base?:GeoProject):WorkspaceDocument{
  return {...doc,savedAt:now(),revisions:history(doc.revisions),draft:{tables:clone(tables),...(base?{base:clone(base)}:{})}};
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
    engineVersion:pkg.version,project:clone(project)}]);
  next.activeRevisionId=id;
  return next;
}

export function restoreRevision(doc:WorkspaceDocument,id:string):WorkspaceDocument{
  const revision=doc.revisions.find(r=>r.id===id);
  if(!revision)throw new Error("That checkpoint is not in this workspace.");
  const next=updateDraft(doc,tablesFromProject(revision.project),revision.project);
  next.activeRevisionId=id;
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

function parseTables(value:unknown):EditorTables{
  const t=record(value,"draft.tables"),p=record(t.project,"draft.tables.project"),rows=record(t.rows,"draft.tables.rows");
  for(const key of Object.keys(emptyTables().project))text(p[key],`draft.tables.project.${key}`);
  for(const [name,columns] of Object.entries(COLUMNS)){
    list(rows[name],`draft.tables.rows.${name}`).forEach((row,i)=>{
      const cells=list(row,`draft.tables.rows.${name}[${i}]`);
      if(cells.length!==columns.length)invalid(`draft.tables.rows.${name}[${i}]`,`must have ${columns.length} cells`);
      cells.forEach((cell,j)=>text(cell,`draft.tables.rows.${name}[${i}][${j}]`));
    });
  }
  return clone(t) as unknown as EditorTables;
}

function intervals(value:unknown,path:string,allowUnassigned=false){
  for(const [i,row] of records(value,path).entries()){
    const at=`${path}[${i}]`,from=number(row.from,`${at}.from`),to=number(row.to,`${at}.to`);
    if(from<0||to<=from)invalid(at,"has inverted or negative depths");
    text(row.unit,`${at}.unit`,!allowUnassigned);optionalStrings(row,["name"],at);
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
function parseProject(value:unknown,path:string):GeoProject{
  const p=clone(record(value,path));
  if(p.format!==undefined&&p.format!=="geomodel3d-project")invalid(`${path}.format`,"must be geomodel3d-project");
  if(p.version!==undefined&&p.version!==1)invalid(`${path}.version`,"is not supported");
  delete p.format;delete p.version;
  text(p.name,`${path}.name`,true);optionalStrings(p,["description","source","crs","crsCode","crsProj4"],path);
  optionalNumbers(p,["base","groundwaterDepth","margin"],path);optionalBoolean(p,"cptLayers",path);
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
    optionalNumbers(b,["depth","lon","lat"],at);intervals(b.intervals,`${at}.intervals`);
    if(!(b.intervals as unknown[]).length)invalid(`${at}.intervals`,"must contain a log");
    for(const [key,required,optional] of [["spt",["depth","blows","penetration"],[]],["water",["depth"],[]],["tests",["depth","value"],["to"]]] as const){
      if(b[key]===undefined)continue;
      for(const [j,r] of records(b[key],`${at}.${key}`).entries()){
        const loc=`${at}.${key}[${j}]`;
        for(const k of required)number(r[k],`${loc}.${k}`);
        optionalNumbers(r,[...optional],loc);
        if(key==="water")optionalStrings(r,["date"],loc);
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
      const depth=list(c.depth,`${at}.depth`).map((d,j)=>number(d,`${at}.depth[${j}]`));
      if(!depth.length||depth.some((d,j)=>d<0||j>0&&d<=depth[j-1]))invalid(`${at}.depth`,"must increase from a nonnegative depth");
      for(const key of ["qc","fs","u2","rf","qt"]){
        if(key!=="qc"&&c[key]===undefined)continue;
        const values=list(c[key],`${at}.${key}`);
        if(values.length!==depth.length)invalid(`${at}.${key}`,"must have one value for each depth");
        c[key]=values.map((v,j)=>number(v,`${at}.${key}[${j}]`,true));
      }
      if(c.layers!==undefined)intervals(c.layers,`${at}.layers`,true);
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

export function parseWorkspace(value:unknown):WorkspaceDocument{
  const d=record(value,"document");
  if(d.format!=="geomodel3d-workspace")invalid("format","must be geomodel3d-workspace");
  if(d.version!==1)invalid("version","is not supported");
  const id=text(d.id,"id",true),savedAt=date(d.savedAt,"savedAt"),draft=record(d.draft,"draft");
  const revisions=records(d.revisions,"revisions").map((r,i):WorkspaceRevision=>{
    const at=`revisions[${i}]`;
    return {id:text(r.id,`${at}.id`,true),...(r.parentId===undefined?{}:{parentId:text(r.parentId,`${at}.parentId`,true)}),
      createdAt:date(r.createdAt,`${at}.createdAt`),reason:text(r.reason,`${at}.reason`),engineVersion:text(r.engineVersion,`${at}.engineVersion`,true),
      project:parseProject(r.project,`${at}.project`)};
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
  if(revisions.length&&active===undefined)invalid("activeRevisionId","is required when checkpoints exist");
  return {format:"geomodel3d-workspace",version:1,id,savedAt,
    draft:{tables:parseTables(draft.tables),...(draft.base===undefined?{}:{base:parseProject(draft.base,"draft.base")})},revisions:freeze(revisions),
    ...(active===undefined?{}:{activeRevisionId:active})};
}

const revisionJson=new WeakMap<WorkspaceRevision,string>();
export function toWorkspaceJson(doc:WorkspaceDocument):string{
  // Autosave serialises an already typed document. Validation/import preprocessing belongs at the read boundary,
  // rather than reinterpreting every historical project on each keystroke.
  const project=(p:GeoProject)=>JSON.parse(toProjectJson(p));
  const metadata={format:doc.format,version:doc.version,id:doc.id,savedAt:doc.savedAt,
    ...(doc.activeRevisionId===undefined?{}:{activeRevisionId:doc.activeRevisionId})};
  const draft={tables:doc.draft.tables,...(doc.draft.base?{base:project(doc.draft.base)}:{})};
  const revisions=doc.revisions.map(r=>{
    const cached=revisionJson.get(r);
    if(cached!==undefined)return cached;
    const json=JSON.stringify({...r,project:project(r.project)},null,1);
    if(frozen.has(r))revisionJson.set(r,json);
    return json;
  });
  // Concatenate already-encoded immutable revisions rather than traversing the whole history on each autosave.
  return `${JSON.stringify(metadata,null,1).slice(0,-2)},\n "draft": ${JSON.stringify(draft,null,1)},\n "revisions": [${revisions.length?`\n${revisions.join(",\n")}\n`:""}]\n}\n`;
}
