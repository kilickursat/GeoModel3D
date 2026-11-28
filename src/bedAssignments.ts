import type {Borehole,GeoProject,Interval,UnitDef} from "./schema";
import {acceptEvidenceField,changeEvidenceField,type EvidenceRecord} from "./evidence";

/** A reviewed interpretation of one source interval. Rank is a 1-based slot in the resulting Units table. */
export interface BedAssignment {
  holeId:string; from:number; to:number; materialId:string; expectedBed:string;
  bedId:string; rank:number; rationale:string; evidenceId?:string; sourceSha256?:string;
}
const sourceKey=(row:Pick<BedAssignment,"holeId"|"from"|"to">)=>JSON.stringify([row.holeId,row.from,row.to]);
const materialOf=(u:UnitDef)=>u.materialId??u.id;
const nonempty=(v:unknown):v is string=>typeof v==="string"&&!!v.trim();
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);

/** Retain review records even when subsequent edits to the project have made them historical. */
export function parseBedAssignments(input:unknown):BedAssignment[]{
  if(!Array.isArray(input))throw new Error("Bed assignments must be a list.");
  const seen=new Set<string>();
  return input.map((entry:unknown,index)=>{
    const at=`Bed assignment ${index+1}`;
    if(!entry||typeof entry!=="object"||Array.isArray(entry))throw new Error(`${at} must be a record.`);
    const {holeId,from,to,materialId,expectedBed,bedId,rank,rationale,evidenceId,sourceSha256}=entry as Record<string,unknown>;
    if(!nonempty(holeId)||!finite(from)||!finite(to)||from<0||to<=from)throw new Error(`${at} must identify a borehole and valid logged depths.`);
    if(!nonempty(materialId)||!nonempty(expectedBed)||!nonempty(bedId)||!nonempty(rationale))
      throw new Error(`${at} requires the logged material, expected bed, interpreted bed and review rationale.`);
    if(/^(unresolved|local only)$/i.test(bedId.trim()))throw new Error(`${at} must name a specific interpreted bed.`);
    if(!finite(rank)||!Number.isSafeInteger(rank)||rank<1)throw new Error(`${at} requires a positive integer bed rank.`);
    if(evidenceId!==undefined&&!nonempty(evidenceId))throw new Error(`${at} has an invalid evidence ID.`);
    if(sourceSha256!==undefined&&(typeof sourceSha256!=="string"||!/^[a-f0-9]{64}$/i.test(sourceSha256)))throw new Error(`${at} has an invalid source SHA-256.`);
    const row={holeId,from,to,materialId,expectedBed,bedId,rank,rationale:rationale.trim(),
      ...(evidenceId===undefined?{}:{evidenceId}),...(sourceSha256===undefined?{}:{sourceSha256:sourceSha256.toLowerCase()})};
    const key=sourceKey(row);
    if(seen.has(key))throw new Error(`${at} repeats an interval at ${holeId}, ${from}–${to} m.`);
    seen.add(key);
    return row;
  });
}

function sameDecision(a:BedAssignment|undefined,b:BedAssignment){
  return !!a&&a.materialId===b.materialId&&a.expectedBed===b.expectedBed&&a.bedId===b.bedId&&a.rank===b.rank&&
    a.rationale===b.rationale&&a.evidenceId===b.evidenceId&&a.sourceSha256===b.sourceSha256;
}

// A user may have edited the bed twice and returned to the same identifier. A linked
// record must still carry the submitted review after its last correction.
function evidenceConfirms(row:BedAssignment,evidence:EvidenceRecord|undefined){
  if(!evidence)return true;
  const events=evidence.fields.unit?.events??[];
  for(let i=events.length-1;i>=0;i--){
    const e=events[i];
    if(e.value===row.bedId&&e.reason===row.rationale&&
      (row.expectedBed===row.bedId?e.action==="accepted":e.action==="corrected"&&e.previous===row.expectedBed))return true;
    if(e.action==="corrected")return false;
  }
  return false;
}

interface Resolved { row:BedAssignment; log:Interval; bed:UnitDef; evidence?:EvidenceRecord; replay:boolean }

// Rows referring to different source beds can share a new bed only when its inherited
// engineering properties are unambiguous. An existing target already has its own definition.
function sameProperties(a:UnitDef,b:UnitDef){
  const aParams=a.params??{},bParams=b.params??{};
  return a.color===b.color&&a.erosive===b.erosive&&a.gamma===b.gamma&&a.gammaSat===b.gammaSat&&a.source===b.source&&
    Object.keys(aParams).length===Object.keys(bParams).length&&Object.entries(aParams).every(([k,v])=>bParams[k]===v);
}

