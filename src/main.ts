import * as THREE from "three";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";
import {COLORS,Lithology,sampleBoreholes} from "./geology";
import {buildGeologicalModel} from "./model";
import {volumeGeometry} from "./volume";
import {surfaceSectionSegments} from "./section";
import "./style.css";

const app=document.querySelector<HTMLDivElement>("#app")!;
const scene=new THREE.Scene();
scene.background=new THREE.Color(0x071018);

const camera=new THREE.PerspectiveCamera(52,innerWidth/innerHeight,.1,1000);
camera.position.set(150,150,130);

const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setSize(innerWidth,innerHeight);
app.appendChild(renderer.domElement);

const controls=new OrbitControls(camera,renderer.domElement);
controls.target.set(52,38,58);
controls.enableDamping=true;

scene.add(new THREE.HemisphereLight(0xbfd8ff,0x182028,2.1));
const sun=new THREE.DirectionalLight(0xffffff,2.7);
sun.position.set(50,80,160);
scene.add(sun);

const grid=new THREE.GridHelper(150,15,0x31505d,0x193039);
grid.position.set(52,38,0);
scene.add(grid);

const units:Lithology[]=["Alluvium","Weathered Rock","Sandstone","Mudstone","Granite"];
const modelData=buildGeologicalModel(sampleBoreholes,units);
const modelGroup=new THREE.Group();
const sectionGroup=new THREE.Group();
scene.add(modelGroup,sectionGroup);

function addVolume(unit:Lithology){
  const volume=modelData.volumes.find(v=>v.unit===unit)!;
  const gdata=volumeGeometry(volume);
  const g=new THREE.BufferGeometry();
  g.setAttribute("position",new THREE.BufferAttribute(gdata.positions,3));
  g.setIndex(new THREE.BufferAttribute(gdata.indices,1));
  g.computeVertexNormals();
  const m=new THREE.MeshStandardMaterial({
    color:COLORS[unit],transparent:true,opacity:.30,side:THREE.DoubleSide,
    roughness:.96,metalness:0,depthWrite:false
  });
  const mesh=new THREE.Mesh(g,m);
  mesh.userData.unit=unit;
  modelGroup.add(mesh);
}
units.forEach(addVolume);

for(const [id,surface] of [["Ground",modelData.ground],...Array.from(modelData.bottoms.entries())]){
  const g=new THREE.BufferGeometry();
  const pos=new Float32Array(surface.points.flatMap(p=>[p.x,p.y,p.z]));
  const ind=new Uint32Array(surface.triangles.flatMap(t=>[t.a,t.b,t.c]));
  g.setAttribute("position",new THREE.BufferAttribute(pos,3));
  g.setIndex(new THREE.BufferAttribute(ind,1));
  g.computeVertexNormals();
  const material=new THREE.MeshBasicMaterial({
    color:id==="Ground"?0xdfeaf0:0xffffff,transparent:true,opacity:id==="Ground"?.16:.06,
    wireframe:true,side:THREE.DoubleSide,depthWrite:false
  });
  const mesh=new THREE.Mesh(g,material);
  mesh.userData.horizon=id;
  modelGroup.add(mesh);
}

for(const b of sampleBoreholes){
  const total=Math.max(...b.intervals.map(i=>i.to));
  const stem=new THREE.Mesh(
    new THREE.CylinderGeometry(.24,.24,total,8),
    new THREE.MeshBasicMaterial({color:0xdce8ef,transparent:true,opacity:.95})
  );
  stem.position.set(b.x,b.y,b.z-total/2);
  scene.add(stem);

  for(const i of b.intervals){
    const marker=new THREE.Mesh(
      new THREE.CylinderGeometry(.50,.50,Math.max(.4,i.to-i.from),8),
      new THREE.MeshBasicMaterial({color:COLORS[i.lithology]})
    );
    marker.position.set(b.x,b.y,b.z-(i.from+i.to)/2);
    scene.add(marker);
  }
}

