// Leave-one-out cross-validation of the model: each borehole in turn is left out, the model is built from the others
// as the app builds it, and the borehole's log is compared with what that model predicts at its collar. A model honours
// every borehole it is built from, so only this says how far it can be trusted between them (the usual check of a
// spatial interpolation; Isaaks & Srivastava, An Introduction to Applied Geostatistics, 1989). Each model is built with
// a probe node at the collar instead of a refined mesh: the horizons there are the refined model's, a few milliseconds
// per borehole instead of seconds.
import {GeoProject,Borehole,UnitDef} from "./schema";
import {buildGeologicalModel,boreholeContacts,sampleModel,GeoModel} from "./model";
import {convexHull} from "./terrain";
import {XY} from "./tin";

// A logged contact, the ground (k = 0) or the top of unit k: its logged and predicted elevations, and the error,
// predicted minus logged (positive where the model puts it too high).
export interface ContactCheck { k:number; logged:number; predicted:number; error:number }
export interface BoreholeCheck {
  id:string; x:number; y:number;
  // Outside the outline of the other boreholes: the prediction there is an extrapolation.
  outside:boolean;
  contacts:ContactCheck[];
  // Logged metres, and those of them predicted in the unit logged.
  logged:number; right:number;
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

// One borehole against the model built from the others: undefined if no model of the others reaches it.
function check(project:GeoProject,holes:Borehole[],b:Borehole,units:UnitDef[]):BoreholeCheck|undefined{
  const others=holes.filter(o=>o!==b),hull=convexHull(others.map(o=>({x:o.x,y:o.y})));
  const distance=hull.length>2&&insidePolygon(hull,b)?0:distanceToPolygon(hull,b);
  const outside=distance>1e-6;
  // Outside the others, the model is extended to reach the borehole, as a model extent would extend it (the frame of
  // an extent lies at least 0.98 times the extent beyond the outline).
  let margin=project.margin,z:number[]|null=null,model:GeoModel|undefined;
  for(let attempt=0;attempt<4&&!z;attempt++){
    if(outside)margin=Math.max(project.margin??0,(1.2*distance+1)*2**attempt);
    model=buildGeologicalModel({...project,boreholes:others,...(margin!==undefined?{margin}:{})},{probe:{x:b.x,y:b.y}});
    z=sampleModel(model,b.x,b.y);
    if(!outside)break;
  }
  if(!z||!model)return undefined;
  const m=model,ids=units.map(u=>u.id);
  // The surfaces of the model built without the borehole: the ground, and the top of each unit it has.
  const topOf=(id:string)=>{const j=m.units.findIndex(u=>u.id===id);return j<0?undefined:j};
  const c=boreholeContacts(b,units);
  const contacts:ContactCheck[]=[],unique:string[]=[];
  for(let k=0;k<=c.deepest;k++){
    const d=c.depth[k]??c.eroded[k];
    if(d===null)continue;
    const j=k===0?0:topOf(ids[k]);
    if(j===undefined){unique.push(ids[k]);continue}
    const logged=b.z-d,predicted=z[j];
    contacts.push({k,logged,predicted,error:predicted-logged});
  }
  // The logged metres in the unit the model predicts there.
  let logged=0,right=0;
  for(const i of b.intervals){
    if(!(i.to>i.from)||!ids.includes(i.unit))continue;
    const top=b.z-i.from,bottom=b.z-i.to,j=topOf(i.unit);
    logged+=top-bottom;
    if(j!==undefined)right+=Math.max(0,Math.min(top,z[j])-Math.max(bottom,z[j+1]));
  }
  const worst=contacts.reduce<ContactCheck|undefined>((w,q)=>!w||Math.abs(q.error)>Math.abs(w.error)?q:w,undefined);
  const mae=contacts.length?contacts.reduce((s,q)=>s+Math.abs(q.error),0)/contacts.length:NaN;
  return {id:b.id,x:b.x,y:b.y,outside,contacts,logged,right,mae,...(worst?{worst}:{}),unique:[...new Set(unique)]};
}

function surfaceChecks(checks:BoreholeCheck[],names:string[]):SurfaceCheck[]{
  return names.map((name,k)=>{
    const e=checks.flatMap(b=>b.contacts.filter(q=>q.k===k).map(q=>({id:b.id,e:q.error})));
    if(!e.length)return null;
    const n=e.length,worst=e.reduce((w,q)=>Math.abs(q.e)>Math.abs(w.e)?q:w);
    return {k,name,n,bias:e.reduce((s,q)=>s+q.e,0)/n,mae:e.reduce((s,q)=>s+Math.abs(q.e),0)/n,rms:Math.sqrt(e.reduce((s,q)=>s+q.e*q.e,0)/n),max:worst.e,at:worst.id};
  }).filter((s):s is SurfaceCheck=>!!s);
}

// Leaves out each borehole of the model in turn, yielding how many are done before each and at the end, so that a
// caller can show progress and stop between boreholes; returns the result. `full` is the model of all the boreholes,
// when it is already built.
export function* crossValidation(project:GeoProject,full=buildGeologicalModel(project)):Generator<{done:number;total:number},CrossValidation>{
  const holes=full.boreholes,units=full.units;
  const surfaces=["Ground surface",...full.units.slice(1).map(u=>`Top of ${u.name}`)];
  const boreholes:BoreholeCheck[]=[],notes:string[]=[];
  if(holes.length<2)notes.push("Cross-validation needs at least two boreholes in the model");
  else for(let i=0;i<holes.length;i++){
    yield {done:i,total:holes.length};
    const r=check(project,holes,holes[i],units);
    if(r)boreholes.push(r);else notes.push(`${holes[i].id}: no model of the other boreholes reaches it; left out`);
  }
  yield {done:holes.length,total:holes.length};
  const share=(list:BoreholeCheck[])=>{const l=list.reduce((s,b)=>s+b.logged,0);return l?list.reduce((s,b)=>s+b.right,0)/l:NaN};
  const inside=boreholes.filter(b=>!b.outside),outside=boreholes.filter(b=>b.outside);
  const unique=[...new Set(boreholes.flatMap(b=>b.unique))];
  if(unique.length)notes.push(`Logged in one borehole only, so not predicted from the others: ${unique.map(id=>full.units.find(u=>u.id===id)!.name).join(", ")}`);
  return {boreholes,inside:surfaceChecks(inside,surfaces),outside:surfaceChecks(outside,surfaces),share:{inside:share(inside),outside:share(outside)},
    surfaces,terrain:!!project.terrain,notes};
}
// The same, all at once; `progress` is told how many boreholes are done.
export function crossValidate(project:GeoProject,progress?:(done:number,total:number)=>void):CrossValidation{
  const steps=crossValidation(project);
  for(;;){const r=steps.next();if(r.done)return r.value;progress?.(r.value.done,r.value.total)}
}
