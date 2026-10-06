import * as THREE from "three";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";
import {CSS2DRenderer,CSS2DObject} from "three/addons/renderers/CSS2DRenderer.js";
import pkg from "../package.json";
import {GeoProject,sampleProjects,boreholeDepth} from "./geology";
import {buildGeologicalModel,GeoModel,unitVolume,unitCubicMetres,horizonSurface,modelBounds,footprintArea} from "./model";
import {volumeGeometry} from "./volume";
import {computeSection,offsetRange,principalAzimuth,Section} from "./section";
import {sectionSvg,sectionCsv} from "./sectionSvg";
import {importFiles,toProjectJson,toBoreholeCsv} from "./io";
import "./style.css";

const app=document.querySelector<HTMLDivElement>("#app")!;
const esc=(s:string)=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]!));
const fmt=(v:number,d=0)=>v.toLocaleString("en-US",{maximumFractionDigits:d,minimumFractionDigits:d});
const fmtVolume=(v:number)=>v>=1e6?fmt(v/1e6,2)+" M m³":fmt(v)+" m³";
const fmtArea=(v:number)=>v>=1e4?fmt(v/1e4,2)+" ha":fmt(v)+" m²";

// ---------- scene ----------

const scene=new THREE.Scene();
scene.background=new THREE.Color(0x071018);
const camera=new THREE.PerspectiveCamera(45,innerWidth/innerHeight,0.1,1e5);
camera.up.set(0,0,1);
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setSize(innerWidth,innerHeight);
renderer.localClippingEnabled=true;
app.appendChild(renderer.domElement);
const labelRenderer=new CSS2DRenderer();
labelRenderer.setSize(innerWidth,innerHeight);
labelRenderer.domElement.className="labels";
app.appendChild(labelRenderer.domElement);
const controls=new OrbitControls(camera,renderer.domElement);
controls.enableDamping=true;
scene.add(new THREE.HemisphereLight(0xbfd8ff,0x182028,2.1));
const sun=new THREE.DirectionalLight(0xffffff,2.4);
scene.add(sun);

// Model geometry is built about a local origin (projected coordinates would lose float32 precision) and the
// world group carries the vertical exaggeration.
const world=new THREE.Group();
scene.add(world);
let content=new THREE.Group();
world.add(content);
const sectionGroup=new THREE.Group();
world.add(sectionGroup);
const clipPlane=new THREE.Plane();

let project:GeoProject=sampleProjects[0];
let imported:GeoProject|null=null;
let model:GeoModel;
let section:Section;
let origin={x:0,y:0,z:0},extent=1,sectionBuffer=1;
const view={azimuth:0,offset:0,ve:1,cut:false,flip:false,volumes:true,horizons:true,boreholes:true,labels:true,panel:innerWidth>760,hidden:new Set<string>()};

const volumeMeshes:THREE.Mesh[]=[];
const horizonLines:THREE.LineSegments[]=[];
let holeMesh:THREE.InstancedMesh|null=null;
let holeInfo:Array<{hole:number;interval:number}>=[];
let labels:CSS2DObject[]=[];

function local(x:number,y:number,z:number){return new THREE.Vector3(x-origin.x,y-origin.y,z-origin.z)}

function disposeContent(){
  labels.forEach(l=>l.element.remove());
  labels=[];
  content.traverse(o=>{
    const m=o as THREE.Mesh;
    m.geometry?.dispose();
    const mat=m.material as THREE.Material|THREE.Material[]|undefined;
    if(mat)(Array.isArray(mat)?mat:[mat]).forEach(x=>x.dispose());
  });
  world.remove(content);
  content=new THREE.Group();
  world.add(content);
  volumeMeshes.length=0;
  horizonLines.length=0;
  holeMesh?.dispose();
  holeMesh=null;
  holeInfo=[];
}

