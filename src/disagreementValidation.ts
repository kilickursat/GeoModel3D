// Leave one physical borehole location out of every interpretation before checking its observed contact. The
// observed coverage of a selected-scenario envelope is a diagnostic; it is not a calibrated probability interval.
import type {Borehole,GeoProject} from "./schema";
import type {DisagreementCase} from "./disagreement";
import {buildGeologicalModel,GeoModel,sampleModel} from "./model";
import {compatibleCrs} from "./comparison";
import {convexHull} from "./terrain";
import {toCsv} from "./io";
import type {XY} from "./tin";

export interface DisagreementValidationOptions { unitId:string;maxHoldouts?:number }
export interface DisagreementFoldPrediction {
  caseId:string;prediction?:number;extrapolated:boolean;unavailableReason?:string;
  removedBoreholes:number;removedCpts:number;warnings?:string[];
}
export interface DisagreementValidationRow {
  id:string;x:number;y:number;logged?:number;min?:number;max?:number;referencePrediction?:number;
  referenceError?:number;rangeWidth?:number;covered?:boolean;extrapolated:boolean;
  predictions:DisagreementFoldPrediction[];missingCaseIds:string[];unavailableReason?:string;
}
export interface DisagreementValidationStats {
  nScored:number;nCovered:number;empiricalCoverage?:number;mae?:number;rmse?:number;bias?:number;meanRangeWidth?:number;
}
export interface DisagreementValidation {
  format:"geomodel3d-disagreement-validation";version:1;caseIds:string[];referenceCaseId:string;unitId:string;maxHoldouts:number;
  availableLocations:number;eligibleLocations:number;selectedLocations:number;omittedLocations:number;
  rows:DisagreementValidationRow[];summary:DisagreementValidationStats;interior:DisagreementValidationStats;
  extrapolation:DisagreementValidationStats;notes:string[];
}
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);
const epsilon=1e-6;
export const location=(p:XY)=>`${Math.round(p.x*1000)},${Math.round(p.y*1000)}`;

// A moved observation can have a co-located CPT under another ID in one interpretation. Follow the identity /
// position links to their closure so such a CPT cannot enter a fold after the matching borehole was removed.
export function locationGroups(cases:DisagreementCase[]){
  const links=new Map<string,Set<string>>();
  const connect=(a:string,b:string)=>{if(!links.has(a))links.set(a,new Set());links.get(a)!.add(b)};
  for(const c of cases)for(const [kind,logs] of [["borehole",c.project.boreholes],["cpt",c.project.cpts??[]]] as const)for(const log of logs){
    if(!finite(log.x)||!finite(log.y))continue;
    const p=`position:${location(log)}`,id=`${kind}:${log.id}`;
    connect(p,id);connect(id,p);
  }
  return (hole:XY)=>{
    const keys=new Set<string>(),boreholeIds=new Set<string>(),cptIds=new Set<string>(),seen=new Set<string>(),queue=[`position:${location(hole)}`];
    for(let at=0;at<queue.length;at++){
      const item=queue[at];if(seen.has(item))continue;seen.add(item);
      if(item.startsWith("position:"))keys.add(item.slice(9));
      else if(item.startsWith("borehole:"))boreholeIds.add(item.slice(9));
      else if(item.startsWith("cpt:"))cptIds.add(item.slice(4));
      for(const next of links.get(item)??[])if(!seen.has(next))queue.push(next);
    }
    return {keys,boreholeIds,cptIds};
  };
}

