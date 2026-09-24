import * as THREE from "three";
import {TINSurface} from "./volume";
function planeValue(p:THREE.Vector3,plane:THREE.Plane){return plane.normal.dot(p)+plane.constant}
function edgeIntersection(a:THREE.Vector3,b:THREE.Vector3,fa:number,fb:number){
  if(Math.abs(fa)<1e-8&&Math.abs(fb)<1e-8)return null;
  if((fa>0&&fb>0)||(fa<0&&fb<0))return null;
  const t=fa/(fa-fb);return a.clone().lerp(b,t);
}
export function surfaceSectionSegments(surface:TINSurface,plane:THREE.Plane){
  const out:THREE.Vector3[]=[];
  for(const tri of surface.triangles){
    const p=[surface.points[tri.a],surface.points[tri.b],surface.points[tri.c]].map(q=>new THREE.Vector3(q.x,q.y,q.z));
    const f=p.map(q=>planeValue(q,plane));
    const hits=[edgeIntersection(p[0],p[1],f[0],f[1]),edgeIntersection(p[1],p[2],f[1],f[2]),edgeIntersection(p[2],p[0],f[2],f[0])];
    const unique:THREE.Vector3[]=[];
    for(const h of hits)if(h&&!unique.some(u=>u.distanceToSquared(h)<1e-8))unique.push(h);
    if(unique.length===2)out.push(unique[0],unique[1]);
  }
  return out;
}
