// A ground model to set on a desk in augmented reality, or to open in other 3-D software: the model as the viewer shows
// it, with the same vertical exaggeration and without the hidden units, at hand size, with a pin at each borehole.
// Phones draw a few tens of thousands of triangles smoothly, so the model is built on a coarser mesh and only the
// outside of the visible units is kept. USDZ opens in AR Quick Look on iPhone and iPad; GLB (binary glTF 2.0) in
// Android's Scene Viewer, web viewers and 3-D software such as Blender.
import * as THREE from "three";
import {GLTFExporter} from "three/addons/exporters/GLTFExporter.js";
import {USDZExporter} from "three/addons/exporters/USDZExporter.js";
import {strFromU8,strToU8,unzipSync,zipSync,Zippable} from "three/addons/libs/fflate.module.js";
import {GeoProject} from "./schema";
import {buildGeologicalModel,GeoModel} from "./model";
import {boundaryEdges} from "./tin";

export interface ArOptions {
  ve:number;                    // vertical exaggeration, as in the viewer
  hidden?:ReadonlySet<string>;  // ids of the units left out
  size?:number;                 // metres across the longer side of the footprint
  triangles?:number;            // the size the mesh is refined to, where it is refined
}
export interface ArModel { scene:THREE.Scene; model:GeoModel; scale:number; triangles:number }

const EPS=1e-6;
// A face corner: a node of the mesh on a horizon.
type Corner=[node:number,horizon:number];
// The outside of the visible units, for each unit its surfaces and its walls. In every triangle of the mesh the units
// with thickness there are taken top to bottom: a face lies wherever visible material meets the air or a hidden unit,
// facing out of the material, and walls stand along the edge of the footprint. A hidden unit leaves a gap closed on
// both sides, so the whole stays watertight.
export function skin(m:GeoModel,visible:boolean[]){
  const K=m.units.length,z=m.horizons.map(h=>h.z);
  const faces=m.units.map(()=>({surface:[] as Corner[],wall:[] as Corner[]}));
  const thick=(k:number,n:number)=>z[k][n]-z[k+1][n]>EPS;
  for(const t of m.triangles){
    const units:number[]=[];
    for(let k=0;k<K;k++)if(thick(k,t.a)||thick(k,t.b)||thick(k,t.c))units.push(k);
    if(!units.length)continue;
    const up=(k:number,h:number)=>faces[k].surface.push([t.a,h],[t.b,h],[t.c,h]);
    const down=(k:number,h:number)=>faces[k].surface.push([t.a,h],[t.c,h],[t.b,h]);
    if(visible[units[0]])up(units[0],units[0]);
    for(let i=0;i+1<units.length;i++){
      const a=units[i],b=units[i+1];
      if(visible[a]&&!visible[b])down(a,a+1);
      else if(!visible[a]&&visible[b])up(b,b);
    }
    const last=units[units.length-1];
    if(visible[last])down(last,last+1);
  }
  // A boundary edge a→b has the inside on its left, so the wall below it faces right, outwards.
  for(const [a,b] of boundaryEdges(m.triangles))for(let k=0;k<K;k++){
    if(!visible[k])continue;
    if(thick(k,a))faces[k].wall.push([a,k],[a,k+1],[b,k+1]);
    if(thick(k,b))faces[k].wall.push([a,k],[b,k+1],[b,k]);
  }
  return faces;
}

