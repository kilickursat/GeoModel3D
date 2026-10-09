import {Borehole,GeoProject,UnitDef,boreholeDepth} from "./geology";
import {delaunay,Triangle,XY,triangleArea,uniqueEdges} from "./tin";
import {TINSurface,GeologicalVolume} from "./volume";
import {TerrainGrid,terrainZ,convexHull,boundaryResidual} from "./terrain";

// horizons[0] is the ground surface, horizons[k] the base of units[k-1]; the last one is the model base.
export interface Horizon { id:string; name:string; z:Float64Array; observed:Uint8Array }
export interface CollarResidual { id:string; collar:number; terrain:number; residual:number }
export interface GeoModel {
  project:GeoProject;
  units:UnitDef[];
  // boreholes[i] sits on nodes[i]; nodes added by subdividing the borehole triangulation follow them, then the nodes
  // on the lines where units pinch out or are cut.
  boreholes:Borehole[];
  nodes:XY[];
  triangles:Triangle[];
  horizons:Horizon[];
  base:number;
  warnings:string[];
  // Node chains along the edges of the borehole triangulation; the spacing it was refined to (0 = not refined); and
  // the number of nodes of the refined triangulation, before the nodes on pinch-out lines.
  edgeChains:number[][];
  spacing:number;
  meshNodes:number;
  // Surveyed collar elevation minus terrain, and the collar-corrected terrain for display beyond the model.
  residuals:CollarResidual[];
  terrainAt?:(x:number,y:number)=>number;
  edges?:Array<[number,number]>;
  // The water table at every node, where groundwater is known, and where it comes from.
  water?:{z:Float64Array;source:string};
}
// `start` is the depth where a log begins, when it begins below the collar.
export interface BoreholeContacts { depth:Array<number|null>; eroded:Array<number|null>; deepest:number; eoh:number; notes:string[]; start?:number }

const fmt=(v:number)=>String(Math.round(v*100)/100);

// Reads one log as a layer-cake: depth[k] is the depth of horizon k where the log shows it, `deepest` the last
// unit the hole entered (its base is not seen), `eoh` the final depth. Units skipped by the log have zero
// thickness, unless the unit above the contact is erosive: then the skipped units were eroded, and eroded[k] is
// the depth of the erosion surface, above which their original surfaces lay. A log that begins below the collar says
// nothing about the units above its first one: those contacts are left unknown (null) and `start` records the depth.
export function boreholeContacts(b:Borehole,units:UnitDef[]):BoreholeContacts{
  const index=new Map(units.map((u,i)=>[u.id,i]));
  const depth:Array<number|null>=new Array(units.length+1).fill(null);
  const eroded:Array<number|null>=new Array(units.length+1).fill(null);
  depth[0]=0;
  const notes:string[]=[];
  const intervals=b.intervals.filter(i=>index.has(i.unit)).sort((p,q)=>p.from-q.from||p.to-q.to);
  let deepest=-1,prevTo=0,start:number|undefined;
  for(const i of intervals){
    const u=index.get(i.unit)!;
    if(i.from<prevTo-1e-6)notes.push(`interval ${fmt(i.from)}–${fmt(i.to)} m overlaps the one above`);
    if(deepest<0&&u>=1&&i.from>1e-6){
      start=i.from;
      notes.push(`not logged above ${fmt(i.from)} m; the contacts above are inferred from the neighbouring boreholes`);
      deepest=u;
    }else if(u<deepest){
      notes.push(`${units[u].name} at ${fmt(i.from)}–${fmt(i.to)} m lies below ${units[deepest].name}, out of stratigraphic order; modelled as ${units[deepest].name}`);
    }else if(u>deepest){
      const first=Math.max(deepest+1,1);
      let c=i.from;
      if(first<=u&&i.from>prevTo+1e-6){
        c=(prevTo+i.from)/2;
        notes.push(`no log between ${fmt(prevTo)} and ${fmt(i.from)} m; contact placed at ${fmt(c)} m`);
      }
      const erosion=deepest>=0&&!!units[deepest].erosive;
      for(let k=first;k<=u;k++){
        if(erosion&&k>first)eroded[k]=c;
        else depth[k]=c;
      }
      deepest=u;
    }
    prevTo=Math.max(prevTo,i.to);
  }
  return {depth,eroded,deepest,eoh:Math.max(boreholeDepth(b),prevTo),notes,...(start!==undefined?{start}:{})};
}

