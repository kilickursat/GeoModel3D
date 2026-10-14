// Sections along an alignment: the line of a tunnel, road, railway, pipeline or dike, by points of its centreline in
// plan, with chainage along it and, if given, its design levels. The section follows the line through the model and is
// exact, as the straight section is: it has a sample wherever the line crosses an edge of the triangulation and at each
// point of the line, so the horizons are linear between samples. From it come the longitudinal profile, a table by
// chainage, and straight cross-sections square to the line.
import {GeoModel,locateInModel} from "./model";
import {Alignment,DesignLevel,boreholeDepth} from "./schema";
import {Section,ProjectedBorehole,offsetThrough,sectionRuns} from "./section";
import {columnAt} from "./fields";
import {XY,uniqueEdges} from "./tin";

// The chainage at each point: given at every point, or measured along the line from `start` (0 by default).
export function chainages(a:Alignment){
  const p=a.points;
  if(p.length&&p.every(q=>q.chainage!==undefined))return p.map(q=>q.chainage!);
  const out=[a.start??0];
  for(let i=1;i<p.length;i++)out.push(out[i-1]+Math.hypot(p[i].x-p[i-1].x,p[i].y-p[i-1].y));
  return out;
}
export function alignmentLength(a:Alignment){
  let l=0;
  for(let i=1;i<a.points.length;i++)l+=Math.hypot(a.points[i].x-a.points[i-1].x,a.points[i].y-a.points[i-1].y);
  return l;
}
// What is wrong with an alignment, or null: it needs two points apart, and chainages and design levels in increasing
// chainage.
export function alignmentProblem(a:Alignment):string|null{
  const p=a.points??[];
  if(p.length<2)return "it needs at least two points";
  if(p.some(q=>!Number.isFinite(q.x)||!Number.isFinite(q.y)))return "a point has no x or y";
  for(let i=1;i<p.length;i++)if(Math.hypot(p[i].x-p[i-1].x,p[i].y-p[i-1].y)<1e-3)return `points ${i} and ${i+1} are at the same place`;
  const given=p.filter(q=>q.chainage!==undefined).length;
  if(given&&given<p.length)return "chainage is given at some points but not at all of them";
  const ch=chainages(a);
  if(ch.some(c=>!Number.isFinite(c)))return "a chainage is not a number";
  for(let i=1;i<ch.length;i++)if(!(ch[i]>ch[i-1]))return `chainage does not increase from point ${i} to point ${i+1}`;
  const d=a.design??[];
  if(d.some(q=>!Number.isFinite(q.chainage)||!Number.isFinite(q.top)||(q.bottom!==undefined&&!Number.isFinite(q.bottom))))return "a design level is not a number";
  for(let i=1;i<d.length;i++)if(!(d[i].chainage>d[i-1].chainage))return "the design levels are not in increasing chainage";
  if(d.some(q=>q.bottom!==undefined&&!(q.top>q.bottom)))return "a crown is not above its invert";
  return null;
}

