// Depth-registered photographs of continuous recovered core segments. Blank depth spans remain unobserved;
// a photo supplies a reviewed one-dimensional log, not an independent three-dimensional rock measurement.
import type {Borehole,GeoProject,Interval,UnitDef} from "./schema";
import {newEvidenceId,validateEvidence} from "./evidence";
import type {EvidenceCollection,EvidenceField,EvidenceRecord} from "./evidence";

export interface CoreBox {x0:number;y0:number;x1:number;y1:number}
export interface CorePiece {
  id:string;end:number;sound:"unknown"|"sound"|"unsound";
  breakAfter:"unknown"|"natural"|"mechanical"|"continuous"|"end";unit:string;description:string;
}
export interface CoreRow {
  id:string;box:CoreBox;from:number;to:number;direction:"ltr"|"rtl";
  registrationReviewed:boolean;pieces:CorePiece[];
}
export interface CoreRun {
  id:string;boreholeId:string;sourceId:string;from:number;to:number;rows:CoreRow[];lossReviewed:boolean;
  status:"draft"|"accepted";reviewedBy?:string;acceptedAt?:string;reviewEvidenceId?:string;
}
export interface CoreCollection {version:1;runs:CoreRun[]}
export interface CorePhotoContext {evidence?:EvidenceCollection;boreholes?:readonly Borehole[];units?:readonly UnitDef[]}
export interface CoreMappedPiece {id:string;rowId:string;from:number;to:number;length:number;box:CoreBox}
export interface CoreRunResult {
  runLength:number;recoveredLength:number;missingLength:number;recoveryPercent:number;qualifiedLength:number;
  rqdPercent?:number;issues:string[];pieces:CoreMappedPiece[];
}
// This tolerance handles subtraction of metre depths at the 100 mm boundary; it is not a measurement allowance.
const EPS=1e-9,MAX_DEPTH=1_000_000,MAX_RUNS=1000,MAX_ROWS=2000,MAX_PIECES=20_000,MAX_ITEMS=100_000;
const near=(a:number,b:number)=>Math.abs(a-b)<=EPS;

/** Map a normalized whole-image x coordinate to the row's registered depth. */
export function coreDepthAt(row:CoreRow,x:number):number{
  const t=Math.max(0,Math.min(1,(x-row.box.x0)/(row.box.x1-row.box.x0)));
  return row.from+(row.to-row.from)*(row.direction==="rtl"?1-t:t);
}
export function corePieceBox(row:CoreRow,from:number,to:number):CoreBox{
  const width=row.box.x1-row.box.x0,span=row.to-row.from;
  const x=(depth:number)=>row.box.x0+width*(row.direction==="rtl"?1-(depth-row.from)/span:(depth-row.from)/span);
  const a=x(from),b=x(to);
  return {x0:Math.min(a,b),y0:row.box.y0,x1:Math.max(a,b),y1:row.box.y1};
}

