// A derived comparison of registered photograph annotations and the current borehole log.
// This does not edit either interpretation or infer material inside unrepresented depth.
import {corePieceBox} from "./corePhoto";
import type {CoreBox,CorePiece,CoreRow,CoreRun} from "./corePhoto";
import type {Interval} from "./schema";

export type CoreDepthLogComparison="same-unit"|"different-unit"|"photo-unassigned"|"no-photo"|"no-current-log"
  |"current-unassigned"|"ambiguous-current-log"|"photo-unit-missing"|"current-unit-missing";
export interface CoreDepthLogPhoto {
  rowId:string;pieceId?:string;from:number;to:number;box:CoreBox;direction:CoreRow["direction"];
  unit:string;description:string;sound:CorePiece["sound"];breakAfter:CorePiece["breakAfter"];registrationReviewed:boolean;
  // Original annotated piece bounds: a current-log boundary does not create a new core break.
  pieceFrom?:number;pieceTo?:number;endsPiece?:boolean;
}
export interface CoreDepthLogCurrent {from:number;to:number;originalFrom:number;originalTo:number;unit:string;name?:string;evidenceId?:string}
export interface CoreDepthLogSegment {
  from:number;to:number;length:number;photo?:CoreDepthLogPhoto;
  photoState:"piece"|"registered-unannotated"|"unrepresented"|"reviewed-missing";
  currentLog?:CoreDepthLogCurrent;currentLogCount:number;comparison:CoreDepthLogComparison;
}
export interface CoreDepthLog {
  runId:string;boreholeId:string;sourceId:string;from:number;to:number;status:CoreRun["status"];lossReviewed:boolean;
  reviewedBy?:string;acceptedAt?:string;reviewEvidenceId?:string;segments:CoreDepthLogSegment[];
  summary:{runLength:number;registeredLength:number;unrepresentedLength:number;sameUnitLength:number;differentUnitLength:number;unassessedLength:number};
}
const MAX_ITEMS=100_000,EPS=1e-9;
function fail(message:string):never{throw new Error(`Cannot build the core depth log: ${message}.`)}
function depth(value:number){return Number.isFinite(value)&&value>=0}
function text(value:unknown){return typeof value==="string"?value:""}
function unitAssigned(value:string){return value.trim().length>0}
interface PhotoSpan {from:number;to:number;row:CoreRow;piece?:CorePiece;pieceFrom?:number;pieceTo?:number}

/**
 * Split one run at every photograph and current-log boundary, using a sweep rather than repeated scans.
 * With knownUnitIds, missing catalogue entries are unassessed. Without it, comparison is exact equality
 * of nonblank identifiers only; it does not establish their existence in the project's unit catalogue.
 */
