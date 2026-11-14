import type {GeoProject,GroundwaterPolicy,WaterLevel} from "./schema";

// Date-only cutoffs include the complete UTC day. Observation dates mean the start of that day.
function instant(value:string,endOfDay=false):number{
  const match=/^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if(!match)return NaN;
  const day=Date.parse(match[1]+"T00:00:00.000Z");
  if(!Number.isFinite(day)||new Date(day).toISOString().slice(0,10)!==match[1])return NaN;
  return value.length===10?day+(endOfDay?86400000-1:0):Date.parse(value);
}

/** Validate an explicit policy. The legacy groundwaterDepth fallback belongs only to observed mode. */
export function parseGroundwater(value:unknown):GroundwaterPolicy{
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Groundwater policy must be an object");
  const p=value as Record<string,unknown>;
  const keys=p.mode==="observed"?["mode"]:p.mode==="assumed-depth"?["mode","depth"]:p.mode==="as-of"?["mode","date","includeUndated"]:[];
  if(!keys.length||Object.keys(p).some(k=>!keys.includes(k)))throw new Error("Groundwater policy has an unsupported mode or field");
  if(p.mode==="observed")return {mode:"observed"};
  if(p.mode==="assumed-depth"){
    if(typeof p.depth!=="number"||!Number.isFinite(p.depth))throw new Error("Assumed groundwater depth must be finite");
    return {mode:"assumed-depth",depth:p.depth};
  }
  if(typeof p.date!=="string"||!Number.isFinite(instant(p.date,true)))throw new Error("Groundwater as-of date must be an ISO date or timestamp");
  if(p.includeUndated!==undefined&&typeof p.includeUndated!=="boolean")throw new Error("Groundwater includeUndated must be boolean");
  return {mode:"as-of",date:p.date,...(p.includeUndated!==undefined?{includeUndated:p.includeUndated}:{})};
}

export interface SelectedGroundwater {
  boreholeId:string;x:number;y:number;elevation:number;observation:WaterLevel;undatedFallback:boolean;
}

/** Select actual observations without inventing readings or carrying future observations backward. */
export function selectedGroundwater(project:GeoProject):SelectedGroundwater[]{
  const policy=project.groundwater??{mode:"observed"};
  if(policy.mode==="assumed-depth")return [];
  const cutoff=policy.mode==="as-of"?instant(policy.date,true):Infinity,out:SelectedGroundwater[]=[];
  for(const b of project.boreholes){
    if(![b.x,b.y,b.z].every(Number.isFinite))continue;
    const readings=(b.water??[]).filter(w=>Number.isFinite(w.depth));
    let observation:WaterLevel|undefined,undatedFallback=false;
    if(policy.mode==="observed"){
      for(const w of readings)if(!observation||w.depth<observation.depth)observation=w;
    }else{
      let latest=-Infinity;
      for(const w of readings){
        const at=w.date?instant(w.date):NaN;
        if(at<=cutoff&&(at>latest||at===latest&&(!observation||w.depth<observation.depth))){observation=w;latest=at}
      }
      if(!observation&&policy.includeUndated){
        for(const w of readings)if(!w.date?.trim()&&(!observation||w.depth<observation.depth))observation=w;
        undatedFallback=!!observation;
      }
    }
    if(observation)out.push({boreholeId:b.id,x:b.x,y:b.y,elevation:b.z-observation.depth,observation,undatedFallback});
  }
  return out;
}

/** Prepare once when sampling a mesh; groundwaterAt is the convenient point-query wrapper. */
export function groundwaterField(project:GeoProject){
  const policy=project.groundwater??{mode:"observed"},readings=selectedGroundwater(project);
  const assumed=policy.mode==="assumed-depth"?policy.depth:policy.mode==="observed"&&!readings.length&&Number.isFinite(project.groundwaterDepth)?project.groundwaterDepth:undefined;
  let summary:string;
  if(policy.mode==="assumed-depth")summary=`assumed ${policy.depth} m below ground (explicit scenario override of observed levels)`;
  else if(policy.mode==="as-of"){
    const undated=readings.filter(r=>r.undatedFallback).length;
    summary=readings.length?`water levels as of ${policy.date} in ${readings.length} of ${project.boreholes.length} boreholes (latest eligible dated observation per hole${undated?`; ${undated} undated fallback${undated===1?"":"s"}`:""}), interpolated between them`:`Groundwater unavailable as of ${policy.date}: no eligible observations`;
    summary+=policy.includeUndated?"; undated fallback permitted only where no eligible dated reading exists":"; undated observations excluded";
    summary+="; future observations excluded; legacy assumed depth is not used";
  }else if(readings.length)summary=`water levels logged in ${readings.length} of ${project.boreholes.length} boreholes (the shallowest reading of each), interpolated between them`;
  else if(assumed!==undefined)summary=`assumed ${Math.round(assumed*100)/100} m below ground (no water level is logged)`;
  else summary="Groundwater unavailable: no observed level or legacy assumed depth";
  return {readings,summary,available:readings.length>0||assumed!==undefined,at(x:number,y:number,ground:number):number|undefined{
    if(assumed!==undefined)return ground-assumed;
    let num=0,den=0;
    // Preserve legacy inverse-square arithmetic and first exact-collar precedence.
    for(const r of readings){
      const d2=(r.x-x)**2+(r.y-y)**2;
      if(d2<1e-12)return Math.min(r.elevation,ground);
      num+=r.elevation/d2;den+=1/d2;
    }
    return den>0?Math.min(num/den,ground):undefined;
  }};
}
export const groundwaterAt=(project:GeoProject,x:number,y:number,ground:number)=>groundwaterField(project).at(x,y,ground);
export const groundwaterSummary=(project:GeoProject)=>groundwaterField(project).summary;