/** Reviewed RQD: sound lengths at least 100 mm, rejoined only across explicitly mechanical breaks. */
export function calculateCoreRun(run:CoreRun):CoreRunResult{
  const issues:string[]=[],runLength=run.to-run.from;
  const result:CoreRunResult={runLength,recoveredLength:0,missingLength:0,recoveryPercent:0,qualifiedLength:0,issues,pieces:[]};
  if(!Number.isFinite(runLength)||run.from<0||runLength<=0){issues.push("Enter increasing, nonnegative run depths.");return result}
  const rows=[...run.rows].sort((a,b)=>a.from-b.from),flat:Array<CoreMappedPiece&{piece:CorePiece}>=[];
  let previousEnd=run.from;
  if(!rows.length)issues.push("Register at least one recovered core segment.");
  for(let i=0;i<rows.length;i++)for(let j=0;j<i;j++){
    const a=rows[i].box,b=rows[j].box;
    if(Math.min(a.x1,b.x1)>Math.max(a.x0,b.x0)+1e-12&&Math.min(a.y1,b.y1)>Math.max(a.y0,b.y0)+1e-12){issues.push("Photograph segment boxes overlap; the same core cannot be counted twice.");i=rows.length;break}
  }
  for(const [index,row] of rows.entries()){
    const label=`Segment ${index+1}`;
    if(!Number.isFinite(row.from)||!Number.isFinite(row.to)||row.to<=row.from||row.from<run.from-EPS||row.to>run.to+EPS){issues.push(`${label}: depths must lie inside the run.`);continue}
    if(row.from<previousEnd-EPS)issues.push(`${label}: depth spans overlap.`);
    previousEnd=Math.max(previousEnd,row.to);
    result.recoveredLength+=row.to-row.from;
    if(!row.registrationReviewed)issues.push(`${label}: review depth registration and continuous recovery.`);
    if(!row.pieces.length)issues.push(`${label}: mark and review the recovered pieces.`);
    let from=row.from;
    for(const [pieceIndex,piece] of row.pieces.entries()){
      if(!Number.isFinite(piece.end)||piece.end<=from||piece.end>row.to+EPS){issues.push(`${label}, piece ${pieceIndex+1}: invalid end depth.`);continue}
      const mapped={id:piece.id,rowId:row.id,from,to:piece.end,length:piece.end-from,box:corePieceBox(row,from,piece.end)};
      result.pieces.push(mapped);flat.push({...mapped,piece});
      if(piece.sound==="unknown")issues.push(`${label}, piece ${pieceIndex+1}: review soundness.`);
      if(piece.breakAfter==="unknown")issues.push(`${label}, piece ${pieceIndex+1}: classify the following break.`);
      from=piece.end;
    }
    if(!near(from,row.to))issues.push(`${label}: pieces must cover the entire registered segment.`);
  }
  result.missingLength=Math.max(0,runLength-result.recoveredLength);
  result.recoveryPercent=100*result.recoveredLength/runLength;
  if(result.recoveredLength>runLength+EPS)issues.push("Recovered length exceeds the drilled run length.");
  if(!run.lossReviewed)issues.push("Review all missing core positions and confirm every recovered segment is registered.");
  let joinedLength=0;
  const flush=()=>{if(joinedLength+EPS>=0.1)result.qualifiedLength+=joinedLength;joinedLength=0};
  flat.forEach((mapped,index)=>{
    const next=flat[index+1],contiguous=!!next&&near(mapped.to,next.from),piece=mapped.piece;
    // Unsound material interrupts a solid length. It cannot disqualify an otherwise long sound piece beside it,
    // and two short sound pieces are never joined through an unsound fragment.
    if(piece.sound==="sound")joinedLength+=mapped.length;else flush();
    if(piece.breakAfter==="end"&&contiguous)issues.push(`Piece ${index+1}: a segment boundary is not a reviewed natural or mechanical break.`);
    const joined=piece.breakAfter==="mechanical"||piece.breakAfter==="continuous";
    if(joined&&!contiguous)issues.push(`Piece ${index+1}: a ${piece.breakAfter} join cannot cross missing core or the end of the run.`);
    if(!joined||!contiguous||next.piece.sound!=="sound")flush();
  });
  flush();
  if(!issues.length)result.rqdPercent=100*result.qualifiedLength/runLength;
  return result;
}

