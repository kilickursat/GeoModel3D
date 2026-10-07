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
  // Node chains along the edges of the borehole triangulation, and its subdivision level (1 = not subdivided).
  edgeChains:number[][];
  level:number;
  // Surveyed collar elevation minus terrain, and the collar-corrected terrain for display beyond the model.
  residuals:CollarResidual[];
  terrainAt?:(x:number,y:number)=>number;
  edges?:Array<[number,number]>;
}
export interface BoreholeContacts { depth:Array<number|null>; eroded:Array<number|null>; deepest:number; eoh:number; notes:string[] }

const fmt=(v:number)=>String(Math.round(v*100)/100);

// Reads one log as a layer-cake: depth[k] is the depth of horizon k where the log shows it, `deepest` the last
// unit the hole entered (its base is not seen), `eoh` the final depth. Units skipped by the log have zero
// thickness, unless the unit above the contact is erosive: then the skipped units were eroded, and eroded[k] is
// the depth of the erosion surface, above which their original surfaces lay.
export function boreholeContacts(b:Borehole,units:UnitDef[]):BoreholeContacts{
  const index=new Map(units.map((u,i)=>[u.id,i]));
  const depth:Array<number|null>=new Array(units.length+1).fill(null);
  const eroded:Array<number|null>=new Array(units.length+1).fill(null);
  depth[0]=0;
  const notes:string[]=[];
  const intervals=b.intervals.filter(i=>index.has(i.unit)).sort((p,q)=>p.from-q.from||p.to-q.to);
  let deepest=-1,prevTo=0;
  for(const i of intervals){
    const u=index.get(i.unit)!;
    if(i.from<prevTo-1e-6)notes.push(`interval ${fmt(i.from)}–${fmt(i.to)} m overlaps the one above`);
    if(u<deepest){
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
  return {depth,eroded,deepest,eoh:Math.max(boreholeDepth(b),prevTo),notes};
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

// Splits every triangle into level² similar triangles; nodes on shared edges are shared, so the mesh stays
// conforming. parents[k] gives the barycentric weights of node N+k on the original nodes.
export function subdivide(nodes:XY[],triangles:Triangle[],level:number):Subdivision{
  const out=[...nodes],parents:Array<{i:number[];w:number[]}>=[];
  const add=(i:number[],w:number[])=>{
    out.push({x:i.reduce((s,n,k)=>s+nodes[n].x*w[k],0),y:i.reduce((s,n,k)=>s+nodes[n].y*w[k],0)});
    parents.push({i,w});
    return out.length-1;
  };
  const chains=new Map<string,number[]>();
  const chain=(a:number,b:number)=>{
    const lo=Math.min(a,b),hi=Math.max(a,b),key=lo+":"+hi;
    let c=chains.get(key);
    if(!c){
      c=[lo];
      for(let s=1;s<level;s++)c.push(add([lo,hi],[1-s/level,s/level]));
      c.push(hi);
      chains.set(key,c);
    }
    return a===lo?c:[...c].reverse();
  };
  const tris:Triangle[]=[];
  for(const t of triangles){
    const ab=chain(t.a,t.b),ac=chain(t.a,t.c),cb=chain(t.c,t.b),inner=new Map<number,number>();
    // Lattice point (i, j) = a + i/level·(b−a) + j/level·(c−a).
    const id=(i:number,j:number)=>{
      if(j===0)return ab[i];
      if(i===0)return ac[j];
      if(i+j===level)return cb[i];
      const key=i*(level+1)+j;
      let v=inner.get(key);
      if(v===undefined){v=add([t.a,t.b,t.c],[(level-i-j)/level,i/level,j/level]);inner.set(key,v)}
      return v;
    };
    for(let i=0;i<level;i++)for(let j=0;j<level-i;j++){
      tris.push({a:id(i,j),b:id(i+1,j),c:id(i,j+1)});
      if(i+j<level-1)tris.push({a:id(i+1,j),b:id(i+1,j+1),c:id(i,j+1)});
    }
  }
  return {nodes:out,triangles:tris,parents,edgeChains:[...chains.values()]};
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

// Subdivide finely enough to follow the terrain grid, or to cut cleanly along erosion surfaces.
function subdivisionLevel(nodes:XY[],triangles:Triangle[],terrain?:TerrainGrid){
  const lengths=uniqueEdges(triangles).map(([a,b])=>Math.hypot(nodes[a].x-nodes[b].x,nodes[a].y-nodes[b].y)).sort((p,q)=>p-q);
  const xs=nodes.map(p=>p.x),ys=nodes.map(p=>p.y);
  const extent=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
  const target=Math.max(terrain?Math.min(terrain.dx,terrain.dy):0,extent/(terrain?300:150));
  let level=Math.min(64,Math.max(2,Math.ceil(lengths[Math.floor(lengths.length/2)]/target)));
  while(level>1&&triangles.length*level*level>200_000)level--;
  return level;
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
  const coarse=delaunay(nodes);
  if(nodes.length<3)warnings.push("A TIN model needs at least three boreholes with collar coordinates");
  else if(!coarse.length)warnings.push("All boreholes lie on one line: a TIN model needs three boreholes that are not collinear");

  // Horizon elevations at the boreholes, before the stratigraphic ordering is enforced.
  const N=nodes.length;
  const raw=Array.from({length:K+1},()=>new Float64Array(N));
  const observed=Array.from({length:K+1},()=>new Uint8Array(N));
  contacts.forEach((c,i)=>{for(let k=0;k<=c.deepest;k++)if(c.depth[k]!==null){raw[k][i]=boreholes[i].z-c.depth[k]!;observed[k][i]=1}});
  const eohZ=contacts.map((c,i)=>boreholes[i].z-c.eoh);
  const base=project.base??(N?Math.min(...eohZ):0);

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
  for(let i=0;i<N;i++){
    for(let k=contacts[i].deepest+1;k<=K;k++){
      let v=k===K?base:raw[k-1][i]-idw(thickness[k-1],nodes[i]);
      if(k===contacts[i].deepest+1)v=Math.min(v,eohZ[i]);
      raw[k][i]=Math.max(v,base);
    }
  }

  const erosive=units.some(u=>u.erosive);
  const level=coarse.length&&(project.terrain||erosive)?subdivisionLevel(nodes,coarse,project.terrain):1;
  const mesh=subdivide(nodes,coarse,level);
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
    const r=residuals.map(q=>Number.isFinite(q.residual)?q.residual:0);
    const correction=spread(r);
    // Where the terrain rises above the surface through the collars, the extra height belongs to the units that form
    // the ground at the surrounding boreholes, shared by their barycentric weights: a unit absent from the surface of
    // all of them stays absent. Where the terrain is lower, the ordering below cuts the units from the top.
    const surfaceUnit=boreholes.map((_,i)=>{
      let above=raw[0][i];
      for(let u=0;u<K-1;u++){const below=Math.min(Math.max(raw[u+1][i],base),above);if(above-below>1e-9)return u;above=below}
      return K-1;
    });
    const shares=units.map((_,u)=>spread(surfaceUnit.map(s=>s===u?1:0)));
    let missing=0;
    for(let n=N;n<M;n++){
      const tz=terrainZ(t,mesh.nodes[n].x,mesh.nodes[n].y);
      if(!Number.isFinite(tz)){missing++;known[0][n]=0;continue}
      const ground=tz+correction[n],rise=ground-z[0][n];
      z[0][n]=ground;
      if(rise>0){let below=1;for(let k=1;k<=K;k++){below-=shares[k-1][n];z[k][n]+=rise*below}}
    }
    const outside=residuals.filter(q=>!Number.isFinite(q.terrain));
    if(outside.length)warnings.push(`Terrain grid does not cover ${outside.map(q=>q.id).join(", ")}`);
    const off=residuals.filter(q=>Math.abs(q.residual)>1);
    for(const q of off)warnings.push(`${q.id}: collar ${fmt(q.collar)} m, terrain ${fmt(q.terrain)} m (${q.residual>0?"+":""}${fmt(q.residual)} m); terrain adjusted to the collar`);
    if(missing)warnings.push(`Terrain has no data under ${Math.round(missing/(M-N)*100)} % of the model; the surface between boreholes is used there`);
    const field=boundaryResidual(convexHull(boreholes.map((b,i)=>({x:b.x,y:b.y,r:r[i]}))));
    terrainAt=(x,y)=>terrainZ(t,x,y)+field(x,y);
  }

  // Stratigraphic ordering: each horizon lies at or below the one above and at or above the model base. This
  // cuts older units at the ground (erosion by the present topography) and at erosive unit bases. The lines where a
  // horizon meets the one above or the base are first added to the mesh, so pinch-outs and outcrops run straight
  // across the triangles instead of stepping along their edges.
  const Z=z.map(a=>Array.from(a)),known01=known.map(a=>Array.from(a));
  const cut=splittableMesh(mesh.nodes,mesh.triangles,mesh.edgeChains,Z,known01);
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
  return {project,units,boreholes,nodes:cut.mesh.nodes,triangles:cut.mesh.triangles,horizons,base,warnings,edgeChains:cut.mesh.chains,level,residuals,terrainAt};
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
export function modelBounds(model:GeoModel){
  const xs=model.boreholes.map(b=>b.x),ys=model.boreholes.map(b=>b.y);
  if(!xs.length)return {minX:0,maxX:1,minY:0,maxY:1,minZ:0,maxZ:1};
  const ground=model.horizons[0].z;
  let maxZ=-Infinity;
  for(let i=0;i<ground.length;i++)maxZ=Math.max(maxZ,ground[i]);
  return {minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys),minZ:Math.min(model.base,...model.boreholes.map(b=>b.z-boreholeDepth(b))),maxZ};
}
// Horizon elevations at (x, y), or null outside the model footprint.
export function sampleModel(model:GeoModel,x:number,y:number):number[]|null{
  const p=model.nodes;
  for(const t of model.triangles){
    const d=(p[t.b].x-p[t.a].x)*(p[t.c].y-p[t.a].y)-(p[t.b].y-p[t.a].y)*(p[t.c].x-p[t.a].x);
    const wb=((x-p[t.a].x)*(p[t.c].y-p[t.a].y)-(y-p[t.a].y)*(p[t.c].x-p[t.a].x))/d;
    const wc=((p[t.b].x-p[t.a].x)*(y-p[t.a].y)-(p[t.b].y-p[t.a].y)*(x-p[t.a].x))/d;
    const wa=1-wb-wc,e=-1e-9;
    if(wa<e||wb<e||wc<e)continue;
    return model.horizons.map(h=>wa*h.z[t.a]+wb*h.z[t.b]+wc*h.z[t.c]);
  }
  return null;
}
