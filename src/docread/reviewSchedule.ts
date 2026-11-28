import type {CollarScheduleMatch,CollarScheduleRow} from "./collarSchedule";
import type {DraftHole,PageSize} from "./draft";
import type {TextLine} from "./reconstruct";
import {acceptEvidenceField,changeEvidenceField,type EvidenceBox,type EvidenceField} from "../evidence";

export const positionFields=["x","y","lat","lon","ground"] as const;
export interface DraftSchedule {
  match:CollarScheduleMatch;
  sourceId:string;
  originalBasis:string;
  decision?:{choice:number|"keep";basis:string};
  grid?:{row:number;x:string;y:string};
  depthForId?:string;
}
export const positionBasis=(h:Pick<DraftHole,"values">)=>JSON.stringify([h.values.id,...positionFields.map(k=>h.values[k])]);

export function hasPendingSchedule(h:DraftHole){
  const s=h.schedule;
  if(!s)return false;
  const basis=positionBasis(h);
  return s.decision?s.decision.basis!==basis:s.match.status!=="confirmed"||s.originalBasis!==basis;
}

export function rowSelectionIssue(h:DraftHole,row:CollarScheduleRow){
  if(h.values.id.trim()!==row.id.trim())return "The current borehole ID differs from this schedule row.";
  const f=row.fields,projected=!!(f.x&&f.y),geographic=!!(f.lat&&f.lon);
  if(!projected&&!geographic)return "This row has no usable coordinate pair.";
  if(!!f.x!==!!f.y||!!f.lat!==!!f.lon)return "One coordinate is missing. Enter a verified pair in the current fields.";
  if(projected&&geographic)return "This row contains two coordinate representations. Enter one verified pair in the current fields.";
  return "";
}

export function scheduleValueLines(row:CollarScheduleRow){
  return [row.idLine,...Object.values(row.fields).flatMap(f=>[f.line,f.heading])];
}

function scheduleLines(row:CollarScheduleRow){
  return [...scheduleValueLines(row),...(row.context??[])];
}
export function clearedPositionFields(row:CollarScheduleRow){
  return row.fields.x||row.projectedFromGeographic?["lat","lon"] as const:["x","y"] as const;
}

export function acceptedGridRow(h:DraftHole){
  const s=h.schedule;
  if(!s?.grid||hasPendingSchedule(h)||s.grid.x!==h.values.x||s.grid.y!==h.values.y)return;
  const row=s.match.candidates[s.grid.row];
  if(row?.id.trim()===h.values.id.trim())return row;
}

// Two printed coordinate representations can belong to one schedule row with one surveyed drilled length.
// For repeated IDs on distinct records, use only a row that a reviewer has already identified for this hole.
export function drilledLengthRow(h:DraftHole){
  const s=h.schedule;
  if(!s)return;
  if(s.match.status==="ambiguous"){
    if(typeof s.decision?.choice!=="number"||hasPendingSchedule(h))return;
    const chosen=s.match.candidates[s.decision.choice];
    return chosen?.finalDepth?chosen:undefined;
  }
  const rows=s.match.candidates.filter(r=>r.finalDepth),first=rows[0];
  if(!first)return;
  const depth=first.finalDepth!;
  if(rows.every(r=>r.page===first.page&&r.id===first.id&&r.finalDepth!.value===depth.value&&
    r.finalDepth!.line.x0===depth.line.x0&&r.finalDepth!.line.y0===depth.line.y0))return first;
}

export function drilledLengthIssue(h:DraftHole,row:CollarScheduleRow){
  const depth=row.finalDepth;
  if(!depth||!Number.isFinite(depth.value)||depth.value<=0)return "This row has no verified drilled length.";
  if(h.values.id.trim()!==row.id.trim())return "The current borehole ID differs from the drilled-length record.";
  if(h.layers.some(l=>Number(l.to.trim().replace(",","."))>depth.value))return "The log extends below the printed drilled length. Reconcile the depths before using this value.";
  return "";
}

export function useDrilledLength(h:DraftHole,size:(page:number)=>PageSize|undefined){
  const row=drilledLengthRow(h),field=row?.finalDepth,record=h.evidence;
  if(!row||!field||!record||!h.schedule)throw new Error("A drilled length for this borehole could not be identified.");
  const issue=drilledLengthIssue(h,row);
  if(issue)throw new Error(issue);
  const boxes=sourceBoxes([field.line],row.page,size);
  if(!boxes.length)throw new Error("The drilled length has no source box. Check the original page.");
  const value=String(field.value);
  changeEvidenceField(record,"depth",value,`Selected the printed drilled length for ${row.id} on page ${row.page}.`);
  addSources(record.fields.depth,[...boxes,...sourceBoxes([field.heading,row.idLine],row.page,size)]);
  acceptEvidenceField(record,"depth");
  h.values.final=value;h.src.final=field.line;delete h.flags.final;
  h.schedule.depthForId=row.id;
  if(h.ocrPages?.includes(row.page))record.method="ocr";
}

