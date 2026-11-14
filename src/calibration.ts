// Split conformal calibration of a fixed training-only interpretation envelope. Calibration and audit locations
// never enter any fitted interpretation. Missing calibration predictions retain an unbounded score.
import type {Borehole,GeoProject} from "./schema";
import {buildDisagreement,prepareDisagreementModels,sampleDisagreement} from "./disagreement";
import type {DisagreementCase,DisagreementOptions,DisagreementReport,PreparedDisagreementCase} from "./disagreement";
import {location,locationGroups,observedTop,withinTrainingHull} from "./disagreementValidation";
import {compatibleCrs} from "./comparison";
import {toCsv} from "./io";

export interface CalibrationOptions extends DisagreementOptions {
  coverage?:number;seed?:number;trainingFraction?:number;calibrationFraction?:number;
}
export type CalibrationRole="training"|"calibration"|"audit";
export interface CalibrationGroup {
  id:string;role:CalibrationRole;referenceId:string;x:number;y:number;
  memberReferenceIds:string[];positions:string[];boreholeIds:string[];cptIds:string[];
}
export interface CalibrationPartition {
  groups:CalibrationGroup[];trainingCount:number;calibrationCount:number;auditCount:number;excludedReferenceCount:number;
  excludedReferences:{id:string;reason:string}[];
  removals:{caseId:string;boreholeIds:string[];cptIds:string[];remainingBoreholes:number;remainingCpts:number}[];
}
export interface CalibrationRow {
  groupId:string;id:string;role:"calibration"|"audit";x:number;y:number;logged:number;
  predictions:{caseId:string;elevation?:number}[];missingCaseIds:string[];
  min?:number;max?:number;score?:number;scoreUnbounded:boolean;lower?:number;upper?:number;width?:number;
  covered?:boolean;extrapolated:boolean;unavailableReason?:string;
}
export interface CalibratedSample {
  x:number;y:number;distance?:number;complete:boolean;extrapolated:boolean;
  baseMin?:number;baseMax?:number;lower?:number;upper?:number;width?:number;unavailableReason?:string;
}
export interface CalibrationAuditStats {
  nTotal:number;nScored:number;nCovered:number;nUnavailable:number;
  empiricalCoverage?:number;finiteEmpiricalCoverage?:number;meanWidth?:number;
}
export interface ContactCalibration {
  format:"geomodel3d-contact-calibration";version:1;caseIds:string[];unitId:string;
  options:DisagreementOptions&{coverage:number;seed:number;trainingFraction:number;calibrationFraction:number};
  partition:CalibrationPartition;rows:CalibrationRow[];rank:number;nCalibration:number;finiteCalibration:number;
  quantile?:number;report?:DisagreementReport;intervals:{grid:CalibratedSample[];path:CalibratedSample[]};
  audit:{all:CalibrationAuditStats;interior:CalibrationAuditStats;extrapolation:CalibrationAuditStats};
  notes:string[];unavailableReason?:string;reportUnavailableReason?:string;
}
const finite=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value);
const sorted=(values:Iterable<string>)=>[...values].sort((a,b)=>a.localeCompare(b));
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

// The extra order statistic is essential: clamping k to n would assert unsupported finite coverage at small n.
export function conformalExpansion(scores:Array<number|undefined>,coverage:number):{rank:number;n:number;finiteCount:number;quantile?:number;unavailableReason?:string}{
  if(!finite(coverage)||coverage<.5||coverage>.99)throw new Error("Target coverage must be between 0.5 and 0.99.");
  if(scores.some(score=>score!==undefined&&(!finite(score)||score<0)))throw new Error("Calibration scores must be finite nonnegative values or explicitly unbounded.");
  // Decimal arithmetic avoids both an extra rank from 25 × 0.56 and a lowered rank just above a boundary.
  const n=scores.length,text=String(coverage),denominator=10n**BigInt(text.split(".")[1]?.length??0),numerator=BigInt(text.replace(".",""));
  const rank=Number((BigInt(n+1)*numerator+denominator-1n)/denominator);
  const available=scores.filter(finite).sort((a,b)=>a-b),finiteCount=available.length;
  if(rank>n)return {rank,n,finiteCount,unavailableReason:`A finite ${coverage*100}% interval needs more calibration groups: corrected rank ${rank} exceeds ${n} scores.`};
  if(rank>finiteCount)return {rank,n,finiteCount,unavailableReason:`Corrected rank ${rank} reaches an unbounded score; ${n-finiteCount} calibration groups lack a complete finite prediction.`};
  return {rank,n,finiteCount,quantile:available[rank-1]};
}

