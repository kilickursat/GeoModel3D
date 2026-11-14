// A deterministic spacing plan on a fixed corridor station grid. Proposed positions are hypothetical geometry;
// they never enter the ground model as observations or imply a quantified reduction in geological uncertainty.
import type {Alignment,GeoProject} from "./schema";
import {analyzeCorridor,CorridorFlag,CorridorLog,CorridorReport,CorridorStation} from "./corridor";
import {toCsv} from "./io";

export interface InvestigationOptions {
  step?:number;budget?:number;minSpacing?:number;includeOutside?:boolean;prioritizeFlags?:boolean;
  depthBelowDesign?:number;minCover?:number;maxSupportDistance?:number;maxSamples?:number;
}
export type InvestigationLog=CorridorLog;
export type InvestigationExclusion="outside-model"|"near-recorded"|"duplicate-location";
export interface InvestigationCandidate {
  stationIndex:number;eligible:boolean;exclusion?:InvestigationExclusion;nearestRecordedDistance?:number;
}
export interface InvestigationProposal extends CorridorStation {
  id:string;rank:number;stationIndex:number;baselineDistance?:number;planningDistance?:number;nearestRecordedDistance?:number;
  reasons:string[];proposedDepth?:number;targetElevation?:number;targetReference?:"design-bottom"|"design-top";
  terminationElevation?:number;belowModel?:boolean;
}
export interface InvestigationPlan {
  format:"geomodel3d-investigation-plan";version:1;projectName:string;
  crs?:{name?:string;code?:string;proj4?:string};alignment:Alignment;
  options:{step:number;budget:number;minSpacing:number;includeOutside:boolean;prioritizeFlags:boolean;maxSamples:number;
    depthBelowDesign?:number;minCover?:number;maxSupportDistance?:number};
  corridor:CorridorReport;recordedLogs:InvestigationLog[];usedLogs:InvestigationLog[];
  candidates:InvestigationCandidate[];proposals:InvestigationProposal[];
  summary:{stationCount:number;eligibleCount:number;excludedOutside:number;excludedRecorded:number;excludedDuplicate:number;
    excludedByProposals:number;proposedCount:number;budgetShortfall:number;maxGapBefore?:number;maxGapAfter?:number};
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

export function planInvestigation(project:GeoProject,alignment:Alignment,options:InvestigationOptions={}):InvestigationPlan{
  const budget=options.budget??5,minSpacing=options.minSpacing??20,includeOutside=options.includeOutside??false,prioritizeFlags=options.prioritizeFlags??false;
  if(!Number.isInteger(budget)||budget<1||budget>50)throw new Error("The location budget must be an integer from 1 to 50.");
  if(!finite(minSpacing)||minSpacing<0)throw new Error("Minimum location spacing must be a finite nonnegative number of metres.");
  if(typeof includeOutside!=="boolean"||typeof prioritizeFlags!=="boolean")throw new Error("Outside-model and flagged-station choices must be boolean.");
  if(options.depthBelowDesign!==undefined&&(!finite(options.depthBelowDesign)||options.depthBelowDesign<0))throw new Error("Depth below design must be finite and nonnegative.");
  for(const [kind,logs] of [["borehole",project.boreholes],["CPT",project.cpts??[]]] as const){
    if(new Set(logs.map(log=>log.id)).size!==logs.length)throw new Error(`${kind} IDs must be unique for an investigation plan.`);
  }
  const corridor=analyzeCorridor(project,alignment,options),recordedLogs:InvestigationLog[]=[
    ...project.boreholes.map(({id,x,y})=>({id,x,y,kind:"borehole" as const})),
    ...(project.cpts??[]).map(({id,x,y})=>({id,x,y,kind:"cpt" as const}))
  ].filter(log=>finite(log.x)&&finite(log.y));
  const usedLogs=structuredClone(corridor.usedLogs),seen:Array<{x:number;y:number}>=[];
  const candidates=corridor.stations.map((station,stationIndex):InvestigationCandidate=>{
    const d=nearest(station,recordedLogs);let exclusion:InvestigationExclusion|undefined;
    if(!includeOutside&&!station.inside)exclusion="outside-model";
    else if(d!==undefined&&tooClose(d,minSpacing))exclusion="near-recorded";
    else if(seen.some(previous=>distance(previous,station)<=coincident))exclusion="duplicate-location";
    else seen.push(station);
    return {stationIndex,eligible:!exclusion,...(exclusion?{exclusion}:{}),...(d===undefined?{}:{nearestRecordedDistance:d})};
  });
  const eligible=candidates.filter(c=>c.eligible),proposals:InvestigationProposal[]=[],selected=new Set<number>();
  const planningDistance=(station:CorridorStation)=>{
    const existing=station.nearestLog?.distance,planned=nearest(station,proposals);
    return existing===undefined?planned:planned===undefined?existing:Math.min(existing,planned);
  };
  const flagged=(station:CorridorStation)=>station.flags.some(f=>priorityFlags.has(f));
  const midpoint=(corridor.range.start+corridor.range.end)/2;
  const occupiedIds=new Set(recordedLogs.map(log=>log.id));
  while(proposals.length<budget){
    let best:InvestigationCandidate|undefined,bestDistance:number|undefined;
    for(const candidate of eligible){
      if(selected.has(candidate.stationIndex))continue;
      const station=corridor.stations[candidate.stationIndex],toPlanned=nearest(station,proposals);
      if(toPlanned!==undefined&&tooClose(toPlanned,minSpacing))continue;
      const d=planningDistance(station);
      if(!best){best=candidate;bestDistance=d;continue}
      const first=corridor.stations[best.stationIndex];
      if(prioritizeFlags&&flagged(station)!==flagged(first)){
        if(flagged(station)){best=candidate;bestDistance=d}continue;
      }
      // Without any included logs, the first seed is the station closest to the chainage midpoint. Subsequent
      // choices spread away from hypothetical proposed positions; none creates a finite baseline observation gap.
      const wins=d===undefined&&bestDistance===undefined
        ?Math.abs(station.chainage-midpoint)<Math.abs(first.chainage-midpoint)-tolerance
        :d!==undefined&&(bestDistance===undefined||d>bestDistance+tolerance);
      if(wins){best=candidate;bestDistance=d}
    }
    if(!best)break;
    const station=corridor.stations[best.stationIndex],rank=proposals.length+1,baselineDistance=station.nearestLog?.distance,reasons:string[]=[];
    if(prioritizeFlags&&flagged(station))reasons.push(`Flagged stations were prioritized: ${station.flags.filter(f=>priorityFlags.has(f)).join(", ")}.`);
    reasons.push(bestDistance===undefined?"No used logs provide a baseline distance. The first geometric seed is nearest the alignment's chainage midpoint.":
      `Largest remaining distance to used logs and earlier proposed sites: ${bestDistance.toFixed(2)} m.`);
    if(baselineDistance!==undefined)reasons.push(`Nearest used baseline log is ${baselineDistance.toFixed(2)} m away in plan.`);
    if(!station.inside)reasons.push("Outside the existing model: ground, geological predictions and proposed depth are unavailable.");
    let id=`Proposed-${String(rank).padStart(2,"0")}`;while(occupiedIds.has(id))id+="-plan";occupiedIds.add(id);
    const proposal:InvestigationProposal={...structuredClone(station),id,rank,stationIndex:best.stationIndex,
      ...(baselineDistance===undefined?{}:{baselineDistance}),...(bestDistance===undefined?{}:{planningDistance:bestDistance}),
      ...(best.nearestRecordedDistance===undefined?{}:{nearestRecordedDistance:best.nearestRecordedDistance}),reasons};
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
    proposals.push(proposal);selected.add(best.stationIndex);
  }
  const before=maximum(eligible.map(c=>corridor.stations[c.stationIndex].nearestLog?.distance));
  const after=maximum(eligible.map(c=>planningDistance(corridor.stations[c.stationIndex])));
  const excludedByProposals=eligible.filter(c=>!selected.has(c.stationIndex)&&proposals.some(p=>tooClose(distance(p,corridor.stations[c.stationIndex]),minSpacing))).length;
  const notes=["The location budget counts proposed locations, not money. Locations are unobserved planning suggestions and never enter the geological model as measurements.",
    "Default selection greedily takes the largest remaining horizontal distance to used model logs and earlier hypothetical proposed positions. Equal distances retain increasing chainage order; no optimality or statistical information-gain claim is made.",
    "Coverage proxies use the same initial eligible candidate grid before and after, including selected candidates. After values assume a position at each proposal, not successful drilling or new ground information; they do not quantify uncertainty reduction.",
    "Minimum spacing uses Euclidean project-coordinate distance to every finite recorded borehole/CPT collar, including those unused by the model, and to earlier proposed sites. Coincident positions within 1 mm are always excluded, even when spacing is zero.",
    "Repeated route positions are considered once, at their first eligible chainage. Chainage span is not assumed to equal physical distance. Candidate spacing and model-boundary stations follow the corridor sampling settings.",
    "Ground, groundwater and geological units are model predictions, not surveyed proposal observations. Access, utilities, ownership, constructability, investigation type and required depth need independent review.",
    options.includeOutside?"Outside-model candidate stations were explicitly permitted; no extrapolated ground, geology or depth is supplied there.":"Candidates outside the existing model were excluded. Model coverage can include an inferred margin and does not establish observation support.",
    prioritizeFlags?"Stations with low-cover, water-above-design, above-ground, below-model or distant-support flags are considered before other eligible stations, then by the same distance rule. Missing-data flags do not create an assumed hazard severity.":"Screening flags are shown as context and do not change the default distance ranking.",
    options.depthBelowDesign===undefined?"No depth buffer was supplied, so no proposed drilling depth is given.":`Optional proposed depth is model ground minus design bottom (or design top if no bottom) plus ${options.depthBelowDesign} m, only where that gives positive below-ground penetration. Ground and design must share a vertical datum; this is a geometric target, not a prescribed investigation depth.`];
  if(!usedLogs.length)notes.push("No used baseline logs exist. The first candidate is seeded at the chainage midpoint; baseline maximum gap is unavailable. Any later finite gap is hypothetical spacing only, with no finite baseline improvement claim.");
  if(!eligible.length)notes.push("No eligible candidate locations remain after model-coverage, recorded-collar spacing and duplicate-position exclusions.");
  if(proposals.length<budget)notes.push(`Only ${proposals.length} of ${budget} requested locations fit the candidate grid and spacing rules. Reduce spacing, adjust the candidate grid or explicitly allow outside-model locations to explore alternatives.`);
  notes.push(...corridor.notes.map(note=>`Corridor: ${note}`));
  const crs=project.crs||project.crsCode||project.crsProj4?{...(project.crs?{name:project.crs}:{}),...(project.crsCode?{code:project.crsCode}:{}),...(project.crsProj4?{proj4:project.crsProj4}:{})}:undefined;
  return {format:"geomodel3d-investigation-plan",version:1,projectName:project.name,...(crs?{crs}:{}),alignment:structuredClone(alignment),
    options:{step:corridor.options.step,budget,minSpacing,includeOutside,prioritizeFlags,maxSamples:corridor.options.maxSamples,
      ...(options.depthBelowDesign===undefined?{}:{depthBelowDesign:options.depthBelowDesign}),...(options.minCover===undefined?{}:{minCover:options.minCover}),...(options.maxSupportDistance===undefined?{}:{maxSupportDistance:options.maxSupportDistance})},
    corridor,recordedLogs,usedLogs,candidates,proposals,
    summary:{stationCount:candidates.length,eligibleCount:eligible.length,excludedOutside:candidates.filter(c=>c.exclusion==="outside-model").length,
      excludedRecorded:candidates.filter(c=>c.exclusion==="near-recorded").length,excludedDuplicate:candidates.filter(c=>c.exclusion==="duplicate-location").length,
      excludedByProposals,proposedCount:proposals.length,budgetShortfall:budget-proposals.length,...(before===undefined?{}:{maxGapBefore:before}),...(after===undefined?{}:{maxGapAfter:after})},notes};
}

export function investigationCsv(plan:InvestigationPlan):string{
  const headers=["proposal_id","rank","chainage_m","x_m","y_m","inside_model","model_ground_m","design_top_m","design_bottom_m","cover_m","water_head_above_design_m","nearest_used_log_id","nearest_used_log_kind","nearest_used_log_distance_m","nearest_recorded_distance_m","planning_distance_at_selection_m","proposed_depth_m","target_elevation_m","target_reference","termination_elevation_m","termination_below_model","flags","reasons"];
  const metadataNames=["project_name","alignment_name","location_budget","minimum_spacing_m","requested_step_m","actual_step_m","include_outside","prioritize_flags","depth_below_design_m","min_cover_screen_m","max_support_distance_screen_m","max_samples","eligible_candidate_count","budget_shortfall","max_candidate_gap_before_m","max_candidate_gap_with_proposed_positions_m","crs","alignment_geometry","alignment_start_m","design_levels","review_notes"];
  const o=plan.options,s=plan.summary,metadata=[plan.projectName,plan.alignment.name,o.budget,o.minSpacing,o.step,plan.corridor.range.actualStep,String(o.includeOutside),String(o.prioritizeFlags),o.depthBelowDesign,o.minCover,o.maxSupportDistance,o.maxSamples,s.eligibleCount,s.budgetShortfall,s.maxGapBefore,s.maxGapAfter,JSON.stringify(plan.crs??{}),JSON.stringify(plan.alignment.points),plan.corridor.range.start,JSON.stringify(plan.alignment.design??[]),JSON.stringify(plan.notes)];
  const rows=plan.proposals.map(p=>[p.id,p.rank,p.chainage,p.x,p.y,String(p.inside),p.ground,p.top,p.bottom,p.cover,p.waterHead,p.nearestLog?.id,p.nearestLog?.kind,p.baselineDistance,p.nearestRecordedDistance,p.planningDistance,p.proposedDepth,p.targetElevation,p.targetReference,p.terminationElevation,p.belowModel===undefined?undefined:String(p.belowModel),p.flags.join(";"),JSON.stringify(p.reasons),...metadata]);
  if(!rows.length)rows.push([...Array(headers.length).fill(""),...metadata]);
  return toCsv([[...headers,...metadataNames],...rows]);
}
