// Screen one fixed model along an alignment. These are values at explicit stations, not continuous risk extents
// or a measure of confidence: gaps, missing design and unknown groundwater remain visible in the result.
import type {Alignment,GeoProject} from "./schema";
import {buildGeologicalModel} from "./model";
import {alignmentProblem,alignmentSection,chainages,designAt,pointAt} from "./alignment";
import {columnAt} from "./fields";
import {sectionRuns} from "./section";
import {toCsv} from "./io";

export interface CorridorOptions { step?:number;minCover?:number;maxSupportDistance?:number;maxSamples?:number }
export type CorridorPosition="inside"|"above-ground"|"below-model"|"outside-model";
export type CorridorFlag="outside-model"|"missing-design"|"above-ground"|"below-model"|"low-cover"|"water-above-design"|"water-unknown"|"distant-support"|"no-support";
export interface CorridorUnit { id:string;name:string;color:string }
export interface CorridorLog { id:string;kind:"borehole"|"cpt";x:number;y:number }
export interface CorridorStation {
  chainage:number;x:number;y:number;inside:boolean;ground?:number;water?:number;top?:number;bottom?:number;
  cover?:number;waterHead?:number;topPosition?:CorridorPosition;bottomPosition?:CorridorPosition;
  unitTop?:CorridorUnit;unitBottom?:CorridorUnit;
  nearestLog?:{id:string;kind:"borehole"|"cpt";distance:number};flags:CorridorFlag[];
}
export interface CorridorExtremum { chainage:number;value:number }
export interface CorridorReport {
  format:"geomodel3d-corridor";version:1;projectName:string;alignment:Alignment;
  options:{step:number;minCover?:number;maxSupportDistance?:number;maxSamples:number};
  range:{start:number;end:number;actualStep:number};units:CorridorUnit[];stations:CorridorStation[];
  usedLogs:CorridorLog[];modelBase?:number;
  summary:{stationCount:number;insideCount:number;designCount:number;flaggedStationCount:number;counts:Record<CorridorFlag,number>;
    minCover?:CorridorExtremum;maxWaterHead?:CorridorExtremum;maxLogDistance?:CorridorExtremum};
  notes:string[];
}
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);
const flags:CorridorFlag[]=["outside-model","missing-design","above-ground","below-model","low-cover","water-above-design","water-unknown","distant-support","no-support"];
const unique=(values:number[])=>values.sort((a,b)=>a-b).filter((n,i,all)=>!i||n-all[i-1]>1e-8);

function extremum(stations:CorridorStation[],value:(station:CorridorStation)=>number|undefined,least=false):CorridorExtremum|undefined{
  let found:CorridorExtremum|undefined;
  for(const station of stations){const n=value(station);if(finite(n)&&(!found||(least?n<found.value:n>found.value)))found={chainage:station.chainage,value:n}}
  return found;
}

