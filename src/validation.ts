// Leave-one-out cross-validation of the model: each borehole in turn is left out, the model is built from the others
// as the app builds it, and measured contacts and materials are compared with its predictions at the held-out collar.
// This checks prediction between logs separately from the model's fit at its contributing collars. Each model is built with
// a probe node at the collar instead of a refined mesh: the horizons there are the refined model's, a few milliseconds
// per borehole instead of seconds.
import {GeoProject,Borehole,UnitDef} from "./schema";
import {buildGeologicalModel,collarKey,sampleModel,GeoModel} from "./model";
import {convexHull} from "./terrain";
import {XY} from "./tin";
import {bedPredictionSupport,bedPredictionIssue,cachedBedTops} from "./observedContacts";

// A logged contact, the ground (k = 0) or the top of unit k: its logged and predicted elevations, and the error,
// predicted minus logged (positive where the model puts it too high).
export interface ContactCheck { k:number; logged:number; predicted:number; error:number }
const omissionLabels={
  reference:"held-out log does not establish a unique, directly observed top",
  ambiguity:"training logs contain conflicting or repeated bed IDs",
  training:"training logs have no directly observed top for this bed",
  absent:"bed is absent from this training model",
  prediction:"no finite, positive bed thickness predicted at the held-out collar"
};
type OmittedTop={unit:string;reason:keyof typeof omissionLabels};
export interface BoreholeCheck {
  // `cpt`: the log is a CPT's layers.
  id:string; x:number; y:number; cpt?:boolean;
  // Outside the outline of the other boreholes: the prediction there is an extrapolation.
  outside:boolean;
  contacts:ContactCheck[];
  omittedTops:OmittedTop[];
  // Measured metres eligible for depth scoring, and those predicted in the logged bed.
  logged:number; right:number;
  /** Source rows were malformed or overlapped, making the log's depth-agreement denominator unavailable. */
  depthScoreUnavailable?:boolean;
  // Overlap by logged material, combining distinct interpreted beds that share their materialId.
  materialRight:number;
  // Mean absolute error of its contacts, and the largest.
  mae:number; worst?:ContactCheck;
  // Units that only this borehole logs: the model built without it has none.
  unique:string[];
}
// The errors of one surface: count, mean (bias), mean absolute, root mean square, and the largest, where it is.
export interface SurfaceCheck { k:number; name:string; n:number; bias:number; mae:number; rms:number; max:number; at:string }
export interface CrossValidation {
  boreholes:BoreholeCheck[];
  // The surfaces' errors at the boreholes inside the outline of the others, and at those outside.
  inside:SurfaceCheck[]; outside:SurfaceCheck[];
  // Share of the logged metres predicted in the unit logged, inside and outside (NaN where there are none).
  share:{inside:number;outside:number};
  materialShare:{inside:number;outside:number};
  // Names of the surfaces: the ground, then the top of each unit.
  surfaces:string[];
  // Whether the model followed a terrain grid, which then gives the ground between the boreholes.
  terrain:boolean;
  notes:string[];
}

function insidePolygon(poly:XY[],p:XY){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const a=poly[i],b=poly[j];
    if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
  }
  return inside;
}
function distanceToPolygon(poly:XY[],p:XY){
  let d=Infinity;
  for(let i=0;i<poly.length;i++){
    const a=poly[i],b=poly[(i+1)%poly.length],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;
    const t=l2?Math.min(1,Math.max(0,((p.x-a.x)*dx+(p.y-a.y)*dy)/l2)):0;
    d=Math.min(d,Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy));
  }
  return d;
}

