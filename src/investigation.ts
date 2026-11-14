// A deterministic spacing plan on a fixed corridor station grid. Proposed positions are hypothetical geometry;
// they never enter the ground model as observations or imply a quantified reduction in geological uncertainty.
import type {Alignment,GeoProject} from "./schema";
import {analyzeCorridor,CorridorFlag,CorridorLog,CorridorReport,CorridorStation} from "./corridor";
import {DisagreementCase,prepareDisagreementModels,sampleDisagreement} from "./disagreement";
import {sampleModel} from "./model";
import {contactBins,conditionalCaseEntropy,conditionalInformationGain,informationSettings,InformationOptions,InformationSettings} from "./information";
import {toCsv} from "./io";

export interface InvestigationDisagreementContext { cases:DisagreementCase[];unitId:string }
export interface InvestigationOptions {
  step?:number;budget?:number;minSpacing?:number;includeOutside?:boolean;prioritizeFlags?:boolean;
  depthBelowDesign?:number;minCover?:number;maxSupportDistance?:number;maxSamples?:number;
  disagreementContext?:InvestigationDisagreementContext;prioritizeDisagreement?:boolean;
  information?:InformationOptions;
}
export type InvestigationLog=CorridorLog;
export type InvestigationExclusion="outside-model"|"near-recorded"|"duplicate-location"|"missing-disagreement"|"unknown-cost";
export interface InvestigationInformation {
  bins:number[];requiredContactDepth:number;estimatedDepth:number;estimatedCost:number;expectedGainBits:number;
  cumulativeGainBits:number;gainPerCost:number;remainingBudget:number;
}
export interface InvestigationModelRange { unitId:string;min:number;max:number;width:number;count:number;total:number;caseIds:string[] }
export interface InvestigationCandidate {
  stationIndex:number;eligible:boolean;exclusion?:InvestigationExclusion;nearestRecordedDistance?:number;
  missingCaseIds?:string[];
  costReason?:string;
}
export interface InvestigationProposal extends CorridorStation {
  id:string;rank:number;stationIndex:number;baselineDistance?:number;planningDistance?:number;nearestRecordedDistance?:number;
  reasons:string[];proposedDepth?:number;targetElevation?:number;targetReference?:"design-bottom"|"design-top";
  terminationElevation?:number;belowModel?:boolean;
  modelRange?:InvestigationModelRange;
  information?:InvestigationInformation;
}
export interface InvestigationPlan {
  format:"geomodel3d-investigation-plan";version:1;projectName:string;
  crs?:{name?:string;code?:string;proj4?:string};alignment:Alignment;
  options:{step:number;budget:number;minSpacing:number;includeOutside:boolean;prioritizeFlags:boolean;maxSamples:number;
    depthBelowDesign?:number;minCover?:number;maxSupportDistance?:number;prioritizeDisagreement?:boolean;information?:InformationSettings};
  disagreement?:{unitId:string;caseIds:string[];caseLabels:string[]};
  corridor:CorridorReport;recordedLogs:InvestigationLog[];usedLogs:InvestigationLog[];
  candidates:InvestigationCandidate[];proposals:InvestigationProposal[];
  summary:{stationCount:number;eligibleCount:number;excludedOutside:number;excludedRecorded:number;excludedDuplicate:number;
    excludedByProposals:number;proposedCount:number;budgetShortfall:number;maxGapBefore?:number;maxGapAfter?:number;excludedDisagreement?:number;
    totalCost?:number;unspentBudget?:number;cumulativeInformationBits?:number;priorEntropyBits?:number;
    stopReason?:"location-limit"|"money-budget"|"no-information"|"spacing"|"no-eligible";excludedCost?:number};
  notes:string[];
}
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);
const coincident=.001,tolerance=1e-9;
const priorityFlags=new Set<CorridorFlag>(["low-cover","water-above-design","above-ground","below-model","distant-support"]);
const distance=(a:{x:number;y:number},b:{x:number;y:number})=>Math.hypot(a.x-b.x,a.y-b.y);
const tooClose=(d:number,spacing:number)=>d<=coincident||d<spacing-tolerance;
function nearest(point:{x:number;y:number},points:Array<{x:number;y:number}>):number|undefined{
  let best:number|undefined;
  for(const other of points){const d=distance(point,other);if(finite(d)&&(best===undefined||d<best))best=d}
  return best;
}
function maximum(values:Array<number|undefined>):number|undefined{
  return values.length&&values.every(finite)?values.reduce((a,b)=>Math.max(a,b),0):undefined;
}
// Canonical comparison excludes only source evidence, which numerical workers deliberately leave out. Keep all
// modelling fields, sequences and assumptions so a context from another snapshot cannot silently rank this one.
function snapshotIdentity(project:GeoProject):string{
  const clean=(value:unknown):unknown=>Array.isArray(value)?value.map(clean):value&&typeof value==="object"
    ?Object.fromEntries(Object.entries(value).filter(([key,v])=>v!==undefined&&key!=="evidence"&&key!=="evidenceId").sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,clean(v)])):value;
  return JSON.stringify(clean(project));
}