function buildContent(){
  disposeContent();
  const b=modelBounds(model);
  origin={x:(b.minX+b.maxX)/2,y:(b.minY+b.maxY)/2,z:(b.minZ+b.maxZ)/2};
  extent=Math.max(b.maxX-b.minX,b.maxY-b.minY,(b.maxZ-b.minZ)/2,1);

  model.units.forEach((u,k)=>{
    const g=volumeGeometry(unitVolume(model,k),origin);
    if(!g.indices.length)return;
    const geo=new THREE.BufferGeometry();
    geo.setAttribute("position",new THREE.BufferAttribute(g.positions,3));
    geo.setIndex(new THREE.BufferAttribute(g.indices,1));
    geo.computeVertexNormals();
    const mesh=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:u.color,roughness:.95,metalness:0,transparent:true,depthWrite:false,side:THREE.FrontSide}));
    mesh.userData.unit=k;
    volumeMeshes.push(mesh);
    content.add(mesh);
  });

  model.horizons.forEach((_,k)=>{
    if(!model.triangles.length)return;
    const s=horizonSurface(model,k),geo=new THREE.BufferGeometry();
    geo.setAttribute("position",new THREE.BufferAttribute(new Float32Array(s.points.flatMap(p=>[p.x-origin.x,p.y-origin.y,p.z-origin.z])),3));
    geo.setIndex(s.triangles.flatMap(t=>[t.a,t.b,t.c]));
    const line=new THREE.LineSegments(new THREE.WireframeGeometry(geo),new THREE.LineBasicMaterial({color:k===0?0xdfeaf0:0xffffff,transparent:true,opacity:k===0?.22:.07,depthWrite:false}));
    geo.dispose();
    horizonLines.push(line);
    content.add(line);
  });

  const radius=extent*0.0045,segments:Array<{hole:number;interval:number;top:number;bottom:number;color:string}>=[];
  model.boreholes.forEach((bh,hole)=>{
    bh.intervals.forEach((iv,interval)=>segments.push({hole,interval,top:bh.z-iv.from,bottom:bh.z-iv.to,color:model.units.find(u=>u.id===iv.unit)?.color??"#7b8790"}));
    const logged=Math.max(...bh.intervals.map(i=>i.to)),depth=boreholeDepth(bh);
    if(depth>logged+1e-6)segments.push({hole,interval:-1,top:bh.z-logged,bottom:bh.z-depth,color:"#4f5d66"});
    const el=document.createElement("div");
    el.className="bh-label";
    el.textContent=bh.id;
    const label=new CSS2DObject(el);
    label.position.copy(local(bh.x,bh.y,bh.z));
    label.center.set(0.5,1.3);
    label.userData.hole=hole;
    labels.push(label);
    content.add(label);
  });
  if(segments.length){
    holeMesh=new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,1,10).rotateX(Math.PI/2),new THREE.MeshBasicMaterial(),segments.length);
    const m=new THREE.Matrix4(),q=new THREE.Quaternion(),c=new THREE.Color();
    segments.forEach((s,i)=>{
      const bh=model.boreholes[s.hole];
      m.compose(local(bh.x,bh.y,(s.top+s.bottom)/2),q,new THREE.Vector3(radius,radius,Math.max(s.top-s.bottom,0.02)));
      holeMesh!.setMatrixAt(i,m);
      holeMesh!.setColorAt(i,c.set(s.color));
    });
    holeInfo=segments.map(({hole,interval})=>({hole,interval}));
    content.add(holeMesh);
  }

  const size=niceCeil(extent*1.35),grid=new THREE.GridHelper(size,10,0x31505d,0x193039);
  grid.rotation.x=Math.PI/2;
  grid.position.z=model.base-origin.z-(b.maxZ-b.minZ)*0.03;
  content.add(grid);
}
function niceCeil(v:number){const p=10**Math.floor(Math.log10(v));return Math.ceil(v/p)*p}
// Shift the projection centre away from the open section view so the model sits in the free part of the screen.
function updateViewOffset(){
  const open=view.panel&&innerWidth>760;
  camera.setViewOffset(innerWidth,innerHeight,open?sectionView.offsetWidth*0.14:0,open?sectionView.offsetHeight*0.32:0,innerWidth,innerHeight);
}