// Hold out the whole collar so a coincident log discarded from the full model cannot take its place.
function check(project:GeoProject,holes:Borehole[],b:Borehole,units:UnitDef[],
  observations:ReturnType<typeof cachedBedTops>):BoreholeCheck|undefined{
  const others=holes.filter(o=>o!==b),hull=convexHull(others.map(o=>({x:o.x,y:o.y})));
  const key=collarKey(b),atOtherSite=(p:XY)=>collarKey(p)!==key;
  const without:GeoProject={...project,boreholes:project.boreholes.filter(atOtherSite),cpts:project.cpts?.filter(atOtherSite)};
  const distance=hull.length>2&&insidePolygon(hull,b)?0:distanceToPolygon(hull,b);
  const outside=distance>1e-6;
  // Outside the others, the model is extended to reach the borehole, as a model extent would extend it (the frame of
  // an extent lies at least 0.98 times the extent beyond the outline).
  let margin=project.margin,z:number[]|null=null,model:GeoModel|undefined;
  for(let attempt=0;attempt<4&&!z;attempt++){
    if(outside)margin=Math.max(project.margin??0,(1.2*distance+1)*2**attempt);
    model=buildGeologicalModel({...without,...(margin!==undefined?{margin}:{})},{probe:{x:b.x,y:b.y}});
    z=sampleModel(model,b.x,b.y);
    if(!outside)break;
  }
  if(!z||!model)return undefined;
  const m=model,ids=units.map(u=>u.id);
  // The surfaces of the model built without the borehole: the ground, and the top of each unit it has.
  const trainingIndex=new Map(m.units.map((u,j)=>[u.id,j]));
  const material=new Map(units.map(u=>[u.id,u.materialId??u.id]));
  const materialBands=new Map<string,number[]>();
  m.units.forEach((u,j)=>{
    const id=u.materialId??u.id,bands=materialBands.get(id);
    if(bands)bands.push(j);else materialBands.set(id,[j]);
  });
  const support=bedPredictionSupport(m,observations);
  const contacts:ContactCheck[]=[],unique:string[]=[],omittedTops:OmittedTop[]=[];
  if(Number.isFinite(b.z)&&Number.isFinite(z[0]))contacts.push({k:0,logged:b.z,predicted:z[0],error:z[0]-b.z});
  const reference=observations(b);
  for(const [k,unit] of ids.entries()){
    const top=reference.tops.get(unit);
    if(!top)continue;
    const j=trainingIndex.get(unit);
    if(j===undefined)unique.push(unit);
    if(k===0)continue; // Surface zero in the validation report is surveyed ground, independently of material.
    const omit=(reason:OmittedTop["reason"])=>omittedTops.push({unit,reason});
    if(reference.problem||top.logged===undefined)omit("reference");
    else if(j===undefined)omit("absent");
    else{
      const issue=bedPredictionIssue(support,unit,j,z);
      if(issue)omit(issue);
      else contacts.push({k,logged:top.logged,predicted:z[j],error:z[j]-top.logged});
    }
  }
  // Each non-overlapping model band contributes only its intersection with the measured interval.
  let logged=0,right=0,materialRight=0,previousBase=0;
  // Entire logs with invalid or overlapping intervals lack an unambiguous depth denominator. Where two
  // boundaries differ only within the contact tolerance, count their shared rounding sliver once.
  for(const i of reference.problem?[]:reference.intervals){
    const from=Math.max(previousBase,i.from),id=material.get(i.unit);
    previousBase=Math.max(previousBase,i.to);
    if(id===undefined||i.to<=from)continue;
    const top=b.z-from,bottom=b.z-i.to;
    logged+=i.to-from;
    for(const j of materialBands.get(id)??[]){
      if(!Number.isFinite(z[j])||!Number.isFinite(z[j+1]))continue;
      const overlap=Math.max(0,Math.min(top,z[j])-Math.max(bottom,z[j+1]));
      materialRight+=overlap;
      if(m.units[j].id===i.unit)right+=overlap;
    }
  }
  const worst=contacts.reduce<ContactCheck|undefined>((w,q)=>!w||Math.abs(q.error)>Math.abs(w.error)?q:w,undefined);
  const mae=contacts.length?contacts.reduce((s,q)=>s+Math.abs(q.error),0)/contacts.length:NaN;
  return {id:b.id,x:b.x,y:b.y,outside,contacts,omittedTops,logged,right,materialRight,mae,...(reference.problem?{depthScoreUnavailable:true}:{}),...(worst?{worst}:{}),unique:[...new Set(unique)]};
}

