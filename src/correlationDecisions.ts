// A review applies to the logged interval and the complete discrepancy at its collar as the reviewer saw it.
// Older decisions may remain in a saved project. An edited observation or a different interpretation needs a new review.
import type {CollarIntervalAgreement} from "./correlation";
import type {GeoModel} from "./model";
import type {EditorTables} from "./tables";

interface ReviewedUnit {unit:string;unitName:string;materialId:string;materialName:string}
interface ReviewedSegment extends ReviewedUnit {from:number;to:number}
export interface CorrelationAcceptance extends ReviewedUnit {
  kind:"borehole"|"cpt";holeId:string;intervalIndex:number;from:number;to:number;
  x:number;y:number;z:number;crs:string;description:string;evidenceId:string;
  segments:ReviewedSegment[];rationale:string;
}
type Basis=Omit<CorrelationAcceptance,"rationale">;

function sourceKey(basis:Pick<Basis,"kind"|"holeId"|"intervalIndex"|"from"|"to">){
  return JSON.stringify([basis.kind,basis.holeId,basis.intervalIndex,basis.from,basis.to]);
}

// Compare named fields explicitly: keys in imported JSON can be in any order.
function sameUnit(a:ReviewedUnit,b:ReviewedUnit){
  return a.unit===b.unit&&a.unitName===b.unitName&&a.materialId===b.materialId&&a.materialName===b.materialName;
}
function sameBasis(a:Basis,b:Basis){
  return a.kind===b.kind&&a.holeId===b.holeId&&a.intervalIndex===b.intervalIndex&&a.from===b.from&&a.to===b.to&&sameUnit(a,b)&&
    a.x===b.x&&a.y===b.y&&a.z===b.z&&a.crs===b.crs&&a.description===b.description&&a.evidenceId===b.evidenceId&&
    a.segments.length===b.segments.length&&a.segments.every((s,i)=>{
      const other=b.segments[i];return s.from===other.from&&s.to===other.to&&sameUnit(s,other);
    });
}

function uniqueSources<T extends {id:string}>(items:T[]){
  const sources=new Map<string,T|undefined>();
  for(const item of items)sources.set(item.id,sources.has(item.id)?undefined:item);
  return sources;
}
function basisReader(model:GeoModel){
  const p=model.project;
  const holes=uniqueSources(p.boreholes),cpts=uniqueSources(p.cpts??[]);
  const cptLogs=new Map(model.cptLogs.map(c=>[c.id,c]));
  const units=new Map(p.units.map(u=>[u.id,u]));
  const reviewedUnit=(unit:string):ReviewedUnit=>{
    const definition=units.get(unit),materialId=definition?.materialId??unit;
    return {unit,unitName:definition?.name??unit,materialId,materialName:units.get(materialId)?.name??materialId};
  };
  return (interval:CollarIntervalAgreement):Basis|undefined=>{
    const {kind,holeId,intervalIndex,from,to,unit}=interval;
    if(!interval.mismatchedMetres||interval.unknownMetres||!interval.discrepancies.length)return;
    const h=kind==="cpt"?cptLogs.get(holeId):holes.get(holeId);
    const layer=(kind==="cpt"?cpts.get(holeId)?.layers:h?.intervals)?.[intervalIndex];
    if(!h||!layer||layer.from!==from||layer.to!==to||layer.unit!==unit||![h.x,h.y,h.z].every(Number.isFinite))return;
    const segments:ReviewedSegment[]=[];
    for(const d of interval.discrepancies){
      if(d.reason!=="different-unit"||!d.modelledUnit)return;
      segments.push({from:d.mismatchFrom,to:d.mismatchTo,...reviewedUnit(d.modelledUnit)});
    }
    return {kind,holeId,intervalIndex,from,to,...reviewedUnit(unit),x:h.x,y:h.y,z:h.z,
      crs:p.crsProj4??p.crsCode??p.crs??"",description:layer.name??"",evidenceId:layer.evidenceId??"",segments};
  };
}

