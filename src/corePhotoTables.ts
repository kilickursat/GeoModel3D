// Apply a core-photo edit to the editor's raw draft. Importing a project filters unfinished rows; using a rebuilt
// table here would silently discard those rows when a different, fully reviewed core run was accepted.
import type {GeoProject,Interval} from "./schema";
import type {EditorTables} from "./tables";

type LoggedInterval={hole:string;interval:Interval};
const signature=(hole:string,i:Interval)=>JSON.stringify([hole.trim(),i.from,i.to,i.unit.trim(),i.name?.trim()??"",i.evidenceId??null]);
const intervals=(p:GeoProject):LoggedInterval[]=>p.boreholes.flatMap(b=>b.intervals.map(interval=>({hole:b.id,interval})));
const counts=(entries:LoggedInterval[])=>{
  const result=new Map<string,number>();
  for(const {hole,interval} of entries){const key=signature(hole,interval);result.set(key,(result.get(key)??0)+1)}
  return result;
};
const take=(counts:Map<string,number>,key:string)=>{
  const n=counts.get(key)??0;if(!n)return false;
  if(n===1)counts.delete(key);else counts.set(key,n-1);return true;
};
// Matches the CSV importer's number handling. Empty or incomplete cells must remain raw draft text.
function numeric(value:string|undefined){
  const text=value?.trim();if(!text)return NaN;
  return Number(/^-?\d+,\d+$/.test(text)?text.replace(",","."):text);
}
function rowSignature(row:string[],evidenceId:string|null|undefined):string|undefined{
  const hole=row[0]?.trim(),from=numeric(row[1]),to=numeric(row[2]),unit=row[3]?.trim()??"";
  if(!hole||!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<=from||!unit)return undefined;
  return signature(hole,{from,to,unit,...(row[4]?.trim()?{name:row[4].trim()}:{}),...(evidenceId?{evidenceId}:{})});
}

/** Preserve raw input except the exact interval multiset changed by the core-photo editor and changed depths. */
export function applyCorePhotoProject(t:EditorTables,before:GeoProject,after:GeoProject):EditorTables{
  const result=structuredClone(t),oldEntries=intervals(before),newEntries=intervals(after);
  const removed=counts(oldEntries),remaining=counts(oldEntries),added:LoggedInterval[]=[];
  for(const entry of newEntries){
    const key=signature(entry.hole,entry.interval);take(removed,key);
    if(!take(remaining,key))added.push(entry);
  }
  if(removed.size||added.length){
    const refs=t.evidenceRows?.logs;
    if(refs&&refs.length!==t.rows.logs.length)throw new Error("Evidence links for logs do not match the editor rows.");
    const logs:string[][]=[],bindings:Array<string|null>=[];
    for(const [index,row] of t.rows.logs.entries()){
      const key=rowSignature(row,refs?.[index]);
      if(key!==undefined&&take(removed,key))continue;
      logs.push([...row]);bindings.push(refs?.[index]??null);
    }
    for(const {hole,interval:i} of added){
      logs.push([hole,String(i.from),String(i.to),i.unit,i.name??""]);bindings.push(i.evidenceId??null);
    }
    result.rows.logs=logs;result.evidenceRows={...result.evidenceRows,logs:bindings};
  }
  for(const hole of after.boreholes){
    if(hole.depth===before.boreholes.find(b=>b.id===hole.id)?.depth)continue;
    const row=result.rows.boreholes.find(row=>row[0].trim()===hole.id);
    if(row)row[6]=hole.depth===undefined?"":String(hole.depth);
  }
  if(after.evidence===undefined)delete result.evidence;else result.evidence=structuredClone(after.evidence);
  if(after.corePhotos===undefined)delete result.corePhotos;else result.corePhotos=structuredClone(after.corePhotos);
  return result;
}
