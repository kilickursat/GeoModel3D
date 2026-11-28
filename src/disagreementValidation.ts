// Leave one physical borehole location out of every interpretation before checking its observed contact. The
// observed coverage of a selected-scenario envelope is a diagnostic; it is not a calibrated probability interval.
import type {Borehole,GeoProject} from "./schema";
import type {DisagreementCase} from "./disagreement";
import {buildGeologicalModel,GeoModel,sampleModel} from "./model";
import {compatibleCrs} from "./comparison";
import {convexHull} from "./terrain";
import {toCsv} from "./io";
import {bedPredictionIssue,bedPredictionSupport,cachedBedTops,loggedBedTops} from "./observedContacts";
import type {XY} from "./tin";

export interface DisagreementValidationOptions { unitId:string;maxHoldouts?:number;groupRadius?:number }
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
  format:"geomodel3d-disagreement-validation";version:1;caseIds:string[];referenceCaseId:string;unitId:string;maxHoldouts:number;groupRadius:number;
  availableLocations:number;eligibleLocations:number;selectedLocations:number;omittedLocations:number;
  rows:DisagreementValidationRow[];summary:DisagreementValidationStats;interior:DisagreementValidationStats;
  extrapolation:DisagreementValidationStats;notes:string[];
}
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);
const epsilon=1e-6;
export const location=(p:XY)=>`${Math.round(p.x*1000)},${Math.round(p.y*1000)}`;

// Logs closer than this are one location for held-out checks and calibration splits: a CPT pushed a few metres from
// a borehole nearly fixes that borehole's contacts, so leaving only one of them out would score a near-observation.
export const DEFAULT_GROUP_RADIUS=5;
export function groupRadius(value:unknown=DEFAULT_GROUP_RADIUS):number{
  if(typeof value!=="number"||!Number.isFinite(value)||value<0||value>1000)throw new Error("The log grouping distance must be from 0 to 1000 m.");
  return value;
}

// A moved observation can have a co-located CPT under another ID in one interpretation. Follow the identity /
// position links to their closure so such a CPT cannot enter a fold after the matching borehole was removed.
// Positions within the grouping radius are linked too, and links chain (single linkage): a group can be wider than
// the radius where logs form a chain. A radius of 0 links only identical positions (to 1 mm) and matching IDs.
interface LocationGroup {keys:ReadonlySet<string>;boreholeIds:ReadonlySet<string>;cptIds:ReadonlySet<string>}
export function locationGroups(cases:DisagreementCase[],radius=0){
  // Keep component membership, not every edge: a dense group otherwise needs quadratic adjacency storage and
  // calibration repeatedly walks that same graph for each of its reference logs.
  const nodes=new Map<string,number>(),parents:number[]=[],sizes:number[]=[];
  const positions=new Map<string,XY&{node:number}>();
  const node=(key:string)=>{let index=nodes.get(key);if(index===undefined){index=parents.length;nodes.set(key,index);parents.push(index);sizes.push(1)}return index};
  const root=(index:number)=>{while(parents[index]!==index){parents[index]=parents[parents[index]];index=parents[index]}return index};
  const join=(a:number,b:number)=>{a=root(a);b=root(b);if(a===b)return;if(sizes[a]<sizes[b])[a,b]=[b,a];parents[b]=a;sizes[a]+=sizes[b]};
  for(const c of cases)for(const [kind,logs] of [["borehole",c.project.boreholes],["cpt",c.project.cpts??[]]] as const)for(const log of logs){
    if(!finite(log.x)||!finite(log.y))continue;
    const key=location(log),position=node(`position:${key}`);
    if(!positions.has(key))positions.set(key,{x:log.x,y:log.y,node:position});
    join(position,node(`${kind}:${log.id}`));
  }
  if(radius>0){
    const cell=(v:number)=>Math.floor(v/radius),buckets=new Map<string,Array<XY&{node:number}>>();
    for(const p of positions.values()){
      const x=cell(p.x),y=cell(p.y);
      // Compare with earlier positions only. An already connected pair cannot change the component.
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const q of buckets.get(`${x+dx},${y+dy}`)??[]){
        if(root(p.node)!==root(q.node)&&Math.hypot(p.x-q.x,p.y-q.y)<=radius+1e-9)join(p.node,q.node);
      }
      const bucket=`${x},${y}`;if(!buckets.has(bucket))buckets.set(bucket,[]);buckets.get(bucket)!.push(p);
    }
  }
  const groups=new Map<number,{keys:Set<string>;boreholeIds:Set<string>;cptIds:Set<string>}>(),byPosition=new Map<string,LocationGroup>();
  for(const [key,index] of nodes){
    const component=root(index);let group=groups.get(component);
    if(!group){group={keys:new Set(),boreholeIds:new Set(),cptIds:new Set()};groups.set(component,group)}
    if(key.startsWith("position:")){group.keys.add(key.slice(9));byPosition.set(key.slice(9),group)}
    else if(key.startsWith("borehole:"))group.boreholeIds.add(key.slice(9));
    else group.cptIds.add(key.slice(4));
  };
  // Every known member gets the same read-only component; callers must not mutate shared membership sets.
  return (hole:XY):LocationGroup=>byPosition.get(location(hole))??{keys:new Set([location(hole)]),boreholeIds:new Set(),cptIds:new Set()};
}

// A contact is observed only where its first, unambiguous run begins at the collar or directly follows another
// logged interval. Missing/eroded units and gap midpoints from the modelling kernel are never validation targets.
export function observedTop(hole:Borehole,project:GeoProject,unitId:string):{logged?:number;reason?:string}{
  const order=new Map(project.units.map((u,i)=>[u.id,i]));
  if(!order.has(unitId))return {reason:"The selected unit is not declared in the reference interpretation."};
  const {tops,problem}=loggedBedTops(hole,order);
  return problem?{reason:problem}:tops.get(unitId)??{reason:"The selected unit's top is not logged at this reference borehole."};
}