function idw(samples:Array<{x:number;y:number;v:number}>,p:XY){
  let num=0,den=0;
  for(const s of samples){
    const d2=(s.x-p.x)**2+(s.y-p.y)**2;
    if(d2<1e-12)return s.v;
    num+=s.v/d2;den+=1/d2;
  }
  return den?num/den:0;
}

interface Subdivision { nodes:XY[]; triangles:Triangle[]; parents:Array<{i:number[];w:number[]}>; edgeChains:number[][] }

// Refines a triangulation by longest-edge bisection until no edge is longer than `spacing`. Each step halves the
// longest edge of a triangle and of the neighbour across it; when that edge is not the neighbour's own longest, the
// neighbour is refined first (Rivara's LEPP), so the mesh stays conforming and the triangles keep their shape. Long
// thin triangles between distant boreholes are refined as finely as short ones, so the ground can follow the
// terrain everywhere. New nodes are edge midpoints: parents[k] gives node N+k's barycentric weights on the original
// nodes, and the edge chains follow the original edges.
export function refine(nodes:XY[],triangles:Triangle[],spacing:number,maxTriangles=200_000):Subdivision{
  const pts=[...nodes],weights:Array<Map<number,number>>=nodes.map((_,i)=>new Map([[i,1]]));
  const tris:Array<[number,number,number]|null>=[];
  const SHIFT=2**22,key=(a:number,b:number)=>a<b?a*SHIFT+b:b*SHIFT+a;
  const byEdge=new Map<number,number[]>();
  let alive=0;
  const add=(a:number,b:number,c:number)=>{
    alive++;
    const t=tris.push([a,b,c])-1;
    for(const k of [key(a,b),key(b,c),key(c,a)]){const l=byEdge.get(k);if(l)l.push(t);else byEdge.set(k,[t])}
    return t;
  };
  const remove=(t:number)=>{
    const [a,b,c]=tris[t]!;
    for(const k of [key(a,b),key(b,c),key(c,a)]){const l=byEdge.get(k)!;l.splice(l.indexOf(t),1);if(!l.length)byEdge.delete(k)}
    tris[t]=null;
    alive--;
  };
  for(const t of triangles)add(t.a,t.b,t.c);
  const chains:number[][]=[],chainOf=new Map<number,number>();
  for(const [a,b] of uniqueEdges(triangles)){chainOf.set(key(a,b),chains.length);chains.push([Math.min(a,b),Math.max(a,b)])}
  const len2=(a:number,b:number)=>(pts[a].x-pts[b].x)**2+(pts[a].y-pts[b].y)**2;
  // The longest edge, ties broken the same way in every triangle so that neighbours agree.
  const longest=(t:number):[number,number]=>{
    const [a,b,c]=tris[t]!;
    let best:[number,number]=[a,b],bl=len2(a,b);
    for(const [p,q] of [[b,c],[c,a]] as Array<[number,number]>){
      const l=len2(p,q);
      if(l>bl*(1+1e-12)||(l>=bl*(1-1e-12)&&key(p,q)<key(best[0],best[1]))){best=[p,q];bl=l}
    }
    return best;
  };
  const split=(p:number,q:number)=>{
    const m=pts.push({x:(pts[p].x+pts[q].x)/2,y:(pts[p].y+pts[q].y)/2})-1;
    const w=new Map<number,number>();
    for(const src of [weights[p],weights[q]])for(const [i,v] of src)w.set(i,(w.get(i)??0)+v/2);
    weights.push(w);
    const o=chainOf.get(key(p,q));
    if(o!==undefined){
      const c=chains[o],i=c.indexOf(p),j=c.indexOf(q);
      c.splice(Math.max(i,j),0,m);
      chainOf.delete(key(p,q));chainOf.set(key(p,m),o);chainOf.set(key(m,q),o);
    }
    for(const t of [...byEdge.get(key(p,q))!]){
      const tri=tris[t]!,k=tri.findIndex((v,i)=>(v===p||v===q)&&(tri[(i+1)%3]===p||tri[(i+1)%3]===q));
      const u=tri[k],v=tri[(k+1)%3],x=tri[(k+2)%3];
      remove(t);add(u,m,x);add(m,v,x);
    }
  };
  const bisect=(t0:number)=>{
    const stack=[t0];
    while(stack.length){
      const t=stack[stack.length-1];
      if(!tris[t]){stack.pop();continue}
      const [p,q]=longest(t),n=byEdge.get(key(p,q))!.find(x=>x!==t);
      if(n===undefined||key(...longest(n))===key(p,q)){split(p,q);stack.pop()}
      else stack.push(n);
    }
  };
  const limit=spacing*spacing;
  const queue=tris.map((_,i)=>i);
  while(queue.length&&alive<maxTriangles){
    const t=queue.pop()!;
    if(!tris[t]||len2(...longest(t))<=limit)continue;
    const before=tris.length;
    bisect(t);
    for(let i=before;i<tris.length;i++)if(tris[i])queue.push(i);
  }
  const parents=weights.slice(nodes.length).map(w=>({i:[...w.keys()],w:[...w.values()]}));
  return {nodes:pts,triangles:tris.filter(Boolean).map(t=>({a:t![0],b:t![1],c:t![2]})),parents,edgeChains:chains};
}

