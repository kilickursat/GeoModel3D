import {GeoModel} from "./model";
import {XY,uniqueEdges} from "./tin";
import {boreholeDepth} from "./geology";

// A vertical section: azimuth in degrees clockwise from north (+y), offset in metres from the model centre,
// measured to the right of the section direction.
export interface SectionSpec { azimuth:number; offset:number }
export interface SectionFrame { origin:XY; dir:XY; normal:XY }
export interface ProjectedBorehole { index:number; s:number; offset:number; top:number; bottom:number }
export interface Section extends SectionSpec, SectionFrame {
  s:number[]; x:number[]; y:number[];
  z:number[][];
  observed:boolean[][];
  boreholes:ProjectedBorehole[];
}

export function modelCentre(model:GeoModel):XY{
  if(!model.nodes.length)return {x:0,y:0};
  const xs=model.nodes.map(p=>p.x),ys=model.nodes.map(p=>p.y);
  return {x:(Math.min(...xs)+Math.max(...xs))/2,y:(Math.min(...ys)+Math.max(...ys))/2};
}
export function sectionFrame(model:GeoModel,spec:SectionSpec):SectionFrame{
  const a=spec.azimuth*Math.PI/180,c=modelCentre(model);
  const dir={x:Math.sin(a),y:Math.cos(a)},normal={x:Math.cos(a),y:-Math.sin(a)};
  return {origin:{x:c.x+normal.x*spec.offset,y:c.y+normal.y*spec.offset},dir,normal};
}
// Offsets for which the section line still crosses the model footprint.
export function offsetRange(model:GeoModel,azimuth:number):[number,number]{
  const {origin,normal}=sectionFrame(model,{azimuth,offset:0});
  const f=model.nodes.map(p=>(p.x-origin.x)*normal.x+(p.y-origin.y)*normal.y);
  return f.length?[Math.min(...f),Math.max(...f)]:[0,0];
}
// Azimuth of the long axis of the borehole layout (principal component), the most informative default section.
export function principalAzimuth(model:GeoModel){
  const c=modelCentre(model);
  let sxx=0,syy=0,sxy=0;
  for(const p of model.nodes){const dx=p.x-c.x,dy=p.y-c.y;sxx+=dx*dx;syy+=dy*dy;sxy+=dx*dy}
  const angle=0.5*Math.atan2(2*sxy,sxx-syy);
  const az=(90-angle*180/Math.PI+360)%180;
  return Math.round(az);
}

// Intersects every horizon with the vertical plane. All horizons share the triangulation, so the line crosses the
// same TIN edges at the same points for each of them and the section polylines are aligned sample by sample.
export function computeSection(model:GeoModel,spec:SectionSpec,buffer=Infinity):Section{
  const frame=sectionFrame(model,spec),{origin,dir,normal}=frame;
  const along=(p:XY)=>(p.x-origin.x)*dir.x+(p.y-origin.y)*dir.y;
  const across=(p:XY)=>(p.x-origin.x)*normal.x+(p.y-origin.y)*normal.y;
  const H=model.horizons;
  const b=model.nodes.length?Math.max(...model.nodes.map(p=>Math.abs(across(p))+Math.abs(along(p))),1):1;
  const eps=1e-9*b;
  const samples:Array<{s:number;x:number;y:number;z:number[];observed:boolean[]}>=[];
  const atVertex=new Set<number>();
  const vertex=(i:number)=>{
    if(atVertex.has(i))return;
    atVertex.add(i);
    const p=model.nodes[i];
    samples.push({s:along(p),x:p.x,y:p.y,z:H.map(h=>h.z[i]),observed:H.map(h=>!!h.observed[i])});
  };
  model.edges??=uniqueEdges(model.triangles);
  for(const [i,j] of model.edges){
    const fi=across(model.nodes[i]),fj=across(model.nodes[j]);
    if(Math.abs(fi)<=eps)vertex(i);
    if(Math.abs(fj)<=eps)vertex(j);
    if(Math.abs(fi)<=eps||Math.abs(fj)<=eps||fi*fj>0)continue;
    const t=fi/(fi-fj),p={x:model.nodes[i].x+t*(model.nodes[j].x-model.nodes[i].x),y:model.nodes[i].y+t*(model.nodes[j].y-model.nodes[i].y)};
    samples.push({s:along(p),x:p.x,y:p.y,z:H.map(h=>h.z[i]+t*(h.z[j]-h.z[i])),observed:H.map(h=>!!(h.observed[i]&&h.observed[j]))});
  }
  samples.sort((p,q)=>p.s-q.s);
  const unique=samples.filter((p,k)=>k===0||p.s-samples[k-1].s>eps);
  const boreholes:ProjectedBorehole[]=[];
  model.boreholes.forEach((bh,index)=>{
    const offset=across(bh);
    if(Math.abs(offset)<=buffer)boreholes.push({index,s:along(bh),offset,top:bh.z,bottom:bh.z-boreholeDepth(bh)});
  });
  boreholes.sort((p,q)=>p.s-q.s);
  return {...spec,...frame,
    s:unique.map(p=>p.s),x:unique.map(p=>p.x),y:unique.map(p=>p.y),
    z:H.map((_,k)=>unique.map(p=>p.z[k])),
    observed:H.map((_,k)=>unique.map(p=>p.observed[k])),
    boreholes};
}