const bbox=new THREE.Box3().setFromObject(modelGroup);
const center=bbox.getCenter(new THREE.Vector3());
const size=bbox.getSize(new THREE.Vector3());
const span=Math.max(size.x,size.y)*1.65;

const sectionPlaneMesh=new THREE.Mesh(
  new THREE.PlaneGeometry(span,Math.max(size.z,80)),
  new THREE.MeshBasicMaterial({color:0x78c9df,transparent:true,opacity:.045,side:THREE.DoubleSide,depthWrite:false})
);
scene.add(sectionPlaneMesh);

const sectionAngle=THREE.MathUtils.degToRad(28);
const sectionNormal=new THREE.Vector3(Math.cos(sectionAngle),Math.sin(sectionAngle),0).normalize();
const sectionPlane=new THREE.Plane();
let sectionOffset=0;

const sectionColors:Record<string,number>={Ground:0xe8f5ff,...Object.fromEntries(units.map(u=>[u,COLORS[u]]))};
function updateSection(){
  const point=center.clone().addScaledVector(sectionNormal,sectionOffset);
  sectionPlane.setFromNormalAndCoplanarPoint(sectionNormal,point);
  sectionPlaneMesh.position.copy(point);
  sectionPlaneMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),sectionNormal);

  sectionGroup.clear();
  for(const [id,surface] of [["Ground",modelData.ground],...Array.from(modelData.bottoms.entries())]){
    const points=surfaceSectionSegments(surface,sectionPlane);
    if(!points.length)continue;
    const pos=new Float32Array(points.length*3);
    points.forEach((p,i)=>pos.set([p.x,p.y,p.z],i*3));
    const g=new THREE.BufferGeometry();
    g.setAttribute("position",new THREE.BufferAttribute(pos,3));
    const line=new THREE.LineSegments(g,new THREE.LineBasicMaterial({color:sectionColors[id],transparent:true,opacity:.95}));
    sectionGroup.add(line);
  }
}
updateSection();

const ui=document.createElement("div");
ui.className="ui";
ui.innerHTML='<div class="title">GeoModel3D <span>0.3</span></div><div class="sub">Project-agnostic browser geological modelling engine</div><div class="panel"><b>Geological model</b><div>6 boreholes · 5 units</div><div>5 TIN horizons · 5 closed volumes</div><div>Section kernel: vertical plane intersection</div></div><div class="legend"></div><div class="hint">Drag to orbit · wheel to zoom · right-drag to pan</div>';
app.appendChild(ui);

const legend=ui.querySelector(".legend")!;
for(const u of units){
  const el=document.createElement("label");
  el.innerHTML='<i style="background:#'+COLORS[u].toString(16).padStart(6,"0")+'"></i>'+u;
  legend.appendChild(el);
}

const sectionBox=document.createElement("div");
sectionBox.className="section-control";
sectionBox.innerHTML='<span>SECTION</span><input type="range" min="-90" max="90" value="0" step="1"><output>0 m</output>';
app.appendChild(sectionBox);

const sectionSlider=sectionBox.querySelector("input") as HTMLInputElement;
const sectionOutput=sectionBox.querySelector("output")!;
sectionSlider.oninput=()=>{const sectionOffsetValue=Number(sectionSlider.value);sectionOutput.textContent=sectionOffsetValue+" m";sectionOffset=sectionOffsetValue;updateSection()};

const toggle=document.createElement("button");
toggle.className="toggle";
toggle.textContent="Hide volumes";
app.appendChild(toggle);
let showVolumes=true;
toggle.onclick=()=>{showVolumes=!showVolumes;modelGroup.children.forEach((obj)=>{if(obj.userData.unit)obj.visible=showVolumes});toggle.textContent=showVolumes?"Hide volumes":"Show volumes"};

addEventListener("resize",()=>{
  camera.aspect=innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
});

renderer.setAnimationLoop(()=>{
  controls.update();
  renderer.render(scene,camera);
});
