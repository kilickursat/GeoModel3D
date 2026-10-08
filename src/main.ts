import * as THREE from "three/webgpu";
import {uniform,positionWorld,dot} from "three/tsl";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";
import {CSS2DRenderer,CSS2DObject} from "three/addons/renderers/CSS2DRenderer.js";
import pkg from "../package.json";
import {GeoProject,UnitDef,UnitRule,sampleProjects,realSites,boreholeDepth} from "./geology";
import {buildGeologicalModel,GeoModel,unitVolume,unitCubicMetres,modelBounds,footprintArea} from "./model";
import {volumeGeometry} from "./volume";
import {terrainOutside,convexHull,TerrainGrid} from "./terrain";
import {computeSection,offsetRange,principalAzimuth,Section} from "./section";
import {sectionSvg,sectionCsv,sectionFieldCsv} from "./sectionSvg";
import {importFiles,toProjectJson,toBoreholeCsv,toTestsCsv,decodeText,assignColors} from "./io";
import {SectionField,sectionField,availableFields,columnAt,stressAt,unitWeights,UnitWeight,withTheme,scaleLabel} from "./fields";
import {formatValue,propertyDef} from "./properties";
import {Crs,crsRegistry,projectCrs,findCrs,customCrs,searchCrs,suggestCrs,toProjected,toGeographic} from "./crs";
import {fetchTerrain,elevationSources,mapSources,covers,tileUrl,parseGsiTile,decodeTerrarium,mapTiles,tileXY,ElevationSource,TileSource} from "./tiles";
import {applyUnitRules} from "./rules";
import {reportHtml} from "./report";
import {openEditor} from "./editor";
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
// WebGPU wherever the browser offers it; the renderer falls back to WebGL 2 by itself, and ?backend=webgl forces it.
const wantWebGPU=new URLSearchParams(location.search).get("backend")!=="webgl";
const renderer=new THREE.WebGPURenderer({antialias:true,forceWebGL:!wantWebGPU});
await renderer.init();
const webgl="WebGL 2";
const backendName=(renderer.backend as {isWebGPUBackend?:boolean}).isWebGPUBackend?"WebGPU":webgl;
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setSize(innerWidth,innerHeight);
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
// The cut-away is a fragment mask shared by every clipped material, so it behaves the same on both backends.
// clipPlane mirrors it on the CPU for picking and label visibility.
const clipPlane=new THREE.Plane();
const cutOn=uniform(0),cutNormal=uniform(new THREE.Vector2(1,0)),cutConstant=uniform(0);
const keepFragment=cutOn.lessThan(0.5).or(dot(positionWorld.xy,cutNormal).add(cutConstant).greaterThanEqual(0));
// Frames are drawn only after something changes.
let dirty=2;
const invalidate=()=>{dirty=2};

let project:GeoProject=sampleProjects[0];
let imported:GeoProject|null=null;
let model:GeoModel;
let section:Section;
let origin={x:0,y:0,z:0},extent=1,sectionBuffer=1;
// `field` colours the section: "units", a stress (sv, u, s) or a measured property.
const view={azimuth:0,offset:0,ve:1,cut:true,flip:false,exact:false,volumes:true,horizons:true,boreholes:true,labels:true,terrain:true,map:false,mapSource:"osm",panel:innerWidth>760,hidden:new Set<string>(),field:"units"};
let field:SectionField|null=null,weights:UnitWeight[]=[];

interface UnitMaterials { lit:THREE.MeshStandardNodeMaterial; flat:THREE.MeshBasicNodeMaterial }
const volumeMeshes:Array<THREE.Mesh<THREE.BufferGeometry,THREE.Material>>=[];
const horizonLines:THREE.LineSegments[]=[];
let holeMesh:THREE.InstancedMesh|null=null;
let terrainMesh:THREE.Mesh|null=null;
let gridHelper:THREE.Object3D|null=null;
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
    const unit=o.userData.materials as UnitMaterials|undefined;
    if(unit){unit.lit.dispose();unit.flat.dispose()}
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
    const materials:UnitMaterials={
      lit:new THREE.MeshStandardNodeMaterial({color:u.color,roughness:.95,metalness:0,transparent:true,depthWrite:false,side:THREE.FrontSide}),
      flat:new THREE.MeshBasicNodeMaterial({color:u.color,transparent:true,depthWrite:false,side:THREE.FrontSide})
    };
    materials.lit.maskNode=keepFragment;
    materials.flat.maskNode=keepFragment;
    const mesh=new THREE.Mesh<THREE.BufferGeometry,THREE.Material>(geo,materials.lit);
    mesh.userData.unit=k;
    mesh.userData.materials=materials;
    volumeMeshes.push(mesh);
    content.add(mesh);
  });

  // Horizons are drawn along the edges of the borehole triangulation; a subdivided mesh would only add noise.
  model.horizons.forEach((h,k)=>{
    if(!model.triangles.length)return;
    const pos:number[]=[];
    for(const chain of model.edgeChains)for(let j=0;j<chain.length-1;j++){
      const a=chain[j],b=chain[j+1];
      pos.push(model.nodes[a].x-origin.x,model.nodes[a].y-origin.y,h.z[a]-origin.z,model.nodes[b].x-origin.x,model.nodes[b].y-origin.y,h.z[b]-origin.z);
    }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute("position",new THREE.Float32BufferAttribute(pos,3));
    const material=new THREE.LineBasicNodeMaterial({color:k===0?0xdfeaf0:0xffffff,transparent:true,opacity:k===0?.22:.07,depthWrite:false});
    material.maskNode=keepFragment;
    const line=new THREE.LineSegments(geo,material);
    horizonLines.push(line);
    content.add(line);
  });
  buildTerrain();

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
    const material=new THREE.MeshBasicNodeMaterial();
    material.maskNode=keepFragment;
    holeMesh=new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,1,10).rotateX(Math.PI/2),material,segments.length);
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
  gridHelper=grid;
  grid.rotation.x=Math.PI/2;
  grid.position.z=model.base-origin.z-(b.maxZ-b.minZ)*0.03;
  content.add(grid);
}
function niceCeil(v:number){const p=10**Math.floor(Math.log10(v));return Math.ceil(v/p)*p}