export function planInvestigation(project:GeoProject,alignment:Alignment,options:InvestigationOptions={}):InvestigationPlan{
  const budget=options.budget??5,minSpacing=options.minSpacing??20,includeOutside=options.includeOutside??false,prioritizeFlags=options.prioritizeFlags??false,prioritizeDisagreement=options.prioritizeDisagreement??false;
  if(!Number.isInteger(budget)||budget<1||budget>50)throw new Error("The location budget must be an integer from 1 to 50.");
  if(!finite(minSpacing)||minSpacing<0)throw new Error("Minimum location spacing must be a finite nonnegative number of metres.");
  if(typeof includeOutside!=="boolean"||typeof prioritizeFlags!=="boolean"||typeof prioritizeDisagreement!=="boolean")throw new Error("Outside-model and priority choices must be boolean.");
  if(Number(prioritizeFlags)+Number(prioritizeDisagreement)+Number(options.information!==undefined)>1)throw new Error("Choose either screening-flag priority, model-disagreement priority or information per cost.");
  const context=prioritizeDisagreement||options.information!==undefined?options.disagreementContext:undefined;
  if((prioritizeDisagreement||options.information!==undefined)&&(!context||!Array.isArray(context.cases)||typeof context.unitId!=="string"||!context.unitId.trim()))throw new Error("Model-disagreement or information priority needs selected saved cases and a contact.");
  if(context&&(!context.cases[0]?.project||snapshotIdentity(project)!==snapshotIdentity(context.cases[0].project)))throw new Error("The disagreement reference snapshot must match the project being planned. Reopen analysis for the current project.");
  if(context&&!project.units.some(unit=>unit.id===context.unitId))throw new Error("The selected disagreement contact is absent from the reference project.");
  const disagreementModels=context?prepareDisagreementModels(context.cases):undefined;
  const ranges=new Map<number,InvestigationModelRange>();
  const information=options.information===undefined?undefined:informationSettings(options.information,context!.cases.length);
  const costs=new Map<number,{bins:number[];requiredContactDepth:number;estimatedDepth:number;estimatedCost:number}>();
  if(options.depthBelowDesign!==undefined&&(!finite(options.depthBelowDesign)||options.depthBelowDesign<0))throw new Error("Depth below design must be finite and nonnegative.");
  for(const [kind,logs] of [["borehole",project.boreholes],["CPT",project.cpts??[]]] as const){
    if(new Set(logs.map(log=>log.id)).size!==logs.length)throw new Error(`${kind} IDs must be unique for an investigation plan.`);
  }
  const corridor=analyzeCorridor(project,alignment,options),recorded=new Map<string,InvestigationLog>();
  for(const source of context?context.cases.map(c=>c.project):[project])for(const log of [
    ...source.boreholes.map(({id,x,y})=>({id,x,y,kind:"borehole" as const})),
    ...(source.cpts??[]).map(({id,x,y})=>({id,x,y,kind:"cpt" as const}))
  ])if(finite(log.x)&&finite(log.y))recorded.set(JSON.stringify([log.kind,log.id,log.x,log.y]),log);
  const recordedLogs=[...recorded.values()];
  const usedLogs=structuredClone(corridor.usedLogs),seen:Array<{x:number;y:number}>=[];
  const candidates=corridor.stations.map((station,stationIndex):InvestigationCandidate=>{
    const d=nearest(station,recordedLogs);let exclusion:InvestigationExclusion|undefined,missingCaseIds:string[]|undefined,costReason:string|undefined;
    if(!includeOutside&&!station.inside)exclusion="outside-model";
    else if(d!==undefined&&tooClose(d,minSpacing))exclusion="near-recorded";
    else if(seen.some(previous=>distance(previous,station)<=coincident))exclusion="duplicate-location";
    else if(context&&disagreementModels){
      const sampled=sampleDisagreement(disagreementModels,station.x,station.y,context.unitId);
      if(!sampled.complete||!finite(sampled.min)||!finite(sampled.max)||!finite(sampled.width)){exclusion="missing-disagreement";missingCaseIds=sampled.missingCaseIds.slice()}
      else {
        ranges.set(stationIndex,{unitId:context.unitId,min:sampled.min,max:sampled.max,width:sampled.width,count:sampled.count,total:sampled.total,caseIds:context.cases.map(c=>c.id)});
        if(information){
          const columns=disagreementModels.map(({model})=>sampleModel(model,station.x,station.y));
          const depths=disagreementModels.map(({model},i)=>{
            const k=model.units.findIndex(u=>u.id===context.unitId),column=columns[i],ground=column?.[0],contact=column?.[k],base=column?.[k+1];
            return k>=0&&finite(ground)&&finite(contact)&&finite(base)&&contact-base>tolerance&&ground>=contact-tolerance
              ?Math.max(0,ground-contact)+information.contactBuffer:undefined;
          });
          const designTarget=station.bottom??station.top;
          const designDepth=options.depthBelowDesign===undefined?0:finite(designTarget)
            ?maximum(columns.map(column=>finite(column?.[0])?Math.max(0,column![0]-designTarget+options.depthBelowDesign!):undefined)):undefined;
          const requiredContactDepth=maximum(depths),estimatedDepth=requiredContactDepth===undefined||designDepth===undefined?undefined:Math.max(requiredContactDepth,designDepth);
          const estimatedCost=estimatedDepth===undefined?undefined:information.fixedCost+information.costPerMetre*estimatedDepth;
          if(!station.inside||!finite(station.ground)||!finite(estimatedDepth)||estimatedDepth<=0||!finite(estimatedCost)||estimatedCost<=0||!finite(3/estimatedCost)){
            exclusion="unknown-cost";costReason="A positive-thickness observable selected unit and a finite positive contact-reaching depth and cost are required in every interpretation; any requested design target must also be available.";
          }else{
            try{costs.set(stationIndex,{bins:contactBins(sampled.values.map(v=>v.elevation!),information.resolution,information.origin),requiredContactDepth:requiredContactDepth!,estimatedDepth,estimatedCost})}
            catch(error){exclusion="unknown-cost";costReason=error instanceof Error?error.message:String(error)}
          }
        }
        if(!exclusion)seen.push(station);
      }
    }else seen.push(station);
    return {stationIndex,eligible:!exclusion,...(exclusion?{exclusion}:{}),...(d===undefined?{}:{nearestRecordedDistance:d}),...(missingCaseIds?{missingCaseIds}:{}),...(costReason?{costReason}:{})};
  });
  const eligible=candidates.filter(c=>c.eligible),proposals:InvestigationProposal[]=[],selected=new Set<number>();
  const planningDistance=(station:CorridorStation)=>{
    const existing=station.nearestLog?.distance,planned=nearest(station,proposals);
    return existing===undefined?planned:planned===undefined?existing:Math.min(existing,planned);
  };
  const flagged=(station:CorridorStation)=>station.flags.some(f=>priorityFlags.has(f));
  const midpoint=(corridor.range.start+corridor.range.end)/2;
  const occupiedIds=new Set(recordedLogs.map(log=>log.id));
  const observations:number[][]=[];
  const priorEntropy=information?conditionalCaseEntropy(information.priors):0;
  let totalCost=0,cumulativeInformation=0,stopReason:NonNullable<InvestigationPlan["summary"]["stopReason"]>="location-limit";
  while(proposals.length<budget){
    let best:InvestigationCandidate|undefined,bestDistance:number|undefined,bestGain=0,bestRatio=0,remaining=false,unblocked=false,informative=false;
    for(const candidate of eligible){
      if(selected.has(candidate.stationIndex))continue;
      remaining=true;
      const station=corridor.stations[candidate.stationIndex],toPlanned=nearest(station,proposals);
      if(toPlanned!==undefined&&tooClose(toPlanned,minSpacing))continue;
      unblocked=true;
      const d=planningDistance(station);
      let gain=0,ratio=0;
      if(information){
        const cost=costs.get(candidate.stationIndex)!;
        gain=conditionalInformationGain(information.priors,observations,cost.bins);
        if(gain<=0)continue;
        informative=true;
        if(cost.estimatedCost>information.moneyBudget-totalCost||totalCost+cost.estimatedCost>information.moneyBudget)continue;
        ratio=gain/cost.estimatedCost;
      }
      if(!best){best=candidate;bestDistance=d;bestGain=gain;bestRatio=ratio;continue}
      const first=corridor.stations[best.stationIndex];
      if(information){
        const candidateCost=costs.get(candidate.stationIndex)!.estimatedCost,firstCost=costs.get(best.stationIndex)!.estimatedCost;
        const ratioDifference=ratio-bestRatio,ratioTolerance=Number.EPSILON*8*Math.max(ratio,bestRatio);
        if(Math.abs(ratioDifference)>ratioTolerance){if(ratioDifference>0){best=candidate;bestDistance=d;bestGain=gain;bestRatio=ratio}continue}
        if(Math.abs(gain-bestGain)>Number.EPSILON*8*Math.max(gain,bestGain)){if(gain>bestGain){best=candidate;bestDistance=d;bestGain=gain;bestRatio=ratio}continue}
        if(candidateCost!==firstCost){if(candidateCost<firstCost){best=candidate;bestDistance=d;bestGain=gain;bestRatio=ratio}continue}
      }else if(disagreementModels){
        const width=ranges.get(candidate.stationIndex)!.width,firstWidth=ranges.get(best.stationIndex)!.width;
        if(Math.abs(width-firstWidth)>tolerance){if(width>firstWidth){best=candidate;bestDistance=d}continue}
      }
      if(prioritizeFlags&&flagged(station)!==flagged(first)){
        if(flagged(station)){best=candidate;bestDistance=d}continue;
      }
      // Without any included logs, the first seed is the station closest to the chainage midpoint. Subsequent
      // choices spread away from hypothetical proposed positions; none creates a finite baseline observation gap.
      const wins=d===undefined&&bestDistance===undefined
        ?Math.abs(station.chainage-midpoint)<Math.abs(first.chainage-midpoint)-tolerance
        :d!==undefined&&(bestDistance===undefined||d>bestDistance+tolerance);
      if(wins){best=candidate;bestDistance=d;bestGain=gain;bestRatio=ratio}
    }
    if(!best){
      stopReason=!eligible.length?"no-eligible":information&&conditionalCaseEntropy(information.priors,observations)===0?"no-information":!remaining?"no-eligible":!unblocked?"spacing":!informative?"no-information":"money-budget";
      break;
    }
    const station=corridor.stations[best.stationIndex],rank=proposals.length+1,baselineDistance=station.nearestLog?.distance,reasons:string[]=[];
    const modelRange=ranges.get(best.stationIndex);
    if(information)reasons.push(`Largest affordable expected conditional scenario information per cost: ${bestGain.toFixed(4)} bits from this contact observation, after conditioning on earlier proposed observations.`);
    else if(modelRange)reasons.push(`Largest remaining complete selected-interpretation range: ${modelRange.width.toFixed(2)} m for contact ${modelRange.unitId}, from all ${modelRange.total} selected cases.`);
    if(prioritizeFlags&&flagged(station))reasons.push(`Flagged stations were prioritized: ${station.flags.filter(f=>priorityFlags.has(f)).join(", ")}.`);
    reasons.push(bestDistance===undefined?"No used logs provide a baseline distance. The first geometric seed is nearest the alignment's chainage midpoint.":
      `${information?"Distance to used logs and earlier proposals, used to break information-per-cost ties":modelRange?"Distance to used logs and earlier proposals, used to break range ties":"Largest remaining distance to used logs and earlier proposed sites"}: ${bestDistance.toFixed(2)} m.`);
    if(baselineDistance!==undefined)reasons.push(`Nearest used baseline log is ${baselineDistance.toFixed(2)} m away in plan.`);
    if(!station.inside)reasons.push("Outside the existing model: ground, geological predictions and proposed depth are unavailable.");
    let id=`Proposed-${String(rank).padStart(2,"0")}`;while(occupiedIds.has(id))id+="-plan";occupiedIds.add(id);
    const proposal:InvestigationProposal={...structuredClone(station),id,rank,stationIndex:best.stationIndex,
      ...(baselineDistance===undefined?{}:{baselineDistance}),...(bestDistance===undefined?{}:{planningDistance:bestDistance}),
      ...(best.nearestRecordedDistance===undefined?{}:{nearestRecordedDistance:best.nearestRecordedDistance}),reasons,...(modelRange?{modelRange:structuredClone(modelRange)}:{})};
    if(options.depthBelowDesign!==undefined){
      const target=station.bottom??station.top;
      if(station.inside&&station.ground!==undefined&&target!==undefined){
        const proposedDepth=station.ground-target+options.depthBelowDesign;
        proposal.targetElevation=target;proposal.targetReference=station.bottom!==undefined?"design-bottom":"design-top";
        if(proposedDepth>tolerance){
          const terminationElevation=station.ground-proposedDepth;
          proposal.proposedDepth=proposedDepth;proposal.terminationElevation=terminationElevation;
          if(corridor.modelBase!==undefined)proposal.belowModel=terminationElevation<corridor.modelBase-tolerance;
          if(proposal.belowModel)reasons.push("Proposed termination is below the existing model base; the intervening geology is unknown.");
        }else reasons.push("The geometric target is at or above model ground and requires no below-ground penetration. No drilling depth is proposed by this recipe.");
      }else reasons.push("A depth buffer was supplied, but model ground or a design target is unavailable; no depth was invented.");
    }
    if(information){
      const cost=costs.get(best.stationIndex)!;
      observations.push(cost.bins.slice());totalCost+=cost.estimatedCost;
      cumulativeInformation=Math.max(0,Math.min(priorEntropy,priorEntropy-conditionalCaseEntropy(information.priors,observations)));
      proposal.information={...structuredClone(cost),expectedGainBits:bestGain,cumulativeGainBits:cumulativeInformation,
        gainPerCost:bestRatio,remainingBudget:Math.max(0,information.moneyBudget-totalCost)};
      proposal.proposedDepth=cost.estimatedDepth;proposal.terminationElevation=station.ground!-cost.estimatedDepth;
      proposal.belowModel=corridor.modelBase!==undefined&&proposal.terminationElevation<corridor.modelBase-tolerance;
      reasons.push(`Estimated depth ${cost.estimatedDepth.toFixed(2)} m reaches contact ${context!.unitId} in every selected interpretation with the stated buffer and includes any requested design depth. Estimated cost ${cost.estimatedCost.toFixed(2)} ${information.currency}; cumulative expected information ${cumulativeInformation.toFixed(4)} bits.`);
      if(proposal.belowModel)reasons.push("Contact-reaching termination is below the reference model base; its deeper geology is unavailable.");
    }
    proposals.push(proposal);selected.add(best.stationIndex);
  }
  const before=maximum(eligible.map(c=>corridor.stations[c.stationIndex].nearestLog?.distance));
  const after=maximum(eligible.map(c=>planningDistance(corridor.stations[c.stationIndex])));
  const excludedByProposals=eligible.filter(c=>!selected.has(c.stationIndex)&&proposals.some(p=>tooClose(distance(p,corridor.stations[c.stationIndex]),minSpacing))).length;
  const notes=[information?"The location budget limits the number of proposed sites, and the separate monetary budget limits their total estimated cost. Proposals are unobserved suggestions and never enter the model as measurements.":"The location budget counts proposed locations, not money. Locations are unobserved planning suggestions and never enter the geological model as measurements.",
    "Default selection greedily takes the largest remaining horizontal distance to used model logs and earlier hypothetical proposed positions. Equal distances retain increasing chainage order; no optimality or statistical information-gain claim is made.",
    "Coverage proxies use the same initial eligible candidate grid before and after, including selected candidates. After values assume a position at each proposal, not successful drilling or new ground information; they do not quantify uncertainty reduction.",
    "Minimum spacing uses Euclidean project-coordinate distance to every finite recorded borehole/CPT collar, including those unused by the model, and to earlier proposed sites. Coincident positions within 1 mm are always excluded, even when spacing is zero.",
    "Repeated route positions are considered once, at their first eligible chainage. Chainage span is not assumed to equal physical distance. Candidate spacing and model-boundary stations follow the corridor sampling settings.",
    "Ground, groundwater and geological units are model predictions, not surveyed proposal observations. Access, utilities, ownership, constructability, investigation type and required depth need independent review.",
    options.includeOutside?"Outside-model candidate stations were explicitly permitted; no extrapolated ground, geology or depth is supplied there.":"Candidates outside the existing model were excluded. Model coverage can include an inferred margin and does not establish observation support.",
    prioritizeFlags?"Stations with low-cover, water-above-design, above-ground, below-model or distant-support flags are considered before other eligible stations, then by the same distance rule. Missing-data flags do not create an assumed hazard severity.":"Screening flags are shown as context and do not change the default distance ranking.",
    options.depthBelowDesign===undefined?information?"No design-depth buffer was requested. Proposed depths instead reach the selected contact in every interpretation, with the explicitly supplied contact buffer.":"No depth buffer was supplied, so no proposed drilling depth is given.":`Optional proposed depth is model ground minus design bottom (or design top if no bottom) plus ${options.depthBelowDesign} m, only where that gives positive below-ground penetration. Ground and design must share a vertical datum; this is a geometric target, not a prescribed investigation depth.`];
  if(context)notes.push(information?`The information calculation uses the contact ${context.unitId} predicted by every selected interpretation at each exact candidate coordinate. Missing contacts or unusable ground/depth/cost are excluded.`:`Model-disagreement priority ranks the complete min/max elevation range for contact ${context.unitId} at each exact candidate coordinate, then uses the existing gap rule for ties. All selected cases must provide that contact; missing ranges are excluded, while a complete zero-width range remains valid.`,
    "In disagreement mode, physical spacing excludes recorded borehole/CPT positions from every selected case. Repeated kind, ID and XY records are merged; moved records retain both positions. The baseline gap still uses only logs admitted to the reference model.",
    "Selected-interpretation spread is not a calibrated probability, measured prediction error or expected reduction in uncertainty. Proposed sites do not change the model range or the observations. Source projects are retained in their saved revisions, not copied into this plan.");
  if(information)notes.push(
    `This finite-hypothesis calculation assumes one selected interpretation supplies the true contact and uses normalized prior weights ${JSON.stringify(information.priors)} in selected-case order. These weights are supplied assumptions, not fitted geological probabilities; omitted interpretations and model discrepancy are not represented.`,
    `An investigation is assumed to reveal the noiseless elevation bin floor((contact elevation − ${information.origin} m) / ${information.resolution} m). Resolution and origin are explicit assumptions; measurement noise is not modeled. Tiny elevation differences across a bin edge can distinguish cases, so review bin-origin and resolution sensitivity.`,
    "Expected conditional information is the reduction in weighted case entropy, in bits, after grouping cases by the joint bin signatures of all earlier proposed sites. No hypothetical observation is realized or inserted into the model; the expectation integrates all outcomes under the stated finite-case prior. Redundant sites have zero conditional gain and are not selected. Total gain cannot exceed prior case entropy.",
    `Estimated cost is ${information.fixedCost} ${information.currency} per site plus ${information.costPerMetre} ${information.currency} per metre. Contact-reaching depth is the maximum predicted ground-to-contact depth across all selected cases plus ${information.contactBuffer} m, enlarged by the deepest explicit design target across those case ground levels. The selected unit must have positive thickness in every case: a pinched-out contact is not treated as an observable top. Missing requested targets, nonpositive depths and unrepresentable costs are unavailable, even for fixed-cost-only plans. This is an estimate, not a contractor quotation.`,
    "Selection greedily ranks positive expected conditional bits per estimated cost within the remaining monetary budget and physical spacing constraints. Ties use larger information gain, lower cost, then the existing gap/order rule. This is not a globally optimal budgeted design or a prediction of actual geological uncertainty reduction; inferred contact intervals are calibrated separately.");
  if(!usedLogs.length)notes.push("No used baseline logs exist. The first candidate is seeded at the chainage midpoint; baseline maximum gap is unavailable. Any later finite gap is hypothetical spacing only, with no finite baseline improvement claim.");
  if(!eligible.length)notes.push(`No eligible candidate locations remain after model-coverage, recorded-collar spacing, duplicate-position${context?" and selected-range availability":""} exclusions.`);
  if(proposals.length<budget)notes.push(information?`Selected ${proposals.length} of at most ${budget} locations; selection stopped because of ${stopReason}. Zero-information sites and unaffordable investigations are not added to fill the count.`:`Only ${proposals.length} of ${budget} requested locations fit the candidate grid and spacing rules. Reduce spacing, adjust the candidate grid or explicitly allow outside-model locations to explore alternatives.`);
  notes.push(...corridor.notes.map(note=>`Corridor: ${note}`));
  const crs=project.crs||project.crsCode||project.crsProj4?{...(project.crs?{name:project.crs}:{}),...(project.crsCode?{code:project.crsCode}:{}),...(project.crsProj4?{proj4:project.crsProj4}:{})}:undefined;
  return {format:"geomodel3d-investigation-plan",version:1,projectName:project.name,...(crs?{crs}:{}),alignment:structuredClone(alignment),
    options:{step:corridor.options.step,budget,minSpacing,includeOutside,prioritizeFlags,maxSamples:corridor.options.maxSamples,
      ...(options.depthBelowDesign===undefined?{}:{depthBelowDesign:options.depthBelowDesign}),...(options.minCover===undefined?{}:{minCover:options.minCover}),...(options.maxSupportDistance===undefined?{}:{maxSupportDistance:options.maxSupportDistance}),...(prioritizeDisagreement?{prioritizeDisagreement:true}:{}),...(information?{information}:{})},
    ...(context?{disagreement:{unitId:context.unitId,caseIds:context.cases.map(c=>c.id),caseLabels:context.cases.map(c=>c.label??c.project.name)}}:{}),
    corridor,recordedLogs,usedLogs,candidates,proposals,
    summary:{stationCount:candidates.length,eligibleCount:eligible.length,excludedOutside:candidates.filter(c=>c.exclusion==="outside-model").length,
      excludedRecorded:candidates.filter(c=>c.exclusion==="near-recorded").length,excludedDuplicate:candidates.filter(c=>c.exclusion==="duplicate-location").length,
      excludedByProposals,proposedCount:proposals.length,budgetShortfall:budget-proposals.length,...(before===undefined?{}:{maxGapBefore:before}),...(after===undefined?{}:{maxGapAfter:after}),...(context?{excludedDisagreement:candidates.filter(c=>c.exclusion==="missing-disagreement").length}:{}),
      ...(information?{totalCost,unspentBudget:Math.max(0,information.moneyBudget-totalCost),cumulativeInformationBits:cumulativeInformation,priorEntropyBits:priorEntropy,stopReason,excludedCost:candidates.filter(c=>c.exclusion==="unknown-cost").length}:{})},notes};
}