export function buildCoreDepthLog(run:CoreRun,intervals:readonly Interval[],knownUnitIds?:ReadonlySet<string>):CoreDepthLog{
  if(!depth(run.from)||!depth(run.to)||run.to<=run.from||run.to>1_000_000)fail("run depths must be finite and increasing between 0 and 1,000,000 m");
  if(!Array.isArray(run.rows)||!Array.isArray(intervals)||run.rows.length+intervals.length>MAX_ITEMS)fail("there are too many rows or log intervals");
  if(run.status!=="draft"&&run.status!=="accepted"||typeof run.lossReviewed!=="boolean")fail("run review state is invalid");
  const ids=new Set<string>(),checkId=(value:string)=>{if(typeof value!=="string"||!value.trim()||value.length>256||ids.has(value))fail("run, row and piece identifiers must be distinct nonempty strings");ids.add(value)};
  checkId(run.id);
  const photos:PhotoSpan[]=[],boundaries=new Set<number>([run.from,run.to]);
  let items=run.rows.length+intervals.length,previousEnd=run.from;
  for(const row of [...run.rows].sort((a,b)=>a.from-b.from)){
    checkId(row.id);
    if(!depth(row.from)||!depth(row.to)||row.to<=row.from||row.from<run.from-EPS||row.to>run.to+EPS)fail("registered row depths must lie inside the run");
    if(row.from<previousEnd-EPS)fail("registered rows overlap in depth");
    const {x0,y0,x1,y1}=row.box;
    if(![x0,y0,x1,y1].every(n=>Number.isFinite(n)&&n>=0&&n<=1)||x1<=x0||y1<=y0)fail("a registered row has invalid source-image bounds");
    if(row.direction!=="ltr"&&row.direction!=="rtl"||typeof row.registrationReviewed!=="boolean"||!Array.isArray(row.pieces))fail("a registered row has invalid direction, review state or pieces");
    items+=row.pieces.length;if(items>MAX_ITEMS)fail("there are too many pieces or log intervals");
    // Match the importer's subtraction tolerance at adjoining row/run limits. Never bridge a positive gap.
    const from=Math.max(run.from,previousEnd,row.from),to=Math.min(run.to,row.to);
    if(to<=from)fail("a registered row has no positive depth span inside the run");
    previousEnd=to;boundaries.add(from);boundaries.add(to);
    if(!row.pieces.length){photos.push({from,to,row});continue}
    let cursor=row.from;
    for(const [pieceIndex,piece] of row.pieces.entries()){
      checkId(piece.id);
      if(!depth(piece.end)||piece.end<=cursor||piece.end>row.to+EPS)fail("piece end depths must increase inside their registered row");
      if(!["unknown","sound","unsound"].includes(piece.sound)||!["unknown","natural","mechanical","continuous","end"].includes(piece.breakAfter))fail("a piece has an invalid soundness or break annotation");
      const end=pieceIndex===row.pieces.length-1&&Math.abs(piece.end-row.to)<=EPS?row.to:piece.end;
      const a=Math.max(from,cursor),b=Math.min(to,end);
      if(b>a){photos.push({from:a,to:b,row,piece,pieceFrom:cursor,pieceTo:piece.end});boundaries.add(a);boundaries.add(b)}
      cursor=piece.end;
    }
    if(Math.abs(cursor-row.to)>EPS)fail("annotated pieces must cover their registered row");
  }
  interface Event {at:number;index:number;add:boolean}
  const events:Event[]=[],current=new Map<number,Interval>();
  for(const [index,interval] of intervals.entries()){
    if(!depth(interval.from)||!depth(interval.to)||interval.to<=interval.from)fail("current log intervals must have finite increasing nonnegative depths");
    const from=Math.max(run.from,interval.from),to=Math.min(run.to,interval.to);if(to<=from)continue;
    boundaries.add(from);boundaries.add(to);events.push({at:from,index,add:true},{at:to,index,add:false});
  }
  if(boundaries.size-1>MAX_ITEMS)fail("the split depth log exceeds 100,000 intervals");
  events.sort((a,b)=>a.at-b.at);
  const ordered=[...boundaries].sort((a,b)=>a-b),segments:CoreDepthLogSegment[]=[];
  const summary={runLength:run.to-run.from,registeredLength:0,unrepresentedLength:0,sameUnitLength:0,differentUnitLength:0,unassessedLength:0};
  let eventIndex=0,photoIndex=0;
  for(let i=0;i<ordered.length-1;i++){
    const from=ordered[i],to=ordered[i+1],length=to-from;
    while(eventIndex<events.length&&events[eventIndex].at<=from){const event=events[eventIndex++];if(event.add)current.set(event.index,intervals[event.index]);else current.delete(event.index)}
    while(photoIndex<photos.length&&photos[photoIndex].to<=from)photoIndex++;
    const span=photos[photoIndex]?.from<=from&&photos[photoIndex].to>=to?photos[photoIndex]:undefined;
    const photo:CoreDepthLogPhoto|undefined=span?{rowId:span.row.id,...(span.piece?{pieceId:span.piece.id,pieceFrom:span.pieceFrom,pieceTo:span.pieceTo,endsPiece:Math.abs(to-span.pieceTo!)<=EPS}:{}),from,to,
      box:corePieceBox(span.row,from,to),direction:span.row.direction,unit:text(span.piece?.unit),description:text(span.piece?.description),
      sound:span.piece?.sound??"unknown",breakAfter:span.piece?.breakAfter??"unknown",registrationReviewed:span.row.registrationReviewed}:undefined;
    const entry=current.size===1?current.values().next().value:undefined;
    const currentLog:CoreDepthLogCurrent|undefined=entry?{from,to,originalFrom:entry.from,originalTo:entry.to,unit:text(entry.unit),
      ...(entry.name===undefined?{}:{name:text(entry.name)}),...(entry.evidenceId===undefined?{}:{evidenceId:text(entry.evidenceId)})}:undefined;
    let comparison:CoreDepthLogComparison;
    if(current.size>1)comparison="ambiguous-current-log";
    else if(!photo)comparison="no-photo";
    else if(!currentLog)comparison="no-current-log";
    else if(!unitAssigned(photo.unit))comparison="photo-unassigned";
    else if(knownUnitIds&&!knownUnitIds.has(photo.unit))comparison="photo-unit-missing";
    else if(!unitAssigned(currentLog.unit))comparison="current-unassigned";
    else if(knownUnitIds&&!knownUnitIds.has(currentLog.unit))comparison="current-unit-missing";
    else comparison=photo.unit===currentLog.unit?"same-unit":"different-unit";
    const photoState:CoreDepthLogSegment["photoState"]=photo?photo.pieceId?"piece":"registered-unannotated":run.lossReviewed?"reviewed-missing":"unrepresented";
    segments.push({from,to,length,...(photo?{photo}:{}),photoState,...(currentLog?{currentLog}:{}),currentLogCount:current.size,comparison});
    if(photo)summary.registeredLength+=length;else summary.unrepresentedLength+=length;
    if(comparison==="same-unit")summary.sameUnitLength+=length;else if(comparison==="different-unit")summary.differentUnitLength+=length;else summary.unassessedLength+=length;
  }
  return {runId:run.id,boreholeId:run.boreholeId,sourceId:run.sourceId,from:run.from,to:run.to,status:run.status,lossReviewed:run.lossReviewed,
    ...(run.reviewedBy===undefined?{}:{reviewedBy:run.reviewedBy}),...(run.acceptedAt===undefined?{}:{acceptedAt:run.acceptedAt}),...(run.reviewEvidenceId===undefined?{}:{reviewEvidenceId:run.reviewEvidenceId}),segments,summary};
}