// A mesh whose node fields can be split along the zero line of a function that is linear on every triangle. Each new
// node lies on the edge it splits, with every field interpolated along that edge, so all fields stay linear on every
// triangle and the mesh stays conforming; edge chains gain the nodes inserted on their edges.
function splittableMesh(nodes:XY[],triangles:Triangle[],chains:number[][],fields:number[][],flags:number[][]){
  const mesh={nodes:[...nodes],triangles,chains};
  function split(f:(n:number)=>number,eps=1e-9){
    const pts=mesh.nodes,P=pts.length,value=pts.map((_,n)=>f(n)),made=new Map<number,number>();
    const side=(n:number)=>value[n]>eps?1:value[n]<-eps?-1:0;
    if(!value.some(v=>v>eps)||!value.some(v=>v<-eps))return;
    const between=(a:number,b:number)=>{
      if(side(a)*side(b)>=0)return -1;
      const lo=Math.min(a,b),hi=Math.max(a,b),key=lo*P+hi;
      let m=made.get(key);
      if(m===undefined){
        const t=value[lo]/(value[lo]-value[hi]);
        m=pts.length;
        pts.push({x:pts[lo].x+t*(pts[hi].x-pts[lo].x),y:pts[lo].y+t*(pts[hi].y-pts[lo].y)});
        for(const g of fields)g.push(g[lo]+t*(g[hi]-g[lo]));
        for(const g of flags)g.push(g[lo]&g[hi]);
        value.push(0);
        made.set(key,m);
      }
      return m;
    };
    const out:Triangle[]=[];
    for(const t of mesh.triangles){
      const ab=between(t.a,t.b),bc=between(t.b,t.c),ca=between(t.c,t.a);
      if(ab<0&&bc<0&&ca<0){out.push(t);continue}
      const ring=[t.a];
      if(ab>=0)ring.push(ab);
      ring.push(t.b);
      if(bc>=0)ring.push(bc);
      ring.push(t.c);
      if(ca>=0)ring.push(ca);
      // The zero line cuts the triangle into two convex pieces; nodes on the line belong to both.
      for(const s of [1,-1]){
        const piece=ring.filter(n=>side(n)!==-s);
        if(!piece.some(n=>side(n)===s))continue;
        for(let j=1;j+1<piece.length;j++)out.push({a:piece[0],b:piece[j],c:piece[j+1]});
      }
    }
    if(!made.size)return;
    mesh.triangles=out;
    mesh.chains=mesh.chains.map(c=>{
      const o=[c[0]];
      for(let j=1;j<c.length;j++){const m=made.get(Math.min(c[j-1],c[j])*P+Math.max(c[j-1],c[j]));if(m!==undefined)o.push(m);o.push(c[j])}
      return o;
    });
  }
  return {mesh,split};
}