// The model as a scene: y up, as glTF and USD have it, centred on the footprint and standing on its base, `size`
// metres across (30 cm by default), with the viewer's vertical exaggeration; a mesh per visible unit, and the pins.
export function arModel(project:GeoProject,o:ArOptions):ArModel{
  const m=buildGeologicalModel(project,{triangles:o.triangles??6000}),K=m.units.length;
  const visible=m.units.map(u=>!o.hidden?.has(u.id));
  let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
  for(const p of m.nodes){x0=Math.min(x0,p.x);x1=Math.max(x1,p.x);y0=Math.min(y0,p.y);y1=Math.max(y1,p.y)}
  const cx=(x0+x1)/2,cy=(y0+y1)/2,scale=(o.size??0.3)/Math.max(x1-x0,y1-y0,1e-9);
  const at=(n:number,h:number):[number,number,number]=>[(m.nodes[n].x-cx)*scale,(m.horizons[h].z[n]-m.base)*scale*o.ve,-(m.nodes[n].y-cy)*scale];
  const scene=new THREE.Scene(),root=new THREE.Group();
  root.name=project.name;
  scene.add(root);
  let triangles=0;
  skin(m,visible).forEach((f,k)=>{
    if(!f.surface.length&&!f.wall.length)return;
    // Surfaces share their corners, so they are shaded smoothly; walls have their own, so the rim stays sharp.
    const index=new Map<number,number>(),position:number[]=[],corners:number[]=[];
    const add=(list:Corner[],wall:number)=>{for(const [n,h] of list){
      const key=(n*(K+1)+h)*2+wall;
      let i=index.get(key);
      if(i===undefined){i=position.length/3;index.set(key,i);position.push(...at(n,h))}
      corners.push(i);
    }};
    add(f.surface,0);add(f.wall,1);
    const g=new THREE.BufferGeometry();
    g.setAttribute("position",new THREE.Float32BufferAttribute(position,3));
    g.setIndex(corners);
    g.computeVertexNormals();
    const mesh=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:m.units[k].color||"#888888",roughness:.9,metalness:0}));
    mesh.name=m.units[k].name;
    root.add(mesh);
    triangles+=corners.length/3;
  });
  // A pin at each borehole: a six-sided shaft 12 mm tall from the collar, with a small head.
  const pin:number[]=[],r=0.0012,height=0.012,head=0.0025;
  m.boreholes.forEach((_,i)=>{
    const [x,y,z]=at(i,0),ring=(dy:number)=>Array.from({length:6},(_,j)=>[x+r*Math.cos(j*Math.PI/3),y+dy,z+r*Math.sin(j*Math.PI/3)]);
    const bottom=ring(0),top=ring(height);
    for(let j=0;j<6;j++){const k=(j+1)%6;pin.push(...bottom[j],...top[j],...bottom[k],...top[j],...top[k],...bottom[k])}
    const c=[x,y+height,z],T=[c[0],c[1]+head,c[2]],B=[c[0],c[1]-head,c[2]],E=[c[0]+head,c[1],c[2]],W=[c[0]-head,c[1],c[2]],N=[c[0],c[1],c[2]-head],S=[c[0],c[1],c[2]+head];
    for(const f of [[T,S,E],[T,E,N],[T,N,W],[T,W,S],[B,E,S],[B,N,E],[B,W,N],[B,S,W]])for(const v of f)pin.push(...v);
  });
  if(pin.length){
    const g=new THREE.BufferGeometry();
    g.setAttribute("position",new THREE.Float32BufferAttribute(pin,3));
    g.computeVertexNormals();
    const mesh=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:"#e8f2f7",roughness:.5,metalness:0}));
    mesh.name="Boreholes";
    root.add(mesh);
    triangles+=pin.length/9;
  }
  return {scene,model:m,scale,triangles};
}

// GLB, with the data credit in its asset block.
export async function toGlb(scene:THREE.Object3D,credit?:string){
  return await new GLTFExporter().parseAsync(scene,{binary:true,...(credit?{copyright:credit}:{})}) as ArrayBuffer;
}
// USDZ anchored to a horizontal surface, as AR Quick Look places it, with the data credit as the documentation of the
// file.
export async function toUsdz(scene:THREE.Object3D,credit?:string){
  const usdz=await new USDZExporter().parseAsync(scene,{quickLookCompatible:true,ar:{anchoring:{type:"plane"},planeAnchoring:{alignment:"horizontal"}}});
  if(!credit)return usdz;
  const files=unzipSync(usdz),packed:Zippable={};
  for(const name of Object.keys(files))
    if(name.endsWith(".usda"))files[name]=strToU8(strFromU8(files[name]).replace(/^#usda 1\.0\n\(\n/,`#usda 1.0\n(\n\tdoc = ${JSON.stringify(credit)}\n`));
  // Packed again as the exporter packs it, as USDZ asks: stored, with the data of the first file 64-byte aligned.
  let offset=0;
  for(const name of Object.keys(files)){
    const file=files[name];
    offset+=34+name.length;
    const mod=offset&63;
    packed[name]=mod!==4?[file,{extra:{12345:new Uint8Array(64-mod)}}]:file;
    offset=file.length;
  }
  return zipSync(packed,{level:0,mtime:new Date()});
}
// Safari on iPhone and iPad opens a USDZ link marked rel="ar" in AR Quick Look.
export function quickLookAvailable(){
  try{return document.createElement("a").relList.supports("ar")}catch{return false}
}
