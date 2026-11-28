import type {GeoModel} from "./model";
import type {Borehole} from "./schema";

const epsilon=1e-6;
export interface BedTop {
  logged?:number;
  reason?:string;
  /** The same bed ID was reused in separate runs or contradicts the interpreted order. */
  ambiguous?:boolean;
}

// Source intervals alone determine whether a bed top was measured. A model can assign elevations to missing,
// eroded or unlogged units in order to construct a surface; those elevations cannot serve as reference observations.
export function loggedBedTops(hole:Borehole,order:ReadonlyMap<string,number>){
  const intervals=hole.intervals.slice().sort((a,b)=>a.from-b.from||a.to-b.to);
  let problem:string|undefined;
  if(intervals.some(i=>!Number.isFinite(i.from)||!Number.isFinite(i.to)||i.from<0||i.to<=i.from))
    problem="Invalid logged intervals make this contact unavailable.";
  else if(intervals.some((i,k)=>k>0&&i.from<intervals[k-1].to-epsilon))
    problem="Overlapping logged intervals make the contact ambiguous.";
  const tops=new Map<string,BedTop>();
  let highest=-1;
  for(const [k,interval] of intervals.entries()){
    const previous=intervals[k-1],rank=order.get(interval.unit);
    if(rank===undefined)continue;
    if(previous?.unit===interval.unit&&Math.abs(interval.from-previous.to)<=epsilon)continue;
    const logged=hole.z-interval.from;
    let top:BedTop;
    if(tops.has(interval.unit))top={ambiguous:true,reason:"The selected unit occurs in repeated separated runs; its top is ambiguous."};
    else if(rank<highest)top={ambiguous:true,reason:"The selected unit is out of stratigraphic order; its top is ambiguous."};
    else if(!previous&&interval.from>epsilon)top={reason:"The log starts below the collar; this unit's top was not observed."};
    else if(previous&&interval.from>previous.to+epsilon)top={reason:"An unlogged gap precedes this unit; its top was not observed."};
    else if(!Number.isFinite(logged))top={reason:"The logged contact elevation is not finite."};
    else top={logged};
    tops.set(interval.unit,top);
    highest=Math.max(highest,rank);
  }
  return {tops,problem,intervals};
}

// Share observations of unchanged source holes between folds of one interpretation. Reclassified CPT logs
// are fresh objects on each build and therefore receive a fresh analysis.
export function cachedBedTops(units:readonly {id:string}[]){
  const order=new Map(units.map((u,i)=>[u.id,i]));
  const sourceTops=new WeakMap<Borehole,ReturnType<typeof loggedBedTops>>();
  return (hole:Borehole)=>{
    let log=sourceTops.get(hole);
    if(!log){log=loggedBedTops(hole,order);sourceTops.set(hole,log)}
    return log;
  };
}

/** Bed IDs with measured tops and IDs whose source logs leave the correlation ambiguous, in this fitted model. */
export function bedPredictionSupport(model:GeoModel,observations?:(hole:Borehole)=>ReturnType<typeof loggedBedTops>){
  const read=observations??cachedBedTops(model.units);
  const supported=new Set<string>(),ambiguous=new Set<string>();
  for(const hole of [...model.boreholes,...model.cptLogs]){
    const {tops,problem}=read(hole);
    for(const [unit,top] of tops){
      if(top.ambiguous)ambiguous.add(unit);
      if(!problem&&top.logged!==undefined)supported.add(unit);
    }
  }
  return {supported,ambiguous};
}

export function bedPredictionIssue(support:ReturnType<typeof bedPredictionSupport>,unit:string,index:number,z:readonly number[]|null){
  if(support.ambiguous.has(unit))return "ambiguity";
  if(!support.supported.has(unit))return "training";
  if(!z||!Number.isFinite(z[index])||!Number.isFinite(z[index+1])||z[index]-z[index+1]<=epsilon)return "prediction";
}
