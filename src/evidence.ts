// The evidence behind an imported value. Page snapshots stay on the device and travel with an exported project;
// the original PDF is not stored here. A correction never changes the original value or its source boxes.
export interface EvidenceBox { page:number; x0:number; y0:number; x1:number; y1:number; text:string }
export interface EvidencePage { page:number; width:number; height:number; image?:string }
export interface EvidenceSource { id:string; name:string; sha256?:string; size?:number; pages:EvidencePage[] }
export interface EvidenceEvent {
  at:string; action:"accepted"|"corrected"; value:string; previous?:string; reason?:string;
}
export interface EvidenceField {
  original:string; current:string; boxes:EvidenceBox[]; status:"unreviewed"|"accepted"|"corrected"; events:EvidenceEvent[];
  // An extraction warning or interpretation note, separate from the engineer's review events.
  note?:string;
}
export interface EvidenceRecord {
  id:string; sourceId:string; method:"pdf-text"|"ocr"|"manual"; fields:Record<string,EvidenceField>;
}
export interface EvidenceCollection { version:1; sources:EvidenceSource[]; records:EvidenceRecord[] }

// Bounds apply at the import boundary, before decoding images or copying large arrays.
export const EVIDENCE_MAX_PAGE_IMAGE_BYTES=2*1024*1024;
export const EVIDENCE_MAX_IMAGE_BYTES=32*1024*1024;
const MAX_TEXT=64*1024,MAX_TEXT_TOTAL=32*1024*1024,MAX_ITEMS=200_000;
const FORBIDDEN_KEYS=new Set(["__proto__","constructor","prototype"]);