// The terrain grid around the model footprint: real data, clipped exactly at the footprint, drawn before the model
// and translucent so it never veils it, and cut with it. Without a terrain grid, a georeferenced model gets a flat
// plane at its collars' median elevation instead, shown only to carry the map.
function buildTerrain(){
  terrainMesh=null;
  const t=model.project.terrain,at=model.terrainAt;
  if(!model.triangles.length)return;
  const hull=convexHull(model.boreholes);
  let flat=false,surface:{positions:number[];index:number[]};
  if(t&&at)surface=terrainOutside(t,at,hull,extent*0.25);
  else if(projectCrs(model.project)){
    const zs=model.boreholes.map(b=>b.z).sort((p,q)=>p-q),z=zs[Math.floor(zs.length/2)];
    const b=modelBounds(model),m=extent*0.25,n=96;
    const grid:TerrainGrid={x0:b.minX-m,y0:b.minY-m,dx:(b.maxX-b.minX+2*m)/n,dy:(b.maxY-b.minY+2*m)/n,ncols:n+1,nrows:n+1,z:[]};
    surface=terrainOutside(grid,()=>z,hull,m);
    flat=true;
  }else return;
  const {positions,index}=surface;
  if(!index.length)return;
  const pos=new Float32Array(positions.length);
  for(let i=0;i<positions.length;i+=3){pos[i]=positions[i]-origin.x;pos[i+1]=positions[i+1]-origin.y;pos[i+2]=positions[i+2]-origin.z}
  const geo=new THREE.BufferGeometry();
  geo.setAttribute("position",new THREE.BufferAttribute(pos,3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const material=new THREE.MeshStandardNodeMaterial({color:0x5f6f66,roughness:1,metalness:0,transparent:true,opacity:.42,depthWrite:false});
  material.maskNode=keepFragment;
  terrainMesh=new THREE.Mesh(geo,material);
  terrainMesh.userData.plain=material;
  terrainMesh.userData.flat=flat;
  terrainMesh.renderOrder=-1;
  content.add(terrainMesh);
}

// ---------- real-world placement: coordinate system, terrain and map ----------

// Bundled public datasets fetch their terrain and map when opened. Imported data may be confidential, so nothing is
// requested from tile servers for them until the user asks.
const publicSites=new Set<GeoProject>(realSites);
// Sites whose logs start partly at a harbour or river bed: fetched terrain, the water surface there, would be wrong.
const loggedGround=new Set<GeoProject>(realSites.filter(p=>p.boreholes.some(b=>b.z<-10)&&!p.terrain));
let geoStatus="";
interface MapLayer { key:string; texture:THREE.CanvasTexture; z:number; x0:number; y0:number; nx:number; ny:number; source:TileSource; failed:number }
let mapLayer:MapLayer|null=null;
const mapMaterials:THREE.Material[]=[];

function siteBox(){const b=modelBounds(model),m=extent*0.25;return {minX:b.minX-m,minY:b.minY-m,maxX:b.maxX+m,maxY:b.maxY+m}}
function siteCentre(crs:Crs){const b=modelBounds(model);return toGeographic(crs,(b.minX+b.maxX)/2,(b.minY+b.maxY)/2)}
function setGeoStatus(text:string){geoStatus=text;const el=toolbar.querySelector(".geo-status");if(el)el.textContent=text}

async function loadElevationTile(s:ElevationSource,z:number,x:number,y:number){
  const r=await fetch(tileUrl(s,z,x,y));
  if(!r.ok)return null;
  if(s.format==="gsi")return parseGsiTile(await r.text());
  const bitmap=await createImageBitmap(await r.blob(),{colorSpaceConversion:"none",premultiplyAlpha:"none"});
  const canvas=document.createElement("canvas");
  canvas.width=canvas.height=256;
  const ctx=canvas.getContext("2d",{willReadFrequently:true})!;
  ctx.drawImage(bitmap,0,0);
  return decodeTerrarium(ctx.getImageData(0,0,256,256).data);
}

async function fetchSiteTerrain(){
  const crs=projectCrs(project);
  if(!crs){showNotice("Terrain",["Choose the coordinate system of the data first: terrain is fetched by geographic position."],true);return}
  const target=project,c=siteCentre(crs);
  const sources=elevationSources.filter(s=>covers(s,c.lon,c.lat));
  setGeoStatus("Fetching terrain…");
  try{
    const terrain=await fetchTerrain(crs,siteBox(),sources,loadElevationTile);
    if(project!==target)return;
    target.terrain=terrain;
    setGeoStatus("");
    loadProject(target,[`Terrain: ${terrain.source}; ${terrain.ncols} × ${terrain.nrows} cells of ${fmt(terrain.dx,1)} m`],true);
  }catch(e){
    if(project!==target)return;
    setGeoStatus("");
    showNotice("Terrain could not be fetched",[(e as Error).message,"The model uses the surface through the collars."],true);
  }
}

// The basemap is drawn on the terrain around the model: tiles composed into one texture, and each terrain vertex
// mapped to it through its geographic position.
async function updateMap(){
  const crs=projectCrs(project),mesh=terrainMesh;
  if(!view.map||!crs||!mesh){applyMap(null);renderCredits();return}
  const source=mapSources.find(s=>s.id===view.mapSource)??mapSources[0];
  const t=mapTiles(crs,siteBox(),source);
  const key=`${project.name}|${source.id}|${t.z}/${t.x0}/${t.y0}/${t.x1}/${t.y1}`;
  if(mapLayer?.key!==key){
    const nx=t.x1-t.x0+1,ny=t.y1-t.y0+1,canvas=document.createElement("canvas");
    canvas.width=nx*256;canvas.height=ny*256;
    const ctx=canvas.getContext("2d")!;
    setGeoStatus(`Loading map: ${nx*ny} tiles…`);
    let failed=0;
    const jobs:Promise<void>[]=[];
    for(let y=t.y0;y<=t.y1;y++)for(let x=t.x0;x<=t.x1;x++)jobs.push((async()=>{
      const img=new Image();
      img.crossOrigin="anonymous";
      img.src=tileUrl(source,t.z,x,y);
      try{await img.decode();ctx.drawImage(img,(x-t.x0)*256,(y-t.y0)*256)}catch{failed++}
    })());
    await Promise.all(jobs);
    if(mesh!==terrainMesh||!view.map)return;
    mapLayer?.texture.dispose();
    const texture=new THREE.CanvasTexture(canvas);
    texture.colorSpace=THREE.SRGBColorSpace;
    texture.anisotropy=8;
    mapLayer={key,texture,z:t.z,x0:t.x0,y0:t.y0,nx,ny,source,failed};
    setGeoStatus(failed===nx*ny?"Map tiles could not be loaded":failed?`${failed} of ${nx*ny} map tiles missing`:"");
  }
  applyMap(mapLayer);
  applyDisplay();
}
function applyMap(layer:MapLayer|null){
  const mesh=terrainMesh,crs=projectCrs(project);
  if(!mesh)return;
  if(!layer||!crs){mesh.material=mesh.userData.plain;invalidate();return}
  const pos=mesh.geometry.getAttribute("position"),uv=new Float32Array(pos.count*2);
  for(let i=0;i<pos.count;i++){
    const g=toGeographic(crs,pos.getX(i)+origin.x,pos.getY(i)+origin.y),t=tileXY(g.lon,g.lat,layer.z);
    uv[i*2]=(t.x-layer.x0)/layer.nx;uv[i*2+1]=1-(t.y-layer.y0)/layer.ny;
  }
  mesh.geometry.setAttribute("uv",new THREE.BufferAttribute(uv,2));
  const material=new THREE.MeshStandardNodeMaterial({map:layer.texture,roughness:1,metalness:0,transparent:true,opacity:.9,depthWrite:false});
  material.maskNode=keepFragment;
  mapMaterials.splice(0).forEach(m=>m.dispose());
  mapMaterials.push(material);
  mesh.material=material;
  invalidate();
}

// Changing the coordinate system places boreholes that carry latitude and longitude again; for data given only in
// project coordinates it declares what those coordinates are.
function setProjectCrs(crs:Crs){
  const known=crs.code&&findCrs(crs.code);
  const placed=project.boreholes.some(b=>b.lon!==undefined&&b.lat!==undefined);
  const next:GeoProject={...project,crs:crs.name,crsCode:known?crs.code:undefined,crsProj4:known?undefined:crs.proj4,
    boreholes:project.boreholes.map(b=>b.lon!==undefined&&b.lat!==undefined?{...b,...toProjected(crs,b.lon,b.lat)}:b)};
  const notes=[`Coordinate system: ${crs.name}${crs.code?` (${crs.code})`:""}${crs.note?`. ${crs.note}`:""}`];
  if(placed&&next.terrain){delete next.terrain;notes.push("The terrain grid was in the previous system and was removed; fetch it again")}
  if(!placed)notes.push("No borehole carries latitude and longitude, so coordinates are unchanged: this declares the system they are in");
  imported=next;
  loadProject(next,notes);
}

function creditTexts(){
  const parts:string[]=[];
  if(view.map&&mapLayer&&projectCrs(project))parts.push(`Map ${mapLayer.source.attribution}`);
  if(project.terrain?.source&&view.terrain)parts.push(`Terrain ${project.terrain.source}`);
  if(project.source)parts.push(`Data ${project.source}`);
  return parts;
}
function renderCredits(){
  const parts:string[]=[];
  if(view.map&&mapLayer&&projectCrs(project))parts.push(`Map <a href="${mapLayer.source.link}" target="_blank" rel="noopener">${esc(mapLayer.source.attribution)}</a>`);
  if(project.terrain?.source&&view.terrain)parts.push(`Terrain ${esc(project.terrain.source)}`);
  if(project.source)parts.push(`Data ${esc(project.source)}`);
  credits.innerHTML=parts.join(" · ");
  credits.hidden=!parts.length;
}
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
  invalidate();
}

// ---------- section ----------

const fence=new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicNodeMaterial({vertexColors:true,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1}));
const fenceLines=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicNodeMaterial({color:0x0b1620,transparent:true,opacity:.75}));
const outline=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicNodeMaterial({color:0x78c9df,transparent:true,opacity:.55}));
const endLabels=["A","A′"].map(t=>{const el=document.createElement("div");el.className="end-label";el.textContent=t;const l=new CSS2DObject(el);l.center.set(0.5,1.2);return l});
const waterLine=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicNodeMaterial({color:0x5aa9ff,transparent:true,opacity:.95}));
sectionGroup.add(fence,fenceLines,outline,waterLine,...endLabels);

