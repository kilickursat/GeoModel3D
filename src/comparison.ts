// Compare two interpretations at the same world coordinates. The reference line never recentres on the second
// model, contacts are paired by unit ID, and missing coverage is never treated as a zero elevation or stress.
import {Alignment,GeoProject} from "./schema";
import {buildGeologicalModel,GeoModel,locateInModel,sampleModel} from "./model";
import {computeSection,offsetThrough,principalAzimuth,sectionRuns,Section} from "./section";
import {alignmentProblem,alignmentSection,chainages,pointAt} from "./alignment";
import {stressAt,unitOfReading,unitWeights,UnitWeight} from "./fields";
import {projectCrs} from "./crs";
import {toCsv} from "./io";

export interface ComparisonOptions {
  mode:"section"|"alignment"; azimuth?:number; offset?:number; alignment?:Alignment;
  step?:number; elevation?:number; maxSamples?:number;
}
export interface ComparisonColumn {
  ground:number; water?:number; contacts:Record<string,number>; unitIdAtLevel?:string;
  stress?:{sv:number;u:number;s:number;sh?:number};
}
export interface ComparisonPoint { distance:number;x:number;y:number;before?:ComparisonColumn;after?:ComparisonColumn }
export interface DeltaSummary { count:number;minDelta?:number;maxDelta?:number;meanDelta?:number }
export interface SurfaceComparison extends DeltaSummary {
  unitId:string;status:"shared"|"introduced"|"removed";
  beforeName?:string;afterName?:string;beforeColor?:string;afterColor?:string;
}
export interface ProjectComparison {
  format:"geomodel3d-comparison";version:1;beforeName:string;afterName:string;mode:ComparisonOptions["mode"];
  axisLabel:"Distance (m)"|"Chainage (m)";
  path:{start:number;end:number;step:number;azimuth?:number;offset?:number;alignmentName?:string;elevation?:number};
  points:ComparisonPoint[];surfaces:SurfaceComparison[];
  summary:{sampleCount:number;overlapSamples:number;beforeOnlySamples:number;afterOnlySamples:number;outsideSamples:number;
    maxGroundDelta?:number;maxWaterDelta?:number;changedUnitSamples:number;comparedUnitSamples:number;
    ground:DeltaSummary;water:DeltaSummary};
  notes:string[];
}
type Range=[number,number];
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);
const normalName=(s:string|undefined)=>(s??"").trim().replace(/\s+/g," ").toLowerCase();
function definition(s:string){
  const trimmed=s.trim().replace(/\s+/g," ");
  if(!trimmed.startsWith("+"))return trimmed;
  const tokens=trimmed.split(" ").filter(t=>t!=="+no_defs"&&t!=="+type=crs"),keys=tokens.map(t=>t.split("=",1)[0]);
  // Repeated projection parameters can be order-dependent. Do not declare reordered ambiguous definitions equal.
  return new Set(keys).size===keys.length?tokens.sort().join(" "):trimmed;
}
function compatibleCrs(before:GeoProject,after:GeoProject){
  const a=projectCrs(before),b=projectCrs(after);
  if(a||b){
    if(!a||!b||definition(a.proj4)!==definition(b.proj4))throw new Error("The projects use different coordinate systems or projection definitions. Put both in the same system before comparing.");
  }else if(normalName(before.crs)!==normalName(after.crs)||normalName(before.crsCode)!==normalName(after.crsCode)){
    throw new Error("The projects name different local grids or unrecognised coordinate systems. Confirm a common coordinate system before comparing.");
  }
}
function ranges(section:Section):Range[]{
  return sectionRuns(section).map(([a,b]):Range=>[section.s[a],section.s[b]]).filter(([a,b])=>finite(a)&&finite(b)&&b-a>1e-8);
}
const covered=(ranges:Range[],s:number)=>ranges.some(([a,b])=>s>=a-1e-8&&s<=b+1e-8);
function commonRanges(a:Range[],b:Range[]):Range[]{
  const result:Range[]=[];let i=0,j=0;
  while(i<a.length&&j<b.length){
    const start=Math.max(a[i][0],b[j][0]),end=Math.min(a[i][1],b[j][1]);
    if(end-start>1e-8)result.push([start,end]);
    if(a[i][1]<b[j][1])i++;else j++;
  }
  return result;
}
function summary(values:number[]):DeltaSummary{
  return values.length?{count:values.length,minDelta:Math.min(...values),maxDelta:Math.max(...values),meanDelta:values.reduce((a,b)=>a+b,0)/values.length}:{count:0};
}
const delta=(before:number|undefined,after:number|undefined)=>finite(before)&&finite(after)?after-before:undefined;
const maxAbsolute=(s:DeltaSummary)=>s.count?Math.max(Math.abs(s.minDelta!),Math.abs(s.maxDelta!)):undefined;