type Obj=Record<string,unknown>;
function fail(path:string,reason:string):never{throw new Error(`Invalid core photographs: ${path} ${reason}.`)}
function object(v:unknown,path:string,keys:string[]):Obj{
  if(!v||typeof v!=="object"||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail(path,"must be an object");
  const o=v as Obj;
  for(const k of Object.keys(o))if(!keys.includes(k)||["__proto__","constructor","prototype"].includes(k))fail(`${path}.${k}`,"is not supported");
  return o;
}
function array(v:unknown,path:string,max:number):unknown[]{
  if(!Array.isArray(v)||v.length>max)fail(path,`must be an array of at most ${max} items`);
  for(let i=0;i<v.length;i++)if(!Object.hasOwn(v,i))fail(`${path}[${i}]`,"must not be missing");
  return v;
}
function number(v:unknown,path:string,min=0,max=MAX_DEPTH):number{
  if(typeof v!=="number"||!Number.isFinite(v)||v<min||v>max)fail(path,`must be a finite number between ${min} and ${max}`);
  return v;
}
function bool(v:unknown,path:string):boolean{if(typeof v!=="boolean")fail(path,"must be a boolean");return v}
function choice<T extends string>(v:unknown,path:string,options:readonly T[]):T{
  if(typeof v!=="string"||!options.includes(v as T))fail(path,`must be ${options.join(", ")}`);return v as T;
}

/** Strict bounded import. Drafts may have empty rows or unassigned units; accepted runs must remain reviewable. */
export function validateCorePhotos(value:unknown,context:CorePhotoContext={}):CoreCollection{
  let count=0,textSize=0;
  const item=()=>{if(++count>MAX_ITEMS)fail("collection","contains too many items")};
  const text=(v:unknown,path:string,max=4096,required=false):string=>{
    if(typeof v!=="string"||v.length>max||required&&!v.trim())fail(path,`must be ${required?"a nonempty":"a"} string of at most ${max} characters`);
    textSize+=v.length;if(textSize>4*1024*1024)fail("collection","exceeds the text limit");return v;
  };
  const id=(v:unknown,path:string)=>text(v,path,256,true),seen=new Set<string>();
  const unique=(v:unknown,path:string)=>{const s=id(v,path);if(seen.has(s))fail(path,"is duplicated");seen.add(s);return s};
  const doc=object(value,"collection",["version","runs"]);if(doc.version!==1)fail("version","is not supported");
  const sources=context.evidence===undefined?undefined:new Map(context.evidence.sources.map(s=>[s.id,s]));
  const records=context.evidence===undefined?undefined:new Map(context.evidence.records.map(r=>[r.id,r]));
  const holes=context.boreholes===undefined?undefined:new Set(context.boreholes.map(b=>b.id));
  const units=context.units===undefined?undefined:new Set(context.units.map(u=>u.id));
  const runs=array(doc.runs,"runs",MAX_RUNS).map((value,i):CoreRun=>{
    item();const path=`runs[${i}]`,r=object(value,path,["id","boreholeId","sourceId","from","to","rows","lossReviewed","status","reviewedBy","acceptedAt","reviewEvidenceId"]);
    const runId=unique(r.id,`${path}.id`),boreholeId=id(r.boreholeId,`${path}.boreholeId`),sourceId=id(r.sourceId,`${path}.sourceId`);
    if(holes&&!holes.has(boreholeId))fail(`${path}.boreholeId`,"does not name a borehole");
    if(sources&&!sources.get(sourceId)?.pages.some(p=>p.page===1&&p.image))fail(`${path}.sourceId`,"must name a source with its photograph saved as page 1");
    const from=number(r.from,`${path}.from`),to=number(r.to,`${path}.to`);if(to<=from)fail(path,"must have increasing run depths");
    const status=choice(r.status,`${path}.status`,["draft","accepted"] as const);
    const rows=array(r.rows,`${path}.rows`,MAX_ROWS).map((value,j):CoreRow=>{
      item();const here=`${path}.rows[${j}]`,row=object(value,here,["id","box","from","to","direction","registrationReviewed","pieces"]);
      const rowId=unique(row.id,`${here}.id`),a=number(row.from,`${here}.from`),b=number(row.to,`${here}.to`);
      if(b<=a||a<from-EPS||b>to+EPS)fail(here,"must have increasing depths inside the run");
      const box=object(row.box,`${here}.box`,["x0","y0","x1","y1"]),x0=number(box.x0,`${here}.box.x0`,0,1),y0=number(box.y0,`${here}.box.y0`,0,1),x1=number(box.x1,`${here}.box.x1`,0,1),y1=number(box.y1,`${here}.box.y1`,0,1);
      if(x1<=x0||y1<=y0)fail(`${here}.box`,"must have increasing image coordinates");
      let cursor=a;
      const pieces=array(row.pieces,`${here}.pieces`,MAX_PIECES).map((value,k):CorePiece=>{
        item();const loc=`${here}.pieces[${k}]`,p=object(value,loc,["id","end","sound","breakAfter","unit","description"]);
        const pieceId=unique(p.id,`${loc}.id`),end=number(p.end,`${loc}.end`);
        if(end<=cursor||end>b+EPS)fail(`${loc}.end`,"must increase within its segment");cursor=end;
        const unit=text(p.unit,`${loc}.unit`,256),description=text(p.description,`${loc}.description`);
        if(status==="accepted"&&(!unit.trim()||units&&!units.has(unit)))fail(`${loc}.unit`,"must name a project unit for an accepted log");
        return {id:pieceId,end,sound:choice(p.sound,`${loc}.sound`,["unknown","sound","unsound"] as const),breakAfter:choice(p.breakAfter,`${loc}.breakAfter`,["unknown","natural","mechanical","continuous","end"] as const),unit,description};
      });
      if(pieces.length&&!near(cursor,b))fail(`${here}.pieces`,"must end at the segment's final depth");
      return {id:rowId,from:a,to:b,box:{x0,y0,x1,y1},direction:choice(row.direction,`${here}.direction`,["ltr","rtl"] as const),registrationReviewed:bool(row.registrationReviewed,`${here}.registrationReviewed`),pieces};
    });
    const ordered=[...rows].sort((a,b)=>a.from-b.from);
    for(let j=1;j<ordered.length;j++)if(ordered[j].from<ordered[j-1].to-EPS)fail(`${path}.rows`,"contains overlapping depth spans");
    const reviewedBy=r.reviewedBy===undefined?undefined:text(r.reviewedBy,`${path}.reviewedBy`,256,true);
    const acceptedAt=r.acceptedAt===undefined?undefined:text(r.acceptedAt,`${path}.acceptedAt`,40,true);
    if(acceptedAt!==undefined&&(!Number.isFinite(Date.parse(acceptedAt))||new Date(acceptedAt).toISOString()!==acceptedAt))fail(`${path}.acceptedAt`,"must be an ISO timestamp");
    const reviewEvidenceId=r.reviewEvidenceId===undefined?undefined:id(r.reviewEvidenceId,`${path}.reviewEvidenceId`);
    if(reviewEvidenceId!==undefined&&records&&records.get(reviewEvidenceId)?.sourceId!==sourceId)fail(`${path}.reviewEvidenceId`,"must name a review record for this source");
    const run:CoreRun={id:runId,boreholeId,sourceId,from,to,rows,lossReviewed:bool(r.lossReviewed,`${path}.lossReviewed`),status,
      ...(reviewedBy===undefined?{}:{reviewedBy}),...(acceptedAt===undefined?{}:{acceptedAt}),...(reviewEvidenceId===undefined?{}:{reviewEvidenceId})};
    if(status==="accepted"){
      if(!reviewedBy||!acceptedAt||!reviewEvidenceId)fail(path,"needs its reviewer, acceptance time and evidence record");
      const calculation=calculateCoreRun(run),issues=calculation.issues;if(issues.length)fail(path,`is marked accepted but ${issues[0]}`);
      if(records)validateAcceptedSnapshot(run,calculation,records,path);
    }
    return run;
  });
  return {version:1,runs};
}

// Evidence.current may change when an input table is corrected. The original accepted annotations remain the
// comparison baseline, so ordinary table corrections do not rewrite the history of a reviewed core photograph.
function validateAcceptedSnapshot(run:CoreRun,result:CoreRunResult,records:ReadonlyMap<string,EvidenceRecord>,path:string){
  const summary=records.get(run.reviewEvidenceId!),original=(record:EvidenceRecord|undefined,key:string)=>record?.fields[key]?.original;
  const agrees=(record:EvidenceRecord|undefined,values:Record<string,string>)=>!!record&&record.sourceId===run.sourceId&&record.method==="manual"&&Object.entries(values).every(([key,value])=>original(record,key)===value);
  if(!agrees(summary,{coreRunId:run.id,boreholeId:run.boreholeId,from:String(run.from),to:String(run.to),reviewer:run.reviewedBy!,reviewedAt:run.acceptedAt!,
    recovery:String(result.recoveryPercent),RQD:String(result.rqdPercent),missingLength:String(result.missingLength),lossReview:"Every recovered segment registered; missing core positions reviewed."}))fail(path,"does not match its original accepted run evidence");
  const linked=[...records.values()].filter(r=>original(r,"runReview")===run.reviewEvidenceId);
  const byId=new Map(linked.map(r=>[original(r,"pieceId"),r]));
  if(linked.length!==result.pieces.length||byId.size!==linked.length)fail(path,"does not match its original accepted piece evidence");
  for(const row of run.rows){
    let from=row.from;
    for(const piece of row.pieces){
      const record=byId.get(piece.id),box=corePieceBox(row,from,piece.end),savedBox=record?.fields.from?.boxes[0];
      if(!agrees(record,{coreRunId:run.id,boreholeId:run.boreholeId,pieceId:piece.id,from:String(from),to:String(piece.end),unit:piece.unit,description:piece.description,soundness:piece.sound,breakAfter:piece.breakAfter,rowId:row.id,rowFrom:String(row.from),rowTo:String(row.to),rowBox:JSON.stringify(row.box),direction:row.direction,reviewer:run.reviewedBy!,runReview:run.reviewEvidenceId!})||!savedBox||savedBox.page!==1||(["x0","y0","x1","y1"] as const).some(k=>savedBox[k]!==box[k]))fail(path,"does not match its original accepted piece evidence");
      from=piece.end;
    }
  }
}

/** Apply reviewed intervals atomically. Replacing a run explicitly removes its old log, including missing spans. */
export function acceptCoreRun(project:GeoProject,runId:string,options:{reviewer:string;replaceExisting?:boolean}):GeoProject{
  const reviewer=options.reviewer.trim();if(!reviewer||reviewer.length>256)throw new Error("Enter the reviewer's name (at most 256 characters).");
  const corePhotos=validateCorePhotos(project.corePhotos,{evidence:project.evidence??{version:1,sources:[],records:[]},boreholes:project.boreholes,units:project.units});
  const run=corePhotos.runs.find(r=>r.id===runId);if(!run)throw new Error("The core run was not found.");
  const calculation=calculateCoreRun(run);if(calculation.issues.length)throw new Error(calculation.issues.join(" "));
  const knownUnits=new Set(project.units.map(u=>u.id));
  if(run.rows.some(row=>row.pieces.some(piece=>!knownUnits.has(piece.unit))))throw new Error("Assign every recovered piece to a project unit before acceptance.");
  const hole=project.boreholes.find(b=>b.id===run.boreholeId)!;
  const overlaps=hole.intervals.some(i=>i.from<run.to&&i.to>run.from);
  if(overlaps&&!options.replaceExisting)throw new Error("This run overlaps existing log intervals. Review and explicitly choose to replace the log inside the run.");
  // Bound expansion before creating evidence fields and their events/boxes. The estimate deliberately exceeds
  // the current emitted record size and includes all existing history, whose importer has a 200,000-item limit.
  const existingItems=project.evidence!.sources.reduce((n,s)=>n+1+s.pages.length,0)+project.evidence!.records.reduce((n,r)=>n+1+Object.values(r.fields).reduce((m,f)=>m+1+f.boxes.length+f.events.length,0),0);
  if(existingItems+calculation.pieces.length*70+run.rows.length*15+100>200_000)throw new Error("This review would exceed the saved evidence limit. Split the project or use fewer core pieces before accepting this run.");
  const result=structuredClone(project);result.corePhotos=corePhotos;
  result.evidence=structuredClone(project.evidence!);
  const target=result.boreholes.find(b=>b.id===run.boreholeId)!;
  const at=new Date().toISOString(),runBoxes=run.rows.map(row=>({page:1,...row.box,text:`Registered recovered core ${row.from}–${row.to} m`}));
  const field=(value:string,boxes=runBoxes,note?:string):EvidenceField=>({original:value,current:value,boxes:structuredClone(boxes),status:"accepted",events:[{at,action:"accepted",value,reason:`Reviewed by ${reviewer}`}],...(note?{note}:{})});
  const makeRecord=(fields:Record<string,EvidenceField>):EvidenceRecord=>({id:newEvidenceId(),sourceId:run.sourceId,method:"manual",fields});
  const method="Photo-derived RQD: sound core pieces at least 100 mm divided by drilled run length; explicitly reviewed mechanical breaks and continuous logging boundaries rejoined. Unsound material interrupts a solid length. Missing core remains in the denominator. Manual depth registration and interpretation; no automated lithology or strength prediction.";
  const summary=makeRecord({coreRunId:field(run.id),boreholeId:field(run.boreholeId),from:field(String(run.from)),to:field(String(run.to)),reviewer:field(reviewer),reviewedAt:field(at),method:field(method),recovery:field(String(calculation.recoveryPercent)),RQD:field(String(calculation.rqdPercent)),missingLength:field(String(calculation.missingLength)),lossReview:field("Every recovered segment registered; missing core positions reviewed.")});
  result.evidence.records.push(summary);
  const intervals:Interval[]=[];
  for(const row of [...run.rows].sort((a,b)=>a.from-b.from)){
    let from=row.from;
    for(const piece of row.pieces){
      const boxes=[{page:1,...corePieceBox(row,from,piece.end),text:`${run.boreholeId}: recovered core ${from}–${piece.end} m`}];
      const f=(value:string,note?:string)=>field(value,boxes,note);
      const record=makeRecord({coreRunId:f(run.id),boreholeId:f(run.boreholeId),pieceId:f(piece.id),from:f(String(from)),to:f(String(piece.end)),unit:f(piece.unit),description:f(piece.description),soundness:f(piece.sound),breakAfter:f(piece.breakAfter),rowId:f(row.id),rowFrom:f(String(row.from)),rowTo:f(String(row.to)),rowBox:f(JSON.stringify(row.box)),direction:f(row.direction),reviewer:f(reviewer),runReview:f(summary.id),method:f(method)});
      result.evidence.records.push(record);
      intervals.push({from,to:piece.end,unit:piece.unit,...(piece.description?{name:piece.description}:{}),evidenceId:record.id});from=piece.end;
    }
  }
  const outside=target.intervals.flatMap((interval):Interval[]=>{
    if(interval.to<=run.from||interval.from>=run.to)return [interval];
    return [...(interval.from<run.from?[{...interval,to:run.from}]:[]),...(interval.to>run.to?[{...interval,from:run.to}]:[])];
  });
  target.intervals=[...outside,...intervals].sort((a,b)=>a.from-b.from);
  target.depth=Math.max(target.depth??0,run.to,...target.intervals.map(i=>i.to));
  run.status="accepted";run.reviewedBy=reviewer;run.acceptedAt=at;run.reviewEvidenceId=summary.id;
  // Apply the same evidence bounds as an imported workspace before returning data the UI will persist.
  result.evidence=validateEvidence(result.evidence);
  return result;
}
