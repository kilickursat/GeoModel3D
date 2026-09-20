import * as THREE from "three";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";
import {Borehole,COLORS,contactsFromBoreholes,interpolateSurface,sampleBoreholes,Lithology} from "./geology";
import "./style.css";

const app=document.querySelector<HTMLDivElement>("#app")!;
const scene=new THREE.Scene(); scene.background=new THREE.Color(0x071018);
const camera=new THREE.PerspectiveCamera(55,innerWidth/innerHeight,.1,1000); camera.position.set(115,115,105);
const renderer=new THREE.WebGLRenderer({antialias:true}); renderer.setPixelRatio(Math.min(devicePixelRatio,2)); renderer.setSize(innerWidth,innerHeight); app.appendChild(renderer.domElement);
const controls=new OrbitControls(camera,renderer.domElement); controls.target.set(35,35,55); controls.enableDamping=true;
scene.add(new THREE.HemisphereLight(0xbfd8ff,0x17202a,2)); const sun=new THREE.DirectionalLight(0xffffff,2); sun.position.set(50,80,120); scene.add(sun);

const grid=new THREE.GridHelper(100,10,0x31505d,0x193039); grid.position.set(35,35,0); scene.add(grid);
const contacts=contactsFromBoreholes(sampleBoreholes);
const modelGroup=new THREE.Group(); scene.add(modelGroup);

function surface(unit:Lithology){
 const s=interpolateSurface(contacts,unit);
 const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.BufferAttribute(s.positions,3)); g.setIndex(new THREE.BufferAttribute(s.indices,1)); g.computeVertexNormals();
 const m=new THREE.MeshStandardMaterial({color:COLORS[unit],transparent:true,opacity:.72,side:THREE.DoubleSide,roughness:.85});
 const mesh=new THREE.Mesh(g,m); mesh.userData.unit=unit; modelGroup.add(mesh);
}
surface("Clay"); surface("Sandstone"); surface("Granite");

for(const b of sampleBoreholes){
 const h=60; const g=new THREE.CylinderGeometry(.45,.45,h,10); const m=new THREE.MeshBasicMaterial({color:0xdce8ef});
 const mesh=new THREE.Mesh(g,m); mesh.position.set(b.x,b.y,b.z-h/2); scene.add(mesh);
 const pts=b.intervals.flatMap((i)=>[i.from,i.to]).filter((v,i,a)=>a.indexOf(v)===i);
 for(const d of pts.slice(0,-1)){
   const interval=b.intervals.find(i=>d>=i.from&&d<i.to); if(!interval) continue;
   const mark=new THREE.Mesh(new THREE.SphereGeometry(.8,10,10),new THREE.MeshBasicMaterial({color:COLORS[interval.lithology]}));
   mark.position.set(b.x,b.y,b.z-d); scene.add(mark);
 }
}

const curve=new THREE.CatmullRomCurve3([new THREE.Vector3(-8,15,42),new THREE.Vector3(15,25,45),new THREE.Vector3(38,37,39),new THREE.Vector3(65,50,32),new THREE.Vector3(84,62,27)]);
const tube=new THREE.Mesh(new THREE.TubeGeometry(curve,80,0.65,10,false),new THREE.MeshBasicMaterial({color:0x54d6ff}));
scene.add(tube);

const ui=document.createElement("div"); ui.className="ui"; ui.innerHTML=`<div class="title">GeoModel3D <span>v0.1</span></div><div class="sub">Browser-native geological model prototype</div><div class="legend"></div><div class="hint">Drag: orbit · Wheel: zoom · Right drag: pan</div>`;
app.appendChild(ui);
const legend=ui.querySelector(".legend")!;
for(const u of ["Clay","Sandstone","Granite"] as Lithology[]){const el=document.createElement("label");el.innerHTML=`<i style="background:#${COLORS[u].toString(16).padStart(6,"0")}"></i>${u}`;legend.appendChild(el);}
const clip=document.createElement("input"); clip.type="range";clip.min="-10";clip.max="100";clip.value="100";clip.className="clip";app.appendChild(clip);
clip.oninput=()=>{const z=Number(clip.value); modelGroup.children.forEach(o=>{const box=new THREE.Box3().setFromObject(o);o.visible=box.min.z<z});};

addEventListener("resize",()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});
renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera)});