function column(model:GeoModel,x:number,y:number,elevation:number|undefined,weights:UnitWeight[]):ComparisonColumn|undefined{
  const z=sampleModel(model,x,y);
  if(!z||!finite(z[0]))return;
  const contacts:Record<string,number>=Object.create(null);
  model.units.forEach((u,k)=>{if(finite(z[k]))contacts[u.id]=z[k]});
  const result:ComparisonColumn={ground:z[0],contacts},hit=locateInModel(model,x,y);
  if(model.water&&hit){
    const {t,w}=hit,v=model.water.z,water=w[0]*v[t.a]+w[1]*v[t.b]+w[2]*v[t.c];
    if(finite(water))result.water=water;
  }
  if(elevation!==undefined){
    let k=unitOfReading(z,elevation);
    // The bottom of the final unit is within the model, although reading classification excludes that boundary.
    if(k<0&&Math.abs(elevation-z[z.length-1])<=1e-9)for(let i=model.units.length-1;i>=0;i--)if(z[i]-z[i+1]>1e-9){k=i;break}
    if(k>=0)result.unitIdAtLevel=model.units[k].id;
    if(result.water!==undefined){
      const stress=stressAt(z,result.water,weights,elevation);
      if(stress&&Object.values(stress).every(finite)){
        result.stress={...stress};
        const K0=k>=0?model.units[k].params?.K0:undefined;
        if(finite(K0)&&finite(K0*stress.s))result.stress.sh=K0*stress.s;
      }
    }
  }
  return result;
}

