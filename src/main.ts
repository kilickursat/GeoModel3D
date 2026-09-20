import * as THREE from "three";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";
import {COLORS,contactsFromBoreholes,interpolateSurface,sampleBoreholes,Lithology} from "./geology";
import "./style.css";
const app=document.querySelector<HTMLDivElement>("#app")!;const scene=new THREE.Scene();scene.background=new THREE.Color(0x071018);
const camera=new THREE.PerspectiveCamera(52,innerWidth/innerHeight,.1,1000);camera.position.set(145,145,125);
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);app.appendChild(renderer.domElement);
const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(48,38,55);controls.enableDamping=true;
scene.add(new THREE.HemisphereLight(0xbfd8ff,0x182028,2.2));const sun=new THREE.DirectionalLight(0xffffff,2.4);sun.position.set(50,80,160);scene.add(sun);
const grid=new THREE.GridHelper(130,13,0x31505d,0x193039);grid.position.set(45,38,0);scene.add(grid);
const contacts=contactsFromBoreholes(sampleBoreholes),model=new THREE.Group();scene.add(model);
const units:Lithology[]=["Alluvium","Weathered Rock","Sandstone","Mudstone","Granite"];
for(const unit of units){const s=interpolateSurface(contacts,unit),g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.BufferAttribute(s.positions,3));g.setIndex(new THREE.BufferAttribute(s.indices,1));g.computeVertexNormals();const m=new THREE.MeshStandardMaterial({color:COLORS[unit],transparent:true,opacity:.58,side:THREE.DoubleSide,roughness:.9,depthWrite:false});const mesh=new THREE.Mesh(g,m);mesh.userData.unit=unit;model.add(mesh)}
for(const b of sampleBoreholes){const bh=new THREE.Mesh(new THREE.CylinderGeometry(.38,.38,112,10),new THREE.MeshBasicMaterial({color:0xdce8ef}));bh.position.set(b.x,b.y,b.z-56);scene.add(bh);for(const i of b.intervals){const marker=new THREE.Mesh(new THREE.CylinderGeometry(.62,.62,Math.max(.4,i.to-i.from),8),new THREE.MeshBasicMaterial({color:COLORS[i.lithology]}));marker.position.set(b.x,b.y,b.z-(i.from+i.to)/2);scene.add(marker)}}
const curve=new THREE.CatmullRomCurve3([new THREE.Vector3(-8,15,48),new THREE.Vector3(12,25,48),new THREE.Vector3(40,36,43),new THREE.Vector3(72,48,36),new THREE.Vector3(112,65,29)]);
scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve,100,1.2,14,false),new THREE.MeshStandardMaterial({color:0x54d6ff,transparent:true,opacity:.8,roughness:.4})));
const ui=document.createElement("div");ui.className="ui";ui.innerHTML='<div class="title">GeoModel3D <span>0.2</span></div><div class="sub">Project-agnostic browser geological modelling engine</div><div class="panel"><b>Model</b><div>6 boreholes · 5 geological units</div><div>Interpolated horizons · synthetic reference dataset</div></div><div class="legend"></div><div class="hint">Orbit · zoom · pan · section slider</div>';app.appendChild(ui);
const legend=ui.querySelector(".legend")!;for(const u of units){const el=document.createElement("label");el.innerHTML='<i style="background:#'+COLORS[u].toString(16).padStart(6,"0")+'"></i>'+u;legend.appendChild(el)}
const clip=document.createElement("input");clip.type="range";clip.min="-5";clip.max="125";clip.value="125";clip.className="clip";app.appendChild(clip);clip.oninput=()=>{const z=+clip.value;model.children.forEach(o=>o.visible=new THREE.Box3().setFromObject(o).min.z<z)};
addEventListener("resize",()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera)});