const trainingHulls=new WeakMap<GeoModel,XY[]>();
export function withinTrainingHull(model:GeoModel,point:XY):boolean{
  let hull=trainingHulls.get(model);
  if(!hull){
    hull=convexHull([...model.boreholes,...model.cptLogs]);
    const origin=hull[0];
    let area=0;
    for(let i=0,j=hull.length-1;i<hull.length;j=i++)area+=(hull[j].x-origin.x)*(hull[i].y-origin.y)-(hull[j].y-origin.y)*(hull[i].x-origin.x);
    if(Math.abs(area)<=epsilon*epsilon)hull=[];
    trainingHulls.set(model,hull);
  }
  if(hull.length<3)return false;
  let inside=false;
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
  const maxHoldouts=options.maxHoldouts??12,radius=groupRadius(options.groupRadius);
  if(!Number.isInteger(maxHoldouts)||maxHoldouts<1||maxHoldouts>24)throw new Error("The held-out location limit must be an integer from 1 to 24.");
  for(const c of cases){
    compatibleCrs(cases[0].project,c.project);
    if(new Set(c.project.units.map(u=>u.id)).size!==c.project.units.length)throw new Error("Unit IDs must be unique for held-out validation.");
    for(const [name,logs] of [["Borehole",c.project.boreholes],["CPT",c.project.cpts??[]]] as const)if(new Set(logs.map(log=>log.id)).size!==logs.length)throw new Error(`${name} IDs must be unique within each interpretation for held-out validation.`);
  }
  const caseIds=cases.map(c=>c.id),reference=cases[0],notes=[
    radius>0?`Logs within ${radius} m of each other in plan are one location: holding out a borehole also removes every borehole and CPT linked to it within that distance, and such links chain.`:"The log grouping distance is 0: only records at the same position (to 1 mm) or with matching IDs are removed together.",
    "Each selected reference borehole is held out of every interpretation before prediction. All linked boreholes/CPTs are removed: rounded 1 mm positions connect co-located records, and matching record IDs connect their positions across interpretations, including moved collars and co-located records at those moved positions. Renamed and relocated observations without a shared identity or position link cannot be identified automatically.",
    "Reference targets are directly observed raw tops of the selected stable unit ID. Gap contacts, partial starts, overlapping intervals and repeated or out-of-order tops are unavailable, not inferred observations.",
    "Fold models retain their supplied extent and are not extended to reach a held-out location. The probe-node calculation evaluates the remaining model at the requested point without building its full refined mesh; terrain/erosion are evaluated there as in the existing cross-validation method.",
    "Each fitted interpretation must contain a directly observed top and no unresolved repeated or out-of-order run of the selected bed. The bed must have positive modelled thickness at the held-out location. Every interpretation must supply a prediction to score the envelope.",
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
  const groupFor=locationGroups(cases,radius);
  const observations=cases.map(c=>cachedBedTops(c.project.units));
  const rows=selected.map((hole):DisagreementValidationRow=>{
    const observed=observedTop(hole,reference.project,options.unitId),{keys,boreholeIds,cptIds}=groupFor(hole);
    const row:DisagreementValidationRow={id:hole.id,x:hole.x,y:hole.y,...(observed.logged===undefined?{}:{logged:observed.logged}),
      extrapolated:true,predictions:[],missingCaseIds:[...caseIds]};
    if(observed.logged===undefined){row.unavailableReason=observed.reason;return row}
    row.predictions=cases.map((c,caseIndex)=>{
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
        const issue=bedPredictionIssue(bedPredictionSupport(model,observations[caseIndex]),options.unitId,k,column);
        if(issue){
          result.unavailableReason={
            ambiguity:"The selected bed has repeated or out-of-order runs in the training logs.",
            training:"No admitted training log records a directly observed top for the selected bed.",
            prediction:"The selected bed lacks positive modelled thickness at this location."
          }[issue];
          return result;
        }
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
  return {format:"geomodel3d-disagreement-validation",version:1,caseIds,referenceCaseId:reference.id,unitId:options.unitId,maxHoldouts,groupRadius:radius,
    availableLocations:holes.length,eligibleLocations,selectedLocations:selected.length,omittedLocations:holes.length-selected.length,rows,
    summary:stats(rows),interior:stats(rows.filter(r=>!r.extrapolated)),extrapolation:stats(rows.filter(r=>r.extrapolated)),notes};
}

export function validationCsv(result:DisagreementValidation):string{
  const header=["borehole_id","x_m","y_m","logged_elevation_m","min_elevation_m","max_elevation_m","range_width_m","reference_prediction_m","reference_error_m","covered","extrapolated","missing_case_ids","unavailable_reason","predictions","unit_id","reference_case_id","case_ids","max_holdouts","available_locations","eligible_locations","selected_locations","omitted_locations","group_radius_m","review_notes"];
  const meta=[result.unitId,result.referenceCaseId,JSON.stringify(result.caseIds),result.maxHoldouts,result.availableLocations,result.eligibleLocations,result.selectedLocations,result.omittedLocations,result.groupRadius,JSON.stringify(result.notes)];
  const rows=result.rows.map(row=>[row.id,row.x,row.y,row.logged,row.min,row.max,row.rangeWidth,row.referencePrediction,row.referenceError,
    row.covered===undefined?undefined:String(row.covered),String(row.extrapolated),JSON.stringify(row.missingCaseIds),row.unavailableReason,JSON.stringify(row.predictions),...meta]);
  if(!rows.length)rows.push([...Array(14).fill(""),...meta]);
  return toCsv([header,...rows]);
}