export function compareProjects(before:GeoProject,after:GeoProject,options:ComparisonOptions):ProjectComparison{
  if(options.mode!=="section"&&options.mode!=="alignment")throw new Error("Choose a straight section or an alignment comparison.");
  const cap=options.maxSamples??2001;
  if(!Number.isInteger(cap)||cap<2||cap>2001)throw new Error("The sample limit must be an integer from 2 to 2001.");
  if(options.step!==undefined&&(!finite(options.step)||options.step<=0))throw new Error("The sampling step must be a positive finite number of metres.");
  if(options.elevation!==undefined&&!finite(options.elevation))throw new Error("The comparison elevation must be finite.");
  for(const key of ["azimuth","offset"] as const)if(options[key]!==undefined&&!finite(options[key]))throw new Error(`The section ${key} must be finite.`);
  compatibleCrs(before,after);
  for(const p of [before,after])if(new Set(p.units.map(u=>u.id)).size!==p.units.length)throw new Error(`${p.name}: unit IDs must be unique to compare their contacts.`);
  if(options.mode==="alignment"){
    if(!options.alignment)throw new Error("Choose an explicit reference alignment to compare.");
    const problem=alignmentProblem(options.alignment);if(problem)throw new Error(`The reference alignment is invalid: ${problem}.`);
  }
  const a=buildGeologicalModel(before),b=buildGeologicalModel(after);
  if(!a.triangles.length||!b.triangles.length)throw new Error("Both projects must build a ground model with a usable footprint.");
  const notes=["Deltas are after minus before; maximum ground and water changes are absolute magnitudes.",
    "Elevations are compared as supplied. A common vertical datum must be confirmed; the project format does not verify it.",
    "Contacts mean the top of each geological unit, paired by its stable unit ID. Names and array positions do not identify a contact.",
    "Differences describe model interpretations, not measured ground movement or statistical confidence. No volume differences are estimated."];
  if(!projectCrs(before))notes.push("The local-grid names agree. Their physical origin, orientation and units must also be the same.");
  let start:number,end:number,ar:Range[],br:Range[],at:(s:number)=>{x:number;y:number};
  const path:ProjectComparison["path"]={start:0,end:0,step:0,...(options.elevation===undefined?{}:{elevation:options.elevation})};
  if(options.mode==="section"){
    const azimuth=options.azimuth??principalAzimuth(a),offset=options.offset??0;
    const sa=computeSection(a,{azimuth,offset});
    if(sa.s.length<2)throw new Error("The reference section does not cross the before model over a usable length.");
    const sb=computeSection(b,{azimuth,offset:offsetThrough(b,azimuth,sa.origin)});
    const along=(x:number,y:number)=>(x-sa.origin.x)*sa.dir.x+(y-sa.origin.y)*sa.dir.y;
    ar=ranges(sa);br=ranges({...sb,s:sb.x.map((x,i)=>along(x,sb.y[i]))});
    const ends=[...ar,...br].flat();start=Math.min(...ends);end=Math.max(...ends);
    at=s=>({x:sa.origin.x+s*sa.dir.x,y:sa.origin.y+s*sa.dir.y});
    path.azimuth=azimuth;path.offset=offset;
    notes.push("The straight section is fixed in the before model's coordinate frame and extended along the same line to cover both footprints.");
  }else{
    const alignment=options.alignment!,ch=chainages(alignment);
    start=ch[0];end=ch[ch.length-1];
    ar=ranges(alignmentSection(a,alignment));br=ranges(alignmentSection(b,alignment));
    at=s=>pointAt(alignment,s,ch);path.alignmentName=alignment.name;
    notes.push("Both models use the same supplied alignment geometry and chainages; design levels do not move the sampling line.");
  }
  if(!finite(start)||!finite(end)||!finite(end-start)||end-start<=1e-8)throw new Error("The comparison line has no usable length.");
  if(!commonRanges(ar,br).length)throw new Error("The projects have no overlapping model coverage along this reference line.");
  // Include coverage boundaries and a point in each gap, so plots cannot join across an unsampled hole in either
  // model. The remaining budget holds a regular grid; a very small requested step is explicitly coarsened.
  const required=[start,end,...ar.flat(),...br.flat()].filter(s=>s>=start&&s<=end).sort((x,y)=>x-y);
  const unique=(v:number[])=>v.sort((x,y)=>x-y).filter((s,i,all)=>i===0||s-all[i-1]>1e-8);
  const boundaries=unique(required);
  for(let i=1;i<boundaries.length;i++){
    const mid=(boundaries[i-1]+boundaries[i])/2;
    if(!covered(ar,mid)||!covered(br,mid))required.push(mid);
  }
  const mandatory=unique(required);
  if(mandatory.length>cap)throw new Error("The sample limit is too small to preserve this line's model boundaries and gaps. Increase it or choose a shorter line.");
  const length=end-start,requested=options.step??length/200;
  const available=cap-mandatory.length,segments=Math.max(1,Math.min(Math.ceil(length/requested),available+1)),step=length/segments;
  const distances=unique([...mandatory,...Array.from({length:segments-1},(_,i)=>start+(i+1)*step)]);
  if(step>requested*(1+1e-9))notes.push(`Sampling was limited to ${cap} points; the regular spacing increased from ${requested} m to ${step} m.`);
  notes.push("Sampling includes model boundaries and gaps. Summaries are unweighted statistics over these sample locations, not distance-weighted estimates; intermediate extrema may be missed.");
  path.start=start;path.end=end;path.step=step;
  const aw=unitWeights(a),bw=unitWeights(b);
  if(options.elevation!==undefined)for(const [name,model,weights] of [["Before",a,aw],["After",b,bw]] as const){
    if(!model.water)notes.push(`${name}: groundwater is unknown; water levels and stresses are left unavailable, rather than assuming zero pore pressure.`);
    else notes.push(`${name} water table: ${model.water.source}. Stresses use hydrostatic pore pressure.`);
    const assumed=model.units.filter((_,i)=>weights[i].source==="assumed").map(u=>u.name);
    if(assumed.length)notes.push(`${name}: assumed unit weights of 18 kN/m³ above water and 20 kN/m³ below water for ${assumed.join(", ")}.`);
    const measured=model.units.filter((_,i)=>weights[i].source==="measured").map(u=>u.name);
    if(measured.length)notes.push(`${name}: mean measured unit weight used for ${measured.join(", ")}.`);
    if(model.units.some(u=>!finite(u.params?.K0)))notes.push(`${name}: horizontal effective stress is unavailable in units without K0.`);
  }
  const points=distances.map((distance):ComparisonPoint=>{
    const {x,y}=at(distance),before=column(a,x,y,options.elevation,aw),after=column(b,x,y,options.elevation,bw);
    return {distance,x,y,...(before?{before}:{}),...(after?{after}:{})};
  });
  const beforeUnits=new Map(a.units.map(u=>[u.id,u])),afterUnits=new Map(b.units.map(u=>[u.id,u]));
  const surfaces=[...new Set([...beforeUnits.keys(),...afterUnits.keys()])].map((unitId):SurfaceComparison=>{
    const u=beforeUnits.get(unitId),v=afterUnits.get(unitId),deltas=points.map(p=>delta(p.before?.contacts[unitId],p.after?.contacts[unitId])).filter(finite);
    return {unitId,status:u&&v?"shared":u?"removed":"introduced",...(u?{beforeName:u.name,beforeColor:u.color}:{}),
      ...(v?{afterName:v.name,afterColor:v.color}:{}),...summary(deltas)};
  });
  const ground=summary(points.map(p=>delta(p.before?.ground,p.after?.ground)).filter(finite));
  const water=summary(points.map(p=>delta(p.before?.water,p.after?.water)).filter(finite));
  const overlapping=points.filter(p=>p.before&&p.after),comparable=overlapping.filter(p=>p.before!.unitIdAtLevel!==undefined&&p.after!.unitIdAtLevel!==undefined);
  return {format:"geomodel3d-comparison",version:1,beforeName:before.name,afterName:after.name,mode:options.mode,
    axisLabel:options.mode==="section"?"Distance (m)":"Chainage (m)",path,points,surfaces,
    summary:{sampleCount:points.length,overlapSamples:overlapping.length,beforeOnlySamples:points.filter(p=>p.before&&!p.after).length,
      afterOnlySamples:points.filter(p=>!p.before&&p.after).length,outsideSamples:points.filter(p=>!p.before&&!p.after).length,
      ...(ground.count?{maxGroundDelta:maxAbsolute(ground)}:{}),...(water.count?{maxWaterDelta:maxAbsolute(water)}:{}),
      changedUnitSamples:comparable.filter(p=>p.before!.unitIdAtLevel!==p.after!.unitIdAtLevel).length,comparedUnitSamples:comparable.length,ground,water},
    notes:[...notes,...a.warnings.map(w=>`Before model: ${w}`),...b.warnings.map(w=>`After model: ${w}`)]};
}