export function analyzeCorridor(project:GeoProject,alignment:Alignment,options:CorridorOptions={}):CorridorReport{
  const problem=alignmentProblem(alignment);if(problem)throw new Error(`The corridor alignment is invalid: ${problem}.`);
  const step=options.step??10,cap=options.maxSamples??2001;
  if(!finite(step)||step<=0)throw new Error("The station spacing must be a positive finite number of chainage metres.");
  if(!Number.isInteger(cap)||cap<2||cap>2001)throw new Error("The station limit must be an integer from 2 to 2001.");
  for(const key of ["minCover","maxSupportDistance"] as const)if(options[key]!==undefined&&(!finite(options[key])||options[key]!<0))throw new Error(`The ${key==="minCover"?"cover":"support distance"} screening threshold must be finite and nonnegative.`);
  if(new Set(project.units.map(u=>u.id)).size!==project.units.length)throw new Error("Unit IDs must be unique for a corridor review.");
  const ch=chainages(alignment),start=ch[0],end=ch[ch.length-1],length=end-start;
  if(!finite(length)||length<=1e-8)throw new Error("The alignment needs a usable finite chainage range.");
  const model=buildGeologicalModel(project),section=alignmentSection(model,alignment);
  const ranges=sectionRuns(section).map(([a,b])=>[section.s[a],section.s[b]] as const).filter(([a,b])=>finite(a)&&finite(b));
  const covered=(c:number)=>ranges.some(([a,b])=>c>=a-1e-8&&c<=b+1e-8);
  const required=[start,end,...ch,...(alignment.design??[]).map(d=>d.chainage).filter(c=>c>=start&&c<=end),...ranges.flat()];
  const boundaries=unique([start,end,...ranges.flat()]);
  for(let i=1;i<boundaries.length;i++){const mid=(boundaries[i-1]+boundaries[i])/2;if(!covered(mid))required.push(mid)}
  const mandatory=unique(required.filter(c=>c>=start&&c<=end));
  if(mandatory.length>cap)throw new Error("The station limit is too small to preserve alignment vertices, design knots and model gaps. Increase it or simplify the reference alignment.");
  const segments=Math.max(1,Math.min(Math.ceil(length/step),cap-mandatory.length+1)),actualStep=length/segments;
  const positions=unique([...mandatory,...Array.from({length:segments-1},(_,i)=>start+(i+1)*actualStep)]);
  const units=model.units.map(({id,name,color})=>({id,name,color}));
  const usedLogs:CorridorLog[]=[...model.boreholes.map(({id,x,y})=>({id,x,y,kind:"borehole" as const})),...model.cptLogs.map(({id,x,y})=>({id,x,y,kind:"cpt" as const}))];
  const position=(z:number[],e:number):{position:CorridorPosition;unit?:CorridorUnit}=>{
    if(e>z[0]+1e-9)return {position:"above-ground"};
    for(let k=0;k<units.length;k++)if(e>=z[k+1]-1e-9&&z[k]-z[k+1]>1e-9)return {position:"inside",unit:units[k]};
    return {position:"below-model"};
  };
  const stations=positions.map((chainage):CorridorStation=>{
    const xy=pointAt(alignment,chainage,ch),raw=columnAt(section,chainage),col=raw?.z.length&&raw.z.every(finite)?raw:undefined,d=designAt(alignment.design,chainage);
    const station:CorridorStation={chainage,x:xy.x,y:xy.y,inside:!!col,...(finite(d.top)?{top:d.top}:{}),...(finite(d.bottom)?{bottom:d.bottom}:{}),flags:[]};
    let nearest:CorridorStation["nearestLog"];
    for(const log of usedLogs){const distance=Math.hypot(log.x-xy.x,log.y-xy.y);if(finite(distance)&&(!nearest||distance<nearest.distance))nearest={id:log.id,kind:log.kind,distance}}
    if(nearest)station.nearestLog=nearest;
    if(!col){
      station.flags.push("outside-model");
      if(station.top!==undefined)station.topPosition="outside-model";
      if(station.bottom!==undefined)station.bottomPosition="outside-model";
    }else{
      station.ground=col.z[0];if(finite(col.water))station.water=col.water;
      if(station.top!==undefined){
        const found=position(col.z,station.top);station.topPosition=found.position;if(found.unit)station.unitTop=found.unit;
        station.cover=station.ground-station.top;
        if(station.water!==undefined)station.waterHead=station.water-station.top;
      }
      if(station.bottom!==undefined){const found=position(col.z,station.bottom);station.bottomPosition=found.position;if(found.unit)station.unitBottom=found.unit}
      if(station.topPosition==="above-ground")station.flags.push("above-ground");
      if(station.topPosition==="below-model"||station.bottomPosition==="below-model")station.flags.push("below-model");
      if(station.cover!==undefined&&options.minCover!==undefined&&station.cover<options.minCover-1e-9)station.flags.push("low-cover");
      if(station.waterHead!==undefined&&station.waterHead>1e-9)station.flags.push("water-above-design");
      if(station.water===undefined)station.flags.push("water-unknown");
    }
    if(station.top===undefined)station.flags.push("missing-design");
    if(!nearest)station.flags.push("no-support");
    else if(options.maxSupportDistance!==undefined&&nearest.distance>options.maxSupportDistance+1e-9)station.flags.push("distant-support");
    return station;
  });
  const notes=["This is screening at the listed stations, not a continuous risk assessment, design approval or a confidence estimate. Values and extrema between stations may be missed.",
    "Cover is ground elevation minus design top. Water head is water-table elevation minus design top; it is not a seepage calculation or a water-pressure estimate.",
    "Design top may be a tunnel crown, road level or other supplied design elevation. Above-ground and below-model flags describe its position, not an engineering failure.",
    "Units at exact contacts use the unit above the boundary; the final model base belongs to the last unit with positive thickness.",
    "Only boreholes and CPT layer logs actually admitted to the ground model are used for nearest-log distance. It is horizontal distance in project coordinates, not evidence of vertical support or statistical confidence.",
    "Stations, counts and sample spacing use supplied chainage. Chainage span may differ from physical distance along the alignment; no length percentages are estimated.",
    "Alignment vertices, in-range design knots, model-coverage boundaries and points in model gaps are retained. Unknown ground, water and design values remain unavailable; the model is not extended for this review.",
    "The model footprint may include configured or automatic margin extensions; being within it does not establish observation support. Confirm that alignment and model use the same coordinates and elevation datum.",
    model.water?`Groundwater: ${model.water.source}.`:"Groundwater is unknown; water head is unavailable rather than assuming a dry model.",
    options.minCover===undefined?"The cover screening threshold is disabled.":`Low cover means sampled cover below the chosen ${options.minCover} m screen; this is a user criterion, not a prescribed design limit.`,
    options.maxSupportDistance===undefined?"The nearest-log distance screening threshold is disabled.":`Distant support means nearest used-log distance above the chosen ${options.maxSupportDistance} m screen; this is a user criterion, not a confidence bound.`];
  if(actualStep>step*(1+1e-9))notes.push(`Sampling was limited to ${cap} stations; the regular chainage spacing increased from ${step} m to ${actualStep} m.`);
  if(!stations.some(s=>s.inside))notes.push("The reference alignment has no usable ground-model coverage at the review stations.");
  notes.push(...model.warnings.map(w=>`Model: ${w}`));
  const counts=Object.fromEntries(flags.map(flag=>[flag,stations.filter(s=>s.flags.includes(flag)).length])) as Record<CorridorFlag,number>;
  const minCover=extremum(stations,s=>s.cover,true),maxWaterHead=extremum(stations,s=>s.waterHead),maxLogDistance=extremum(stations,s=>s.nearestLog?.distance);
  return {format:"geomodel3d-corridor",version:1,projectName:project.name,alignment:structuredClone(alignment),
    options:{step,maxSamples:cap,...(options.minCover===undefined?{}:{minCover:options.minCover}),...(options.maxSupportDistance===undefined?{}:{maxSupportDistance:options.maxSupportDistance})},
    range:{start,end,actualStep},units,stations,usedLogs,...(model.triangles.length&&finite(model.base)?{modelBase:model.base}:{}),
    summary:{stationCount:stations.length,insideCount:stations.filter(s=>s.inside).length,designCount:stations.filter(s=>s.top!==undefined).length,
      flaggedStationCount:stations.filter(s=>s.flags.length).length,counts,...(minCover?{minCover}:{}),...(maxWaterHead?{maxWaterHead}:{}),...(maxLogDistance?{maxLogDistance}:{})},notes};
}