// Nodes on a frame around the boreholes, for a model that extends `margin` beyond them: their outline pushed out by
// the margin in `directions` directions (a circle around a single borehole).
export function frameNodes(points:XY[],margin:number,directions=16):XY[]{
  return Array.from({length:directions},(_,j)=>{
    const a=2*Math.PI*j/directions,d={x:Math.cos(a),y:Math.sin(a)};
    let best=points[0],reach=-Infinity;
    for(const p of points){const v=p.x*d.x+p.y*d.y;if(v>reach){reach=v;best=p}}
    return {x:best.x+margin*d.x,y:best.y+margin*d.y};
  });
}
// The extent given to boreholes that enclose no area (fewer than three, or all on one line): the deepest log, a
// quarter of their spread, and at least 10 m, rounded up.
function defaultMargin(holes:Borehole[]){
  const xs=holes.map(b=>b.x),ys=holes.map(b=>b.y);
  const raw=Math.max(10,...holes.map(boreholeDepth),Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))/4);
  const step=raw<50?5:raw<200?10:50;
  return Math.ceil(raw/step)*step;
}

// Refine finely enough to follow the terrain grid, or to cut cleanly along erosion surfaces, within a budget of about
// 80,000 triangles (refined triangles cover about 0.14 × spacing² each).
function refinementSpacing(nodes:XY[],triangles:Triangle[],terrain?:TerrainGrid){
  const xs=nodes.map(p=>p.x),ys=nodes.map(p=>p.y);
  const extent=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
  const area=triangles.reduce((s,t)=>s+triangleArea(nodes,t),0);
  return Math.max(terrain?Math.min(terrain.dx,terrain.dy):0,extent/(terrain?300:150),Math.sqrt(area/(0.14*80_000)));
}

