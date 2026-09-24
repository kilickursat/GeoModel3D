import {delaunay,Point2D,Triangle} from "./tin";
export interface TINSurface {id:string; points:Point2D[]; triangles:Triangle[]}
export interface GeologicalVolume {unit:string; top:TINSurface; bottom:TINSurface}
export function buildSurface(id:string,points:Point2D[]):TINSurface{return{id,points,triangles:delaunay(points)}}
export function volumeGeometry(volume:GeologicalVolume){
  const n=volume.top.points.length;
  const positions=new Float32Array(n*6);
  for(let i=0;i<n;i++){const p=volume.top.points[i],q=volume.bottom.points[i];positions.set([p.x,p.y,p.z,q.x,q.y,q.z],i*6)}
  const indices:number[]=[];
  for(const t of volume.top.triangles){indices.push(t.a*2,t.b*2,t.c*2);indices.push(t.c*2+1,t.b*2+1,t.a*2+1)}
  const edgeCount=new Map<string,{a:number;b:number;count:number}>();
  for(const t of volume.top.triangles){
    for(const [a,b] of [[t.a,t.b],[t.b,t.c],[t.c,t.a]] as Array<[number,number]>){
      const k=(a<b?a:b)+":"+(a<b?b:a); const e=edgeCount.get(k);
      if(e)e.count++; else edgeCount.set(k,{a,b,count:1});
    }
  }
  for(const e of edgeCount.values())if(e.count===1){
    const ta=e.a*2,tb=e.b*2,ba=ta+1,bb=tb+1;
    indices.push(ta,tb,ba,tb,bb,ba);
  }
  return {positions,indices:new Uint32Array(indices)};
}