export function investigationCsv(plan:InvestigationPlan):string{
  const headers=["proposal_id","rank","chainage_m","x_m","y_m","inside_model","model_ground_m","design_top_m","design_bottom_m","cover_m","water_head_above_design_m","nearest_used_log_id","nearest_used_log_kind","nearest_used_log_distance_m","nearest_recorded_distance_m","planning_distance_at_selection_m","proposed_depth_m","target_elevation_m","target_reference","termination_elevation_m","termination_below_model","flags","reasons"];
  const metadataNames=["project_name","alignment_name","location_budget","minimum_spacing_m","requested_step_m","actual_step_m","include_outside","prioritize_flags","depth_below_design_m","min_cover_screen_m","max_support_distance_screen_m","max_samples","eligible_candidate_count","budget_shortfall","max_candidate_gap_before_m","max_candidate_gap_with_proposed_positions_m","crs","alignment_geometry","alignment_start_m","design_levels","review_notes"];
  const o=plan.options,s=plan.summary,metadata=[plan.projectName,plan.alignment.name,o.budget,o.minSpacing,o.step,plan.corridor.range.actualStep,String(o.includeOutside),String(o.prioritizeFlags),o.depthBelowDesign,o.minCover,o.maxSupportDistance,o.maxSamples,s.eligibleCount,s.budgetShortfall,s.maxGapBefore,s.maxGapAfter,JSON.stringify(plan.crs??{}),JSON.stringify(plan.alignment.points),plan.corridor.range.start,JSON.stringify(plan.alignment.design??[]),JSON.stringify(plan.notes)];
  const rows=plan.proposals.map(p=>[p.id,p.rank,p.chainage,p.x,p.y,String(p.inside),p.ground,p.top,p.bottom,p.cover,p.waterHead,p.nearestLog?.id,p.nearestLog?.kind,p.baselineDistance,p.nearestRecordedDistance,p.planningDistance,p.proposedDepth,p.targetElevation,p.targetReference,p.terminationElevation,p.belowModel===undefined?undefined:String(p.belowModel),p.flags.join(";"),JSON.stringify(p.reasons),...metadata]);
  if(!rows.length)rows.push([...Array(headers.length).fill(""),...metadata]);
  const priorityNames=["ranking_method","disagreement_contact_id","disagreement_case_ids","disagreement_case_labels","excluded_missing_disagreement","model_range_min_m","model_range_max_m","model_range_width_m","model_range_count","model_range_total"];
  const informationNames=["information_model","information_prior_weights","observation_resolution_m","observation_bin_origin_m","monetary_budget","cost_currency","fixed_cost","cost_per_m","contact_buffer_m","total_estimated_cost","unspent_budget","prior_entropy_bits","cumulative_information_bits","information_stop_reason","excluded_unknown_cost_count","assumed_contact_bins","contact_reaching_depth_m","estimated_depth_m","estimated_cost","expected_conditional_information_bits","cumulative_expected_information_bits","information_bits_per_cost","remaining_monetary_budget"];
  const info=o.information;
  return toCsv([[...headers,...metadataNames,...priorityNames,...informationNames],...rows.map((row,index)=>{
    const range=plan.proposals[index]?.modelRange,value=plan.proposals[index]?.information;
    return [...row,info?"expected-information-per-cost":o.prioritizeDisagreement?"selected-interpretation-range":o.prioritizeFlags?"screening-flags":"coverage-gap",plan.disagreement?.unitId,
      ...(plan.disagreement?[JSON.stringify(plan.disagreement.caseIds),JSON.stringify(plan.disagreement.caseLabels)]:[undefined,undefined]),s.excludedDisagreement,range?.min,range?.max,range?.width,range?.count,range?.total,
      info?"finite-case-noiseless-contact-bins":undefined,info?JSON.stringify(info.priors):undefined,info?.resolution,info?.origin,info?.moneyBudget,info?.currency,info?.fixedCost,info?.costPerMetre,info?.contactBuffer,
      s.totalCost,s.unspentBudget,s.priorEntropyBits,s.cumulativeInformationBits,s.stopReason,s.excludedCost,value?JSON.stringify(value.bins):undefined,value?.requiredContactDepth,value?.estimatedDepth,value?.estimatedCost,value?.expectedGainBits,value?.cumulativeGainBits,value?.gainPerCost,value?.remainingBudget];
  })]);
}