export function comparisonCsv(result:ProjectComparison):string{
  const stress=["sv","u","s","sh"] as const;
  const header=["distance_m","x_m","y_m","before_inside","after_inside","before_ground_m","after_ground_m","delta_ground_m",
    "before_water_m","after_water_m","delta_water_m","elevation_m","before_unit_at_level","after_unit_at_level",
    ...stress.flatMap(k=>[`before_${k}_kPa`,`after_${k}_kPa`,`delta_${k}_kPa`]),
    ...result.surfaces.flatMap(s=>[`before_top_${s.unitId}_m`,`after_top_${s.unitId}_m`,`delta_top_${s.unitId}_m`])];
  const rows=result.points.map(p=>[p.distance,p.x,p.y,String(!!p.before),String(!!p.after),p.before?.ground,p.after?.ground,delta(p.before?.ground,p.after?.ground),
    p.before?.water,p.after?.water,delta(p.before?.water,p.after?.water),result.path.elevation,p.before?.unitIdAtLevel,p.after?.unitIdAtLevel,
    ...stress.flatMap(k=>[p.before?.stress?.[k],p.after?.stress?.[k],delta(p.before?.stress?.[k],p.after?.stress?.[k])]),
    ...result.surfaces.flatMap(s=>[p.before?.contacts[s.unitId],p.after?.contacts[s.unitId],delta(p.before?.contacts[s.unitId],p.after?.contacts[s.unitId])])]);
  return toCsv([header,...rows]);
}