export function corridorCsv(report:CorridorReport):string{
  const headers=["chainage_m","x_m","y_m","inside_model","ground_m","water_m","design_top_m","design_bottom_m","cover_m","water_head_above_design_m","top_position","bottom_position","unit_top_id","unit_top_name","unit_bottom_id","unit_bottom_name","nearest_log_id","nearest_log_kind","nearest_log_distance_m","flags","project_name","alignment_name","requested_step_m","actual_step_m","min_cover_screen_m","max_support_distance_screen_m","alignment_geometry","design_levels","review_notes","alignment_start_m","alignment_end_m","max_samples"];
  const metadata=[report.projectName,report.alignment.name,report.options.step,report.range.actualStep,report.options.minCover,report.options.maxSupportDistance,JSON.stringify(report.alignment.points),JSON.stringify(report.alignment.design??[]),JSON.stringify(report.notes),report.range.start,report.range.end,report.options.maxSamples];
  const rows=report.stations.map(s=>[s.chainage,s.x,s.y,String(s.inside),s.ground,s.water,s.top,s.bottom,s.cover,s.waterHead,s.topPosition,s.bottomPosition,s.unitTop?.id,s.unitTop?.name,s.unitBottom?.id,s.unitBottom?.name,s.nearestLog?.id,s.nearestLog?.kind,s.nearestLog?.distance,s.flags.join(";"),...metadata]);
  return toCsv([headers,...rows]);
}