function orderedUnits(project:GeoProject,selected:Resolved[]){
  const byId=new Map(project.units.map(unit=>[unit.id,unit]));
  if(byId.size!==project.units.length)throw new Error("The project has duplicate bed identifiers.");
  const materialIds=new Set(project.units.map(materialOf));
  const ranks=new Map<string,number>(),slots=new Map<number,UnitDef>(),created=new Set<string>();
  for(const {row,bed} of selected){
    const {rank,bedId,materialId}=row;
    if(ranks.has(bedId)&&ranks.get(bedId)!==rank||slots.has(rank)&&slots.get(rank)!.id!==bedId)
      throw new Error(`Conflicting reviewed bed ranks for ${bedId} at ${rank}.`);
    let target=byId.get(bedId);
    if(target&&materialOf(target)!==materialId||!target&&materialIds.has(bedId))
      throw new Error(`The bed identifier ${bedId} belongs to a different material.`);
    if(!target){
      target={...bed,id:bedId,name:bedId,materialId,...(bed.params?{params:{...bed.params}}:{})};
      byId.set(bedId,target);created.add(bedId);
    }else if(created.has(bedId)&&!sameProperties(bed,target)){
      throw new Error(`The source beds have different properties. Define ${bedId} before assigning them to it.`);
    }
    slots.set(rank,target);
    ranks.set(bedId,rank);
  }
  if([...slots.keys()].some(rank=>rank>byId.size))throw new Error(`A reviewed bed rank exceeds the resulting ${byId.size} project units.`);
  const remaining=project.units.filter(u=>!ranks.has(u.id));
  let next=0;
  return Array.from({length:byId.size},(_,index)=>slots.get(index+1)??remaining[next++]);
}

// A single ordered bed cannot occupy two separated depths in one hole. A gap between
// adjacent descriptions remains unknown unless the submitted interpretation provides other evidence.
function checkReviewedOrder(hole:Borehole,defined:Map<Interval,Resolved>,ranks:Map<string,number>){
  let deepest=-1,previousEnd=-Infinity,reviewedEnd=-Infinity;
  const closed=new Set<string>();
  let previousBed:string|undefined;
  for(const iv of [...hole.intervals].sort((a,b)=>a.from-b.from||a.to-b.to)){
    const selected=defined.get(iv),id=selected?.row.bedId??iv.unit,rank=ranks.get(id);
    if(selected&&iv.from<previousEnd||iv.from<reviewedEnd)throw new Error(`${hole.id}: the reviewed interval overlaps another logged interval.`);
    if(previousBed!==undefined&&(previousBed!==id||iv.from>previousEnd))closed.add(previousBed);
    if(selected){
      if(rank===undefined||rank<deepest||closed.has(id))throw new Error(`${hole.id}: ${id} at ${iv.from}–${iv.to} m conflicts with the reviewed bed order or a separate occurrence.`);
      reviewedEnd=iv.to;
    }
    if(rank!==undefined)deepest=Math.max(deepest,rank);
    previousBed=id;previousEnd=Math.max(previousEnd,iv.to);
  }
}