// The azimuth of a direction in plan, in degrees clockwise from north.
export const azimuthOf=(d:XY)=>(Math.atan2(d.x,d.y)*180/Math.PI+360)%360;
// The point at a chainage, and the direction of the line there (a unit vector); at a bend, the direction halfway between
// the two legs. Chainages beyond the ends give the ends.
export function pointAt(a:Alignment,c:number,ch=chainages(a)){
  const p=a.points,n=p.length;
  let i=0;
  while(i<n-2&&c>ch[i+1])i++;
  const t=Math.min(1,Math.max(0,(c-ch[i])/(ch[i+1]-ch[i])));
  const leg=(k:number)=>{const dx=p[k+1].x-p[k].x,dy=p[k+1].y-p[k].y,l=Math.hypot(dx,dy);return {x:dx/l,y:dy/l}};
  let dir=leg(i);
  const bend=t>1-1e-9&&i<n-2?i+1:t<1e-9&&i>0?i:-1;
  if(bend>0){const u=leg(bend-1),v=leg(bend),x=u.x+v.x,y=u.y+v.y,l=Math.hypot(x,y);if(l>1e-9)dir={x:x/l,y:y/l}}
  return {x:p[i].x+t*(p[i+1].x-p[i].x),y:p[i].y+t*(p[i+1].y-p[i].y),dir};
}
// Where a point lies from the line: the chainage of the nearest point of the line, the offset (positive to the right
// of the line), and whether it lies beyond either end, where its nearest point is the end itself.
export function nearestOnLine(a:Alignment,q:XY,ch=chainages(a)){
  const p=a.points,n=p.length;
  let best={distance:Infinity,chainage:ch[0],offset:0,beyond:false};
  for(let i=0;i<n-1;i++){
    const dx=p[i+1].x-p[i].x,dy=p[i+1].y-p[i].y,l2=dx*dx+dy*dy;
    const u=((q.x-p[i].x)*dx+(q.y-p[i].y)*dy)/l2,t=Math.min(1,Math.max(0,u));
    const d=Math.hypot(q.x-p[i].x-t*dx,q.y-p[i].y-t*dy);
    if(d<best.distance-1e-12){
      const side=Math.sign(dy*(q.x-p[i].x)-dx*(q.y-p[i].y))||1;
      best={distance:d,chainage:ch[i]+t*(ch[i+1]-ch[i]),offset:side*d,beyond:(i===0&&u<0)||(i===n-2&&u>1)};
    }
  }
  return best;
}
// The design levels at a chainage, interpolated linearly between the given ones; none beyond them.
export function designAt(design:DesignLevel[]|undefined,c:number):{top?:number;bottom?:number}{
  const d=design??[],n=d.length;
  if(!n||c<d[0].chainage-1e-6||c>d[n-1].chainage+1e-6)return {};
  if(n===1)return d[0].bottom===undefined?{top:d[0].top}:{top:d[0].top,bottom:d[0].bottom};
  let i=0;
  while(i<n-2&&c>d[i+1].chainage)i++;
  const t=Math.min(1,Math.max(0,(c-d[i].chainage)/(d[i+1].chainage-d[i].chainage)));
  const top=d[i].top+t*(d[i+1].top-d[i].top),b0=d[i].bottom,b1=d[i+1].bottom;
  return b0===undefined||b1===undefined?{top}:{top,bottom:b0+t*(b1-b0)};
}

interface Sample { s:number; x:number; y:number; z:number[]; observed:boolean[]; w:number }
// The bounding boxes of the triangulation's edges, built once per model, to skip the edges far from a leg.
const edgeBoxes=new WeakMap<GeoModel,Float64Array>();
function boxesOf(model:GeoModel){
  let b=edgeBoxes.get(model);
  if(b)return b;
  const e=model.edges??=uniqueEdges(model.triangles),p=model.nodes;
  b=new Float64Array(e.length*4);
  e.forEach(([i,j],k)=>{b![4*k]=Math.min(p[i].x,p[j].x);b![4*k+1]=Math.min(p[i].y,p[j].y);b![4*k+2]=Math.max(p[i].x,p[j].x);b![4*k+3]=Math.max(p[i].y,p[j].y)});
  edgeBoxes.set(model,b);
  return b;
}

