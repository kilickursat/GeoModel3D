import {parseCsv,toCsv} from "./csv";
import type {BedAssignment} from "./bedAssignments";
import type {GeoProject} from "./schema";

const required=["hole_id","from","to","material_id","expected_bed","reviewed_bed","bed_rank","review_reason"];
const columns=[...required.slice(0,5),"source_sha256","evidence_id",...required.slice(5)];

export function isBedReviewCsv(text:string):boolean{
  const header=text.trimStart().split(/[\r\n]/,1)[0];
  if(!/reviewed_bed|bed_rank/i.test(header))return false;
  return parseCsv(header)[0]?.some(value=>["reviewed_bed","bed_rank"].includes(value.trim().toLowerCase()))??false;
}

export function readBedReviewCsv(text:string):BedAssignment[]{
  const [header,...rows]=parseCsv(text,undefined,true);
  const names=(header??[]).map(value=>value.trim().toLowerCase());
  if(new Set(names).size!==names.length)throw new Error("Bed review worksheet has duplicate column names.");
  const missing=required.filter(key=>!names.includes(key));
  if(missing.length)throw new Error(`Bed review worksheet is missing columns: ${missing.join(", ")}.`);
  const index=new Map(names.map((name,i)=>[name,i]));
  const assignments:BedAssignment[]=[];
  for(const [i,row] of rows.entries()){
    const line=i+2;
    if(row.length!==names.length)throw new Error(`Bed review row ${line} has ${row.length} fields for ${names.length} columns.`);
    const cell=(name:string)=>row[index.get(name)??-1]?.trim()??"";
    const bedId=cell("reviewed_bed"),rank=cell("bed_rank"),rationale=cell("review_reason");
    if(!bedId&&!rank&&!rationale)continue;
    if(/^(unresolved|local only)$/i.test(bedId))throw new Error(`Bed review row ${line} needs a specific correlated bed ID. Leave the three decision fields empty to defer it.`);
    if(!bedId||!/^\d+$/.test(rank)||!Number.isSafeInteger(Number(rank))||Number(rank)<1||!rationale)
      throw new Error(`Bed review row ${line} needs a bed ID, a positive integer rank and an engineering reason.`);
    const holeId=cell("hole_id"),materialId=cell("material_id"),expectedBed=cell("expected_bed");
    const depth=(key:string)=>{
      const raw=cell(key);
      // Accept decimal or scientific notation. Empty fields must never become a zero-depth contact.
      if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)||!Number.isFinite(Number(raw)))
        throw new Error(`Bed review row ${line} needs a finite ${key} depth in metres.`);
      return Number(raw);
    };
    const from=depth("from"),to=depth("to");
    if(!holeId||!materialId||!expectedBed||from<0||to<=from)throw new Error(`Bed review row ${line} has an incomplete source or invalid interval.`);
    const evidenceId=cell("evidence_id"),sourceSha256=cell("source_sha256");
    assignments.push({holeId,from,to,materialId,expectedBed,bedId,rank:Number(rank),rationale,
      ...(sourceSha256?{sourceSha256}:{}),...(evidenceId?{evidenceId}:{})});
  }
  return assignments;
}

/** One row per original interval, including adjacent intervals of the same material. Review decisions start blank. */
export function toBedReviewCsv(project:GeoProject):string{
  const units=new Map(project.units.map(unit=>[unit.id,unit]));
  const records=new Map(project.evidence?.records.map(record=>[record.id,record]));
  const sources=new Map(project.evidence?.sources.map(source=>[source.id,source]));
  const rows:Array<Array<string|number|undefined>>=[[...columns,"source_pdf","description"]];
  for(const hole of project.boreholes)for(const interval of hole.intervals){
    const record=interval.evidenceId?records.get(interval.evidenceId):undefined;
    const source=record?sources.get(record.sourceId):undefined;
    rows.push([hole.id,interval.from,interval.to,units.get(interval.unit)?.materialId??interval.unit,interval.unit,
      source?.sha256,source?.sha256?undefined:interval.evidenceId,"","","",source?.name,interval.name]);
  }
  return toCsv(rows);
}