function updateSection(){
  section=computeSection(model,{azimuth:view.azimuth,offset:view.offset},sectionBuffer);
  field=view.field==="units"?null:sectionField(model,section,view.field);
  const s=section,n=s.s.length,lines:number[]=[];
  const p=(j:number,z:number)=>[s.x[j]-origin.x,s.y[j]-origin.y,z-origin.z];
  fence.geometry.dispose();
  fence.geometry=field?fieldFence(field):unitFence();
  s.z.forEach(z=>{for(let j=0;j<n-1;j++)lines.push(...p(j,z[j]),...p(j+1,z[j+1]))});
  fenceLines.geometry.dispose();
  fenceLines.geometry=new THREE.BufferGeometry();
  fenceLines.geometry.setAttribute("position",new THREE.Float32BufferAttribute(lines,3));
  const water:number[]=[];
  if(s.water)for(let j=0;j<n-1;j++)if(Number.isFinite(s.water[j])&&Number.isFinite(s.water[j+1]))water.push(...p(j,s.water[j]),...p(j+1,s.water[j+1]));
  waterLine.geometry.dispose();
  waterLine.geometry=new THREE.BufferGeometry();
  waterLine.geometry.setAttribute("position",new THREE.Float32BufferAttribute(water,3));
  outline.geometry.dispose();
  outline.geometry=new THREE.BufferGeometry();
  if(n>1){
    const top=Math.max(...s.z[0])+(Math.max(...s.z[0])-model.base)*0.04;
    outline.geometry.setAttribute("position",new THREE.Float32BufferAttribute([...p(0,model.base),...p(n-1,model.base),...p(n-1,top),...p(0,top),...p(0,model.base)],3));
    endLabels[0].position.set(...(p(0,top) as [number,number,number]));
    endLabels[1].position.set(...(p(n-1,top) as [number,number,number]));
  }
  endLabels.forEach(l=>l.visible=n>1);
  renderFieldLegend();
  cutSide=0;
  updateCutSide();
  applyDisplay();
  renderSectionPanel();
}
// The section face in unit colours: one quad strip per unit between consecutive section samples.
function unitFence(){
  const s=section,n=s.s.length,pos:number[]=[],col:number[]=[],c=new THREE.Color();
  const p=(j:number,z:number)=>[s.x[j]-origin.x,s.y[j]-origin.y,z-origin.z];
  model.units.forEach((u,k)=>{
    if(view.hidden.has(u.id))return;
    c.set(u.color);
    for(let j=0;j<n-1;j++){
      const t0=s.z[k][j],b0=s.z[k+1][j],t1=s.z[k][j+1],b1=s.z[k+1][j+1];
      if(t0-b0<1e-9&&t1-b1<1e-9)continue;
      for(const v of [p(j,t0),p(j,b0),p(j+1,b1),p(j,t0),p(j+1,b1),p(j+1,t1)]){pos.push(...v);col.push(c.r,c.g,c.b)}
    }
  });
  const g=new THREE.BufferGeometry();
  g.setAttribute("position",new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute("color",new THREE.Float32BufferAttribute(col,3));
  return g;
}
// The section face coloured by a field: a grid per unit that follows the unit's top and base, with the value at each
// grid node taken just inside the unit, so properties change sharply at unit boundaries.
function fieldFence(f:SectionField){
  const s=section,K=model.units.length,scale=withTheme(f.scale,true),nodata=new THREE.Color(0x26343e),c=new THREE.Color();
  const s0=s.s[0],s1=s.s[s.s.length-1],cols=[...new Set([...s.s,...Array.from({length:161},(_,i)=>s0+(s1-s0)*i/160)])].sort((a,b)=>a-b);
  const columns=cols.map(d=>({d,c:columnAt(s,d)!})).filter(q=>q.c);
  const zmax=Math.max(...s.z[0]),dz=Math.max((zmax-model.base)/90,1e-3),eps=dz*1e-3;
  const pos:number[]=[],col:number[]=[],index:number[]=[];
  model.units.forEach((u,k)=>{
    if(view.hidden.has(u.id))return;
    const thick=Math.max(...columns.map(q=>q.c.z[k]-q.c.z[k+1]));
    if(thick<1e-9)return;
    const rows=Math.max(1,Math.ceil(thick/dz)),first=pos.length/3;
    for(const {d,c:col0} of columns)for(let r=0;r<=rows;r++){
      const top=col0.z[k],bottom=col0.z[k+1],e=top-(top-bottom)*r/rows;
      pos.push(col0.x-origin.x,col0.y-origin.y,e-origin.z);
      const v=top-bottom<1e-9?NaN:f.at(d,Math.min(top-eps,Math.max(bottom+eps,e)));
      const hex=scale.colorOf(v);
      if(hex)c.set(hex);else c.copy(nodata);
      col.push(c.r,c.g,c.b);
    }
    for(let i=0;i<columns.length-1;i++)for(let r=0;r<rows;r++){
      const a=first+i*(rows+1)+r,b=a+1,a2=a+rows+1,b2=a2+1;
      index.push(a,b,b2,a,b2,a2);
    }
  });
  const g=new THREE.BufferGeometry();
  g.setAttribute("position",new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute("color",new THREE.Float32BufferAttribute(col,3));
  g.setIndex(index);
  return g;
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
  cutNormal.value.set(clipPlane.normal.x,clipPlane.normal.y);
  cutConstant.value=clipPlane.constant;
  return true;
}

// ---------- display state ----------

function applyDisplay(){
  world.scale.set(1,1,view.ve);
  cutOn.value=view.cut?1:0;
  for(const m of volumeMeshes){
    const {lit,flat}=m.userData.materials as UnitMaterials;
    m.material=view.exact?flat:lit;
    m.visible=view.volumes&&!view.hidden.has(model.units[m.userData.unit].id);
    for(const mat of [lit,flat]){
      if(mat.transparent===view.cut){
        mat.transparent=!view.cut;
        mat.depthWrite=view.cut;
        mat.side=view.cut?THREE.DoubleSide:THREE.FrontSide;
        mat.needsUpdate=true;
      }
      mat.opacity=view.cut?1:.24;
    }
  }
  for(const l of horizonLines)l.visible=view.horizons;
  if(holeMesh)holeMesh.visible=view.boreholes;
  if(terrainMesh)terrainMesh.visible=terrainMesh.userData.flat?view.map&&!!mapLayer:view.terrain;
  for(const l of labels)l.visible=view.boreholes&&view.labels&&(!view.cut||clipPlane.distanceToPoint(l.position)>=0);
  renderCredits();
  invalidate();
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
  <label class="crs">Coordinates <input class="crs-input" list="crs-options" placeholder="EPSG code, system or country" spellcheck="false" autocomplete="off"></label>
  <datalist id="crs-options"></datalist>
  <div class="legend"></div>
  <details class="rules"><summary>Unit rules</summary><div class="rule-list"></div>
    <div class="rule-actions"><button class="add-rule">Add rule</button><button class="apply-rules">Apply</button></div><div class="rule-note"></div></details>
</div>
<div class="hint">Drag to orbit · wheel to zoom · right-drag to pan · drop CSV, AGS4, borehole XML or JSON files to import</div>`;
app.appendChild(ui);
const datasetSelect=ui.querySelector<HTMLSelectElement>(".dataset")!;

const toolbar=document.createElement("div");
toolbar.className="toolbar";
toolbar.innerHTML=`<button class="import">Import data…</button>
<button class="edit-data" title="Type in or paste boreholes, logs, water levels, SPT and laboratory results, and unit properties">Edit data…</button>
<input class="file" type="file" multiple hidden accept=".csv,.tsv,.txt,.ags,.json,.xml,.asc,.xyz">
<details class="menu"><summary>Export</summary><div>
  <button data-export="project">Project (JSON)</button>
  <button data-export="boreholes">Boreholes (CSV)</button>
  <button data-export="tests">Tests (CSV)</button>
  <button data-export="svg">Section (SVG)</button>
  <button data-export="section">Section (CSV)</button>
  <button data-export="field" title="The values of the field shown on the section, on a grid">Section field (CSV)</button>
  <button data-export="report-A3" title="Opens the print dialog: choose Save as PDF">Report (PDF, A3)</button>
  <button data-export="report-A4" title="Opens the print dialog: choose Save as PDF">Report (PDF, A4)</button>
</div></details>
<div class="toggles">
  <label><input type="checkbox" data-view="volumes" checked>Volumes</label>
  <label><input type="checkbox" data-view="horizons" checked>Horizons</label>
  <label><input type="checkbox" data-view="boreholes" checked>Boreholes</label>
  <label><input type="checkbox" data-view="labels" checked>Labels</label>
  <label><input type="checkbox" data-view="terrain" checked>Terrain</label>
  <label title="Needs the coordinate system of the data; map tiles are requested from the map's server"><input type="checkbox" data-view="map">Map</label>
  <label><input type="checkbox" data-view="cut" checked>Cut at section</label>
  <label><input type="checkbox" data-view="flip">Keep other side</label>
  <label title="Unlit legend colours: what you see is the legend colour, independent of lighting"><input type="checkbox" data-view="exact">Exact colours</label>
</div>
<div class="geo"><select class="map-source" aria-label="Map"></select><button class="fetch-terrain" title="Elevation tiles are requested for the area around the model">Fetch terrain</button><div class="geo-status" aria-live="polite"></div></div>
<div class="backend">Renderer: ${backendName}${wantWebGPU&&backendName!=="WebGPU"?" (WebGPU unavailable here)":` · <a href="?backend=${backendName==="WebGPU"?"webgl":"webgpu"}">use ${backendName==="WebGPU"?webgl:"WebGPU"}</a>`}</div>`;
app.appendChild(toolbar);
const fileInput=toolbar.querySelector<HTMLInputElement>(".file")!;

const controlsBar=document.createElement("div");
controlsBar.className="section-control";
controlsBar.innerHTML=`<span class="tag">SECTION</span>
<label>Azimuth<input type="range" class="azimuth" min="0" max="179" step="1"><output class="azimuth-out"></output></label>
<label>Offset<input type="range" class="offset" step="1"><output class="offset-out"></output></label>
<label>V.E.<input type="range" class="ve" min="1" max="10" step="0.5"><output class="ve-out"></output></label>
<label class="field-pick" title="Colour the section by unit, by a stress, or by a measured property interpolated within each unit">Colour<select class="field-select" aria-label="Colour the section by"></select></label>
<button class="panel-toggle" aria-pressed="false">2-D section</button>`;
app.appendChild(controlsBar);
const azimuthInput=controlsBar.querySelector<HTMLInputElement>(".azimuth")!;
const offsetInput=controlsBar.querySelector<HTMLInputElement>(".offset")!;
const veInput=controlsBar.querySelector<HTMLInputElement>(".ve")!;
const panelToggle=controlsBar.querySelector<HTMLButtonElement>(".panel-toggle")!;
const fieldSelect=controlsBar.querySelector<HTMLSelectElement>(".field-select")!;

const sectionView=document.createElement("div");
sectionView.className="section-view";
sectionView.innerHTML=`<div class="section-head"><span class="section-name"></span><button data-export="svg">SVG</button><button data-export="section">CSV</button><button class="close" aria-label="Close section view">×</button></div><div class="section-body"></div>`;
app.appendChild(sectionView);
const sectionBody=sectionView.querySelector<HTMLDivElement>(".section-body")!;

const notice=document.createElement("div");
notice.className="notice";
notice.hidden=true;
app.appendChild(notice);
const credits=document.createElement("div");
credits.className="credits";
credits.hidden=true;
app.appendChild(credits);
const fieldLegend=document.createElement("div");
fieldLegend.className="field-legend";
fieldLegend.hidden=true;
app.appendChild(fieldLegend);
const tooltip=document.createElement("div");
tooltip.className="tooltip";
tooltip.hidden=true;
app.appendChild(tooltip);
const dropZone=document.createElement("div");
dropZone.className="drop";
dropZone.hidden=true;
dropZone.innerHTML="<div>Drop borehole or terrain files<br><span>CSV tables · AGS4 · Japanese borehole XML (電子納品, KuniJiban) · GeoModel3D or Georeport3D JSON · terrain grid (.asc, .xyz)</span></div>";
app.appendChild(dropZone);

function renderPanel(){
  const projects=[...sampleProjects,...(imported?[imported]:[])];
  datasetSelect.innerHTML=projects.map((p,i)=>`<option value="${i}"${p===project?" selected":""}>${esc(i>=sampleProjects.length?"Imported: "+p.name:p.name)}</option>`).join("");
  ui.querySelector(".desc")!.textContent=project.description??"";
  const count=(n:number,what:string)=>`${n} ${what}${n===1?"":"s"}`;
  const stats=[count(model.boreholes.length,"borehole"),count(model.units.length,"unit"),count(model.horizons.length,"horizon")];
  if(model.triangles.length)stats.push(`footprint ${fmtArea(footprintArea(model))}`);
  if(project.terrain)stats.push(`terrain ${fmt(project.terrain.dx,1)} m grid`);
  ui.querySelector(".stats")!.innerHTML=stats.join(" · ");
  const crs=projectCrs(project),input=ui.querySelector<HTMLInputElement>(".crs-input")!;
  input.value=crs?`${crs.code?crs.code+" · ":""}${crs.name}`:project.crs??"";
  input.title=crs?.note??(crs?"":"Not georeferenced: choose the coordinate system the data are in to fetch terrain and show a map");
  // Systems suggested for the site come first when its geographic position is known.
  const placed=project.boreholes.find(b=>b.lon!==undefined&&b.lat!==undefined);
  const first=placed?suggestCrs(placed.lon!,placed.lat!):crs?.code&&findCrs(crs.code)?[findCrs(crs.code)!]:[];
  ui.querySelector("#crs-options")!.innerHTML=[...first,...crsRegistry.filter(e=>!first.includes(e))].map(e=>`<option value="${esc(e.code+" · "+e.name)}">${esc(e.region)}</option>`).join("");
  const sources=crs?mapSources.filter(m=>{const c=siteCentre(crs);return covers(m,c.lon,c.lat)}):mapSources.slice(0,1);
  if(!sources.some(m=>m.id===view.mapSource))view.mapSource=sources[0].id;
  const mapSelect=toolbar.querySelector<HTMLSelectElement>(".map-source")!;
  mapSelect.innerHTML=sources.map(m=>`<option value="${m.id}"${m.id===view.mapSource?" selected":""}>${esc(m.name)}</option>`).join("");
  mapSelect.disabled=!crs;
  toolbar.querySelector<HTMLInputElement>('[data-view="map"]')!.disabled=!crs;
  toolbar.querySelector<HTMLInputElement>('[data-view="map"]')!.checked=view.map;
  toolbar.querySelector<HTMLButtonElement>(".fetch-terrain")!.disabled=!crs;
  renderRules();
  ui.querySelector(".legend")!.innerHTML=model.units.map((u,k)=>{
    const title=[u.name,u.erosive?"Erosive base: cuts down into older units":"",unitProperties(u)].filter(Boolean).join("\n");
    return `<label title="${esc(title)}"><input type="checkbox" data-unit="${esc(u.id)}"${view.hidden.has(u.id)?"":" checked"}><i style="background:${u.color}"></i><span class="name">${esc(u.name)}</span>${u.erosive?'<span class="tag">erosive</span>':""}<span class="vol">${model.triangles.length?fmtVolume(unitCubicMetres(model,k)):""}</span></label>`;
  }).join("");
}
function unitProperties(u:UnitDef){
  const p=[u.gamma!==undefined?`γ ${fmt(u.gamma,1)} kN/m³`:"",u.gammaSat!==undefined?`γsat ${fmt(u.gammaSat,1)} kN/m³`:""].filter(Boolean).join(" · ");
  return p&&u.source?`${p} (${u.source})`:p;
}

// ---------- unit rules ----------

const ruleList=ui.querySelector<HTMLDivElement>(".rule-list")!;
const ruleRow=(r:Partial<UnitRule>)=>`<div class="rule"><div class="rule-main"><input class="r-match" value="${esc(r.match??"")}" placeholder="description matches" title="A regular expression tested against the logged description" spellcheck="false" aria-label="Description matches">
<span>→</span><input class="r-unit" list="unit-options" value="${esc(r.unit??"")}" placeholder="unit" aria-label="Unit"><button class="r-del" aria-label="Remove rule">×</button></div>
<div class="rule-if"><label>N ≥<input class="r-minN" type="number" step="any" value="${r.minN??""}"></label><label>N &lt;<input class="r-maxN" type="number" step="any" value="${r.maxN??""}"></label>
<label title="Elevation of the top of the interval, m">top ≥<input class="r-minZ" type="number" step="any" value="${r.minZ??""}"></label><label>&lt;<input class="r-maxZ" type="number" step="any" value="${r.maxZ??""}"></label></div></div>`;
function renderRules(){
  const box=ui.querySelector<HTMLDetailsElement>(".rules")!;
  box.hidden=!project.rules;
  if(!project.rules)return;
  box.querySelector("summary")!.textContent=`Unit rules (${project.rules.length})`;
  ruleList.innerHTML=project.rules.map(ruleRow).join("")+`<datalist id="unit-options">${project.units.map(u=>`<option value="${esc(u.id)}">${esc(u.name)}</option>`).join("")}</datalist>`;
  const {unmatched}=applyUnitRules(project.boreholes,project.rules);
  const names=new Set(project.boreholes.flatMap(b=>b.intervals.map(i=>i.name).filter(Boolean)));
  box.querySelector(".rule-note")!.textContent=`${names.size} logged descriptions. The first rule that matches a description, its median N-value and the elevation of its top gives the unit.`+
    (unmatched.size?` No rule matches: ${[...unmatched].slice(0,12).map(([n,c])=>`${n} (${c})`).join(", ")}${unmatched.size>12?"…":""}`:"");
}
function readRules():UnitRule[]{
  const num=(row:Element,c:string)=>{const v=(row.querySelector(c) as HTMLInputElement).value.trim();return v===""?undefined:Number(v)};
  return [...ruleList.querySelectorAll(".rule")].map(row=>{
    const r:UnitRule={match:(row.querySelector(".r-match") as HTMLInputElement).value.trim(),unit:(row.querySelector(".r-unit") as HTMLInputElement).value.trim()};
    for(const k of ["minN","maxN","minZ","maxZ"] as const){const v=num(row,".r-"+k);if(v!==undefined&&Number.isFinite(v))r[k]=v}
    return r;
  }).filter(r=>r.match&&r.unit);
}
// New units go to the bottom of the column; units no interval uses any more are dropped.
function applyRules(){
  const rules=readRules();
  const {boreholes,unmatched}=applyUnitRules(project.boreholes,rules);
  const used=new Set(boreholes.flatMap(b=>b.intervals.map(i=>i.unit)));
  const kept=project.units.filter(u=>used.has(u.id)),added=[...used].filter(id=>!kept.some(u=>u.id===id));
  const notes=[`${rules.length} unit rules applied`];
  if(added.length)notes.push(`New units added at the bottom of the column: ${added.join(", ")}`);
  if(unmatched.size)notes.push(`Descriptions that no rule assigns to a unit are modelled as units of their own: ${[...unmatched].map(([n,c])=>`${n} (${c})`).join(", ")}`);
  const next:GeoProject={...project,rules,boreholes,units:assignColors([...kept.map(u=>({...u})),...added.map(id=>({id,name:id,color:""}))])};
  imported=next;
  loadProject(next,notes,true);
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
  invalidate();
}

function renderSectionPanel(){
  if(!view.panel||!section)return;
  sectionView.querySelector(".section-name")!.textContent=`Section A–A′ · ${String(view.azimuth).padStart(3,"0")}° · ${view.offset>=0?"+":""}${Math.round(view.offset)} m`;
  sectionBody.innerHTML=sectionSvg(model,section,{width:sectionBody.clientWidth,height:sectionBody.clientHeight,theme:"dark",title:false,buffer:sectionBuffer,hidden:view.hidden,field:field??undefined});
}

// The fields offered for this model, and the colour key of the one shown.
function renderFieldOptions(){
  const fields=availableFields(model);
  if(!fields.some(f=>f.key===view.field))view.field="units";
  fieldSelect.innerHTML=`<option value="units">Units</option>`+fields.map(f=>`<option value="${esc(f.key)}"${f.key===view.field?" selected":""}>${esc(f.label)}</option>`).join("");
  fieldSelect.value=view.field;
}
function renderFieldLegend(){
  fieldLegend.hidden=!field;
  if(!field)return;
  const scale=withTheme(field.scale,true);
  fieldLegend.innerHTML=`<div class="fl-title">${esc(field.name)} <b>${esc(field.symbol)}</b>${field.unit?` (${esc(field.unit)})`:""}</div>
<div class="fl-bar">${scale.colors.map(c=>`<i style="background:${c}"></i>`).join("")}</div>
<div class="fl-ticks">${[0,Math.round(scale.colors.length/2),scale.colors.length].map(i=>`<span>${esc(scaleLabel(scale,scale.edges[i]))}</span>`).join("")}</div>
<div class="fl-notes">${field.notes.map(n=>`<div>${esc(n)}</div>`).join("")}</div>`;
}

function showNotice(title:string,lines:string[],error=false){
  if(!lines.length&&!error){notice.hidden=true;return}
  const shown=lines.length>12?lines.slice(0,10):lines,rest=lines.slice(shown.length);
  const list=(l:string[])=>`<ul>${l.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`;
  notice.className="notice"+(error?" error":"");
  notice.innerHTML=`<div class="notice-head"><b>${esc(title)}</b><button aria-label="Dismiss">×</button></div>${list(shown)}${rest.length?`<details><summary>${rest.length} more</summary>${list(rest)}</details>`:""}`;
  notice.hidden=false;
  notice.querySelector("button")!.onclick=()=>{notice.hidden=true};
}

let currentNotes:string[]=[];
// keepView rebuilds the same site (new terrain or rules) without moving the camera or resetting the controls.
function loadProject(p:GeoProject,importWarnings:string[]=[],keepView=false){
  const before={...origin};
  project=p;
  model=buildGeologicalModel(p);
  weights=unitWeights(model);
  if(!keepView){view.hidden.clear();view.field="units"}
  renderFieldOptions();
  buildContent();
  if(keepView){
    const shift=new THREE.Vector3(before.x-origin.x,before.y-origin.y,(before.z-origin.z)*view.ve);
    camera.position.add(shift);controls.target.add(shift);controls.update();
  }else{
    const b=modelBounds(model),height=Math.max(b.maxZ-b.minZ,1);
    // Enough exaggeration to read the layers, but not so much that real terrain turns into spikes.
    view.ve=Math.min(5,Math.max(1,Math.round(extent/(height*3)*2)/2));
    view.azimuth=model.nodes.length>1?principalAzimuth(model):0;
    view.offset=0;
    view.labels=model.boreholes.length<=40;
    toolbar.querySelector<HTMLInputElement>('[data-view="labels"]')!.checked=view.labels;
    view.map=publicSites.has(p)&&!!projectCrs(p);
  }
  sectionBuffer=Math.max(extent*0.12,1);
  renderPanel();
  syncControls();
  updateSection();
  if(!keepView)fitCamera();
  const warnings=[...importWarnings,...model.warnings];
  currentNotes=warnings;
  showNotice(`${p.name}: ${warnings.length} note${warnings.length===1?"":"s"}`,warnings);
  if(publicSites.has(p)&&!loggedGround.has(p)&&!p.terrain&&projectCrs(p)&&!keepView)void fetchSiteTerrain();
  void updateMap();
}

async function importFileList(list:FileList|File[]){
  try{
    const files=await Promise.all([...list].map(async f=>({name:f.name,text:decodeText(new Uint8Array(await f.arrayBuffer()))})));
    const result=importFiles(files,project);
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
  if(kind==="tests")download(`${slug}-tests.csv`,toTestsCsv(project),"text/csv");
  if(kind==="svg")download(`${slug}-section-${tag}.svg`,sectionSvg(model,section,{width:1600,height:900,theme:"light",legend:true,buffer:sectionBuffer,roundVe:true,hidden:view.hidden,field:field??undefined}),"image/svg+xml");
  if(kind==="section")download(`${slug}-section-${tag}.csv`,sectionCsv(model,section),"text/csv");
  if(kind==="field"){
    if(field)download(`${slug}-section-${tag}-${field.key}.csv`,sectionFieldCsv(model,section,field),"text/csv");
    else showNotice("Section field",["Choose a field under Colour on the section bar first: a stress or a measured property."],true);
  }
  if(kind.startsWith("report-"))void printReport(kind==="report-A4"?"A4":"A3");
}

// The 3-D view as a PNG: rendered on white without the grid or the room kept for the section panel, and cropped
// to the model. A blank capture, as a renderer may give, is left out.
function captureView(){
  const background=scene.background;
  scene.background=new THREE.Color(0xffffff);
  camera.clearViewOffset();
  if(gridHelper)gridHelper.visible=false;
  let url:string|undefined;
  try{
    renderer.render(scene,camera);
    url=cropToContent(renderer.domElement);
  }catch{url=undefined}
  if(gridHelper)gridHelper.visible=true;
  scene.background=background;
  updateViewOffset();
  invalidate();
  return url;
}
function cropToContent(source:HTMLCanvasElement,maxWidth=2400){
  const w=source.width,h=source.height,full=document.createElement("canvas");
  full.width=w;full.height=h;
  const ctx=full.getContext("2d",{willReadFrequently:true})!;
  ctx.drawImage(source,0,0);
  const px=ctx.getImageData(0,0,w,h).data;
  let x0=w,y0=h,x1=-1,y1=-1;
  for(let y=0;y<h;y+=2)for(let x=0;x<w;x+=2){
    const i=(y*w+x)*4;
    if(px[i]<245||px[i+1]<245||px[i+2]<245){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y}
  }
  if(x1<0)return undefined;
  const pad=Math.round(Math.max(x1-x0,y1-y0)*0.03);
  x0=Math.max(0,x0-pad);y0=Math.max(0,y0-pad);x1=Math.min(w-1,x1+pad);y1=Math.min(h-1,y1+pad);
  const scale=Math.min(1,maxWidth/(x1-x0+1)),out=document.createElement("canvas");
  out.width=Math.round((x1-x0+1)*scale);out.height=Math.round((y1-y0+1)*scale);
  out.getContext("2d")!.drawImage(full,x0,y0,x1-x0+1,y1-y0+1,0,0,out.width,out.height);
  return out.toDataURL("image/png");
}
// The report is printed from a hidden frame; the print dialog's "Save as PDF" makes the file.
async function printReport(paper:"A3"|"A4"){
  const html=reportHtml(model,section,{paper,image:captureView(),date:new Date().toISOString().slice(0,10),version:pkg.version,
    credits:creditTexts(),notes:currentNotes,sectionBuffer,ve:view.ve,hidden:view.hidden,field:field??undefined});
  const frame=document.createElement("iframe");
  frame.className="print-frame";
  frame.setAttribute("aria-hidden","true");
  document.body.appendChild(frame);
  await new Promise<void>(resolve=>{frame.onload=()=>resolve();frame.srcdoc=html});
  const doc=frame.contentDocument!;
  await Promise.all([...doc.images].map(img=>img.decode().catch(()=>undefined)));
  frame.contentWindow!.focus();
  frame.contentWindow!.print();
  setTimeout(()=>frame.remove(),60_000);
}

datasetSelect.onchange=()=>{const i=Number(datasetSelect.value);loadProject(i<sampleProjects.length?sampleProjects[i]:imported!)};
toolbar.querySelector<HTMLButtonElement>(".import")!.onclick=()=>fileInput.click();
toolbar.querySelector<HTMLButtonElement>(".edit-data")!.onclick=()=>openEditor(project,{download,onApply:r=>{imported=r.project;loadProject(r.project,r.warnings)}});
fileInput.onchange=()=>{if(fileInput.files?.length)importFileList(fileInput.files);fileInput.value=""};
app.addEventListener("click",e=>{
  const kind=(e.target as HTMLElement).closest<HTMLElement>("[data-export]")?.dataset.export;
  if(kind){exportAs(kind);toolbar.querySelector("details")!.open=false}
});
toolbar.querySelectorAll<HTMLInputElement>("[data-view]").forEach(input=>{
  input.onchange=()=>{
    const key=input.dataset.view as "volumes"|"horizons"|"boreholes"|"labels"|"terrain"|"map"|"cut"|"flip"|"exact";
    view[key]=input.checked;
    if(key==="cut"||key==="flip")updateSection();else applyDisplay();
    if(key==="map")void updateMap();
    syncControls();
  };
});
ui.querySelector(".legend")!.addEventListener("change",e=>{
  const input=e.target as HTMLInputElement,id=input.dataset.unit!;
  if(input.checked)view.hidden.delete(id);else view.hidden.add(id);
  updateSection();
});
toolbar.querySelector<HTMLSelectElement>(".map-source")!.onchange=e=>{view.mapSource=(e.target as HTMLSelectElement).value;void updateMap()};
toolbar.querySelector<HTMLButtonElement>(".fetch-terrain")!.onclick=()=>void fetchSiteTerrain();
ui.querySelector<HTMLInputElement>(".crs-input")!.onchange=e=>{
  const value=(e.target as HTMLInputElement).value.trim();
  try{
    const code=value.match(/EPSG:\d+/i)?.[0];
    const found=value.startsWith("+")?customCrs(value):code?findCrs(code):searchCrs(value,2).length===1?searchCrs(value,2)[0]:undefined;
    if(!found)throw new Error(`No coordinate system matches “${value}”. Type an EPSG code or part of a name, or paste a PROJ definition.`);
    setProjectCrs(found);
  }catch(err){showNotice("Coordinate system",[(err as Error).message],true);renderPanel()}
};
ui.querySelector(".add-rule")!.addEventListener("click",()=>ruleList.insertAdjacentHTML("beforeend",ruleRow({})));
ui.querySelector(".apply-rules")!.addEventListener("click",applyRules);
ruleList.addEventListener("click",e=>{const b=(e.target as HTMLElement).closest(".r-del");if(b)b.closest(".rule")!.remove()});
let sectionQueued=false;
const queueSection=()=>{if(!sectionQueued){sectionQueued=true;requestAnimationFrame(()=>{sectionQueued=false;updateSection()})}};
azimuthInput.oninput=()=>{view.azimuth=Number(azimuthInput.value);syncControls();queueSection()};
offsetInput.oninput=()=>{view.offset=Number(offsetInput.value);syncControls();queueSection()};
veInput.oninput=()=>{view.ve=Number(veInput.value);syncControls();applyDisplay()};
panelToggle.onclick=()=>{view.panel=!view.panel;syncControls();renderSectionPanel()};
fieldSelect.onchange=()=>{view.field=fieldSelect.value;updateSection()};
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
      const what=iv?`${esc(model.units.find(u=>u.id===iv.unit)?.name??iv.unit)} ${fmt(iv.from,2)}–${fmt(iv.to,2)} m`:"not logged";
      const spt=iv?(bh.spt??[]).filter(t=>t.depth>=iv.from&&t.depth<iv.to).map(t=>t.penetration>=300?String(t.blows):`${t.blows}/${fmt(t.penetration/10)} cm`):[];
      const logged=[iv?.name&&iv.name!==iv.unit?esc(iv.name):"",spt.length?`N ${spt.join(", ")}`:""].filter(Boolean).join(" · ");
      const water=bh.water?.length?` · water ${fmt(Math.min(...bh.water.map(w=>w.depth)),2)} m deep`:"";
      const where=bh.lat!==undefined&&bh.lon!==undefined?` (${fmt(bh.lat,5)}°, ${fmt(bh.lon,5)}°)`:"";
      html=`<b>${esc(bh.id)}</b> · ${what}${logged?`<span>${logged}</span>`:""}<span>collar E ${fmt(bh.x,1)} N ${fmt(bh.y,1)}${where} · ${fmt(bh.z,2)} m · final depth ${fmt(boreholeDepth(bh),1)} m${water}</span>`;
    }
  }
  // The section face, or a unit volume in front of it.
  const faceHit=sectionGroup.visible?raycaster.intersectObject(fence)[0]:undefined;
  const volumeHit=view.volumes?raycaster.intersectObjects(volumeMeshes.filter(m=>m.visible)).find(kept):undefined;
  if(!html&&faceHit&&(!volumeHit||faceHit.distance<=volumeHit.distance+1e-6)){
    const along=(faceHit.point.x+origin.x-section.origin.x)*section.dir.x+(faceHit.point.y+origin.y-section.origin.y)*section.dir.y;
    html=sectionReadout(along,faceHit.point.z/view.ve+origin.z);
  }
  if(!html&&view.volumes){
    const hit=volumeHit;
    if(hit){
      const u=model.units[hit.object.userData.unit],props=unitProperties(u);
      html=`<b>${esc(u.name)}</b>${u.erosive?" · erosive base":""}<span>${fmtVolume(unitCubicMetres(model,hit.object.userData.unit))} in the model · elevation ${fmt(hit.point.z/view.ve+origin.z,1)} m</span>${props?`<span>${esc(props)}</span>`:""}`;
    }
  }
  if(!html&&terrainMesh?.visible){
    const hit=raycaster.intersectObject(terrainMesh).find(kept);
    if(hit)html=terrainMesh.userData.flat?`<b>Map</b><span>drawn at the collars' median elevation, ${fmt(hit.point.z/view.ve+origin.z,1)} m: there is no terrain grid</span>`
      :`<b>Terrain</b> · ${fmt(hit.point.z/view.ve+origin.z,2)} m<span>${esc(project.terrain?.source??"terrain grid")}, outside the model</span>`;
  }
  tooltip.hidden=!html;
  if(html){
    tooltip.innerHTML=html;
    tooltip.style.left=Math.min(pointer.x+14,innerWidth-tooltip.offsetWidth-8)+"px";
    tooltip.style.top=Math.min(pointer.y+14,innerHeight-tooltip.offsetHeight-8)+"px";
  }
}

// What the section shows at a point: the unit, its depth, the stresses there and the field's value.
function sectionReadout(along:number,e:number){
  const c=columnAt(section,along);
  if(!c)return "";
  let k=-1;
  for(let i=0;i<model.units.length;i++)if(e<=c.z[i]+1e-6&&e>=c.z[i+1]-1e-6&&c.z[i]-c.z[i+1]>1e-9){k=i;break}
  if(k<0)return "";
  const st=stressAt(c.z,c.water,weights,e),assumed=weights.some(w=>w.source==="assumed");
  let html=`<b>${esc(model.units[k].name)}</b> · ${fmt(c.z[0]-e,1)} m deep, elevation ${fmt(e,1)} m`;
  if(st)html+=`<span>σv ${fmt(st.sv)} kPa · u ${fmt(st.u)} kPa · σ′v ${fmt(st.s)} kPa${assumed?" (some unit weights assumed)":""}</span>`;
  if(field&&!["sv","u","s"].includes(field.key)){
    const v=field.at(along,e),p=propertyDef(field.key);
    html+=`<span>${esc(p.symbol)} ${Number.isFinite(v)?`${formatValue(field.key,field.log?10**v:v)}${p.unit?" "+esc(p.unit):""}, interpolated`:"not measured in this unit"}</span>`;
  }
  return html;
}
sectionBody.addEventListener("pointermove",e=>{
  const svg=sectionBody.querySelector("svg"),frame=svg?.dataset.frame?.split(",").map(Number);
  if(!svg||!frame){tooltip.hidden=true;return}
  const [l,t,pw,ph,s0,s1,z0,z1]=frame,r=svg.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
  const html=x>=l&&x<=l+pw&&y>=t&&y<=t+ph?sectionReadout(s0+(x-l)/pw*(s1-s0),z1-(y-t)/ph*(z1-z0)):"";
  tooltip.hidden=!html;
  if(html){
    tooltip.innerHTML=html;
    tooltip.style.left=Math.min(e.clientX+14,innerWidth-tooltip.offsetWidth-8)+"px";
    tooltip.style.top=Math.max(8,Math.min(e.clientY-tooltip.offsetHeight-10,innerHeight-tooltip.offsetHeight-8))+"px";
  }
});
sectionBody.addEventListener("pointerleave",()=>{tooltip.hidden=true});

addEventListener("resize",()=>{
  camera.aspect=innerWidth/innerHeight;
  updateViewOffset();
  renderer.setSize(innerWidth,innerHeight);
  labelRenderer.setSize(innerWidth,innerHeight);
  renderSectionPanel();
  invalidate();
});

controls.addEventListener("change",invalidate);
loadProject(project);
renderer.setAnimationLoop(()=>{
  controls.update();
  updateTooltip();
  if(!dirty)return;
  dirty--;
  if(view.cut&&updateCutSide())applyDisplay();
  renderer.render(scene,camera);
  labelRenderer.render(scene,camera);
});