function fitCamera(){
  const b=modelBounds(model),ve=view.ve;
  const box=new THREE.Box3(new THREE.Vector3(b.minX-origin.x,b.minY-origin.y,(b.minZ-origin.z)*ve),new THREE.Vector3(b.maxX-origin.x,b.maxY-origin.y,(b.maxZ-origin.z)*ve));
  const sphere=box.getBoundingSphere(new THREE.Sphere());
  const dist=Math.max(sphere.radius,extent/2)/Math.sin(THREE.MathUtils.degToRad(camera.fov/2))*(innerWidth<760?1.35:1.1);
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(new THREE.Vector3(0.62,-1.1,0.72).normalize(),dist);
  camera.near=dist/500;
  camera.far=dist*30;
  updateViewOffset();
  sun.position.copy(sphere.center).add(new THREE.Vector3(0.45,-0.7,1).multiplyScalar(dist));
  controls.update();
}

// ---------- section ----------

const fence=new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1}));
const fenceLines=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0x0b1620,transparent:true,opacity:.75}));
const outline=new THREE.LineLoop(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0x78c9df,transparent:true,opacity:.55}));
const endLabels=["A","A′"].map(t=>{const el=document.createElement("div");el.className="end-label";el.textContent=t;const l=new CSS2DObject(el);l.center.set(0.5,1.2);return l});
sectionGroup.add(fence,fenceLines,outline,...endLabels);

function updateSection(){
  section=computeSection(model,{azimuth:view.azimuth,offset:view.offset},sectionBuffer);
  const s=section,n=s.s.length,pos:number[]=[],col:number[]=[],lines:number[]=[],c=new THREE.Color();
  const p=(j:number,z:number)=>[s.x[j]-origin.x,s.y[j]-origin.y,z-origin.z];
  model.units.forEach((u,k)=>{
    c.set(u.color);
    for(let j=0;j<n-1;j++){
      const t0=s.z[k][j],b0=s.z[k+1][j],t1=s.z[k][j+1],b1=s.z[k+1][j+1];
      if(t0-b0<1e-9&&t1-b1<1e-9)continue;
      for(const v of [p(j,t0),p(j,b0),p(j+1,b1),p(j,t0),p(j+1,b1),p(j+1,t1)]){pos.push(...v);col.push(c.r,c.g,c.b)}
    }
  });
  s.z.forEach(z=>{for(let j=0;j<n-1;j++)lines.push(...p(j,z[j]),...p(j+1,z[j+1]))});
  fence.geometry.dispose();
  fence.geometry=new THREE.BufferGeometry();
  fence.geometry.setAttribute("position",new THREE.Float32BufferAttribute(pos,3));
  fence.geometry.setAttribute("color",new THREE.Float32BufferAttribute(col,3));
  fenceLines.geometry.dispose();
  fenceLines.geometry=new THREE.BufferGeometry();
  fenceLines.geometry.setAttribute("position",new THREE.Float32BufferAttribute(lines,3));
  outline.geometry.dispose();
  outline.geometry=new THREE.BufferGeometry();
  if(n>1){
    const top=Math.max(...s.z[0])+(Math.max(...s.z[0])-model.base)*0.04;
    outline.geometry.setAttribute("position",new THREE.Float32BufferAttribute([...p(0,model.base),...p(n-1,model.base),...p(n-1,top),...p(0,top)],3));
    endLabels[0].position.set(...(p(0,top) as [number,number,number]));
    endLabels[1].position.set(...(p(n-1,top) as [number,number,number]));
  }
  endLabels.forEach(l=>l.visible=n>1);
  cutSide=0;
  updateCutSide();
  applyDisplay();
  renderSectionPanel();
}
// The cut keeps the half beyond the section as seen from the camera, so the section face looks at the viewer.
let cutSide=0;
function updateCutSide(){
  if(!section)return false;
  const n=new THREE.Vector3(section.normal.x,section.normal.y,0),p=new THREE.Vector3(section.origin.x-origin.x,section.origin.y-origin.y,0);
  const side=(n.dot(camera.position.clone().sub(p))>0?-1:1)*(view.flip?-1:1);
  if(side===cutSide)return false;
  cutSide=side;
  clipPlane.setFromNormalAndCoplanarPoint(n.multiplyScalar(side),p);
  return true;
}

