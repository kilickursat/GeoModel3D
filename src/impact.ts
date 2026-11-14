// Test a fixed model's predictions against boreholes that were not present in that revision. The updated model
// supplies a separate interpretation shift, never a validation score: it was built using the new observations.
import type {Borehole,Cpt,GeoProject,Interval} from "./schema";
import {buildGeologicalModel,GeoModel,sampleModel} from "./model";
import {compatibleCrs} from "./comparison";
import {toCsv} from "./io";

export interface InputChanges { added:string[];removed:string[];modified:string[];unchanged:string[] }
export interface ImpactContact {
  unitId:string;unitName:string;logged:number;before?:number;after?:number;
  predictionError?:number;modelShift?:number;unavailableReason?:string;
}
export interface AddedBoreholeImpact {
  id:string;x:number;y:number;z:number;beforeInside:boolean;afterInside:boolean;previouslyObserved?:boolean;
  ground:ImpactContact;contacts:ImpactContact[];loggedLength:number;comparedLength:number;matchingLength:number;
  maxAbsContactError?:number;notes:string[];
}
export interface DataImpactReview {
  format:"geomodel3d-data-impact";version:1;beforeName:string;afterName:string;
  boreholes:InputChanges;cpts:InputChanges;otherChanges:string[];additions:AddedBoreholeImpact[];
  summary:{addedBoreholes:number;reviewedBoreholes:number;outsideBefore:number;comparedContacts:number;
    maxAbsContactError?:number;loggedLength:number;comparedLength:number;matchingLength:number};
  notes:string[];
}
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);
const epsilon=1e-6;
// Object key order and provenance do not change an input. Sequences that encode sampling or rule precedence keep
// their order; only lists whose order is cosmetic (such as logged intervals) are sorted by their content.
function canonical(value:unknown):string{
  function clean(v:unknown):unknown{
    if(Array.isArray(v))return v.map(clean);
    if(v&&typeof v==="object")return Object.fromEntries(Object.entries(v).filter(([k,w])=>w!==undefined&&k!=="evidenceId"&&k!=="evidence"&&k!=="source").sort(([a],[b])=>a.localeCompare(b)).map(([k,w])=>[k,clean(w)]));
    return v;
  }
  return JSON.stringify(clean(value));
}
const sorted=(list:unknown[]|undefined)=>(list??[]).map(v=>canonical(v)).sort();
function boreholeValue(b:Borehole){return canonical({...b,intervals:sorted(b.intervals),water:sorted(b.water),spt:sorted(b.spt),tests:sorted(b.tests)})}
function cptValue(c:Cpt){return canonical({...c,layers:sorted(c.layers)})}
function inventory<T extends {id:string}>(before:T[],after:T[],value:(item:T)=>string,kind:string):InputChanges{
  for(const [name,list] of [["Before",before],["After",after]] as const){
    if(list.some(item=>!item.id.trim()))throw new Error(`${name}: ${kind} IDs must not be empty.`);
    if(new Set(list.map(item=>item.id)).size!==list.length)throw new Error(`${name}: ${kind} IDs must be unique for an impact review.`);
  }
  const a=new Map(before.map(item=>[item.id,item])),b=new Map(after.map(item=>[item.id,item]));
  const ids=[...new Set([...a.keys(),...b.keys()])].sort(),result:InputChanges={added:[],removed:[],modified:[],unchanged:[]};
  for(const id of ids){
    const first=a.get(id),last=b.get(id);
    result[!first?"added":!last?"removed":value(first)===value(last)?"unchanged":"modified"].push(id);
  }
  return result;
}
function changes(before:GeoProject,after:GeoProject):string[]{
  const groups:[string,unknown,unknown][]=[
    ["Unit definitions or stratigraphic order",before.units,after.units],
    ["Unit assignment rules",before.rules??[],after.rules??[]],
    ["CPT layer rules",before.cptRules??[],after.cptRules??[]],
    ["Terrain grid",before.terrain,after.terrain],
    ["Model base elevation",before.base,after.base],
    ["Model extent (margin)",before.margin??0,after.margin??0],
    ["CPT layers in model",before.cptLayers??false,after.cptLayers??false],
    ["Groundwater policy or fallback depth",[before.groundwater??{mode:"observed"},before.groundwaterDepth],[after.groundwater??{mode:"observed"},after.groundwaterDepth]],
    ["Reference alignments or design levels",before.alignments??[],after.alignments??[]]
  ];
  const result=groups.filter(([,a,b])=>canonical(a)!==canonical(b)).map(([name])=>name);
  const reordered=(a:{id:string}[],b:{id:string}[])=>{
    const first=new Set(a.map(i=>i.id)),last=new Set(b.map(i=>i.id));
    return canonical(a.filter(i=>last.has(i.id)).map(i=>i.id))!==canonical(b.filter(i=>first.has(i.id)).map(i=>i.id));
  };
  if(reordered(before.boreholes,after.boreholes)||reordered(before.cpts??[],after.cpts??[]))result.push("Borehole/CPT model input order");
  return result;
}
function levels(model:GeoModel,b:Borehole):number[]|undefined{
  if(![b.x,b.y,b.z].every(finite))return;
  const z=sampleModel(model,b.x,b.y);
  return z?.length&&z.every(finite)?z:undefined;
}
function metric(unitId:string,unitName:string,logged:number,a:number|undefined,b:number|undefined,reason?:string,keepShift=false):ImpactContact{
  return {unitId,unitName,logged,...(finite(a)?{before:a}:{}),...(finite(b)?{after:b}:{}),
    ...(!reason&&finite(a)?{predictionError:a-logged}:{}),
    ...((!reason||keepShift)&&finite(a)&&finite(b)?{modelShift:b-a}:{}),...(reason?{unavailableReason:reason}:{})};
}
function reviewHole(hole:Borehole,before:GeoModel,after:GeoModel,project:GeoProject):AddedBoreholeImpact{
  const a=levels(before,hole),b=levels(after,hole),notes:string[]=[],names=new Map(project.units.map(u=>[u.id,u.name]));
  const beforeIds=new Map(before.units.map((u,k)=>[u.id,k])),afterIds=new Map(after.units.map((u,k)=>[u.id,k]));
  const at=(z:number[]|undefined,ids:Map<string,number>,id:string)=>{const k=ids.get(id);return z&&k!==undefined?z[k]:undefined};
  const valid=hole.intervals.filter(i=>finite(i.from)&&finite(i.to)&&i.to>i.from&&i.from>=0).slice().sort((p,q)=>p.from-q.from||p.to-q.to);
  if(valid.length!==hole.intervals.length)notes.push("Invalid or non-positive logged intervals were excluded.");
  const overlaps=valid.some((i,k)=>k>0&&i.from<valid[k-1].to-epsilon);
  if(overlaps)notes.push("Overlapping intervals make contact observations and logged-length agreement ambiguous; those metrics are unavailable.");
  const collarKey=(p:{x:number;y:number})=>`${Math.round(p.x*1000)},${Math.round(p.y*1000)}`;
  const previouslyObserved=[...before.boreholes,...before.cptLogs].some(item=>collarKey(item)===collarKey(hole));
  const priorReason="This collar was already used by the before model under another log ID; it is not an independent new observation.";
  if(previouslyObserved)notes.push(priorReason+" Prediction errors and agreement are withheld; any model shift is still reported.");
  const runCounts=new Map<string,number>();
  valid.forEach((i,k)=>{if(!k||i.unit!==valid[k-1].unit||Math.abs(i.from-valid[k-1].to)>epsilon)runCounts.set(i.unit,(runCounts.get(i.unit)??0)+1)});
  const contacts:ImpactContact[]=[],seen=new Set<string>();
  let previous:Interval|undefined,previousOrder=-1;
  for(const interval of valid){
    const order=project.units.findIndex(u=>u.id===interval.unit),same=previous?.unit===interval.unit&&Math.abs(previous.to-interval.from)<=epsilon;
    if(!same){
      let reason:string|undefined;
      if(overlaps)reason="Overlapping logged intervals.";
      else if(!names.has(interval.unit))reason="Logged unit is not declared in the updated project.";
      else if((runCounts.get(interval.unit)??0)>1||seen.has(interval.unit)||order<previousOrder)reason="Repeated or out-of-order unit; its top contact is ambiguous.";
      else if(!previous&&interval.from>epsilon)reason="Log begins below the collar; the unit's top was not observed.";
      else if(previous&&interval.from>previous.to+epsilon)reason="Unlogged gap above this interval; the unit's top was not observed.";
      else if(!a)reason="Outside the before model's footprint or no usable baseline model.";
      else if(!beforeIds.has(interval.unit))reason="Unit is absent from the before model.";
      else if(previouslyObserved)reason=priorReason;
      const first=at(a,beforeIds,interval.unit),last=at(b,afterIds,interval.unit);
      contacts.push(metric(interval.unit,names.get(interval.unit)??interval.unit,hole.z-interval.from,first,last,reason,reason===priorReason));
      seen.add(interval.unit);
    }
    previous=interval;previousOrder=Math.max(previousOrder,order);
  }
  if(!a)notes.push("The before model does not cover this collar. Predictions and interpretation shifts are unavailable; its footprint was not extended.");
  if(!b)notes.push("The updated model does not cover this collar.");
  if(!after.boreholes.some(item=>item.id===hole.id))notes.push("The updated model did not use this borehole; check coincident collars, positions and unit assignments. Updated values are model samples, not an asserted fit to this log.");
  const ground=metric("__ground__","Ground",hole.z,a?.[0],b?.[0],a?(previouslyObserved?priorReason:undefined):"Outside the before model's footprint or no usable baseline model.",previouslyObserved);
  // Compare only actually logged, non-overlapping metres within the unchanged baseline's vertical range. Gaps,
  // undeclared units and depths outside that model never become inferred matches or zero-length confidence scores.
  let loggedLength=0,comparedLength=0,matchingLength=0;
  if(!overlaps)for(const interval of valid){
    loggedLength+=interval.to-interval.from;
    if(!a||previouslyObserved||!names.has(interval.unit))continue;
    const top=Math.min(hole.z-interval.from,a[0]),bottom=Math.max(hole.z-interval.to,a[a.length-1]);
    if(!(top>bottom))continue;
    comparedLength+=top-bottom;
    const k=beforeIds.get(interval.unit);
    if(k!==undefined)matchingLength+=Math.max(0,Math.min(top,a[k])-Math.max(bottom,a[k+1]));
  }
  if(valid.some((i,k)=>i.from>(k?valid[k-1].to:0)+epsilon))notes.push("Unlogged gaps and the interval above a partial log are excluded from logged-length agreement; tops following them are not observed contacts.");
  if(a&&!previouslyObserved&&loggedLength>comparedLength+epsilon)notes.push("Some logged metres are outside the before model's vertical range or use undeclared units; only shared, declared logged metres are compared.");
  const errors=contacts.flatMap(c=>c.predictionError===undefined?[]:[Math.abs(c.predictionError)]);
  return {id:hole.id,x:hole.x,y:hole.y,z:hole.z,beforeInside:!!a,afterInside:!!b,...(previouslyObserved?{previouslyObserved:true}:{}),ground,contacts,loggedLength,comparedLength,matchingLength,
    ...(errors.length?{maxAbsContactError:Math.max(...errors)}:{}),notes};
}
export function reviewDataImpact(before:GeoProject,after:GeoProject):DataImpactReview{
  compatibleCrs(before,after);
  for(const [label,project] of [["Before",before],["After",after]] as const)if(new Set(project.units.map(u=>u.id)).size!==project.units.length)throw new Error(`${label}: unit IDs must be unique for an impact review.`);
  const boreholes=inventory(before.boreholes,after.boreholes,boreholeValue,"borehole"),cpts=inventory(before.cpts??[],after.cpts??[],cptValue,"CPT"),otherChanges=changes(before,after);
  const notes=["Predictions sample the unchanged before model at newly added borehole collars, using its actual model footprint. The model is not extended or refitted to these observations.",
    "The actual model footprint may include configured or automatic margin extensions. Being inside it does not establish prior observation support.",
    "Prediction error is before prediction minus newly logged elevation. Interpretation shift is updated model minus before model at the same collar; it is not validation of the updated model.",
    "Contacts are actual, directly observed tops paired by stable unit ID. Tops after unlogged gaps, below a partial start or in ambiguous repeated units are unavailable.",
    "New IDs at collars already used by the before model may be renamed or duplicate logs. Their prediction errors and agreement are withheld; they are not independent new observations.",
    "Logged-length agreement compares known logged intervals only over the before model's vertical range. It is not statistical confidence or an uncertainty estimate.",
    "Elevations use the supplied datum. Confirm a common vertical datum; matching coordinate-system names alone cannot verify it."];
  if(boreholes.modified.length||boreholes.removed.length||cpts.modified.length||cpts.removed.length||cpts.added.length||otherChanges.length)notes.push("Other inputs or assumptions changed as well. Interpretation shifts cannot be attributed solely to the added boreholes.");
  else if(boreholes.added.length)notes.push("Only boreholes were added among the reviewed model inputs. Their joint interpretation change is not an estimate of each borehole's individual influence.");
  if(cpts.added.length)notes.push("Added CPTs are listed in the input register. This review evaluates new borehole logs only, not predictions against CPT-derived layer interpretations.");
  let additions:AddedBoreholeImpact[]=[];
  if(boreholes.added.length){
    const a=buildGeologicalModel(before),b=buildGeologicalModel(after),added=new Set(boreholes.added);
    additions=after.boreholes.filter(hole=>added.has(hole.id)).map(hole=>reviewHole(hole,a,b,after)).sort((a,b)=>a.id.localeCompare(b.id));
    notes.push(...a.warnings.map(w=>`Before model: ${w}`),...b.warnings.map(w=>`Updated model: ${w}`));
  }else notes.push("No new borehole IDs were added. Changed or renamed existing logs are listed in the register, not treated as new independent observations.");
  const contacts=additions.flatMap(h=>h.contacts).filter(c=>c.predictionError!==undefined),errors=contacts.map(c=>Math.abs(c.predictionError!));
  return {format:"geomodel3d-data-impact",version:1,beforeName:before.name,afterName:after.name,boreholes,cpts,otherChanges,additions,
    summary:{addedBoreholes:boreholes.added.length,reviewedBoreholes:additions.filter(h=>h.beforeInside&&!h.previouslyObserved).length,outsideBefore:additions.filter(h=>!h.beforeInside).length,
      comparedContacts:contacts.length,...(errors.length?{maxAbsContactError:Math.max(...errors)}:{}),
      loggedLength:additions.reduce((s,h)=>s+h.loggedLength,0),comparedLength:additions.reduce((s,h)=>s+h.comparedLength,0),matchingLength:additions.reduce((s,h)=>s+h.matchingLength,0)},notes};
}
export function impactCsv(result:DataImpactReview):string{
  const header=["borehole_id","x_m","y_m","before_inside","after_inside","surface","unit_id","logged_elevation_m","before_elevation_m","after_elevation_m","prediction_error_m","model_shift_m","unavailable_reason","logged_length_m","compared_length_m","matching_length_m"];
  const metadataNames=["before_project","after_project",...(["boreholes","cpts"] as const).flatMap(kind=>["added","removed","modified","unchanged"].map(change=>`${change}_${kind}_ids`)),"other_changes","review_notes","previously_observed_collar","borehole_notes"];
  const metadata=[result.beforeName,result.afterName,...(["boreholes","cpts"] as const).flatMap(kind=>(["added","removed","modified","unchanged"] as const).map(change=>JSON.stringify(result[kind][change]))),JSON.stringify(result.otherChanges),JSON.stringify(result.notes)];
  const rows=result.additions.flatMap(hole=>[hole.ground,...hole.contacts].map(c=>[hole.id,hole.x,hole.y,String(hole.beforeInside),String(hole.afterInside),c.unitName,c.unitId,c.logged,c.before,c.after,c.predictionError,c.modelShift,c.unavailableReason,hole.loggedLength,hole.comparedLength,hole.matchingLength,...metadata,String(!!hole.previouslyObserved),JSON.stringify(hole.notes)]));
  // An inventory-only review still needs one row so pinned metadata and the change register survive the export.
  if(!rows.length)rows.push([...Array(header.length).fill(""),...metadata,"",""]);
  return toCsv([[...header,...metadataNames],...rows]);
}
