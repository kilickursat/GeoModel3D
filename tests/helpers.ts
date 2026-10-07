import {XY} from "../src/tin";

// Deterministic PRNG (mulberry32) so geometric tests are reproducible.
export function rng(seed:number){
  return ()=>{seed=seed+0x6d2b79f5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296};
}
export function randomPoints(n:number,seed:number,w=400,h=300):XY[]{
  const r=rng(seed);
  return Array.from({length:n},()=>({x:r()*w,y:r()*h}));
}
export function convexHullArea(points:XY[]){
  const p=[...points].sort((a,b)=>a.x-b.x||a.y-b.y);
  const cross=(o:XY,a:XY,b:XY)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
  const lower:XY[]=[],upper:XY[]=[];
  for(const q of p){while(lower.length>=2&&cross(lower[lower.length-2],lower[lower.length-1],q)<=0)lower.pop();lower.push(q)}
  for(const q of [...p].reverse()){while(upper.length>=2&&cross(upper[upper.length-2],upper[upper.length-1],q)<=0)upper.pop();upper.push(q)}
  const hull=[...lower.slice(0,-1),...upper.slice(0,-1)];
  let a=0;
  for(let i=0;i<hull.length;i++){const j=(i+1)%hull.length;a+=hull[i].x*hull[j].y-hull[j].x*hull[i].y}
  return Math.abs(a)/2;
}
// Signed volume of a closed triangle mesh (divergence theorem); positive when faces point outwards.
export function meshVolume(positions:ArrayLike<number>,indices:ArrayLike<number>){
  let v=0;
  for(let f=0;f<indices.length;f+=3){
    const [a,b,c]=[indices[f]*3,indices[f+1]*3,indices[f+2]*3];
    const ax=positions[a],ay=positions[a+1],az=positions[a+2],bx=positions[b],by=positions[b+1],bz=positions[b+2],cx=positions[c],cy=positions[c+1],cz=positions[c+2];
    v+=ax*(by*cz-bz*cy)-ay*(bx*cz-bz*cx)+az*(bx*cy-by*cx);
  }
  return v/6;
}
// Directed edges used more often than their reverse; empty for a closed, consistently oriented surface
// (shells that touch along a pinch line share an edge between four faces, which is still closed).
export function openEdges(indices:ArrayLike<number>){
  const S=2**24,count=new Map<number,number>();
  for(let f=0;f<indices.length;f+=3)for(let e=0;e<3;e++){
    const k=indices[f+e]*S+indices[f+(e+1)%3];count.set(k,(count.get(k)??0)+1);
  }
  const open:string[]=[];
  for(const [k,n] of count){const a=Math.floor(k/S),b=k%S;if(count.get(b*S+a)!==n)open.push(a+">"+b)}
  return open;
}