/** Index one model once when rendering a list, report or totals. A missing decision means that review is still pending. */
export function correlationAcceptanceLookup(model:GeoModel){
  const decisions=new Map(model.project.correlationAcceptances?.map(a=>[sourceKey(a),a]));
  const readBasis=decisions.size?basisReader(model):undefined;
  return (interval:CollarIntervalAgreement):CorrelationAcceptance|undefined=>{
    const saved=decisions.get(sourceKey(interval));
    if(!saved)return;
    const current=readBasis?.(interval);
    return current&&sameBasis(saved,current)?saved:undefined;
  };
}

export function correlationAcceptance(model:GeoModel,interval:CollarIntervalAgreement){
  return correlationAcceptanceLookup(model)(interval);
}

/** Record a deliberate acceptance in the editing draft. The model geometry and original observation are untouched. */
export function setCorrelationAcceptance(tables:EditorTables,model:GeoModel,interval:CollarIntervalAgreement,reason:string){
  if(!reason.trim())throw new Error("Enter a reason for accepting this collar discrepancy.");
  const sources=interval.kind==="cpt"?model.project.cpts??[]:model.project.boreholes;
  if(sources.filter(s=>s.id===interval.holeId).length!==1)
    throw new Error(`The ${interval.kind==="cpt"?"CPT":"borehole"} ID “${interval.holeId}” must identify exactly one source before its discrepancy can be accepted.`);
  const basis=basisReader(model)(interval);
  if(!basis)throw new Error("Only a logged interval with fully modelled coverage and a material discrepancy can be accepted.");
  const record={...basis,rationale:reason};
  const key=sourceKey(record),current=tables.correlationAcceptances??model.project.correlationAcceptances??[];
  tables.correlationAcceptances=[...current.filter(a=>sourceKey(a)!==key),record];
  return record;
}

const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
const named=(v:unknown):v is string=>typeof v==="string"&&!!v.trim();
function parseReviewedUnit(raw:Record<string,unknown>,path:string):ReviewedUnit{
  const {unit,unitName,materialId,materialName}=raw;
  if(!named(unit)||typeof unitName!=="string"||!named(materialId)||typeof materialName!=="string")
    throw new Error(`${path} must identify the interpreted unit and logged material.`);
  return {unit,unitName,materialId,materialName};
}

export function parseCorrelationAcceptances(value:unknown):CorrelationAcceptance[]{
  if(!Array.isArray(value))throw new Error("Correlation acceptances must be a list.");
  const keys=new Set<string>();
  return value.map((raw:unknown,i)=>{
    const path=`Correlation acceptance ${i+1}`;
    if(!obj(raw))throw new Error(`${path} must be a record.`);
    const {kind,holeId,intervalIndex,from,to,x,y,z,crs,description,evidenceId,rationale}=raw;
    if((kind!=="borehole"&&kind!=="cpt")||!named(holeId)||!finite(intervalIndex)||!Number.isSafeInteger(intervalIndex)||intervalIndex<0)
      throw new Error(`${path} must identify a source interval.`);
    if(!finite(from)||from<0||!finite(to)||to<=from||!finite(x)||!finite(y)||!finite(z)||typeof crs!=="string")
      throw new Error(`${path} has an invalid collar or logged depth range.`);
    if(typeof description!=="string"||typeof evidenceId!=="string"||!named(rationale))
      throw new Error(`${path} must include its source description, evidence reference and reason.`);
    if(!Array.isArray(raw.segments)||!raw.segments.length)throw new Error(`${path} has no model discrepancies.`);
    const segments:ReviewedSegment[]=[];
    let end=from;
    for(const segment of raw.segments){
      if(!obj(segment)||!finite(segment.from)||!finite(segment.to)||segment.from<end||segment.to<=segment.from||segment.to>to)
        throw new Error(`${path} has an invalid discrepancy depth range.`);
      segments.push({from:segment.from,to:segment.to,...parseReviewedUnit(segment,path)});
      end=segment.to;
    }
    const record:CorrelationAcceptance={kind,holeId,intervalIndex,from,to,x,y,z,crs,description,evidenceId,rationale,
      ...parseReviewedUnit(raw,path),segments};
    const key=sourceKey(record);
    if(keys.has(key))throw new Error(`Duplicate correlation acceptance for ${holeId}, ${from}–${to} m.`);
    keys.add(key);
    return record;
  });
}