export function applyBedAssignments(project:GeoProject,assignments:readonly BedAssignment[]):GeoProject{
  const rows=parseBedAssignments(assignments);
  if(!rows.length)return project;
  const byUnit=new Map(project.units.map(u=>[u.id,u]));
  const previous=new Map((project.bedAssignments??[]).map(a=>[sourceKey(a),a]));
  const records=new Map(project.evidence?.records.map(r=>[r.id,r]));
  const sources=new Map(project.evidence?.sources.map(s=>[s.id,s]));
  const byHole=new Map<string,Borehole|null>();
  const byInterval=new Map<string,Interval|null>();
  const evidenceUse=new Set<string>(),shared=new Set<string>();
  for(const h of project.boreholes){
    byHole.set(h.id,byHole.has(h.id)?null:h);
    for(const interval of h.intervals){
      const key=sourceKey({holeId:h.id,from:interval.from,to:interval.to});
      byInterval.set(key,byInterval.has(key)?null:interval);
      if(interval.evidenceId){if(evidenceUse.has(interval.evidenceId))shared.add(interval.evidenceId);evidenceUse.add(interval.evidenceId)}
    }
  }
  const sourceMatches=(row:BedAssignment,log:Interval,evidence:EvidenceRecord|undefined)=>{
    const source=evidence?sources.get(evidence.sourceId):undefined,hash=source?.sha256?.toLowerCase();
    if(log.evidenceId&&(!evidence||!source||shared.has(log.evidenceId)))return false;
    if(hash!==row.sourceSha256||row.evidenceId!==undefined&&row.evidenceId!==log.evidenceId||!hash&&row.evidenceId!==log.evidenceId)return false;
    const f=evidence?.fields;
    const depth=(value:string)=>value.trim()?Number(value.trim().replace(",",".")):NaN;
    return (!f?.boreholeId||f.boreholeId.current===row.holeId)&&(!f?.from||depth(f.from.current)===log.from)&&(!f?.to||depth(f.to.current)===log.to);
  };
  const selected:Resolved[]=[],byLog=new Map<Interval,Resolved>(),checkedHoles=new Set<Borehole>();
  const selectedKeys=new Set(rows.map(sourceKey));
  const previousRanks=new Map(project.units.map((u,i)=>[u.id,i+1]));
  const historicalRanks:BedAssignment[]=[];
  // A partial worksheet may not reorder an earlier, still-current review at another collar.
  // Dormant records remain history; changing an unrelated unit must not reactivate them.
  const retained=[...previous.values()].filter(row=>!selectedKeys.has(sourceKey(row)));
  const candidates=[...rows.map(row=>({row,incoming:true})),...retained.map(row=>({row,incoming:false}))];
  for(const {row,incoming} of candidates){
    const key=sourceKey(row);
    const hole=byHole.get(row.holeId),log=byInterval.get(key);
    if(!hole||!log){
      if(incoming)throw new Error(`Missing or ambiguous logged interval at ${row.holeId}, ${row.from}–${row.to} m.`);
      continue;
    }
    const bed=byUnit.get(log.unit),evidence=log.evidenceId?records.get(log.evidenceId):undefined;
    if(!sourceMatches(row,log,evidence)){
      if(incoming)throw new Error(`${row.holeId}, ${row.from}–${row.to} m: the reviewed source evidence does not match the project.`);
      continue;
    }
    const unchanged=!!bed&&materialOf(bed)===row.materialId&&(!evidence?.fields.unit||evidence.fields.unit.current===log.unit);
    const recorded=sameDecision(previous.get(key),row);
    const inPosition=previousRanks.get(row.bedId)===row.rank;
    const confirmed=recorded&&unchanged&&log.unit===row.bedId&&evidenceConfirms(row,evidence);
    const replay=confirmed&&inPosition;
    if(!incoming&&!replay){
      if(confirmed&&!inPosition)historicalRanks.push(row);
      continue;
    }
    if(recorded&&!replay)throw new Error(`The reviewed interval or position of ${row.bedId} has changed since this assignment.`);
    if(!bed||!unchanged||!replay&&log.unit!==row.expectedBed)throw new Error(`${row.holeId}, ${row.from}–${row.to} m: the logged material or expected bed changed.`);
    const item={row,log,bed,evidence,replay};
    selected.push(item);byLog.set(log,item);checkedHoles.add(hole);
  }
  const units=orderedUnits(project,selected),ranks=new Map(units.map((u,i)=>[u.id,i]));
  for(const row of historicalRanks)if(ranks.get(row.bedId)===row.rank-1)
    throw new Error(`The proposed order would restore a stale review for ${row.holeId}, ${row.from}–${row.to} m. Review that interval explicitly.`);
  for(const hole of checkedHoles)checkReviewedOrder(hole,byLog,ranks);
  if(selected.every(s=>s.replay))return project;

  const editedEvidence=new Map<string,EvidenceRecord>();
  for(const {row,log,evidence,replay} of selected){
    if(replay)continue;
    previous.set(sourceKey(row),row);
    if(evidence){
      const field=evidence.fields.unit;
      const fields={...evidence.fields,unit:field?{...field,events:[...field.events]}:
        {original:log.unit,current:log.unit,boxes:[],status:"unreviewed" as const,events:[]}};
      const record={...evidence,fields};
      if(log.unit===row.bedId)acceptEvidenceField(record,"unit",row.rationale);
      else changeEvidenceField(record,"unit",row.bedId,row.rationale);
      editedEvidence.set(record.id,record);
    }
  }
  const changedHoles=new Set(selected.filter(s=>!s.replay&&s.log.unit!==s.row.bedId).map(s=>s.row.holeId));
  const boreholes=project.boreholes.map(h=>changedHoles.has(h.id)?{...h,intervals:h.intervals.map(iv=>{
    const id=byLog.get(iv)?.row.bedId;return id&&id!==iv.unit?{...iv,unit:id}:iv;
  })}:h);
  const evidence=project.evidence;
  return {...project,units,boreholes,bedAssignments:[...previous.values()],...(evidence&&editedEvidence.size?{evidence:{...evidence,
    records:evidence.records.map(r=>editedEvidence.get(r.id)??r)}}:{})};
}