// ---------- display state ----------

function applyDisplay(){
  world.scale.set(1,1,view.ve);
  const planes=view.cut?[clipPlane]:[];
  for(const m of volumeMeshes){
    const mat=m.material as THREE.MeshStandardMaterial;
    m.visible=view.volumes&&!view.hidden.has(model.units[m.userData.unit].id);
    if(mat.transparent===view.cut){
      mat.transparent=!view.cut;
      mat.depthWrite=view.cut;
      mat.side=view.cut?THREE.DoubleSide:THREE.FrontSide;
      mat.needsUpdate=true;
    }
    mat.opacity=view.cut?1:.24;
    mat.clippingPlanes=planes;
  }
  for(const l of horizonLines){l.visible=view.horizons;(l.material as THREE.Material).clippingPlanes=planes}
  if(holeMesh){holeMesh.visible=view.boreholes;(holeMesh.material as THREE.Material).clippingPlanes=planes}
  for(const l of labels)l.visible=view.boreholes&&view.labels&&(!view.cut||clipPlane.distanceToPoint(l.position)>=0);
}

// ---------- UI ----------

const ui=document.createElement("div");
ui.className="ui";
ui.innerHTML=`<div class="title">GeoModel3D <span>${pkg.version.split(".").slice(0,2).join(".")}</span></div>
<div class="sub">Project-agnostic browser geological modelling engine</div>
<div class="panel">
  <select class="dataset" aria-label="Dataset"></select>
  <div class="desc"></div>
  <div class="stats"></div>
  <div class="legend"></div>
</div>
<div class="hint">Drag to orbit · wheel to zoom · right-drag to pan · drop CSV, AGS4 or JSON files to import</div>`;
app.appendChild(ui);
const datasetSelect=ui.querySelector<HTMLSelectElement>(".dataset")!;

const toolbar=document.createElement("div");
toolbar.className="toolbar";
toolbar.innerHTML=`<button class="import">Import data…</button>
<input class="file" type="file" multiple hidden accept=".csv,.tsv,.txt,.ags,.json">
<details class="menu"><summary>Export</summary><div>
  <button data-export="project">Project (JSON)</button>
  <button data-export="boreholes">Boreholes (CSV)</button>
  <button data-export="svg">Section (SVG)</button>
  <button data-export="section">Section (CSV)</button>
</div></details>
<div class="toggles">
  <label><input type="checkbox" data-view="volumes" checked>Volumes</label>
  <label><input type="checkbox" data-view="horizons" checked>Horizons</label>
  <label><input type="checkbox" data-view="boreholes" checked>Boreholes</label>
  <label><input type="checkbox" data-view="labels" checked>Labels</label>
  <label><input type="checkbox" data-view="cut">Cut at section</label>
  <label><input type="checkbox" data-view="flip">Keep other side</label>
</div>`;
app.appendChild(toolbar);
const fileInput=toolbar.querySelector<HTMLInputElement>(".file")!;

const controlsBar=document.createElement("div");
controlsBar.className="section-control";
controlsBar.innerHTML=`<span class="tag">SECTION</span>
<label>Azimuth<input type="range" class="azimuth" min="0" max="179" step="1"><output class="azimuth-out"></output></label>
<label>Offset<input type="range" class="offset" step="1"><output class="offset-out"></output></label>
<label>V.E.<input type="range" class="ve" min="1" max="10" step="0.5"><output class="ve-out"></output></label>
<button class="panel-toggle" aria-pressed="false">2-D section</button>`;
app.appendChild(controlsBar);
const azimuthInput=controlsBar.querySelector<HTMLInputElement>(".azimuth")!;
const offsetInput=controlsBar.querySelector<HTMLInputElement>(".offset")!;
const veInput=controlsBar.querySelector<HTMLInputElement>(".ve")!;
const panelToggle=controlsBar.querySelector<HTMLButtonElement>(".panel-toggle")!;

