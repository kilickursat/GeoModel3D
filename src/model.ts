import {Borehole,GeoProject,UnitDef,boreholeDepth} from "./geology";
import {delaunay,Triangle,XY,triangleArea} from "./tin";
import {TINSurface,GeologicalVolume} from "./volume";

// horizons[0] is the ground surface, horizons[k] the base of units[k-1]; the last one is the model base.
export interface Horizon { id:string; name:string; z:Float64Array; observed:Uint8Array }
export interface GeoModel {
  project:GeoProject;
  units:UnitDef[];
  boreholes:Borehole[];
  nodes:XY[];
  triangles:Triangle[];
  horizons:Horizon[];
  base:number;
  warnings:string[];
}
export interface BoreholeContacts { depth:Array<number|null>; deepest:number; eoh:number; notes:string[] }

const fmt=(v:number)=>String(Math.round(v*100)/100);

// Reads one log as a layer-cake: depth[k] is the depth of horizon k where the log shows it, `deepest` the last
// unit the hole entered (its base is not seen), `eoh` the final depth. Units skipped by the log have zero thickness.
export function boreholeContacts(b:Borehole,units:UnitDef[]):BoreholeContacts{
  const index=new Map(units.map((u,i)=>[u.id,i]));
  const depth:Array<number|null>=new Array(units.length+1).fill(null);
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
      for(let k=first;k<=u;k++)depth[k]=c;
      deepest=u;
    }
    prevTo=Math.max(prevTo,i.to);
  }
  return {depth,deepest,eoh:Math.max(boreholeDepth(b),prevTo),notes};
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
  const triangles=delaunay(nodes);
  if(nodes.length<3)warnings.push("A TIN model needs at least three boreholes with collar coordinates");
  else if(!triangles.length)warnings.push("All boreholes lie on one line: a TIN model needs three boreholes that are not collinear");

  const N=nodes.length;
  const z=Array.from({length:K+1},()=>new Float64Array(N));
  const observed=Array.from({length:K+1},()=>new Uint8Array(N));
  contacts.forEach((c,i)=>{for(let k=0;k<=c.deepest;k++){z[k][i]=boreholes[i].z-c.depth[k]!;observed[k][i]=1}});
  const eohZ=contacts.map((c,i)=>boreholes[i].z-c.eoh);
  const base=project.base??(N?Math.min(...eohZ):0);

  // Thickness of unit u wherever both its top and base were logged (zero where the unit is absent).
  const thickness=units.map((_,u)=>{
    const s:Array<{x:number;y:number;v:number}>=[];
    for(let i=0;i<N;i++)if(observed[u+1][i])s.push({x:nodes[i].x,y:nodes[i].y,v:z[u][i]-z[u+1][i]});
    return s;
  });
  // Below the deepest unit a hole entered, stack inverse-distance-weighted thicknesses; that unit's base must lie below the end of the hole.
  for(let i=0;i<N;i++){
    for(let k=contacts[i].deepest+1;k<=K;k++){
      let v=k===K?base:z[k-1][i]-idw(thickness[k-1],nodes[i]);
      if(k===contacts[i].deepest+1)v=Math.min(v,eohZ[i]);
      z[k][i]=Math.max(v,base);
    }
  }
  for(let k=1;k<=K;k++)for(let i=0;i<N;i++)z[k][i]=Math.max(Math.min(z[k][i],z[k-1][i]),base);

  const horizons:Horizon[]=z.map((zk,k)=>({
    id:k===0?"ground":k===K?"base":"base:"+units[k-1].id,
    name:k===0?"Ground surface":k===K?"Model base":"Base of "+units[k-1].name,
    z:zk,observed:observed[k]
  }));
  return {project,units,boreholes,nodes,triangles,horizons,base,warnings};
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
  const xs=model.boreholes.map(b=>b.x),ys=model.boreholes.map(b=>b.y),zs=model.boreholes.map(b=>b.z);
  if(!xs.length)return {minX:0,maxX:1,minY:0,maxY:1,minZ:0,maxZ:1};
  return {minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys),minZ:Math.min(model.base,...zs.map((z,i)=>z-boreholeDepth(model.boreholes[i]))),maxZ:Math.max(...zs)};
}
