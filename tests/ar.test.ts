import {describe,it,expect} from "vitest";
import * as THREE from "three";
import {arModel,skin,toGlb,toUsdz} from "../src/ar";
import {unitCubicMetres} from "../src/model";
import {valleyProject,referenceProject,antwerpProject} from "../src/geology";
import {unzipSync,strFromU8} from "three/addons/libs/fflate.module.js";

// Node has no FileReader, which the GLB writer reads its buffers with.
(globalThis as {FileReader?:unknown}).FileReader??=class{
  result:ArrayBuffer|null=null;onloadend:(()=>void)|null=null;
  readAsArrayBuffer(b:Blob){void b.arrayBuffer().then(r=>{this.result=r;this.onloadend?.()})}
};

const units=(scene:THREE.Scene)=>scene.children[0].children.filter(c=>c.name!=="Boreholes") as THREE.Mesh[];
const triangles=(mesh:THREE.Mesh)=>{
  const p=mesh.geometry.getAttribute("position"),idx=mesh.geometry.getIndex()!,out:THREE.Vector3[][]=[];
  for(let i=0;i<idx.count;i+=3)out.push([0,1,2].map(j=>new THREE.Vector3().fromBufferAttribute(p,idx.getX(i+j))));
  return out;
};
// The volume enclosed by outward-facing triangles (divergence theorem).
const enclosed=(meshes:THREE.Mesh[])=>meshes.flatMap(triangles).reduce((v,[a,b,c])=>v+a.dot(b.clone().cross(c))/6,0);

describe("models for augmented reality",()=>{
  it("stand on the desk at the size asked, centred on the footprint",()=>{
    const {scene,scale}=arModel(valleyProject,{ve:2,size:0.3});
    // The units, without the pin heads that stand out at the edge.
    const box=new THREE.Box3();
    for(const m of units(scene))box.expandByObject(m);
    // Positions are single precision: within a micrometre.
    expect(Math.max(box.max.x-box.min.x,box.max.z-box.min.z)).toBeCloseTo(0.3,6);
    expect(box.min.y).toBeCloseTo(0,6);
    expect((box.min.x+box.max.x)/2).toBeCloseTo(0,6);
    expect(scale).toBeGreaterThan(0);
  });

  it("enclose exactly the volume of the units, with the exaggeration, and keep only their outside",()=>{
    for(const p of [valleyProject,referenceProject]){
      const ve=3,{scene,model,scale}=arModel(p,{ve});
      const volume=model.units.reduce((s,_,k)=>s+unitCubicMetres(model,k),0)*scale**3*ve;
      expect(enclosed(units(scene))/volume).toBeCloseTo(1,6);
      // With every unit shown, the surfaces are the top and the base only, not a shell per unit.
      expect(skin(model,model.units.map(()=>true)).reduce((s,f)=>s+f.surface.length/3,0)).toBe(2*model.triangles.length);
    }
  });

  it("leave a closed gap where units are hidden",()=>{
    const hidden=new Set([valleyProject.units[2].id]);
    const {scene,model,scale}=arModel(valleyProject,{ve:1,hidden});
    const kept=model.units.reduce((s,u,k)=>s+(hidden.has(u.id)?0:unitCubicMetres(model,k)),0)*scale**3;
    expect(enclosed(units(scene))/kept).toBeCloseTo(1,6);
    expect(units(scene).map(m=>m.name)).not.toContain(valleyProject.units[2].name);
    // Watertight: every edge is crossed once in each direction.
    const key=(v:THREE.Vector3)=>[v.x,v.y,v.z].map(c=>Math.round(c*1e7)).join(",");
    const edges=new Map<string,number>();
    for(const [a,b,c] of units(scene).flatMap(triangles))for(const [p,q] of [[a,b],[b,c],[c,a]]){
      const kp=key(p),kq=key(q);
      if(kp===kq)continue;
      edges.set(kp+"|"+kq,(edges.get(kp+"|"+kq)??0)+1);
    }
    for(const [k,n] of edges)expect(edges.get(k.split("|").reverse().join("|"))??0).toBe(n);
  });

  it("keep a real site to a phone's few tens of thousands of triangles",()=>{
    const {triangles:n}=arModel(antwerpProject,{ve:5});
    expect(n).toBeGreaterThan(2000);
    expect(n).toBeLessThan(40000);
  });

  it("write GLB and USDZ carrying the data credit",async()=>{
    const {scene}=arModel(referenceProject,{ve:1});
    const glb=new Uint8Array(await toGlb(scene,"Data: test credit"));
    const view=new DataView(glb.buffer,glb.byteOffset);
    expect(strFromU8(glb.subarray(0,4))).toBe("glTF");
    expect(view.getUint32(4,true)).toBe(2);
    expect(view.getUint32(8,true)).toBe(glb.byteLength);
    const json=JSON.parse(strFromU8(glb.subarray(20,20+view.getUint32(12,true))));
    expect(json.asset.copyright).toBe("Data: test credit");
    expect(json.meshes.length).toBe(referenceProject.units.length+1);

    const usdz=await toUsdz(scene,"Data: \"quoted\" credit");
    expect(strFromU8(usdz.subarray(0,4))).toBe("PK\x03\x04");
    // Every file is stored, its data starting on a 64-byte boundary, as USDZ requires.
    const head=new DataView(usdz.buffer,usdz.byteOffset);
    let files=0;
    for(let pos=0;head.getUint32(pos,true)===0x04034b50;files++){
      const size=head.getUint32(pos+18,true),start=pos+30+head.getUint16(pos+26,true)+head.getUint16(pos+28,true);
      expect(head.getUint16(pos+8,true)).toBe(0);
      expect(start%64).toBe(0);
      pos=start+size;
    }
    expect(files).toBeGreaterThan(1);
    const unpacked=unzipSync(usdz),name=Object.keys(unpacked)[0];
    expect(name).toMatch(/\.usda$/);
    const usda=strFromU8(unpacked[name]);
    expect(usda).toContain('doc = "Data: \\"quoted\\" credit"');
    expect(usda).toContain('token preliminary:anchoring:type = "plane"');
  });
});