// The section along an alignment: s is the chainage. Boreholes within `buffer` metres of the line are projected onto
// it, at the chainage of their nearest point; those beyond its ends are left out.
export function alignmentSection(model:GeoModel,a:Alignment,buffer=Infinity):Section{
  const ch=chainages(a),P=a.points,H=model.horizons,W=model.water?.z,nodes=model.nodes;
  const edges=model.edges??=uniqueEdges(model.triangles),boxes=boxesOf(model);
  let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
  for(const q of nodes){x0=Math.min(x0,q.x);x1=Math.max(x1,q.x);y0=Math.min(y0,q.y);y1=Math.max(y1,q.y)}
  const eps=1e-9*Math.max(Math.hypot(x1-x0,y1-y0),1);
  // A point of the line inside a triangle; observed where every corner it depends on is.
  const inside=(x:number,y:number):Sample|null=>{
    const hit=locateInModel(model,x,y);
    if(!hit)return null;
    const {t,w}=hit,c=[t.a,t.b,t.c],used=c.filter((_,k)=>w[k]>1e-9);
    const mix=(v:ArrayLike<number>)=>w[0]*v[c[0]]+w[1]*v[c[1]]+w[2]*v[c[2]];
    return {s:0,x,y,z:H.map(h=>mix(h.z)),observed:H.map(h=>used.every(n=>h.observed[n])),w:W?mix(W):NaN};
  };
  const samples:Sample[]=[];
  for(let i=0;i<P.length-1;i++){
    const A=P[i],B=P[i+1],dx=B.x-A.x,dy=B.y-A.y,L=Math.hypot(dx,dy),ux=dx/L,uy=dy/L;
    const along=(q:XY)=>(q.x-A.x)*ux+(q.y-A.y)*uy,across=(q:XY)=>(q.x-A.x)*uy-(q.y-A.y)*ux;
    const bx0=Math.min(A.x,B.x)-eps,bx1=Math.max(A.x,B.x)+eps,by0=Math.min(A.y,B.y)-eps,by1=Math.max(A.y,B.y)+eps;
    const leg:Sample[]=[];
    for(const [q,s] of [[A,0],[B,L]] as const){const v=inside(q.x,q.y);if(v){v.s=s;leg.push(v)}}
    const onLine=new Set<number>();
    const node=(n:number)=>{
      const s=along(nodes[n]);
      if(onLine.has(n)||s<-eps||s>L+eps)return;
      onLine.add(n);
      leg.push({s,x:nodes[n].x,y:nodes[n].y,z:H.map(h=>h.z[n]),observed:H.map(h=>!!h.observed[n]),w:W?W[n]:NaN});
    };
    for(let e=0;e<edges.length;e++){
      if(boxes[4*e]>bx1||boxes[4*e+2]<bx0||boxes[4*e+1]>by1||boxes[4*e+3]<by0)continue;
      const [m,n]=edges[e],fm=across(nodes[m]),fn=across(nodes[n]);
      if(Math.abs(fm)<=eps)node(m);
      if(Math.abs(fn)<=eps)node(n);
      if(Math.abs(fm)<=eps||Math.abs(fn)<=eps||fm*fn>0)continue;
      const t=fm/(fm-fn),q={x:nodes[m].x+t*(nodes[n].x-nodes[m].x),y:nodes[m].y+t*(nodes[n].y-nodes[m].y)},s=along(q);
      if(s<-eps||s>L+eps)continue;
      leg.push({s,x:q.x,y:q.y,z:H.map(h=>h.z[m]+t*(h.z[n]-h.z[m])),observed:H.map(h=>!!(h.observed[m]&&h.observed[n])),w:W?W[m]+t*(W[n]-W[m]):NaN});
    }
    leg.sort((p,q)=>p.s-q.s);
    for(const v of leg){
      const s=Math.min(L,Math.max(0,v.s)),c=s>=L?ch[i+1]:ch[i]+s/L*(ch[i+1]-ch[i]);
      const last=samples[samples.length-1];
      if(last&&c-last.s<=eps*Math.max(1,Math.abs(c)))continue;
      samples.push({...v,s:c});
    }
  }
  // Two samples in a row are joined unless the line between them leaves the model: there is no edge between them, so
  // the stretch lies in one triangle or wholly outside, and its middle tells which.
  const runs:Array<[number,number]>=[];
  let first=0;
  for(let j=0;j<samples.length-1;j++){
    const mid=pointAt(a,(samples[j].s+samples[j+1].s)/2,ch);
    if(!locateInModel(model,mid.x,mid.y)){runs.push([first,j]);first=j+1}
  }
  if(samples.length)runs.push([first,samples.length-1]);
  const boreholes:ProjectedBorehole[]=[];
  model.boreholes.forEach((bh,index)=>{
    const q=nearestOnLine(a,bh,ch);
    if(!q.beyond&&Math.abs(q.offset)<=buffer)boreholes.push({index,s:q.chainage,offset:q.offset,top:bh.z,bottom:bh.z-boreholeDepth(bh)});
  });
  boreholes.sort((p,q)=>p.s-q.s);
  const a0=P[0],a1=P[P.length-1],l=Math.hypot(a1.x-a0.x,a1.y-a0.y)||1,dir={x:(a1.x-a0.x)/l,y:(a1.y-a0.y)/l};
  return {azimuth:azimuthOf(dir),offset:0,origin:{x:a0.x,y:a0.y},dir,normal:{x:dir.y,y:-dir.x},
    s:samples.map(p=>p.s),x:samples.map(p=>p.x),y:samples.map(p=>p.y),
    z:H.map((_,k)=>samples.map(p=>p.z[k])),observed:H.map((_,k)=>samples.map(p=>p.observed[k])),
    boreholes,...(W?{water:samples.map(p=>p.w)}:{}),
    alignment:{name:a.name,s:ch,x:P.map(p=>p.x),y:P.map(p=>p.y),...(a.design?.length?{design:a.design}:{})},runs};
}

// The stretches of chainage where the line is outside the model: before it enters, between its stretches inside, and
// after it leaves.
export function outsideStretches(s:Section):Array<[number,number]>{
  const a=s.alignment;
  if(!a)return [];
  const runs=sectionRuns(s),out:Array<[number,number]>=[],c0=a.s[0],c1=a.s[a.s.length-1];
  if(!runs.length)return [[c0,c1]];
  if(s.s[runs[0][0]]>c0+1e-6)out.push([c0,s.s[runs[0][0]]]);
  for(let k=0;k+1<runs.length;k++)out.push([s.s[runs[k][1]],s.s[runs[k+1][0]]]);
  const end=s.s[runs[runs.length-1][1]];
  if(end<c1-1e-6)out.push([end,c1]);
  return out;
}