// A contact is observed only where its first, unambiguous run begins at the collar or directly follows another
// logged interval. Missing/eroded units and gap midpoints from the modelling kernel are never validation targets.
export function observedTop(hole:Borehole,project:GeoProject,unitId:string):{logged?:number;reason?:string}{
  const order=new Map(project.units.map((u,i)=>[u.id,i]));
  if(!order.has(unitId))return {reason:"The selected unit is not declared in the reference interpretation."};
  const intervals=hole.intervals.slice().sort((a,b)=>a.from-b.from||a.to-b.to);
  if(intervals.some(i=>!finite(i.from)||!finite(i.to)||i.from<0||i.to<=i.from))return {reason:"Invalid logged intervals make this contact unavailable."};
  if(intervals.some((i,k)=>k>0&&i.from<intervals[k-1].to-epsilon))return {reason:"Overlapping logged intervals make the contact ambiguous."};
  const runs=new Map<string,number>();
  intervals.forEach((i,k)=>{if(!k||i.unit!==intervals[k-1].unit||Math.abs(i.from-intervals[k-1].to)>epsilon)runs.set(i.unit,(runs.get(i.unit)??0)+1)});
  if(!runs.has(unitId))return {reason:"The selected unit's top is not logged at this reference borehole."};
  if(runs.get(unitId)!>1)return {reason:"The selected unit occurs in repeated separated runs; its top is ambiguous."};
  let highest=-1;
  for(let k=0;k<intervals.length;k++){
    const interval=intervals[k],rank=order.get(interval.unit)??-1;
    if(interval.unit===unitId){
      if(rank<highest)return {reason:"The selected unit is out of stratigraphic order; its top is ambiguous."};
      if(!k&&interval.from>epsilon)return {reason:"The log starts below the collar; this unit's top was not observed."};
      if(k&&interval.from>intervals[k-1].to+epsilon)return {reason:"An unlogged gap precedes this unit; its top was not observed."};
      const logged=hole.z-interval.from;
      return finite(logged)?{logged}:{reason:"The logged contact elevation is not finite."};
    }
    highest=Math.max(highest,rank);
  }
  return {reason:"The selected unit's top is not logged at this reference borehole."};
}

export function withinTrainingHull(model:GeoModel,point:XY):boolean{
  const hull=convexHull([...model.boreholes,...model.cptLogs]);
  if(hull.length<3)return false;
  const origin=hull[0];
  let area=0,inside=false;
  for(let i=0,j=hull.length-1;i<hull.length;j=i++)area+=(hull[j].x-origin.x)*(hull[i].y-origin.y)-(hull[j].y-origin.y)*(hull[i].x-origin.x);
  if(Math.abs(area)<=epsilon*epsilon)return false;
  for(let i=0,j=hull.length-1;i<hull.length;j=i++){
    const a=hull[j],b=hull[i],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;
    const t=l2?Math.min(1,Math.max(0,((point.x-a.x)*dx+(point.y-a.y)*dy)/l2)):0;
    if(Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy)<=epsilon)return true;
    if((a.y>point.y)!==(b.y>point.y)&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
  }
  return inside;
}

function subset(holes:Borehole[],cap:number):Borehole[]{
  const sorted=holes.slice().sort((a,b)=>a.x-b.x||a.y-b.y||a.id.localeCompare(b.id));
  if(sorted.length<=cap)return sorted;
  const centre={x:sorted.reduce((s,b)=>s+b.x,0)/sorted.length,y:sorted.reduce((s,b)=>s+b.y,0)/sorted.length};
  const selected:Borehole[]=[];
  let seed=sorted[0];
  for(const hole of sorted)if(Math.hypot(hole.x-centre.x,hole.y-centre.y)<Math.hypot(seed.x-centre.x,seed.y-centre.y)-epsilon)seed=hole;
  selected.push(seed);
  const available=new Set(sorted.filter(hole=>hole!==seed));
  while(selected.length<cap){
    let best:Borehole|undefined,distance=-1;
    for(const hole of sorted){
      if(!available.has(hole))continue;
      const d=Math.min(...selected.map(p=>Math.hypot(hole.x-p.x,hole.y-p.y)));
      if(d>distance+epsilon){best=hole;distance=d}
    }
    if(!best)break;
    selected.push(best);available.delete(best);
  }
  return selected.sort((a,b)=>a.x-b.x||a.y-b.y||a.id.localeCompare(b.id));
}

function stats(rows:DisagreementValidationRow[]):DisagreementValidationStats{
  const scored=rows.filter(r=>r.covered!==undefined&&finite(r.referenceError)&&finite(r.rangeWidth));
  const nScored=scored.length,nCovered=scored.filter(r=>r.covered).length;
  if(!nScored)return {nScored,nCovered};
  return {nScored,nCovered,empiricalCoverage:nCovered/nScored,
    mae:scored.reduce((s,r)=>s+Math.abs(r.referenceError!)/nScored,0),
    rmse:Math.hypot(...scored.map(r=>r.referenceError!/Math.sqrt(nScored))),
    bias:scored.reduce((s,r)=>s+r.referenceError!/nScored,0),
    meanRangeWidth:scored.reduce((s,r)=>s+r.rangeWidth!/nScored,0)};
}