/** CSV retains annotations and current-log provenance separately; empty cells mean unavailable. */
export function coreDepthLogCsv(log:CoreDepthLog,context:{sourceId:string;sourceName:string;sourceSha256?:string}):string{
  if(context.sourceId!==log.sourceId)throw new Error("The CSV source does not match this core run.");
  const header=["run_id","borehole_id","source_id","source_name","source_sha256","run_from_m","run_to_m","run_status","run_loss_reviewed","run_reviewed_by","run_accepted_at","run_review_evidence_id",
    "from_m","to_m","length_m","photo_state","row_id","piece_id","photo_piece_from_m","photo_piece_to_m","photo_direction","photo_box_x0","photo_box_y0","photo_box_x1","photo_box_y1",
    "photo_unit_id","photo_description","photo_soundness","photo_piece_break_after","segment_ends_piece","photo_registration_reviewed","current_log_count","current_log_from_m","current_log_to_m","current_log_original_from_m","current_log_original_to_m","current_log_unit_id","current_log_description","current_log_evidence_id","comparison"];
  const cell=(value:string|number|boolean|undefined)=>{
    if(value===undefined)return '""';if(typeof value!=="string")return String(value);
    // Quoting alone does not prevent spreadsheet formulas. Preserve the literal text with an apostrophe.
    const safe=/^[\s\u0000-\u0020\u007f-\u009f]*[=+\-@]/u.test(value)||/^[\t\r\n]/.test(value)?"'"+value:value;
    return '"'+safe.replaceAll('"','""')+'"';
  };
  const lines=[header.map(cell).join(",")],encoder=new TextEncoder();let bytes=encoder.encode(lines[0]).length+2;
  for(const segment of log.segments){
    const p=segment.photo,c=segment.currentLog;
    const line=[log.runId,log.boreholeId,context.sourceId,context.sourceName,context.sourceSha256,log.from,log.to,log.status,log.lossReviewed,log.reviewedBy,log.acceptedAt,log.reviewEvidenceId,
      segment.from,segment.to,segment.length,segment.photoState,p?.rowId,p?.pieceId,p?.pieceFrom,p?.pieceTo,p?.direction,p?.box.x0,p?.box.y0,p?.box.x1,p?.box.y1,
      p?.unit,p?.description,p?.sound,p?.breakAfter,p?.endsPiece,p?.registrationReviewed,segment.currentLogCount,c?.from,c?.to,c?.originalFrom,c?.originalTo,c?.unit,c?.name,c?.evidenceId,segment.comparison].map(cell).join(",");
    bytes+=encoder.encode(line).length+2;if(bytes>16*1024*1024)throw new Error("This depth-log CSV exceeds 16 MiB of text. Export a smaller registered run.");lines.push(line);
  }
  return lines.join("\r\n")+"\r\n";
}