const sectionView=document.createElement("div");
sectionView.className="section-view";
sectionView.innerHTML=`<div class="section-head"><span class="section-name"></span><button data-export="svg">SVG</button><button data-export="section">CSV</button><button class="close" aria-label="Close section view">×</button></div><div class="section-body"></div>`;
app.appendChild(sectionView);
const sectionBody=sectionView.querySelector<HTMLDivElement>(".section-body")!;

const notice=document.createElement("div");
notice.className="notice";
notice.hidden=true;
app.appendChild(notice);
const tooltip=document.createElement("div");
tooltip.className="tooltip";
tooltip.hidden=true;
app.appendChild(tooltip);
const dropZone=document.createElement("div");
dropZone.className="drop";
dropZone.hidden=true;
dropZone.innerHTML="<div>Drop borehole files<br><span>CSV tables · AGS4 · GeoModel3D or Georeport3D JSON</span></div>";
app.appendChild(dropZone);

function renderPanel(){
  const projects=[...sampleProjects,...(imported?[imported]:[])];
  datasetSelect.innerHTML=projects.map((p,i)=>`<option value="${i}"${p===project?" selected":""}>${esc(i>=sampleProjects.length?"Imported: "+p.name:p.name)}</option>`).join("");
  ui.querySelector(".desc")!.textContent=project.description??"";
  const count=(n:number,what:string)=>`${n} ${what}${n===1?"":"s"}`;
  const stats=[count(model.boreholes.length,"borehole"),count(model.units.length,"unit"),count(model.horizons.length,"horizon")];
  if(model.triangles.length)stats.push(`footprint ${fmtArea(footprintArea(model))}`);
  if(project.crs)stats.push(esc(project.crs));
  ui.querySelector(".stats")!.innerHTML=stats.join(" · ");
  ui.querySelector(".legend")!.innerHTML=model.units.map((u,k)=>`<label title="${esc(u.name)}"><input type="checkbox" data-unit="${esc(u.id)}"${view.hidden.has(u.id)?"":" checked"}><i style="background:${u.color}"></i><span class="name">${esc(u.name)}</span><span class="vol">${model.triangles.length?fmtVolume(unitCubicMetres(model,k)):""}</span></label>`).join("");
}

function syncControls(){
  const [lo,hi]=offsetRange(model,view.azimuth);
  offsetInput.min=String(Math.floor(lo));
  offsetInput.max=String(Math.ceil(hi));
  view.offset=Math.min(Math.max(view.offset,Math.floor(lo)),Math.ceil(hi));
  azimuthInput.value=String(view.azimuth);
  offsetInput.value=String(Math.round(view.offset));
  veInput.value=String(view.ve);
  controlsBar.querySelector(".azimuth-out")!.textContent=String(view.azimuth).padStart(3,"0")+"°";
  controlsBar.querySelector(".offset-out")!.textContent=(view.offset>=0?"+":"")+Math.round(view.offset)+" m";
  controlsBar.querySelector(".ve-out")!.textContent="×"+view.ve;
  panelToggle.setAttribute("aria-pressed",String(view.panel));
  sectionView.hidden=!view.panel;
  updateViewOffset();
  toolbar.querySelector<HTMLInputElement>('[data-view="flip"]')!.disabled=!view.cut;
}

function renderSectionPanel(){
  if(!view.panel||!section)return;
  sectionView.querySelector(".section-name")!.textContent=`Section A–A′ · ${String(view.azimuth).padStart(3,"0")}° · ${view.offset>=0?"+":""}${Math.round(view.offset)} m`;
  sectionBody.innerHTML=sectionSvg(model,section,{width:sectionBody.clientWidth,height:sectionBody.clientHeight,theme:"dark",title:false,buffer:sectionBuffer});
}