export function buildGeologicalModel(project:GeoProject):GeoModel{
  const warnings:string[]=[];
  const declared=new Set(project.units.map(u=>u.id)),used=new Set<string>(),unknown=new Set<string>();
  for(const b of project.boreholes)for(const i of b.intervals)(declared.has(i.unit)?used:unknown).add(i.unit);
  if(unknown.size)warnings.push(`Intervals in units missing from the unit list were ignored: ${[...unknown].join(", ")}`);
  const units=project.units.filter(u=>used.has(u.id));
  const unobserved=project.units.filter(u=>!used.has(u.id));
  if(unobserved.length)warnings.push(`Units with no logged intervals are not modelled: ${unobserved.map(u=>u.name).join(", ")}`);
  const K=units.length;

  const boreholes:Borehole[]=[],nodes:XY[]=[],contacts:BoreholeContacts[]=[];
  const positions=new Map<string,string>();
  for(const b of project.boreholes){
    if(![b.x,b.y,b.z].every(Number.isFinite)){warnings.push(`${b.id}: collar position or elevation missing; borehole not used`);continue}
    const c=boreholeContacts(b,units);
    if(c.deepest<0){warnings.push(`${b.id}: no intervals in the modelled units; borehole not used`);continue}
    const key=Math.round(b.x*1000)+","+Math.round(b.y*1000);
    if(positions.has(key)){warnings.push(`${b.id}: same collar position as ${positions.get(key)}; borehole not used`);continue}
    positions.set(key,b.id);
    for(const n of c.notes)warnings.push(`${b.id}: ${n}`);
    boreholes.push(b);nodes.push({x:b.x,y:b.y});contacts.push(c);
  }
  // The model covers the outline of the boreholes, or extends beyond it on a frame of nodes. Boreholes that enclose no
  // area are given an extent, so that one or two boreholes still make a model.
  const NB=nodes.length;
  let margin=project.margin!==undefined&&Number.isFinite(project.margin)&&project.margin>0?project.margin:0;
  if(!NB)warnings.push("No borehole could be placed: a model needs boreholes with collar coordinates and logged intervals");
  else if(!margin&&(NB<3||!delaunay(nodes).length)){
    margin=defaultMargin(boreholes);
    warnings.push(NB===1?`One borehole: the model extends ${margin} m around it, with flat horizons; set the model extent in the project to change it`
      :NB===2?`Two boreholes: the model extends ${margin} m around them; set the model extent in the project to change it`
      :`All boreholes lie on one line: the model extends ${margin} m to either side; set the model extent in the project to change it`);
  }
  if(NB&&margin)nodes.push(...frameNodes(nodes.slice(),margin));
  const coarse=delaunay(nodes);

  // Horizon elevations at the boreholes (and the frame), before the stratigraphic ordering is enforced.
  const N=nodes.length;
  const raw=Array.from({length:K+1},()=>new Float64Array(N));
  const observed=Array.from({length:K+1},()=>new Uint8Array(N));
  contacts.forEach((c,i)=>{for(let k=0;k<=c.deepest;k++)if(c.depth[k]!==null){raw[k][i]=boreholes[i].z-c.depth[k]!;observed[k][i]=1}});
  const eohZ=contacts.map((c,i)=>boreholes[i].z-c.eoh);
  const base=project.base??(NB?Math.min(...eohZ):0);

  // Logs that begin below the collar: the contacts above their first unit come from the holes that logged them, kept
  // between the ground and the depth where the log begins (the first unit is there, so its top is no deeper).
  const logged=new Map<number,Array<{x:number;y:number;v:number}>>();
  const loggedAt=(k:number)=>{
    if(!logged.has(k)){const s:Array<{x:number;y:number;v:number}>=[];for(let j=0;j<N;j++)if(observed[k][j])s.push({x:nodes[j].x,y:nodes[j].y,v:raw[k][j]});logged.set(k,s)}
    return logged.get(k)!;
  };
  contacts.forEach((c,i)=>{
    if(c.start===undefined)return;
    const floor=boreholes[i].z-c.start;
    for(let k=1;k<=c.deepest;k++)if(c.depth[k]===null&&c.eroded[k]===null){
      const s=loggedAt(k);
      raw[k][i]=Math.min(boreholes[i].z,Math.max(s.length?idw(s,nodes[i]):floor,floor));
    }
  });
  // Surfaces removed by erosion at a hole: their original elevation comes from the holes that logged them and is
  // never below the erosion surface; the ordering below then cuts them at that surface.
  for(let k=1;k<=K;k++){
    const samples:Array<{x:number;y:number;v:number}>=[];
    for(let i=0;i<N;i++)if(observed[k][i])samples.push({x:nodes[i].x,y:nodes[i].y,v:raw[k][i]});
    contacts.forEach((c,i)=>{
      if(c.eroded[k]===null)return;
      const zc=boreholes[i].z-c.eroded[k]!;
      raw[k][i]=Math.max(samples.length?idw(samples,nodes[i]):zc,zc);
    });
  }
  // Thickness of unit u wherever both its top and base were logged (zero where the unit is absent).
  const thickness=units.map((_,u)=>{
    const s:Array<{x:number;y:number;v:number}>=[];
    for(let i=0;i<N;i++)if(observed[u][i]&&observed[u+1][i])s.push({x:nodes[i].x,y:nodes[i].y,v:raw[u][i]-raw[u+1][i]});
    return s;
  });
  // Below the deepest unit a hole entered, stack inverse-distance-weighted thicknesses; that unit's base must lie below the end of the hole.
  for(let i=0;i<NB;i++){
    for(let k=contacts[i].deepest+1;k<=K;k++){
      let v=k===K?base:raw[k-1][i]-idw(thickness[k-1],nodes[i]);
      if(k===contacts[i].deepest+1)v=Math.min(v,eohZ[i]);
      raw[k][i]=Math.max(v,base);
    }
  }
  // The frame takes every horizon from the boreholes with the same inverse-distance weights, so the horizons keep
  // their order there; nothing on it counts as logged.
  for(let n=NB;n<N;n++)for(let k=0;k<=K;k++){
    const s:Array<{x:number;y:number;v:number}>=[];
    for(let i=0;i<NB;i++)s.push({x:nodes[i].x,y:nodes[i].y,v:raw[k][i]});
    raw[k][n]=idw(s,nodes[n]);
  }

  const erosive=units.some(u=>u.erosive);
  const spacing=coarse.length&&(project.terrain||erosive)?refinementSpacing(nodes,coarse,project.terrain):0;
  const mesh=spacing?refine(nodes,coarse,spacing):{nodes,triangles:coarse,parents:[],edgeChains:uniqueEdges(coarse).map(([a,b])=>[Math.min(a,b),Math.max(a,b)])};
  const M=mesh.nodes.length;
  const spread=(values:ArrayLike<number>)=>{
    const out=new Float64Array(M);
    for(let i=0;i<N;i++)out[i]=values[i];
    mesh.parents.forEach((p,n)=>{let s=0;p.i.forEach((j,m)=>{s+=values[j]*p.w[m]});out[N+n]=s});
    return out;
  };
  const z=raw.map(spread);
  const known=observed.map(o=>{
    const out=new Uint8Array(M);
    out.set(o);
    mesh.parents.forEach((p,n)=>{out[N+n]=p.i.every(j=>o[j])?1:0});
    return out;
  });

  // Terrain: the ground follows the grid, corrected by the collar residuals so that every collar keeps its
  // surveyed elevation.
  let residuals:CollarResidual[]=[],terrainAt:((x:number,y:number)=>number)|undefined;
  if(project.terrain&&N){
    const t=project.terrain;
    residuals=boreholes.map(b=>{const tz=terrainZ(t,b.x,b.y);return {id:b.id,collar:b.z,terrain:tz,residual:b.z-tz}});
    // The frame takes the collar residuals by inverse distance, as it takes the horizons.
    const r=residuals.map(q=>Number.isFinite(q.residual)?q.residual:0);
    const atHoles=r.map((v,i)=>({x:nodes[i].x,y:nodes[i].y,v}));
    for(let n=NB;n<N;n++)r.push(idw(atHoles,nodes[n]));
    const correction=spread(r);
    // Where the terrain rises above the surface through the collars, the extra height is made of what the top of the
    // surrounding boreholes is made of: each unit's share is its part of the top 5 m of the log, interpolated with the
    // boreholes' barycentric weights. A thin topsoil therefore takes little of it, and a unit absent from the top of
    // all of them takes none. Where the terrain is lower, the ordering below cuts the units from the top.
    const TOP=5;
    const near=units.map(()=>new Float64Array(N));
    for(let i=0;i<N;i++){
      let above=raw[0][i],sum=0;
      for(let u=0;u<K;u++){
        const below=u+1===K?Math.min(base,above):Math.min(Math.max(raw[u+1][i],base),above);
        const part=Math.max(0,Math.min(above,raw[0][i])-Math.max(below,raw[0][i]-TOP));
        near[u][i]=part;sum+=part;above=below;
      }
      for(let u=0;u<K;u++)near[u][i]=sum>0?near[u][i]/sum:u===K-1?1:0;
    }
    const shares=near.map(spread);
    let missing=0;
    for(let n=NB;n<M;n++){
      const tz=terrainZ(t,mesh.nodes[n].x,mesh.nodes[n].y);
      if(!Number.isFinite(tz)){missing++;known[0][n]=0;continue}
      const ground=tz+correction[n],rise=ground-z[0][n];
      z[0][n]=ground;
      if(rise>0){let below=1;for(let k=1;k<=K;k++){below-=shares[k-1][n];z[k][n]+=rise*below}}
    }
    const outside=residuals.filter(q=>!Number.isFinite(q.terrain));
    if(outside.length)warnings.push(`Terrain grid does not cover ${outside.map(q=>q.id).join(", ")}`);
    // A consistent offset, as when the collars are in another height datum than the terrain grid, is reported once;
    // collars that differ from it by more than 1 m are listed. When more than ten do, the collars and the grid scatter,
    // as with a coarse grid or heights read off a map: the scatter is reported once, as a robust standard deviation
    // (1.4826 times the median absolute deviation), and only the collars more than three times as far off are listed.
    const sorted=residuals.map(q=>q.residual).filter(Number.isFinite).sort((a,b)=>a-b);
    const median=sorted.length?sorted[Math.floor(sorted.length/2)]:0,shift=Math.abs(median)>0.5?median:0;
    if(shift)warnings.push(`Collars lie ${fmt(Math.abs(shift))} m ${shift>0?"above":"below"} the terrain grid on average, as when the heights use another datum; the terrain is adjusted to the collars`);
    let off=residuals.filter(q=>Math.abs(q.residual-shift)>1);
    if(off.length>10){
      const deviations=sorted.map(v=>Math.abs(v-median)).sort((a,b)=>a-b);
      const scatter=1.4826*deviations[Math.floor(deviations.length/2)],limit=Math.max(1,3*scatter);
      if(limit>1){
        warnings.push(`${off.length} of ${sorted.length} collars are more than 1 m off the terrain grid${shift?" after the average offset":""}, with a typical scatter of ±${fmt(scatter)} m; the terrain is adjusted to every collar, and only those more than ${fmt(limit)} m off are listed`);
        off=off.filter(q=>Math.abs(q.residual-shift)>limit);
      }
    }
    for(const q of off)warnings.push(`${q.id}: collar ${fmt(q.collar)} m, terrain ${fmt(q.terrain)} m (${q.residual>0?"+":""}${fmt(q.residual)} m); terrain adjusted to the collar`);
    if(missing)warnings.push(`Terrain has no data under ${Math.round(missing/(M-NB)*100)} % of the model; the surface between boreholes is used there`);
    const field=boundaryResidual(convexHull(nodes.map((p,i)=>({x:p.x,y:p.y,r:r[i]}))));
    terrainAt=(x,y)=>terrainZ(t,x,y)+field(x,y);
  }

  // Groundwater: the water table through the shallowest water level logged in each borehole, interpolated by inverse
  // distance and kept at or below the ground; where no borehole records one, the project's assumed depth below ground.
  const readings:Array<{x:number;y:number;v:number}>=[];
  for(const b of boreholes)if(b.water?.length)readings.push({x:b.x,y:b.y,v:b.z-Math.min(...b.water.map(w=>w.depth))});
  let W:number[]|undefined,waterSource="";
  if(readings.length){
    W=mesh.nodes.map((p,n)=>Math.min(idw(readings,p),z[0][n]));
    waterSource=`water levels logged in ${readings.length} of ${NB} boreholes (the shallowest reading of each), interpolated between them`;
  }else if(project.groundwaterDepth!==undefined&&Number.isFinite(project.groundwaterDepth)){
    W=Array.from(z[0],g=>g-project.groundwaterDepth!);
    waterSource=`assumed ${fmt(project.groundwaterDepth)} m below ground (no water level is logged)`;
  }

  // Stratigraphic ordering: each horizon lies at or below the one above and at or above the model base. This
  // cuts older units at the ground (erosion by the present topography) and at erosive unit bases. The lines where a
  // horizon meets the one above or the base are first added to the mesh, so pinch-outs and outcrops run straight
  // across the triangles instead of stepping along their edges.
  const Z=z.map(a=>Array.from(a)),known01=known.map(a=>Array.from(a));
  const cut=splittableMesh(mesh.nodes,mesh.triangles,mesh.edgeChains,W?[...Z,W]:Z,known01);
  for(let k=1;k<=K;k++){
    const zk=Z[k],above=Z[k-1];
    if(k===K)zk.fill(base);
    cut.split(n=>zk[n]-base);
    for(let n=0;n<zk.length;n++)zk[n]=Math.max(zk[n],base);
    cut.split(n=>zk[n]-above[n]);
    for(let n=0;n<zk.length;n++)zk[n]=Math.min(zk[n],above[n]);
  }

  const horizons:Horizon[]=Z.map((zk,k)=>({
    id:k===0?"ground":k===K?"base":"base:"+units[k-1].id,
    name:k===0?"Ground surface":k===K?"Model base":"Base of "+units[k-1].name,
    z:Float64Array.from(zk),observed:Uint8Array.from(known01[k])
  }));
  return {project,units,boreholes,nodes:cut.mesh.nodes,triangles:cut.mesh.triangles,horizons,base,warnings,edgeChains:cut.mesh.chains,spacing,meshNodes:M,residuals,terrainAt,
    ...(W?{water:{z:Float64Array.from(W),source:waterSource}}:{})};
}