function random(seed:number){
  let state=seed;
  return ()=>{state=(state+0x6D2B79F5)>>>0;let value=state;value=Math.imul(value^(value>>>15),value|1);value^=value+Math.imul(value^(value>>>7),value|61);return ((value^(value>>>14))>>>0)/4294967296};
}
function statistics(rows:CalibrationRow[],finiteQuantile:boolean):CalibrationAuditStats{
  const scored=rows.filter(row=>row.covered!==undefined&&finite(row.width)),nTotal=rows.length,nScored=scored.length,nCovered=scored.filter(row=>row.covered).length;
  return {nTotal,nScored,nCovered,nUnavailable:nTotal-nScored,
    ...(nTotal&&finiteQuantile?{empiricalCoverage:nCovered/nTotal}:{}),
    ...(nScored?{finiteEmpiricalCoverage:nCovered/nScored,meanWidth:scored.reduce((sum,row)=>sum+row.width!/nScored,0)}:{})};
}

export function calibrateDisagreement(cases:DisagreementCase[],options:CalibrationOptions):ContactCalibration{
  const coverage=options.coverage??.9,seed=options.seed??1729,trainingFraction=options.trainingFraction??.5,calibrationFraction=options.calibrationFraction??.3;
  if(!finite(coverage)||coverage<.5||coverage>.99)throw new Error("Target coverage must be between 0.5 and 0.99.");
  if(!Number.isInteger(seed)||seed<0||seed>4294967295)throw new Error("The calibration split seed must be a whole number from 0 to 4294967295.");
  if(!finite(trainingFraction)||!finite(calibrationFraction)||trainingFraction<=0||calibrationFraction<=0||trainingFraction+calibrationFraction>=1)throw new Error("Training and calibration fractions must be positive and leave a separate audit fraction.");
  if(cases.length<2||cases.length>6)throw new Error("Select two to six interpretations for calibration.");
  if(cases.some(c=>typeof c.id!=="string"||!c.id.trim())||new Set(cases.map(c=>c.id)).size!==cases.length)throw new Error("Calibration interpretation IDs must be nonempty and unique.");
  if(typeof options.unitId!=="string"||!options.unitId.trim())throw new Error("Choose a stable unit ID for calibration.");
  for(const c of cases){
    compatibleCrs(cases[0].project,c.project);
    if(new Set(c.project.units.map(unit=>unit.id)).size!==c.project.units.length)throw new Error("Calibration unit IDs must be unique.");
    for(const [kind,logs] of [["Borehole",c.project.boreholes],["CPT",c.project.cpts??[]]] as const)if(new Set(logs.map(log=>log.id)).size!==logs.length)throw new Error(`${kind} IDs must be unique within each calibration interpretation.`);
  }
  const reference=cases[0].project,groupFor=locationGroups(cases),excludedReferences:CalibrationPartition["excludedReferences"]=[],representatives=new Map<string,{hole:Borehole;logged:number;group:CalibrationGroup}>();
  const ordered=reference.boreholes.slice().sort((a,b)=>a.id.localeCompare(b.id)||a.x-b.x||a.y-b.y);
  for(const hole of ordered){
    const observation=observedTop(hole,reference,options.unitId);
    if(![hole.x,hole.y,hole.z].every(finite)||observation.logged===undefined){excludedReferences.push({id:hole.id,reason:observation.reason??"The collar coordinates or elevation are not finite."});continue}
    const linked=groupFor(hole),positions=sorted(linked.keys),id=`location:${positions[0]}`;
    if(representatives.has(id))continue;
    representatives.set(id,{hole,logged:observation.logged,group:{id,role:"training",referenceId:hole.id,x:hole.x,y:hole.y,
      memberReferenceIds:ordered.filter(other=>linked.boreholeIds.has(other.id)||linked.keys.has(location(other))).map(other=>other.id),
      positions,boreholeIds:sorted(linked.boreholeIds),cptIds:sorted(linked.cptIds)}});
  }
  const groups=[...representatives.values()].map(value=>value.group).sort((a,b)=>a.id.localeCompare(b.id));
  const shuffled=groups.slice(),rng=random(seed);
  for(let i=shuffled.length-1;i>0;i--){const at=Math.floor(rng()*(i+1));[shuffled[i],shuffled[at]]=[shuffled[at],shuffled[i]]}
  const trainingCount=Math.floor(groups.length*trainingFraction),calibrationCount=Math.floor(groups.length*calibrationFraction);
  shuffled.forEach((group,index)=>{group.role=index<trainingCount?"training":index<trainingCount+calibrationCount?"calibration":"audit"});
  const keys=new Set<string>(),boreholeIds=new Set<string>(),cptIds=new Set<string>();
  for(const group of groups)if(group.role!=="training"){
    group.positions.forEach(value=>keys.add(value));group.boreholeIds.forEach(value=>boreholeIds.add(value));group.cptIds.forEach(value=>cptIds.add(value));
  }
  const removals:CalibrationPartition["removals"]=[],trainingCases=cases.map(c=>{
    const boreholes=c.project.boreholes.filter(hole=>!keys.has(location(hole))&&!boreholeIds.has(hole.id));
    const cpts=(c.project.cpts??[]).filter(cpt=>!keys.has(location(cpt))&&!cptIds.has(cpt.id));
    removals.push({caseId:c.id,boreholeIds:c.project.boreholes.filter(hole=>!boreholes.includes(hole)).map(hole=>hole.id),
      cptIds:(c.project.cpts??[]).filter(cpt=>!cpts.includes(cpt)).map(cpt=>cpt.id),remainingBoreholes:boreholes.length,remainingCpts:cpts.length});
    const project:GeoProject={...c.project,boreholes,...(c.project.cpts?{cpts}:{})};
    return {...c,project};
  });
  const normalized={...structuredClone(options),coverage,seed,trainingFraction,calibrationFraction};
  const partition:CalibrationPartition={groups,trainingCount,calibrationCount,auditCount:groups.length-trainingCount-calibrationCount,
    excludedReferenceCount:excludedReferences.length,excludedReferences,removals};
  const notes=[
    "Split conformal envelope expansion: score = max(training minimum − logged top, logged top − training maximum, 0). The expansion is the ceil((n + 1) × target coverage)-th calibration score. A rank above n or reaching an unbounded score supplies no finite interval; it is never clamped.",
    "Whole physical groups are split before fitting. Rounded 1 mm positions and matching borehole/CPT IDs link observations across every selected interpretation, including moved collars. One observed reference top per group is selected by stable ID order. The seeded shuffle uses no elevations or residuals. Renamed and relocated observations without a shared identity or position cannot be linked automatically.",
    "All calibration and audit groups, including their linked records, are removed from every fitted interpretation together. Audit observations never set the expansion. Groundwater-dependent automatic CPT interpretations and terrain collar corrections are recomputed from remaining inputs; unit rules, definitions and the external terrain remain fixed assumptions.",
    "The map, path, calibration predictions and audit predictions use the same fixed, fully built training-only models. These are different models from the full-data disagreement map. The fitted models are not extended to reach removed locations. Missing calibration predictions retain unbounded scores rather than disappearing from n.",
    "The nominal coverage property is marginal for a future exchangeable physical group, conditional on fixed training and interpretation assumptions. Spatially dependent or adaptively investigated geology need not be exchangeable. No site-specific, simultaneous path, or unconditional spatial coverage guarantee is asserted. Repeated seed, case or coverage selection after inspecting results can invalidate the interpretation.",
    "Calibration targets are directly observed, unambiguous tops of this unit. Coverage does not address unit absence, unlogged contacts, uncertain unit definitions, terrain derived from withheld observations, or information already embedded in chosen interpretations.",
    "Audit coverage uses all audit groups in its denominator when a finite expansion exists; unavailable audit intervals are not counted as demonstrated coverage. Coverage among finite audit intervals is reported separately. Interior and extrapolated counts are descriptive strata, not separately calibrated guarantees.",
    "Reference: Angelopoulos and Bates (2021), A Gentle Introduction to Conformal Prediction and Distribution-Free Uncertainty Quantification, https://arxiv.org/abs/2107.07511."];
  let models:PreparedDisagreementCase[]|undefined,report:DisagreementReport|undefined,fitFailure:string|undefined,reportUnavailableReason:string|undefined;
  if(trainingCount<1)fitFailure="There are no observed reference groups in the training partition.";
  else try{models=prepareDisagreementModels(trainingCases)}catch(error){fitFailure=`The training-only models could not build: ${message(error)}`}
  if(models)try{report=buildDisagreement(trainingCases,options)}catch(error){reportUnavailableReason=`The training-only map or path is unavailable: ${message(error)}`;notes.push(reportUnavailableReason)}
  const rows:CalibrationRow[]=groups.filter(group=>group.role!=="training").map(group=>{
    const target=representatives.get(group.id)!,row:CalibrationRow={groupId:group.id,id:group.referenceId,role:group.role as "calibration"|"audit",x:group.x,y:group.y,logged:target.logged,
      predictions:[],missingCaseIds:cases.map(c=>c.id),scoreUnbounded:true,extrapolated:true};
    if(!models){row.unavailableReason=fitFailure??"No training models are available.";return row}
    const sample=sampleDisagreement(models,group.x,group.y,options.unitId);
    row.predictions=sample.values;row.missingCaseIds=sample.missingCaseIds;row.extrapolated=models.some(c=>!withinTrainingHull(c.model,group));
    if(!sample.complete||!finite(sample.min)||!finite(sample.max)){row.unavailableReason="At least one training interpretation lacks a finite contact prediction at this removed location.";return row}
    const score=Math.max(sample.min-target.logged,target.logged-sample.max,0);
    if(!finite(score)){row.unavailableReason="The contact residual is not finite.";return row}
    row.min=sample.min;row.max=sample.max;row.score=score;row.scoreUnbounded=false;return row;
  });
  const calibrationRows=rows.filter(row=>row.role==="calibration"),expansion=conformalExpansion(calibrationRows.map(row=>row.score),coverage),quantile=fitFailure?undefined:expansion.quantile;
  const unavailableReason=fitFailure??expansion.unavailableReason;
  const interval=(min:number|undefined,max:number|undefined)=>{
    if(quantile===undefined||min===undefined||max===undefined)return undefined;
    const lower=min-quantile,upper=max+quantile,width=upper-lower;
    return [lower,upper,width].every(finite)?{lower,upper,width}:undefined;
  };
  for(const row of rows){
    const bounds=interval(row.min,row.max);
    if(bounds){Object.assign(row,bounds);row.covered=row.logged>=bounds.lower&&row.logged<=bounds.upper}
    else row.unavailableReason??=unavailableReason??"The interval bounds are not finite.";
  }
  const samples=(points:DisagreementReport["grid"]["points"]|DisagreementReport["points"]):CalibratedSample[]=>points.map(point=>{
    const bounds=interval(point.min,point.max);
    return {x:point.x,y:point.y,...("distance" in point?{distance:point.distance as number}:{}),complete:!!bounds,
      extrapolated:models?.some(c=>!withinTrainingHull(c.model,point))??true,
      ...(point.min===undefined?{}:{baseMin:point.min}),...(point.max===undefined?{}:{baseMax:point.max}),
      ...(bounds??{unavailableReason:unavailableReason??"At least one training interpretation lacks a finite prediction here."})};
  });
  const audit=rows.filter(row=>row.role==="audit");
  if(fitFailure)notes.push(fitFailure);
  if(!partition.auditCount)notes.push("No independent audit groups remain with this partition; audit coverage is unavailable.");
  return {format:"geomodel3d-contact-calibration",version:1,caseIds:cases.map(c=>c.id),unitId:options.unitId,options:normalized,partition,rows,
    rank:expansion.rank,nCalibration:expansion.n,finiteCalibration:expansion.finiteCount,...(quantile===undefined?{}:{quantile}),...(report?{report}:{}),
    intervals:{grid:report?samples(report.grid.points):[],path:report?samples(report.points):[]},
    audit:{all:statistics(audit,quantile!==undefined),interior:statistics(audit.filter(row=>!row.extrapolated),quantile!==undefined),extrapolation:statistics(audit.filter(row=>row.extrapolated),quantile!==undefined)},
    notes,...(unavailableReason?{unavailableReason}:{}),...(reportUnavailableReason?{reportUnavailableReason}:{})};
}