export function sourceBoxes(read:TextLine[],defaultPage:number,size:(page:number)=>PageSize|undefined):EvidenceBox[]{
  return read.flatMap(l=>{
    const line=l.shown??l,page=l.page??defaultPage,s=size(page);
    if(!s||!(s.width>0&&s.height>0)||![line.x0,line.y0,line.x1,line.y1].every(Number.isFinite))return [];
    const clamp=(n:number)=>Math.max(0,Math.min(1,n));
    const x0=clamp(line.x0/s.width),x1=clamp(line.x1/s.width),y0=clamp(line.y0/s.height),y1=clamp(line.y1/s.height);
    return x1>x0&&y1>y0?[{page,x0,y0,x1,y1,text:l.text}]:[];
  });
}

// Keep both the latest schedule source and every earlier source behind the correction history.
function addSources(field:EvidenceField,boxes:EvidenceBox[]){
  const distinct=new Map([...boxes,...field.boxes].map(b=>[JSON.stringify([b.page,b.x0,b.y0,b.x1,b.y1,b.text]),b]));
  field.boxes=[...distinct.values()];
}

export function decideSchedule(h:DraftHole,choice:number|"keep",size:(page:number)=>PageSize|undefined){
  const s=h.schedule,r=h.evidence;
  if(!s||!r)throw new Error("No collar schedule evidence is available for this borehole.");
  const row=choice==="keep"?undefined:s.match.candidates[choice];
  if(choice!=="keep"&&!row)throw new Error("Choose a schedule row.");
  const reason=row?`Selected the ${row.coordinateKind??"collar"} position for ${row.id} on page ${row.page} for the log on page ${h.pages[0]}.`:
    `Kept the current fields for ${h.values.id} after reviewing the collar schedule.`;
  if(row){
    const issue=rowSelectionIssue(h,row);
    if(issue)throw new Error(issue);
    // Resolve every required box before mutating fields so a missing page cannot partially apply a row.
    const acquired=positionFields.flatMap(k=>{
      const f=row.fields[k];
      if(!f||row.projectedFromGeographic&&(k==="lat"||k==="lon"))return [];
      const boxes=sourceBoxes([f.line],row.page,size);
      if(!boxes.length)throw new Error("The selected coordinate has no source box. Enter it manually after checking the original page.");
      boxes.push(...sourceBoxes([f.heading,row.idLine,...(row.context??[])],row.page,size));
      return [{k,value:String(f.value),line:f.line,boxes,reason}];
    });
    if(row.projectedFromGeographic){
      const lat=row.fields.lat,lon=row.fields.lon;
      if(!lat||!lon||!row.crsCode)throw new Error("The projected result needs both printed angles and a coordinate system.");
      for(const k of ["x","y"] as const){
        const f=k==="x"?lon:lat,boxes=sourceBoxes([f.line],row.page,size);
        if(!boxes.length||!Number.isFinite(row.projectedFromGeographic[k]))throw new Error("The selected angles could not be verified on the source page.");
        boxes.push(...sourceBoxes(scheduleLines(row),row.page,size));
        acquired.push({k,value:String(row.projectedFromGeographic[k]),line:f.line,boxes,
          reason:`${reason} Projected the printed latitude and longitude into ${row.crsCode}.`});
      }
    }
    for(const {k,value,line,boxes,reason:fieldReason} of acquired){
      const field=k==="ground"?"z":k;
      changeEvidenceField(r,field,value,fieldReason);
      const evidence=r.fields[field];
      addSources(evidence,boxes);
      acceptEvidenceField(r,field);
      h.src[k]=line;h.values[k]=value;delete h.flags[k];
    }
    for(const k of clearedPositionFields(row)){
      if(h.values[k])changeEvidenceField(r,k,"",`${reason} Removed the previous coordinate representation.`);
      h.values[k]="";delete h.src[k];delete h.flags[k];
    }
    s.grid=typeof choice==="number"&&(row.fields.x&&row.fields.y||row.projectedFromGeographic)?
      {row:choice,x:h.values.x,y:h.values.y}:undefined;
  }
  const decision="Collar schedule review";
  const description=row?`${reason} ${positionFields.filter(k=>row.fields[k]).map(k=>`${k} ${row.fields[k]!.value}`).join(", ")}`:
    reason;
  changeEvidenceField(r,decision,description);
  const candidates=s.match.candidates;
  addSources(r.fields[decision],candidates.flatMap(candidate=>sourceBoxes(scheduleLines(candidate),candidate.page,size)));
  r.fields[decision].note=[...new Set([...s.match.notes,...candidates.flatMap(candidate=>candidate.notes)])].join(" ")||undefined;
  if(candidates.some(candidate=>h.ocrPages?.includes(candidate.page)))r.method="ocr";
  acceptEvidenceField(r,decision);
  s.decision={choice,basis:positionBasis(h)};
}