export function horizonSurface(model:GeoModel,k:number):TINSurface{
  const h=model.horizons[k];
  return {id:h.id,points:model.nodes.map((p,i)=>({x:p.x,y:p.y,z:h.z[i]})),triangles:model.triangles};
}
export function unitVolume(model:GeoModel,u:number):GeologicalVolume{
  return {unit:model.units[u].id,top:horizonSurface(model,u),bottom:horizonSurface(model,u+1)};
}
// Exact volume of the unit between two linear TIN horizons: Σ triangle area × mean vertex thickness.
export function unitCubicMetres(model:GeoModel,u:number){
  const top=model.horizons[u].z,bottom=model.horizons[u+1].z;
  let v=0;
  for(const t of model.triangles)v+=triangleArea(model.nodes,t)*((top[t.a]-bottom[t.a])+(top[t.b]-bottom[t.b])+(top[t.c]-bottom[t.c]))/3;
  return v;
}
export function footprintArea(model:GeoModel){return model.triangles.reduce((s,t)=>s+triangleArea(model.nodes,t),0)}
// The footprint's extent (the boreholes' when there is no model) and the elevations from the deepest end of hole or the
// base up to the highest ground.
export function modelBounds(model:GeoModel){
  const points:XY[]=model.triangles.length?model.nodes:model.boreholes;
  if(!points.length)return {minX:0,maxX:1,minY:0,maxY:1,minZ:0,maxZ:1};
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,maxZ=-Infinity,minZ=model.base;
  for(const p of points){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y)}
  const ground=model.horizons[0].z;
  for(let i=0;i<ground.length;i++)maxZ=Math.max(maxZ,ground[i]);
  for(const b of model.boreholes)minZ=Math.min(minZ,b.z-boreholeDepth(b));
  return {minX,maxX,minY,maxY,minZ,maxZ};
}
// A grid of cells listing the triangles whose bounding box overlaps them, built once per model.
const triangleIndex=new WeakMap<GeoModel,{x0:number;y0:number;size:number;nx:number;ny:number;cells:Triangle[][]}>();
function cellsOf(model:GeoModel){
  let index=triangleIndex.get(model);
  if(index)return index;
  const p=model.nodes,xs=p.map(q=>q.x),ys=p.map(q=>q.y);
  const x0=Math.min(...xs),y0=Math.min(...ys),w=Math.max(...xs)-x0||1,h=Math.max(...ys)-y0||1;
  const size=Math.sqrt(w*h/Math.max(1,model.triangles.length)),nx=Math.ceil(w/size)+1,ny=Math.ceil(h/size)+1;
  const cells:Triangle[][]=Array.from({length:nx*ny},()=>[]);
  for(const t of model.triangles){
    const tx=[p[t.a].x,p[t.b].x,p[t.c].x],ty=[p[t.a].y,p[t.b].y,p[t.c].y];
    const c0=Math.floor((Math.min(...tx)-x0)/size),c1=Math.floor((Math.max(...tx)-x0)/size);
    const r0=Math.floor((Math.min(...ty)-y0)/size),r1=Math.floor((Math.max(...ty)-y0)/size);
    for(let r=r0;r<=r1;r++)for(let c=c0;c<=c1;c++)cells[r*nx+c].push(t);
  }
  index={x0,y0,size,nx,ny,cells};
  triangleIndex.set(model,index);
  return index;
}
// Horizon elevations at (x, y), or null outside the model footprint.
export function sampleModel(model:GeoModel,x:number,y:number):number[]|null{
  const p=model.nodes;
  if(!model.triangles.length)return null;
  const g=cellsOf(model),c=Math.floor((x-g.x0)/g.size),r=Math.floor((y-g.y0)/g.size);
  if(c<0||r<0||c>=g.nx||r>=g.ny)return null;
  for(const t of g.cells[r*g.nx+c]){
    const d=(p[t.b].x-p[t.a].x)*(p[t.c].y-p[t.a].y)-(p[t.b].y-p[t.a].y)*(p[t.c].x-p[t.a].x);
    const wb=((x-p[t.a].x)*(p[t.c].y-p[t.a].y)-(y-p[t.a].y)*(p[t.c].x-p[t.a].x))/d;
    const wc=((p[t.b].x-p[t.a].x)*(y-p[t.a].y)-(p[t.b].y-p[t.a].y)*(x-p[t.a].x))/d;
    const wa=1-wb-wc,e=-1e-9;
    if(wa<e||wb<e||wc<e)continue;
    return model.horizons.map(h=>wa*h.z[t.a]+wb*h.z[t.b]+wc*h.z[t.c]);
  }
  return null;
}