export const newEvidenceId=()=>globalThis.crypto?.randomUUID?.()??`evidence-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
export function evidenceRecord(evidence:EvidenceCollection|undefined,id:string|undefined):EvidenceRecord|undefined{
  return id===undefined?undefined:evidence?.records.find(r=>r.id===id);
}

function fieldKey(key:string){
  if(!key.trim()||key.length>128||FORBIDDEN_KEYS.has(key))throw new Error("Invalid evidence field name.");
}
function eventTime(field:EvidenceField){
  // A corrected local clock must not put a later edit before the events already recorded for this value.
  const last=field.events.at(-1)?.at;
  return new Date(Math.max(Date.now(),last?Date.parse(last):0)).toISOString();
}
export function changeEvidenceField(record:EvidenceRecord,key:string,value:string,reason?:string):void{
  fieldKey(key);
  let field=Object.hasOwn(record.fields,key)?record.fields[key]:undefined;
  if(!field){field={original:"",current:"",boxes:[],status:"unreviewed",events:[]};record.fields[key]=field}
  if(field.current===value)return;
  field.events.push({at:eventTime(field),action:"corrected",value,previous:field.current,...(reason===undefined?{}:{reason})});
  field.current=value;field.status="corrected";
}
export function acceptEvidenceField(record:EvidenceRecord,key:string):void{
  fieldKey(key);
  const field=Object.hasOwn(record.fields,key)?record.fields[key]:undefined;
  if(!field)throw new Error("That field has no evidence to accept.");
  field.events.push({at:eventTime(field),action:"accepted",value:field.current});
  field.status="accepted";
}

type ObjectValue=Record<string,unknown>;
function fail(path:string,why:string):never{throw new Error(`Invalid evidence: ${path} ${why}.`)}
function object(value:unknown,path:string,keys?:string[]):ObjectValue{
  if(!value||typeof value!=="object"||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(path,"must be an object");
  const o=value as ObjectValue;
  for(const key of Object.keys(o))if(FORBIDDEN_KEYS.has(key)||keys&&!keys.includes(key))fail(`${path}.${key}`,"is not a supported field");
  return o;
}
function array(value:unknown,path:string,max=MAX_ITEMS):unknown[]{
  if(!Array.isArray(value)||value.length>max)fail(path,`must be an array of at most ${max} items`);
  for(let i=0;i<value.length;i++)if(!Object.hasOwn(value,i))fail(`${path}[${i}]`,"must not be missing");
  return value;
}
function numeric(value:unknown,path:string):number{
  if(typeof value!=="number"||!Number.isFinite(value))fail(path,"must be a finite number");
  return value;
}
function positiveInteger(value:unknown,path:string):number{
  const n=numeric(value,path);if(!Number.isSafeInteger(n)||n<1)fail(path,"must be a positive integer");return n;
}
function oneOf<T extends string>(value:unknown,values:readonly T[],path:string):T{
  if(typeof value!=="string"||!values.includes(value as T))fail(path,`must be ${values.join(", ")}`);
  return value as T;
}

export function validateEvidence(value:unknown):EvidenceCollection{
  let textBytes=0,imageBytes=0,itemCount=0;
  const count=(n:number)=>{itemCount+=n;if(itemCount>MAX_ITEMS)fail("collection",`exceeds ${MAX_ITEMS} evidence items`)};
  const text=(v:unknown,path:string,max=MAX_TEXT,nonempty=false):string=>{
    if(typeof v!=="string"||v.length>max||nonempty&&!v.trim())fail(path,`must be ${nonempty?"a nonempty":"a"} string of at most ${max} characters`);
    textBytes+=v.length*2;
    if(textBytes>MAX_TEXT_TOTAL)fail("collection","exceeds the text size limit");
    return v;
  };
  const id=(v:unknown,path:string)=>text(v,path,256,true);
  function png(value:unknown,path:string):string{
    const prefix="data:image/png;base64,";
    if(typeof value!=="string"||!value.startsWith(prefix))fail(path,"must be a PNG data URL");
    // Check length before the base64 expression or decoder sees an untrusted image.
    const length=value.length-prefix.length;
    if(length>4*Math.ceil(EVIDENCE_MAX_PAGE_IMAGE_BYTES/3))fail(path,"exceeds the 2 MiB page image limit");
    const payload=value.slice(prefix.length);
    if(!payload.length||payload.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(payload))fail(path,"has invalid base64 data");
    const bytes=payload.length/4*3-(payload.endsWith("==")?2:payload.endsWith("=")?1:0);
    imageBytes+=bytes;
    if(bytes>EVIDENCE_MAX_PAGE_IMAGE_BYTES||imageBytes>EVIDENCE_MAX_IMAGE_BYTES)fail(path,"exceeds the image size limit");
    let raw:string;
    try{raw=atob(payload)}catch{fail(path,"has invalid base64 data")}
    const signature=[137,80,78,71,13,10,26,10];
    if(raw.length<45||signature.some((n,i)=>raw.charCodeAt(i)!==n)||raw.slice(12,16)!=="IHDR"||raw.slice(-8,-4)!=="IEND")fail(path,"does not contain a PNG image");
    const uint32=(i:number)=>(raw.charCodeAt(i)*0x1000000+(raw.charCodeAt(i+1)<<16)+(raw.charCodeAt(i+2)<<8)+raw.charCodeAt(i+3));
    const width=uint32(16),height=uint32(20);
    if(uint32(8)!==13||width<1||height<1||width>4096||height>4096||width*height>16_777_216)fail(path,"has unsupported PNG dimensions");
    return value;
  }
  const doc=object(value,"collection",["version","sources","records"]);
  if(doc.version!==1)fail("version","is not supported");
  const sourceIds=new Set<string>(),pagesBySource=new Map<string,Set<number>>();
  const sources=array(doc.sources,"sources",1000).map((source,i):EvidenceSource=>{
    count(1);
    const at=`sources[${i}]`,s=object(source,at,["id","name","sha256","size","pages"]),sourceId=id(s.id,`${at}.id`);
    if(sourceIds.has(sourceId))fail(`${at}.id`,"is duplicated");sourceIds.add(sourceId);
    const seen=new Set<number>();pagesBySource.set(sourceId,seen);
    const pages=array(s.pages,`${at}.pages`,2000).map((page,j):EvidencePage=>{
      count(1);
      const loc=`${at}.pages[${j}]`,p=object(page,loc,["page","width","height","image"]);
      const n=positiveInteger(p.page,`${loc}.page`),width=numeric(p.width,`${loc}.width`),height=numeric(p.height,`${loc}.height`);
      if(seen.has(n))fail(`${loc}.page`,"is duplicated");seen.add(n);
      if(width<=0||height<=0||width>100_000||height>100_000)fail(loc,"has invalid page dimensions");
      return {page:n,width,height,...(p.image===undefined?{}:{image:png(p.image,`${loc}.image`)})};
    });
    const sha=s.sha256===undefined?undefined:text(s.sha256,`${at}.sha256`,64);
    if(sha!==undefined&&!/^[a-fA-F0-9]{64}$/.test(sha))fail(`${at}.sha256`,"must be a SHA-256 hex digest");
    const size=s.size===undefined?undefined:numeric(s.size,`${at}.size`);
    if(size!==undefined&&(!Number.isSafeInteger(size)||size<0))fail(`${at}.size`,"must be a nonnegative byte count");
    return {id:sourceId,name:text(s.name,`${at}.name`,4096,true),pages,...(sha===undefined?{}:{sha256:sha}),...(size===undefined?{}:{size})};
  });
  const recordIds=new Set<string>();
  const records=array(doc.records,"records",100_000).map((record,i):EvidenceRecord=>{
    count(1);
    const at=`records[${i}]`,r=object(record,at,["id","sourceId","method","fields"]),recordId=id(r.id,`${at}.id`),sourceId=id(r.sourceId,`${at}.sourceId`);
    if(recordIds.has(recordId))fail(`${at}.id`,"is duplicated");recordIds.add(recordId);
    if(!sourceIds.has(sourceId))fail(`${at}.sourceId`,"does not name a source");
    const method=oneOf(r.method,["pdf-text","ocr","manual"] as const,`${at}.method`),input=object(r.fields,`${at}.fields`);
    const entries=Object.entries(input);if(entries.length>128)fail(`${at}.fields`,"has too many fields");
    const fields:Record<string,EvidenceField>={};
    for(const [key,field] of entries){
      count(1);fieldKey(key);
      const loc=`${at}.fields.${key}`,f=object(field,loc,["original","current","boxes","status","events","note"]);
      const original=text(f.original,`${loc}.original`),current=text(f.current,`${loc}.current`);
      const note=f.note===undefined?undefined:text(f.note,`${loc}.note`);
      const status=oneOf(f.status,["unreviewed","accepted","corrected"] as const,`${loc}.status`);
      const boxes=array(f.boxes,`${loc}.boxes`,2000).map((box,j):EvidenceBox=>{
        count(1);
        const here=`${loc}.boxes[${j}]`,b=object(box,here,["page","x0","y0","x1","y1","text"]),page=positiveInteger(b.page,`${here}.page`);
        if(!pagesBySource.get(sourceId)!.has(page))fail(`${here}.page`,"does not name a source page");
        const x0=numeric(b.x0,`${here}.x0`),y0=numeric(b.y0,`${here}.y0`),x1=numeric(b.x1,`${here}.x1`),y1=numeric(b.y1,`${here}.y1`);
        if(x0<0||y0<0||x1>1||y1>1||x1<=x0||y1<=y0)fail(here,"must have normalized, increasing coordinates within 0 to 1");
        return {page,x0,y0,x1,y1,text:text(b.text,`${here}.text`)};
      });
      let previousValue=original,previousTime=-Infinity;
      const events=array(f.events,`${loc}.events`,10_000).map((event,j):EvidenceEvent=>{
        count(1);
        const here=`${loc}.events[${j}]`,e=object(event,here,["at","action","value","previous","reason"]);
        const at=text(e.at,`${here}.at`,40,true),time=Date.parse(at);
        if(!Number.isFinite(time)||new Date(time).toISOString()!==at||time<previousTime)fail(`${here}.at`,"must be an ISO timestamp in event order");
        previousTime=time;
        const action=oneOf(e.action,["accepted","corrected"] as const,`${here}.action`),value=text(e.value,`${here}.value`);
        const previous=e.previous===undefined?undefined:text(e.previous,`${here}.previous`),reason=e.reason===undefined?undefined:text(e.reason,`${here}.reason`);
        if(previous!==undefined&&previous!==previousValue)fail(`${here}.previous`,"does not match the preceding value");
        if(action==="accepted"&&value!==previousValue)fail(here,"accepts a value that was not current");
        previousValue=value;
        return {at,action,value,...(previous===undefined?{}:{previous}),...(reason===undefined?{}:{reason})};
      });
      if(current!==previousValue)fail(`${loc}.current`,"does not match its evidence history");
      if(status==="unreviewed"?events.length>0:events.at(-1)?.action!==status)fail(`${loc}.status`,"does not match its evidence history");
      fields[key]={original,current,boxes,status,events,...(note===undefined?{}:{note})};
    }
    return {id:recordId,sourceId,method,fields};
  });
  return {version:1,sources,records};
}