function surfaceChecks(checks:BoreholeCheck[],names:string[]):SurfaceCheck[]{
  return names.map((name,k)=>{
    const e=checks.flatMap(b=>b.contacts.filter(q=>q.k===k).map(q=>({id:b.id,e:q.error})));
    if(!e.length)return null;
    const n=e.length,worst=e.reduce((w,q)=>Math.abs(q.e)>Math.abs(w.e)?q:w);
    return {k,name,n,bias:e.reduce((s,q)=>s+q.e,0)/n,mae:e.reduce((s,q)=>s+Math.abs(q.e),0)/n,rms:Math.sqrt(e.reduce((s,q)=>s+q.e*q.e,0)/n),max:worst.e,at:worst.id};
  }).filter((s):s is SurfaceCheck=>!!s);
}

// Leaves out each log of the model in turn (the boreholes, then the CPT layers the model is built with), yielding how
// many are done before each and at the end, so that a caller can show progress and stop between them; returns the
// result. `full` is the model of all the logs, when it is already built.
export function* crossValidation(project:GeoProject,full=buildGeologicalModel(project)):Generator<{done:number;total:number},CrossValidation>{
  const holes=[...full.boreholes,...full.cptLogs],units=full.units,first=full.boreholes.length;
  const observations=cachedBedTops(project.units);
  const surfaces=["Ground surface",...full.units.slice(1).map(u=>`Top of ${u.name}`)];
  const boreholes:BoreholeCheck[]=[],notes:string[]=[];
  if(holes.length<2)notes.push("Cross-validation needs at least two logs in the model");
  else for(let i=0;i<holes.length;i++){
    yield {done:i,total:holes.length};
    const r=check(project,holes,holes[i],units,observations);
    if(r)boreholes.push(i>=first?{...r,cpt:true}:r);else notes.push(`${holes[i].id}: no model of the other logs reaches it; left out`);
  }
  if(full.cptLogs.length)notes.push(`${full.cptLogs.length} of the logs are CPT layers: each is left out in turn as a borehole is`);
  yield {done:holes.length,total:holes.length};
  const share=(list:BoreholeCheck[],metric:"right"|"materialRight")=>{
    const metres=list.reduce((s,b)=>s+b.logged,0);
    return metres?list.reduce((s,b)=>s+b[metric],0)/metres:NaN;
  };
  const inside=boreholes.filter(b=>!b.outside),outside=boreholes.filter(b=>b.outside);
  const unavailable=boreholes.filter(b=>b.depthScoreUnavailable);
  if(unavailable.length)notes.push(`All depth intervals from ${unavailable.map(b=>b.id).join(", ")} were excluded from the bed and material agreement totals because source intervals are invalid or overlap. Surveyed ground is checked independently.`);
  const omissions=new Map<OmittedTop["reason"],number>();
  for(const hole of boreholes)for(const {reason} of hole.omittedTops)omissions.set(reason,(omissions.get(reason)??0)+1);
  for(const [reason,n] of omissions)notes.push(`Excluded ${n} bed-top ${n===1?"comparison":"comparisons"} from contact errors (${omissionLabels[reason]}).`);
  const unique=[...new Set(boreholes.flatMap(b=>b.unique))];
  if(unique.length)notes.push(`Logged in one borehole only, so not predicted from the others: ${unique.map(id=>full.units.find(u=>u.id===id)!.name).join(", ")}`);
  return {boreholes,inside:surfaceChecks(inside,surfaces),outside:surfaceChecks(outside,surfaces),share:{inside:share(inside,"right"),outside:share(outside,"right")},
    materialShare:{inside:share(inside,"materialRight"),outside:share(outside,"materialRight")},
    surfaces,terrain:!!project.terrain,notes};
}
// The same, all at once; `progress` is told how many boreholes are done.
export function crossValidate(project:GeoProject,progress?:(done:number,total:number)=>void):CrossValidation{
  const steps=crossValidation(project);
  for(;;){const r=steps.next();if(r.done)return r.value;progress?.(r.value.done,r.value.total)}
}