export function validateDisagreement(cases:DisagreementCase[],options:DisagreementValidationOptions):DisagreementValidation{
  if(cases.length<2||cases.length>6)throw new Error("Select two to six interpretations for held-out validation.");
  if(cases.some(c=>!c.id?.trim())||new Set(cases.map(c=>c.id)).size!==cases.length)throw new Error("Interpretation IDs must be nonempty and unique for held-out validation.");
  if(typeof options.unitId!=="string"||!options.unitId.trim())throw new Error("Choose a stable unit ID for held-out validation.");
  const maxHoldouts=options.maxHoldouts??12;
  if(!Number.isInteger(maxHoldouts)||maxHoldouts<1||maxHoldouts>24)throw new Error("The held-out location limit must be an integer from 1 to 24.");
  for(const c of cases){
    compatibleCrs(cases[0].project,c.project);
    if(new Set(c.project.units.map(u=>u.id)).size!==c.project.units.length)throw new Error("Unit IDs must be unique for held-out validation.");
    for(const [name,logs] of [["Borehole",c.project.boreholes],["CPT",c.project.cpts??[]]] as const)if(new Set(logs.map(log=>log.id)).size!==logs.length)throw new Error(`${name} IDs must be unique within each interpretation for held-out validation.`);
  }
  const caseIds=cases.map(c=>c.id),reference=cases[0],notes=[
    "Each selected reference borehole is held out of every interpretation before prediction. All linked boreholes/CPTs are removed: rounded 1 mm positions connect co-located records, and matching record IDs connect their positions across interpretations, including moved collars and co-located records at those moved positions. Renamed and relocated observations without a shared identity or position link cannot be identified automatically.",
    "Reference targets are directly observed raw tops of the selected stable unit ID. Gap contacts, partial starts, overlapping intervals and repeated or out-of-order tops are unavailable, not inferred observations.",
    "Fold models retain their supplied extent and are not extended to reach a held-out location. The probe-node calculation evaluates the remaining model at the requested point without building its full refined mesh; terrain/erosion are evaluated there as in the existing cross-validation method.",
    "An envelope is scored only when every selected interpretation supplies a finite held-out prediction and the reference top is observed. Missing predictions do not become zero widths, successes or failures in the coverage denominator.",
    "Reference error is the first interpretation's held-out prediction minus the observed contact elevation. MAE, RMSE and bias use only fully scored envelope rows.",
    "Interior rows are within the observation hulls of all remaining admitted model logs, including hull boundaries. Extrapolation rows are outside at least one training hull; configured and automatic model margins do not create observation support.",
    "Observed envelope coverage is a descriptive held-out fraction, not a calibrated probability, confidence interval or guarantee at unobserved locations. Sites and folds are spatially dependent, and small denominators are shown explicitly.",
    "Validation is conditional on the supplied interpretations, unit definitions/order, rules, external terrain and other fixed assumptions. It cannot undo information already embedded in those assumptions or a terrain grid derived from held-out observations."];
  let holes:Borehole[]=[];
  try{
    const probe=reference.project.boreholes.find(b=>finite(b.x)&&finite(b.y));
    holes=buildGeologicalModel(reference.project,{probe:probe??{x:0,y:0}}).boreholes;
  }catch(error){notes.push(`The reference interpretation could not build: ${error instanceof Error?error.message:String(error)}. No locations were scored.`)}
  const selected=subset(holes,maxHoldouts),eligibleLocations=holes.filter(hole=>observedTop(hole,reference.project,options.unitId).logged!==undefined).length;
  if(selected.length<holes.length)notes.push(`The held-out limit selected ${selected.length} of ${holes.length} admitted reference boreholes. Selection starts nearest the collar centroid, then spreads by farthest horizontal distance; it precedes contact eligibility checks and does not use residuals. Observations of rare-unit tops may be omitted. The validation does not cover omitted locations.`);
  if(!holes.length)notes.push("There are no admitted reference borehole locations to hold out. CPT interpretations alone are not treated as independent borehole observations.");
  const groupFor=locationGroups(cases);
  const rows=selected.map((hole):DisagreementValidationRow=>{
    const observed=observedTop(hole,reference.project,options.unitId),{keys,boreholeIds,cptIds}=groupFor(hole);
    const row:DisagreementValidationRow={id:hole.id,x:hole.x,y:hole.y,...(observed.logged===undefined?{}:{logged:observed.logged}),
      extrapolated:true,predictions:[],missingCaseIds:[...caseIds]};
    if(observed.logged===undefined){row.unavailableReason=observed.reason;return row}
    row.predictions=cases.map(c=>{
      const remainingBoreholes=c.project.boreholes.filter(b=>!keys.has(location(b))&&!boreholeIds.has(b.id));
      const remainingCpts=(c.project.cpts??[]).filter(p=>!keys.has(location(p))&&!cptIds.has(p.id));
      const result:DisagreementFoldPrediction={caseId:c.id,extrapolated:true,removedBoreholes:c.project.boreholes.length-remainingBoreholes.length,removedCpts:(c.project.cpts??[]).length-remainingCpts.length};
      try{
        const training:GeoProject={...c.project,boreholes:remainingBoreholes,...(c.project.cpts?{cpts:remainingCpts}:{})};
        const model=buildGeologicalModel(training,{probe:hole});
        result.extrapolated=!withinTrainingHull(model,hole);
        if(model.warnings.length)result.warnings=model.warnings;
        if(!model.boreholes.length&&!model.cptLogs.length){result.unavailableReason="No admitted training logs remain after removing this location.";return result}
        const k=model.units.findIndex(unit=>unit.id===options.unitId);
        if(k<0){result.unavailableReason="The selected unit is absent from this fold's training model.";return result}
        const column=sampleModel(model,hole.x,hole.y),value=column?.[k];
        if(!finite(value)){result.unavailableReason="The held-out collar is outside this fold's usable model footprint.";return result}
        result.prediction=value;
      }catch(error){result.unavailableReason=`The fold could not build: ${error instanceof Error?error.message:String(error)}`}
      return result;
    });
    row.extrapolated=row.predictions.some(p=>p.extrapolated);
    row.missingCaseIds=row.predictions.filter(p=>p.prediction===undefined).map(p=>p.caseId);
    const first=row.predictions[0].prediction;
    if(first!==undefined){row.referencePrediction=first;const error=first-observed.logged;if(finite(error))row.referenceError=error}
    if(row.missingCaseIds.length){row.unavailableReason="At least one selected interpretation lacks a usable held-out prediction; this row is excluded from envelope coverage.";return row}
    const values=row.predictions.map(p=>p.prediction!),min=Math.min(...values),max=Math.max(...values),width=max-min;
    if(!finite(width)||!finite(row.referenceError)){row.unavailableReason="Derived envelope width or reference error is not finite.";return row}
    row.min=min;row.max=max;row.rangeWidth=width;row.covered=observed.logged>=min-epsilon&&observed.logged<=max+epsilon;
    return row;
  });
  return {format:"geomodel3d-disagreement-validation",version:1,caseIds,referenceCaseId:reference.id,unitId:options.unitId,maxHoldouts,
    availableLocations:holes.length,eligibleLocations,selectedLocations:selected.length,omittedLocations:holes.length-selected.length,rows,
    summary:stats(rows),interior:stats(rows.filter(r=>!r.extrapolated)),extrapolation:stats(rows.filter(r=>r.extrapolated)),notes};
}

export function validationCsv(result:DisagreementValidation):string{
  const header=["borehole_id","x_m","y_m","logged_elevation_m","min_elevation_m","max_elevation_m","range_width_m","reference_prediction_m","reference_error_m","covered","extrapolated","missing_case_ids","unavailable_reason","predictions","unit_id","reference_case_id","case_ids","max_holdouts","available_locations","eligible_locations","selected_locations","omitted_locations","review_notes"];
  const meta=[result.unitId,result.referenceCaseId,JSON.stringify(result.caseIds),result.maxHoldouts,result.availableLocations,result.eligibleLocations,result.selectedLocations,result.omittedLocations,JSON.stringify(result.notes)];
  const rows=result.rows.map(row=>[row.id,row.x,row.y,row.logged,row.min,row.max,row.rangeWidth,row.referencePrediction,row.referenceError,
    row.covered===undefined?undefined:String(row.covered),String(row.extrapolated),JSON.stringify(row.missingCaseIds),row.unavailableReason,JSON.stringify(row.predictions),...meta]);
  if(!rows.length)rows.push([...Array(14).fill(""),...meta]);
  return toCsv([header,...rows]);
}