export function calibrationCsv(result:ContactCalibration):string{
  const header=["record_type","group_id","reference_borehole_id","x_m","y_m","distance_m","logged_elevation_m","training_min_m","training_max_m","calibration_score_m","score_unbounded","lower_m","upper_m","width_m","covered","extrapolated","unavailable_reason","predictions","unit_id","case_ids","target_coverage","split_seed","corrected_rank","calibration_groups","finite_calibration_scores","expansion_m","training_fraction","calibration_fraction","partition","review_notes"];
  const meta=[result.unitId,JSON.stringify(result.caseIds),result.options.coverage,result.options.seed,result.rank,result.nCalibration,result.finiteCalibration,result.quantile,result.options.trainingFraction,result.options.calibrationFraction,JSON.stringify(result.partition),JSON.stringify(result.notes)];
  // Partition membership and method notes belong to the entire export; repeating them for every map sample can
  // turn a small analysis into tens of megabytes. An explicit metadata record preserves them once, including for
  // an empty result. Each numerical row still identifies its cases, target, split and expansion independently.
  const pointMeta=[...meta.slice(0,-2),undefined,undefined];
  const rows:Array<Array<string|number|undefined>>=[["metadata",...Array(17).fill(undefined),...meta],
    ...result.rows.map(row=>[row.role,row.groupId,row.id,row.x,row.y,undefined,row.logged,row.min,row.max,row.score,String(row.scoreUnbounded),row.lower,row.upper,row.width,row.covered===undefined?undefined:String(row.covered),String(row.extrapolated),row.unavailableReason,JSON.stringify(row.predictions),...pointMeta])];
  for(const [kind,points] of [["map",result.intervals.grid],["path",result.intervals.path]] as const)for(const point of points)rows.push([kind,undefined,undefined,point.x,point.y,point.distance,undefined,point.baseMin,point.baseMax,undefined,undefined,point.lower,point.upper,point.width,undefined,String(point.extrapolated),point.unavailableReason,undefined,...pointMeta]);
  return toCsv([header,...rows]);
}