function showNotice(title:string,lines:string[],error=false){
  if(!lines.length&&!error){notice.hidden=true;return}
  const shown=lines.slice(0,12);
  notice.className="notice"+(error?" error":"");
  notice.innerHTML=`<div class="notice-head"><b>${esc(title)}</b><button aria-label="Dismiss">×</button></div><ul>${shown.map(l=>`<li>${esc(l)}</li>`).join("")}${lines.length>shown.length?`<li>…and ${lines.length-shown.length} more</li>`:""}</ul>`;
  notice.hidden=false;
  notice.querySelector("button")!.onclick=()=>{notice.hidden=true};
}

function loadProject(p:GeoProject,importWarnings:string[]=[]){
  project=p;
  model=buildGeologicalModel(p);
  view.hidden.clear();
  buildContent();
  const b=modelBounds(model),height=Math.max(b.maxZ-b.minZ,1);
  view.ve=Math.min(10,Math.max(1,Math.round(extent/(height*3)*2)/2));
  view.azimuth=model.nodes.length>1?principalAzimuth(model):0;
  view.offset=0;
  view.labels=model.boreholes.length<=80;
  toolbar.querySelector<HTMLInputElement>('[data-view="labels"]')!.checked=view.labels;
  sectionBuffer=Math.max(extent*0.12,1);
  renderPanel();
  syncControls();
  updateSection();
  fitCamera();
  const warnings=[...importWarnings,...model.warnings];
  showNotice(`${p.name}: ${warnings.length} note${warnings.length===1?"":"s"}`,warnings);
}

async function importFileList(list:FileList|File[]){
  try{
    const files=await Promise.all([...list].map(async f=>({name:f.name,text:await f.text()})));
    const result=importFiles(files);
    imported=result.project;
    loadProject(result.project,result.warnings);
  }catch(err){
    showNotice("Import failed",[(err as Error).message],true);
  }
}

function download(name:string,text:string,type:string){
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([text],{type}));
  a.download=name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
function exportAs(kind:string){
  const slug=project.name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"geomodel3d";
  const tag=`${String(view.azimuth).padStart(3,"0")}-${view.offset>=0?"p":"m"}${Math.abs(Math.round(view.offset))}`;
  if(kind==="project")download(`${slug}.geomodel3d.json`,toProjectJson(project),"application/json");
  if(kind==="boreholes")download(`${slug}-boreholes.csv`,toBoreholeCsv(project),"text/csv");
  if(kind==="svg")download(`${slug}-section-${tag}.svg`,sectionSvg(model,section,{width:1600,height:900,theme:"light",legend:true,buffer:sectionBuffer}),"image/svg+xml");
  if(kind==="section")download(`${slug}-section-${tag}.csv`,sectionCsv(model,section),"text/csv");
}

datasetSelect.onchange=()=>{const i=Number(datasetSelect.value);loadProject(i<sampleProjects.length?sampleProjects[i]:imported!)};
toolbar.querySelector<HTMLButtonElement>(".import")!.onclick=()=>fileInput.click();
fileInput.onchange=()=>{if(fileInput.files?.length)importFileList(fileInput.files);fileInput.value=""};
app.addEventListener("click",e=>{
  const kind=(e.target as HTMLElement).closest<HTMLElement>("[data-export]")?.dataset.export;
  if(kind){exportAs(kind);toolbar.querySelector("details")!.open=false}
});
toolbar.querySelectorAll<HTMLInputElement>("[data-view]").forEach(input=>{
  input.onchange=()=>{
    const key=input.dataset.view as "volumes"|"horizons"|"boreholes"|"labels"|"cut"|"flip";
    view[key]=input.checked;
    if(key==="cut"||key==="flip")updateSection();else applyDisplay();
    syncControls();
  };
});
ui.querySelector(".legend")!.addEventListener("change",e=>{
  const input=e.target as HTMLInputElement,id=input.dataset.unit!;
  if(input.checked)view.hidden.delete(id);else view.hidden.add(id);
  applyDisplay();
});
let sectionQueued=false;
const queueSection=()=>{if(!sectionQueued){sectionQueued=true;requestAnimationFrame(()=>{sectionQueued=false;updateSection()})}};
azimuthInput.oninput=()=>{view.azimuth=Number(azimuthInput.value);syncControls();queueSection()};
offsetInput.oninput=()=>{view.offset=Number(offsetInput.value);syncControls();queueSection()};
veInput.oninput=()=>{view.ve=Number(veInput.value);syncControls();applyDisplay()};
panelToggle.onclick=()=>{view.panel=!view.panel;syncControls();renderSectionPanel()};
sectionView.querySelector<HTMLButtonElement>(".close")!.onclick=()=>{view.panel=false;syncControls()};