// A straight section square to the line at a chainage: its azimuth (0–180°) and the offset that puts it through the
// line there, for an azimuth rounded to whole degrees as the section controls hold it.
export function crossSectionAt(model:GeoModel,a:Alignment,c:number){
  const p=pointAt(a,c),azimuth=Math.round(azimuthOf(p.dir)+90)%180;
  return {azimuth,offset:offsetThrough(model,azimuth,p),x:p.x,y:p.y};
}

// ---------- a table by chainage ----------

// Where an elevation lies in the column: the index of its unit, -1 above the ground, -2 below the model.
const ABOVE=-1,BELOW=-2;
function unitAtLevel(z:number[],e:number){
  if(e>z[0]+1e-9)return ABOVE;
  for(let k=0;k+1<z.length;k++)if(e>=z[k+1]-1e-9&&z[k]-z[k+1]>1e-9)return k;
  return BELOW;
}
export interface ChainageRow {
  chainage:number; x:number; y:number; ground:number; water?:number;
  // Design levels, and the unit at each (an index, or -1 above the ground, -2 below the model).
  top?:number; bottom?:number; unitTop?:number; unitBottom?:number;
  // Each unit's thickness, and, between crown and invert, its share of the height.
  thickness:number[]; share?:number[];
}
// A row every `step` metres, at round chainages, where the line is in the model.
export function chainageTable(model:GeoModel,s:Section,step:number):ChainageRow[]{
  const rows:ChainageRow[]=[],K=model.units.length;
  if(s.s.length<2||!(step>0))return rows;
  const s1=s.s[s.s.length-1];
  for(let i=Math.ceil(s.s[0]/step-1e-9);i*step<=s1+1e-9;i++){
    const c=i*step,col=columnAt(s,c);
    if(!col)continue;
    const z=col.z,d=designAt(s.alignment?.design,c);
    const row:ChainageRow={chainage:c,x:col.x,y:col.y,ground:z[0],thickness:Array.from({length:K},(_,k)=>Math.max(0,z[k]-z[k+1]))};
    if(col.water!==undefined&&Number.isFinite(col.water))row.water=col.water;
    if(d.top!==undefined){row.top=d.top;row.unitTop=unitAtLevel(z,d.top)}
    if(d.bottom!==undefined&&d.top!==undefined){
      const top=d.top,bottom=d.bottom,h=top-bottom;
      row.bottom=bottom;
      row.unitBottom=unitAtLevel(z,bottom);
      row.share=Array.from({length:K},(_,k)=>Math.max(0,Math.min(top,z[k])-Math.max(bottom,z[k+1]))/h);
    }
    rows.push(row);
  }
  return rows;
}
// The name of the unit at a design level, as the table gives it.
export const unitLabel=(model:GeoModel,k:number|undefined)=>k===undefined?"":k===ABOVE?"above ground":k===BELOW?"below the model":model.units[k].name;

// ---------- lines across a straight section ----------

// Where the lines of a project cross a straight section: the distance along the section, the line's chainage there and
// its design levels, as levels on the line's centre; no shape of what is built along it is assumed.
export interface Crossing { name:string; s:number; chainage:number; x:number; y:number; top?:number; bottom?:number }
export function lineCrossings(s:Section,lines:Alignment[]):Crossing[]{
  const n=s.s.length;
  if(s.alignment||n<2)return [];
  const ax=s.x[0],ay=s.y[0],dx=s.x[n-1]-ax,dy=s.y[n-1]-ay,out:Crossing[]=[];
  for(const line of lines){
    const ch=chainages(line),p=line.points;
    for(let i=0;i+1<p.length;i++){
      const ex=p[i+1].x-p[i].x,ey=p[i+1].y-p[i].y,den=dx*ey-dy*ex;
      if(Math.abs(den)<1e-12)continue;
      const t=((p[i].x-ax)*ey-(p[i].y-ay)*ex)/den,u=((p[i].x-ax)*dy-(p[i].y-ay)*dx)/den;
      if(t<0||t>1||u<0||u>1)continue;
      const c=ch[i]+u*(ch[i+1]-ch[i]);
      out.push({name:line.name,s:s.s[0]+t*(s.s[n-1]-s.s[0]),chainage:c,x:ax+t*dx,y:ay+t*dy,...designAt(line.design,c)});
    }
  }
  return out.sort((a,b)=>a.s-b.s);
}
