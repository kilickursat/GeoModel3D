import {delaunay,Point2D,Triangle,boundaryEdges} from "./tin";
export interface TINSurface {id:string; points:Point2D[]; triangles:Triangle[]}
export interface GeologicalVolume {unit:string; top:TINSurface; bottom:TINSurface}
export function buildSurface(id:string,points:Point2D[]):TINSurface{return{id,points,triangles:delaunay(points)}}

// Closed, outward-facing mesh of the material between two horizons on the same triangulation. Where the unit has
// zero thickness its top and bottom vertices are shared, so pinched-out ground adds no faces and the shell stays closed.
export function volumeGeometry(volume:GeologicalVolume,origin={x:0,y:0,z:0},eps=1e-6){
  const n=volume.top.points.length;
  const positions=new Float32Array(n*6);
  const bottom=new Uint32Array(n);
  for(let i=0;i<n;i++){
    const p=volume.top.points[i],q=volume.bottom.points[i];
    positions.set([p.x-origin.x,p.y-origin.y,p.z-origin.z,q.x-origin.x,q.y-origin.y,q.z-origin.z],i*6);
    bottom[i]=p.z-q.z>eps?i*2+1:i*2;
  }
  const indices:number[]=[];
  for(const t of volume.top.triangles){
    if(bottom[t.a]===t.a*2&&bottom[t.b]===t.b*2&&bottom[t.c]===t.c*2)continue;
    indices.push(t.a*2,t.b*2,t.c*2,bottom[t.c],bottom[t.b],bottom[t.a]);
  }
  // Boundary edge a→b has the interior on its left; the wall below it faces right (outwards).
  for(const [a,b] of boundaryEdges(volume.top.triangles)){
    const ta=a*2,tb=b*2,ba=bottom[a],bb=bottom[b];
    if(ba!==ta)indices.push(ta,ba,bb);
    if(bb!==tb)indices.push(ta,bb,tb);
  }
  return {positions,indices:new Uint32Array(indices)};
}