let dragDepth=0;
addEventListener("dragenter",e=>{if(e.dataTransfer?.types.includes("Files")){dragDepth++;dropZone.hidden=false}});
addEventListener("dragleave",()=>{if(--dragDepth<=0){dragDepth=0;dropZone.hidden=true}});
addEventListener("dragover",e=>e.preventDefault());
addEventListener("drop",e=>{e.preventDefault();dragDepth=0;dropZone.hidden=true;if(e.dataTransfer?.files.length)importFileList(e.dataTransfer.files)});

// ---------- hover ----------

const raycaster=new THREE.Raycaster();
let pointer:{x:number;y:number}|null=null,pointerMoved=false;
renderer.domElement.addEventListener("pointermove",e=>{pointer={x:e.clientX,y:e.clientY};pointerMoved=true});
renderer.domElement.addEventListener("pointerleave",()=>{pointer=null;tooltip.hidden=true});
function updateTooltip(){
  if(!pointerMoved)return;
  pointerMoved=false;
  if(!pointer){tooltip.hidden=true;return}
  raycaster.setFromCamera(new THREE.Vector2(pointer.x/innerWidth*2-1,-pointer.y/innerHeight*2+1),camera);
  const kept=(h:THREE.Intersection)=>!view.cut||clipPlane.distanceToPoint(h.point)>=-1e-6;
  let html="";
  if(holeMesh?.visible){
    const hit=raycaster.intersectObject(holeMesh).find(kept);
    if(hit&&hit.instanceId!==undefined){
      const info=holeInfo[hit.instanceId],bh=model.boreholes[info.hole],iv=bh.intervals[info.interval];
      const what=iv?`${esc(model.units.find(u=>u.id===iv.unit)?.name??iv.unit)} ${fmt(iv.from,1)}–${fmt(iv.to,1)} m`:"not logged";
      html=`<b>${esc(bh.id)}</b> · ${what}<span>collar ${fmt(bh.x,1)}, ${fmt(bh.y,1)} · ${fmt(bh.z,2)} m · final depth ${fmt(boreholeDepth(bh),1)} m</span>`;
    }
  }
  if(!html&&view.volumes){
    const hit=raycaster.intersectObjects(volumeMeshes.filter(m=>m.visible)).find(kept);
    if(hit){const k=hit.object.userData.unit;html=`<b>${esc(model.units[k].name)}</b><span>${fmtVolume(unitCubicMetres(model,k))} in the model</span>`}
  }
  tooltip.hidden=!html;
  if(html){
    tooltip.innerHTML=html;
    tooltip.style.left=Math.min(pointer.x+14,innerWidth-tooltip.offsetWidth-8)+"px";
    tooltip.style.top=Math.min(pointer.y+14,innerHeight-tooltip.offsetHeight-8)+"px";
  }
}

addEventListener("resize",()=>{
  camera.aspect=innerWidth/innerHeight;
  updateViewOffset();
  renderer.setSize(innerWidth,innerHeight);
  labelRenderer.setSize(innerWidth,innerHeight);
  renderSectionPanel();
});

loadProject(project);
renderer.setAnimationLoop(()=>{
  controls.update();
  if(view.cut&&updateCutSide())applyDisplay();
  updateTooltip();
  renderer.render(scene,camera);
  labelRenderer.render(scene,camera);
});
