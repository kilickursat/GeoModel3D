import * as THREE from "three/webgpu";
import {uniform,positionWorld,dot} from "three/tsl";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";
import {CSS2DRenderer,CSS2DObject} from "three/addons/renderers/CSS2DRenderer.js";
import pkg from "../package.json";
import {GeoProject,UnitDef,UnitRule,Alignment,Cpt,sampleProjects,realSites,boreholeDepth,cptDepth} from "./geology";
import {buildGeologicalModel,GeoModel,unitVolume,unitCubicMetres,modelBounds,footprintArea,sampleModel} from "./model";
import {volumeGeometry} from "./volume";
import {terrainOutside,convexHull,TerrainGrid} from "./terrain";
import {computeSection,offsetRange,offsetThrough,principalAzimuth,Section,sectionRuns,joined,alongOf} from "./section";
import {sectionSvg,sectionCsv,sectionFieldCsv,sectionTitle,chainageCsv,cptTraceWidths} from "./sectionSvg";
import {importFiles,toProjectJson,toBoreholeCsv,toTestsCsv,toCsv,decodeText,assignColors,toAlignmentCsv,toCptCsv} from "./io";
import {cptAt,thinned,cptScale} from "./cpt";
import {cptLogSvg,CptBand} from "./cptSvg";
import {alignmentSection,chainages,pointAt,designAt,crossSectionAt,lineCrossings,Crossing} from "./alignment";
import {XY} from "./tin";
import {SectionField,sectionField,availableFields,columnAt,stressAt,unitWeights,UnitWeight,withTheme,scaleLabel,colourScale,ColourScale} from "./fields";
import {formatValue,propertyDef} from "./properties";
import {Crs,crsRegistry,projectCrs,findCrs,customCrs,searchCrs,suggestCrs,toProjected,toGeographic} from "./crs";
import {fetchTerrain,elevationSources,mapSources,covers,tileUrl,parseGsiTile,decodeTerrarium,mapTiles,tileXY,ElevationSource,TileSource} from "./tiles";
import {applyUnitRules} from "./rules";
import {reportHtml} from "./report";
import {createInputWorkspace} from "./input";
import {crossValidation,CrossValidation} from "./validation";
import {arModel,toGlb,toUsdz,quickLookAvailable} from "./ar";
import {COMPACT,COMPACT_SIDE,Rect,viewShift,fitAngle,segmentDistance} from "./layout";
import "./style.css";

const app=document.querySelector<HTMLDivElement>("#app")!;
const esc=(s:string)=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]!));
const fmt=(v:number,d=0)=>v.toLocaleString("en-US",{maximumFractionDigits:d,minimumFractionDigits:d});
const fmtVolume=(v:number)=>v>=1e6?fmt(v/1e6,2)+" M m³":fmt(v)+" m³";
const fmtArea=(v:number)=>v>=1e4?fmt(v/1e4,2)+" ha":fmt(v)+" m²";
// Phones and small tablets get the compact layout (see layout.ts); on its side, its sheets open from the left.
const compactQuery=matchMedia(COMPACT),sideQuery=matchMedia(COMPACT_SIDE),touchQuery=matchMedia("(pointer: coarse)");
const compact=()=>compactQuery.matches;
const calm=matchMedia("(prefers-reduced-motion: reduce)");

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
// `field` colours the section: "units", a stress (sv, u, s) or a measured property. `alignment` is the line the section
// follows, an index into the project's alignments, or -1 for a straight section by azimuth and offset; `chainage` is
// the marker on that line, and `step` the step of its table by chainage.
const view={azimuth:0,offset:0,ve:1,cut:true,flip:false,exact:false,volumes:true,horizons:true,boreholes:true,cpts:true,labels:true,terrain:true,map:false,mapSource:"osm",panel:!compact(),hidden:new Set<string>(),field:"units",alignment:-1,chainage:0,step:10};
let field:SectionField|null=null,weights:UnitWeight[]=[];

interface UnitMaterials { lit:THREE.MeshStandardNodeMaterial; flat:THREE.MeshBasicNodeMaterial }
const volumeMeshes:Array<THREE.Mesh<THREE.BufferGeometry,THREE.Material>>=[];
const horizonLines:THREE.LineSegments[]=[];
let holeMesh:THREE.InstancedMesh|null=null;
let terrainMesh:THREE.Mesh|null=null;
let gridHelper:THREE.Object3D|null=null;
let holeInfo:Array<{hole:number;interval:number}>=[];
// CPTs: an axis each, and the cone resistance drawn out from it on a panel that turns about the axis to face the camera.
let cptAxes:THREE.InstancedMesh|null=null;
const cptPanels:THREE.Group[]=[],cptFills:THREE.Mesh[]=[];
// The cross-validation of the model shown, the run in progress (a new model or Stop ends it), and its markers.
let validation:CrossValidation|null=null,validationRun=0,errorMarkers:THREE.InstancedMesh|null=null,errorRims:THREE.InstancedMesh|null=null,errorMarked:string[]=[],showErrors=true;
const lowerFirst=(s:string)=>s.charAt(0).toLowerCase()+s.slice(1);
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
  cptAxes?.dispose();
  cptAxes=null;
  cptPanels.length=0;
  cptFills.length=0;
  errorMarkers?.dispose();
  errorRims?.dispose();
  errorMarkers=errorRims=null;
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
  buildCpts(radius);

  const size=niceCeil(extent*1.35),grid=new THREE.GridHelper(size,10,0x31505d,0x193039);
  gridHelper=grid;
  grid.rotation.x=Math.PI/2;
  grid.position.z=model.base-origin.z-(b.maxZ-b.minZ)*0.03;
  content.add(grid);
}
function niceCeil(v:number){const p=10**Math.floor(Math.log10(v));return Math.ceil(v/p)*p}
// Each CPT: a thin axis from its start to its deepest reading, and its cone resistance as a filled outline out to the
// right of it, 3.5 % of the model's extent at the full scale, on a panel turned to face the camera (faceCpts).
function buildCpts(radius:number){
  const cpts=model.cpts;
  if(!cpts.length)return;
  const qcMax=cptScale(Math.max(...cpts.flatMap(c=>c.qc.filter(Number.isFinite)),1)),k=extent*0.035/qcMax;
  const height=Math.max(...cpts.map(c=>cptDepth(c)),1),step=Math.max(0.05,height/800);
  const fill=new THREE.MeshBasicNodeMaterial({color:0xd6e6ee,side:THREE.DoubleSide});
  const edge=new THREE.LineBasicNodeMaterial({color:0x0b1620});
  fill.maskNode=keepFragment;
  edge.maskNode=keepFragment;
  cptAxes=new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,1,8).rotateX(Math.PI/2),new THREE.MeshBasicNodeMaterial({color:0xd6e6ee}),cpts.length);
  (cptAxes.material as THREE.MeshBasicNodeMaterial).maskNode=keepFragment;
  const m=new THREE.Matrix4(),q=new THREE.Quaternion(),r=radius*0.55;
  cpts.forEach((c,i)=>{
    const bottom=c.z-cptDepth(c);
    cptAxes!.setMatrixAt(i,m.compose(local(c.x,c.y,(c.z+bottom)/2),q,new THREE.Vector3(r,r,Math.max(c.z-bottom,0.02))));
    // The outline and the strip between it and the axis, in the panel's plane: x across, z up.
    const keep=thinned(c,step),line:number[]=[],strip:number[]=[];
    let prev:{u:number;e:number}|null=null;
    for(const j of keep){
      const v=c.qc[j],e=c.z-c.depth[j]-origin.z;
      if(!Number.isFinite(v)){prev=null;continue}
      const u=Math.max(v,0)*k;
      if(prev){
        line.push(prev.u,0,prev.e,u,0,e);
        strip.push(0,0,prev.e,prev.u,0,prev.e,u,0,e,0,0,prev.e,u,0,e,0,0,e);
      }
      prev={u,e};
    }
    const panel=new THREE.Group();
    panel.position.copy(local(c.x,c.y,origin.z));
    const g=new THREE.BufferGeometry();
    g.setAttribute("position",new THREE.Float32BufferAttribute(strip,3));
    const mesh=new THREE.Mesh(g,fill);
    mesh.userData.cpt=i;
    const outlineGeometry=new THREE.BufferGeometry();
    outlineGeometry.setAttribute("position",new THREE.Float32BufferAttribute(line,3));
    panel.add(mesh,new THREE.LineSegments(outlineGeometry,edge));
    cptPanels.push(panel);
    cptFills.push(mesh);
    content.add(panel);
    const el=document.createElement("div");
    el.className="bh-label cpt-label";
    el.textContent=c.id;
    const label=new CSS2DObject(el);
    label.position.copy(local(c.x,c.y,c.z));
    label.center.set(0.5,1.3);
    label.userData.cpt=i;
    labels.push(label);
    content.add(label);
  });
  cptAxes.instanceMatrix.needsUpdate=true;
  content.add(cptAxes);
  facing=NaN;
  faceCpts();
}
// The CPT panels turn about their axes to face the camera, so the cone resistance reads from any side.
let facing=NaN;
function faceCpts(){
  if(!cptPanels.length)return false;
  camera.updateMatrixWorld();
  const right=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,0),a=Math.atan2(right.y,right.x);
  if(Math.abs(a-facing)<1e-6)return false;
  facing=a;
  for(const p of cptPanels)p.rotation.z=a;
  return true;
}

// The terrain grid around the model footprint: real data, clipped exactly at the footprint, drawn before the model
// and translucent so it never veils it, and cut with it. Without a terrain grid, a georeferenced model gets a flat
// plane at its collars' median elevation instead, shown only to carry the map.
function buildTerrain(){
  terrainMesh=null;
  const t=model.project.terrain,at=model.terrainAt;
  if(!model.triangles.length)return;
  const hull=convexHull(model.nodes);
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
  material.userData.opacity=.42;
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
  material.userData.opacity=.9;
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
// The view is drawn shifted, and on small screens shrunk, so that the model sits in the part of the screen the panels
// leave free. When a panel opens or closes it glides there for a moment, timed by the clock, so a slow device takes
// fewer, longer steps rather than more frames; a new model, a new window size and the report capture place it at once.
interface Shift { x:number; y:number; k:number }
const shift:Shift={x:0,y:0,k:1},GLIDE=220;
let glide:{from:Shift;to:Shift;t0:number}|null=null;
function updateViewOffset(now=false){
  const to=targetShift(),aim=glide?.to??shift;
  if(now||calm.matches){glide=null;Object.assign(shift,to);applyShift();return}
  if(Math.abs(to.x-aim.x)<0.5&&Math.abs(to.y-aim.y)<0.5&&Math.abs(to.k-aim.k)<1e-3)return;
  glide={from:{...shift},to,t0:performance.now()};
  invalidate();
}
function applyShift(){
  camera.setViewOffset(innerWidth*shift.k,innerHeight*shift.k,shift.x,shift.y,innerWidth,innerHeight);
  invalidate();
}
// One step of the glide, run every frame while it lasts.
function stepShift(){
  if(!glide)return;
  const t=Math.min(1,(performance.now()-glide.t0)/GLIDE),e=1-(1-t)**3,{from,to}=glide;
  shift.x=from.x+(to.x-from.x)*e;shift.y=from.y+(to.y-from.y)*e;shift.k=from.k+(to.k-from.k)*e;
  if(t>=1)glide=null;
  applyShift();
}
function targetShift(){
  // Wide screens: away from the section view at the bottom right.
  if(!compact()){
    const open=view.panel;
    return {x:open?sectionView.offsetWidth*0.14:0,y:open?sectionView.offsetHeight*0.32:0,k:1};
  }
  const room=compactRoom(),free={...room};
  free.y0+=bars.notice;
  if(sideQuery.matches)free.x0+=bars.sheetW;else free.y1-=bars.sheetH;
  const r=sectionView.getBoundingClientRect();
  if(view.panel&&r.width>0){
    if(sideQuery.matches)free.x1=Math.min(free.x1,r.left-8);else free.y0=Math.max(free.y0,r.bottom+6);
  }
  return viewShift(innerWidth,innerHeight,free,room);
}
// The room the model has on a small screen with no panel open: between the title bar and the bar at the bottom.
function compactRoom():Rect{return {x0:0,y0:bars.top,x1:innerWidth,y1:innerHeight-bars.dock}}

function fitCamera(){
  const b=modelBounds(model),ve=view.ve;
  const box=new THREE.Box3(new THREE.Vector3(b.minX-origin.x,b.minY-origin.y,(b.minZ-origin.z)*ve),new THREE.Vector3(b.maxX-origin.x,b.maxY-origin.y,(b.maxZ-origin.z)*ve));
  const sphere=box.getBoundingSphere(new THREE.Sphere());
  // On a small screen the model fits the room between the bars, by its width where that is the narrower side.
  const fov=THREE.MathUtils.degToRad(camera.fov),radius=Math.max(sphere.radius,extent/2),room=compactRoom();
  const dist=compact()?radius/Math.sin(fitAngle(fov,room.x1-room.x0,room.y1-room.y0,innerHeight))*1.02:radius/Math.sin(fov/2)*1.1;
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(new THREE.Vector3(0.62,-1.1,0.72).normalize(),dist);
  camera.near=dist/500;
  camera.far=dist*30;
  updateViewOffset(true);
  sun.position.copy(sphere.center).add(new THREE.Vector3(0.45,-0.7,1).multiplyScalar(dist));
  controls.update();
  invalidate();
}

// ---------- section ----------

const fence=new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicNodeMaterial({vertexColors:true,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1}));
const fenceLines=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicNodeMaterial({color:0x0b1620,transparent:true,opacity:.75}));
const outline=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicNodeMaterial({color:0x78c9df,transparent:true,opacity:.55}));
const lineFrame=new THREE.LineSegments(new THREE.BufferGeometry(),outline.material);
const endLabels=["A","A′"].map(t=>{const el=document.createElement("div");el.className="end-label";el.textContent=t;const l=new CSS2DObject(el);l.center.set(0.5,1.2);return l});
const waterLine=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicNodeMaterial({color:0x5aa9ff,transparent:true,opacity:.95}));
// Along an alignment: its design levels (a band from crown to invert, or a line), labels of its chainage along the
// ground, and a marker at the chainage chosen.
const designBand=new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicNodeMaterial({color:0xffffff,transparent:true,opacity:.3,side:THREE.DoubleSide,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));
const designLines=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicNodeMaterial({color:0xffffff}));
const markerLine=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicNodeMaterial({color:0x78c9df}));
const markerLabel=(()=>{const el=document.createElement("div");el.className="end-label";const l=new CSS2DObject(el);l.center.set(0.5,1.2);return l})();
let chainageLabels:CSS2DObject[]=[];
// On a straight section, where the project's lines cross it: their design levels on the section face, and their names.
const crossLines=new THREE.LineSegments(new THREE.BufferGeometry(),designLines.material);
let crossings:Crossing[]=[];
sectionGroup.add(fence,fenceLines,outline,lineFrame,waterLine,designBand,designLines,markerLine,markerLabel,crossLines,...endLabels);

// The line the section follows, when it is an alignment. The cut applies to straight sections only: along a line the
// units are drawn see-through around the section.
const lineOf=():Alignment|undefined=>view.alignment>=0?project.alignments?.[view.alignment]:undefined;
const cutting=()=>view.cut&&!lineOf()&&!drawing;
const positions=(g:{geometry:THREE.BufferGeometry},list:number[])=>{
  g.geometry.dispose();
  g.geometry=new THREE.BufferGeometry();
  g.geometry.setAttribute("position",new THREE.Float32BufferAttribute(list,3));
};
// The top of the frame drawn around the section, a little above its highest ground.
const frameTop=()=>{const z=Math.max(...section.z[0]);return z+(z-model.base)*0.04};

function updateSection(){
  const line=lineOf();
  section=line?alignmentSection(model,line,sectionBuffer):computeSection(model,{azimuth:view.azimuth,offset:view.offset},sectionBuffer);
  field=view.field==="units"?null:sectionField(model,section,view.field);
  const s=section,n=s.s.length,lines:number[]=[];
  const p=(j:number,z:number)=>[s.x[j]-origin.x,s.y[j]-origin.y,z-origin.z];
  fence.geometry.dispose();
  fence.geometry=field?fieldFence(field):unitFence();
  s.z.forEach(z=>{for(let j=0;j<n-1;j++)if(joined(s,j))lines.push(...p(j,z[j]),...p(j+1,z[j+1]))});
  positions(fenceLines,lines);
  const water:number[]=[];
  if(s.water)for(let j=0;j<n-1;j++)if(joined(s,j)&&Number.isFinite(s.water[j])&&Number.isFinite(s.water[j+1]))water.push(...p(j,s.water[j]),...p(j+1,s.water[j+1]));
  positions(waterLine,water);
  // A frame around the section, above its ground: a rectangle for a straight section; along a line, around each
  // stretch of it inside the model, following the line.
  const rectangle:number[]=[],frame:number[]=[];
  if(n>1){
    const top=frameTop();
    if(!line)rectangle.push(...p(0,model.base),...p(n-1,model.base),...p(n-1,top),...p(0,top),...p(0,model.base));
    else for(const [a,b] of sectionRuns(s)){
      if(b<=a)continue;
      frame.push(...p(a,model.base),...p(a,top),...p(b,model.base),...p(b,top));
      for(let j=a;j<b;j++)frame.push(...p(j,model.base),...p(j+1,model.base),...p(j,top),...p(j+1,top));
    }
    endLabels[0].position.set(...(p(0,top) as [number,number,number]));
    endLabels[1].position.set(...(p(n-1,top) as [number,number,number]));
  }
  positions(outline,rectangle);
  positions(lineFrame,frame);
  endLabels.forEach(l=>l.visible=n>1&&!line);
  drawLine();
  renderFieldLegend();
  cutSide=0;
  updateCutSide();
  applyDisplay();
  renderSectionPanel();
}
// A round step, 1, 2 or 5 times a power of ten, about `v`.
function roundStep(v:number){const p=10**Math.floor(Math.log10(Math.max(v,1e-9))),f=v/p;return (f<1.5?1:f<3.5?2:f<7.5?5:10)*p}
// The design levels of the line on the section face, its chainage along the ground, and the marker.
function drawLine(){
  const line=lineOf(),s=section,band:number[]=[],edges:number[]=[];
  chainageLabels.forEach(l=>{sectionGroup.remove(l);l.element.remove()});
  chainageLabels=[];
  if(line&&s.alignment){
    const ch=s.alignment.s,P=(c:number,z:number)=>{const q=pointAt(line,c,ch);return [q.x-origin.x,q.y-origin.y,z-origin.z]};
    const d=line.design??[];
    if(d.length>1){
      // At the design levels and at the bends between them, so the band follows the line in plan.
      const at=[...new Set([...d.map(q=>q.chainage),...ch.filter(c=>c>d[0].chainage&&c<d[d.length-1].chainage)])].sort((a,b)=>a-b).map(c=>({c,...designAt(d,c)}));
      for(let i=0;i+1<at.length;i++){
        const a=at[i],b=at[i+1];
        if(a.top===undefined||b.top===undefined)continue;
        edges.push(...P(a.c,a.top),...P(b.c,b.top));
        if(a.bottom===undefined||b.bottom===undefined)continue;
        edges.push(...P(a.c,a.bottom),...P(b.c,b.bottom));
        band.push(...P(a.c,a.top),...P(a.c,a.bottom),...P(b.c,b.bottom),...P(a.c,a.top),...P(b.c,b.bottom),...P(b.c,b.top));
      }
      for(const e of [at[0],at[at.length-1]])if(e.top!==undefined&&e.bottom!==undefined)edges.push(...P(e.c,e.top),...P(e.c,e.bottom));
    }
    // Labels at round chainages along the ground, about eight of them.
    const c0=ch[0],c1=ch[ch.length-1],step=roundStep((c1-c0)/8);
    for(let i=Math.ceil(c0/step-1e-9);i*step<=c1+1e-9;i++){
      const col=columnAt(s,i*step);
      if(!col)continue;
      const el=document.createElement("div");
      el.className="ch-label";
      el.textContent=fmt(i*step);
      const l=new CSS2DObject(el);
      l.center.set(0.5,1.25);
      l.position.set(col.x-origin.x,col.y-origin.y,col.z[0]-origin.z);
      chainageLabels.push(l);
      sectionGroup.add(l);
    }
  }
  // A straight section crossed by lines: a bar from invert to crown, a mark at a single level, or a line up the face.
  crossings=line?[]:lineCrossings(s,project.alignments??[]);
  const cross:number[]=[],top=s.s.length>1?frameTop():0,mark=(top-model.base)*0.015;
  for(const c of crossings){
    const at=(z:number)=>[c.x-origin.x,c.y-origin.y,z-origin.z];
    const [z0,z1]=c.top!==undefined&&c.bottom!==undefined?[c.bottom,c.top]:c.top!==undefined?[c.top-mark,c.top+mark]:[model.base,top];
    cross.push(...at(z0),...at(z1));
    const el=document.createElement("div");
    el.className="ch-label";
    el.textContent=`${c.name} · ${fmt(c.chainage)}`;
    const l=new CSS2DObject(el);
    l.center.set(0.5,1.25);
    l.position.set(...(at(z1) as [number,number,number]));
    chainageLabels.push(l);
    sectionGroup.add(l);
  }
  positions(crossLines,cross);
  positions(designBand,band);
  positions(designLines,edges);
  placeMarker();
}
function placeMarker(){
  const col=lineOf()&&section?.alignment?columnAt(section,view.chainage):null,list:number[]=[];
  if(col){
    const top=frameTop();
    list.push(col.x-origin.x,col.y-origin.y,model.base-origin.z,col.x-origin.x,col.y-origin.y,top-origin.z);
    markerLabel.position.set(col.x-origin.x,col.y-origin.y,top-origin.z);
    markerLabel.element.textContent=fmt(view.chainage,view.chainage%1?1:0);
  }
  positions(markerLine,list);
  markerLabel.visible=!!col;
  invalidate();
}
// The section face in unit colours: one quad strip per unit between consecutive section samples.
function unitFence(){
  const s=section,n=s.s.length,pos:number[]=[],col:number[]=[],c=new THREE.Color();
  const p=(j:number,z:number)=>[s.x[j]-origin.x,s.y[j]-origin.y,z-origin.z];
  model.units.forEach((u,k)=>{
    if(view.hidden.has(u.id))return;
    c.set(u.color);
    for(let j=0;j<n-1;j++){
      if(!joined(s,j))continue;
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
  // Where the line leaves the model between two columns, they are not joined.
  const link=columns.map((q,i)=>i+1<columns.length&&!!columnAt(s,(q.d+columns[i+1].d)/2));
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
    for(let i=0;i<columns.length-1;i++)if(link[i])for(let r=0;r<rows;r++){
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
  if(!section||!cutting())return false;
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
  const cut=cutting();
  cutOn.value=cut?1:0;
  for(const m of volumeMeshes){
    const {lit,flat}=m.userData.materials as UnitMaterials;
    m.material=view.exact?flat:lit;
    m.visible=view.volumes&&!view.hidden.has(model.units[m.userData.unit].id);
    for(const mat of [lit,flat]){
      if(mat.transparent===cut){
        mat.transparent=!cut;
        mat.depthWrite=cut;
        mat.side=cut?THREE.DoubleSide:THREE.FrontSide;
        mat.needsUpdate=true;
      }
      // Along a line the units are fainter, so the section face along it stands out.
      mat.opacity=cut?1:lineOf()?.1:.24;
    }
  }
  for(const l of horizonLines)l.visible=view.horizons;
  if(holeMesh)holeMesh.visible=view.boreholes;
  if(cptAxes)cptAxes.visible=view.cpts;
  for(const p of cptPanels)p.visible=view.cpts;
  placeErrorMarkers();
  if(terrainMesh){
    terrainMesh.visible=terrainMesh.userData.flat?view.map&&!!mapLayer:view.terrain;
    // A section along a line is underground with nothing cut away in front of it: the ground around is see-through.
    const m=terrainMesh.material as THREE.Material;
    m.opacity=lineOf()?Math.min(m.userData.opacity??1,.28):m.userData.opacity??m.opacity;
  }
  for(const l of labels)l.visible=(l.userData.cpt===undefined?view.boreholes:view.cpts)&&view.labels&&(!cut||clipPlane.distanceToPoint(l.position)>=0);
  renderCredits();
  invalidate();
}

// ---------- UI ----------

const ui=document.createElement("div");
ui.className="ui";
// On a small screen each panel opens as a sheet, with a title, buttons of its own and a close button.
const sheetHead=(title:string,buttons="")=>`<div class="sheet-head"><b>${title}</b>${buttons}<button class="sheet-close" aria-label="Close">×</button></div>`;
ui.innerHTML=`<div class="title">GeoModel3D <span>${pkg.version.split(".").slice(0,2).join(".")}</span></div>
<button class="site-name" aria-controls="sheet-site" title="The dataset, its units and the check of the model"></button>
<div class="sub">Project-agnostic browser geological modelling engine</div>
<div class="panel" id="sheet-site">
  ${sheetHead("Site")}
  <select class="dataset" aria-label="Dataset"></select>
  <div class="desc"></div>
  <div class="stats"></div>
  <label class="crs">Coordinates <input class="crs-input" list="crs-options" placeholder="EPSG code, system or country" spellcheck="false" autocomplete="off"></label>
  <datalist id="crs-options"></datalist>
  <div class="legend"></div>
  <details class="rules"><summary>Unit rules</summary><div class="rule-list"></div>
    <div class="rule-actions"><button class="add-rule">Add rule</button><button class="apply-rules">Apply</button></div><div class="rule-note"></div></details>
  <details class="check"><summary>Check the model</summary>
    <p class="check-note">Each borehole in turn is left out and predicted from the others: how far the model can be trusted between boreholes, and which logs to check.</p>
    <div class="check-actions"><button class="run-check">Cross-validate</button><span class="check-status" aria-live="polite"></span></div>
    <div class="check-results"></div></details>
  <p class="panel-hint"></p>
</div>
<div class="hint"></div>`;
app.appendChild(ui);
const datasetSelect=ui.querySelector<HTMLSelectElement>(".dataset")!;
const panel=ui.querySelector<HTMLDivElement>(".panel")!,siteName=ui.querySelector<HTMLButtonElement>(".site-name")!;
// How to move about the model, with a mouse or with fingers.
function renderHint(){
  const text=touchQuery.matches?"One finger orbits · pinch to zoom · two fingers pan · tap a borehole, a CPT or a unit for its details"
    :"Drag to orbit · wheel to zoom · right-drag to pan · drop CSV, AGS4, GEF, XML or JSON files to import";
  ui.querySelector(".hint")!.textContent=text;
  ui.querySelector(".panel-hint")!.textContent=text;
}
renderHint();
touchQuery.addEventListener("change",renderHint);

const toolbar=document.createElement("div");
toolbar.className="toolbar";
toolbar.id="sheet-tools";
toolbar.innerHTML=`${sheetHead("View")}
<button class="input-data" title="Type in or paste your own boreholes, logs, groundwater, field and laboratory tests and unit parameters, then build the model">Enter your own data…</button>
<button class="import">Import data…</button>
<input class="file" type="file" multiple hidden accept=".csv,.tsv,.txt,.ags,.json,.xml,.gef,.asc,.xyz,.geojson,.dxf">
<details class="menu"><summary>Export</summary><div>
  <button data-export="project">Project (JSON)</button>
  <button data-export="boreholes">Boreholes (CSV)</button>
  <button data-export="tests">Tests (CSV)</button>
  <button data-export="cpts" class="cpt-only" title="Every reading of the CPTs, with the friction ratio">CPTs (CSV)</button>
  <button data-export="svg">Section (SVG)</button>
  <button data-export="section">Section (CSV)</button>
  <button data-export="field" title="The values of the field shown on the section, on a grid">Section field (CSV)</button>
  <button data-export="chainage" class="along-only" title="Along the line: the ground, the water table, the design levels with the cover and the units at them, and each unit's thickness, at round chainages">Chainage table (CSV)</button>
  <button data-export="alignment" class="along-only" title="The line's points with their chainage and design levels">Alignment (CSV)</button>
  <button data-export="report-A3" title="Opens the print dialog: choose Save as PDF">Report (PDF, A3)</button>
  <button data-export="report-A4" title="Opens the print dialog: choose Save as PDF">Report (PDF, A4)</button>
  <button data-export="usdz" title="The model as shown, 30 cm across, to set on a desk: opens in AR Quick Look on iPhone and iPad, downloads elsewhere">3-D model for AR (USDZ)</button>
  <button data-export="glb" title="The model as shown, 30 cm across, for Android, web viewers and 3-D software such as Blender">3-D model (GLB)</button>
</div></details>
<div class="toggles">
  <label><input type="checkbox" data-view="volumes" checked>Volumes</label>
  <label><input type="checkbox" data-view="horizons" checked>Horizons</label>
  <label><input type="checkbox" data-view="boreholes" checked>Boreholes</label>
  <label class="cpt-only"><input type="checkbox" data-view="cpts" checked>CPTs</label>
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
controlsBar.id="sheet-section";
// The section sheet carries the 2-D section button in its title row, where it takes no height from the model.
// The line is straight, by azimuth and offset, or one of the project's alignments, followed by chainage.
controlsBar.innerHTML=`${sheetHead("Section",'<button class="panel-toggle" aria-pressed="false">2-D section</button>')}<span class="tag">SECTION</span>
<label class="line-pick" title="A straight section, or a section along a line: a tunnel, road, railway or dike"><span>Line</span><select class="line-select" aria-label="Section line"></select></label>
<label class="straight-only"><span>Azimuth</span><input type="range" class="azimuth" min="0" max="179" step="1"><output class="azimuth-out"></output></label>
<label class="straight-only"><span>Offset</span><input type="range" class="offset" step="1"><output class="offset-out"></output></label>
<label class="along-only" title="A chainage on the line: marked on the section and in 3-D"><span>Chainage</span><input type="range" class="chainage" step="any"><output class="chainage-out"></output></label>
<button class="along-only cross-here" title="A straight section square to the line at this chainage">Cross-section</button>
<label class="along-only step-pick" title="The table by chainage, in CSV and in the report: a row every…"><span>Table</span><select class="table-step" aria-label="Table by chainage, a row every">${[1,2,5,10,20,25,50,100].map(v=>`<option value="${v}"${v===10?" selected":""}>every ${v} m</option>`).join("")}</select></label>
<label class="ve-pick"><span>V.E.</span><input type="range" class="ve" min="1" max="10" step="0.5"><output class="ve-out"></output></label>
<label class="field-pick" title="Colour the section by unit, by a stress, or by a measured property interpolated within each unit"><span>Colour</span><select class="field-select" aria-label="Colour the section by"></select></label>
<button class="panel-toggle" aria-pressed="false">2-D section</button>`;
app.appendChild(controlsBar);
const azimuthInput=controlsBar.querySelector<HTMLInputElement>(".azimuth")!;
const offsetInput=controlsBar.querySelector<HTMLInputElement>(".offset")!;
const veInput=controlsBar.querySelector<HTMLInputElement>(".ve")!;
const panelToggles=controlsBar.querySelectorAll<HTMLButtonElement>(".panel-toggle");
const fieldSelect=controlsBar.querySelector<HTMLSelectElement>(".field-select")!;
const lineSelect=controlsBar.querySelector<HTMLSelectElement>(".line-select")!,chainageInput=controlsBar.querySelector<HTMLInputElement>(".chainage")!;

// The two tabs: the model, and the input workspace where a case is typed in.
const modes=document.createElement("nav");
modes.className="modes";
modes.setAttribute("role","tablist");
modes.setAttribute("aria-label","View");
modes.innerHTML=`<button role="tab" data-mode="model" aria-selected="true">3-D model</button><button role="tab" data-mode="input" aria-selected="false">Input data</button>`;
app.appendChild(modes);

const sectionView=document.createElement("div");
sectionView.className="section-view";
sectionView.innerHTML=`<div class="section-head"><span class="section-name"></span><button data-export="svg">SVG</button><button data-export="section">CSV</button><button class="along-only" data-export="chainage" title="The table by chainage (CSV)">Table</button><button class="close" aria-label="Close section view">×</button></div><div class="section-body"></div>`;
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
// On a small screen the credits keep to one line, and open in full when tapped.
credits.addEventListener("click",e=>{if(compact()&&!(e.target as Element).closest("a"))credits.classList.toggle("open")});
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
dropZone.innerHTML="<div>Drop borehole, CPT, terrain or alignment files<br><span>CSV tables · AGS4 · Japanese borehole XML (電子納品, KuniJiban) · BRO and DOV XML · CPT (GEF, BRO, DOV, AGS4, CSV) · GeoModel3D or Georeport3D JSON · terrain grid (.asc, .xyz) · alignment (CSV, GeoJSON, DXF, LandXML)</span></div>";
app.appendChild(dropZone);

// ---------- small screens: the bar at the bottom and its sheets ----------

type SheetName=""|"site"|"section"|"view"|"files";
const icon=(paths:string)=>`<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const dock=document.createElement("nav");
dock.className="dock";
dock.setAttribute("aria-label","Panels");
dock.innerHTML=([
  ["site","Site","sheet-site",icon('<path d="M12 3.5 3 8l9 4.5L21 8z"/><path d="m3 12.5 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>')],
  ["section","Section","sheet-section",icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10.5c3-1.6 6 .6 9-.4s5.5-1.4 9 .2M3 15c3.5-1.2 6.5.6 9.5-.3s5-1 8.5 0"/>')],
  ["view","View","sheet-tools",icon('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>')],
  ["files","Files","sheet-tools",icon('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2.5h8A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/>')]
] as const).map(([key,label,id,svg])=>`<button data-sheet="${key}" aria-controls="${id}" aria-expanded="false">${svg}<span>${label}</span></button>`).join("");
app.appendChild(dock);

// The sizes the compact layout is drawn with, measured from the page: the title bar, the bar at the bottom, the sheet
// open (its height, or its width when it opens from the left) and the notes under the title bar.
const bars={top:0,dock:0,sheetH:0,sheetW:0,notice:0};
const sheetOpen=()=>(document.body.dataset.sheet??"") as SheetName;
const sheetElement=()=>({site:panel,section:controlsBar,view:toolbar,files:toolbar,"":null})[sheetOpen()];
function setSheet(name:SheetName){
  document.body.dataset.sheet=name;
  dock.querySelectorAll<HTMLButtonElement>("[data-sheet]").forEach(b=>b.setAttribute("aria-expanded",String(b.dataset.sheet===name)));
  siteName.setAttribute("aria-expanded",String(name==="site"));
  toolbar.querySelector(".sheet-head b")!.textContent=name==="files"?"Files":"View";
  hideTooltip();
  layoutCompact();
}
function layoutCompact(){
  const style=document.body.style;
  if(compact()){
    const sheet=sheetElement(),side=sideQuery.matches;
    bars.top=Math.ceil(Math.max(ui.querySelector(".title")!.getBoundingClientRect().bottom,siteName.getBoundingClientRect().bottom,modes.getBoundingClientRect().bottom))+6;
    // While a line is drawn, its bar takes the place of the bar at the bottom.
    bars.dock=drawing?drawBar.offsetHeight:dock.offsetHeight;
    bars.sheetH=sheet&&!side?sheet.offsetHeight:0;
    bars.sheetW=sheet&&side?sheet.offsetWidth:0;
    bars.notice=notice.hidden?0:notice.offsetHeight+6;
    // On its side the 2-D section takes the right of the screen, and the credits stop short of it.
    const pip=side&&view.panel?sectionView.offsetWidth:0;
    for(const [key,v] of Object.entries({"--top-h":bars.top,"--dock-h":bars.dock,"--sheet-h":bars.sheetH,"--sheet-w":bars.sheetW,"--notice-h":bars.notice,"--pip-w":pip}))style.setProperty(key,v+"px");
  }
  updateViewOffset();
}
// Measured again whenever one of them changes size, once per frame at most.
let layoutQueued=false;
const layoutSoon=()=>{if(!layoutQueued){layoutQueued=true;requestAnimationFrame(()=>{layoutQueued=false;layoutCompact()})}};
const sizes=new ResizeObserver(layoutSoon);
for(const el of [ui,modes,dock,panel,toolbar,controlsBar,notice,sectionView])sizes.observe(el);
compactQuery.addEventListener("change",()=>{layoutCompact();renderSectionPanel()});

dock.addEventListener("click",e=>{
  const b=(e.target as Element).closest<HTMLButtonElement>("[data-sheet]");
  if(b)setSheet(sheetOpen()===b.dataset.sheet?"":b.dataset.sheet as SheetName);
});
siteName.onclick=()=>setSheet(sheetOpen()==="site"?"":"site");
app.addEventListener("click",e=>{if((e.target as Element).closest(".sheet-close"))setSheet("")});
addEventListener("keydown",e=>{if(e.key==="Escape"&&compact()&&sheetOpen())setSheet("")});
// A sheet from the bottom follows a finger that pulls its title down, and closes when let go far enough down.
app.addEventListener("pointerdown",e=>{
  const head=(e.target as Element).closest(".sheet-head"),sheet=sheetElement();
  if(!head||!sheet||!compact()||sideQuery.matches||(e.target as Element).closest("button"))return;
  const y0=e.clientY,id=e.pointerId;
  let dy=0;
  sheet.style.transition="none";
  const move=(m:PointerEvent)=>{if(m.pointerId===id){dy=Math.max(0,m.clientY-y0);sheet.style.transform=dy?`translateY(${dy}px)`:""}};
  const end=(u:PointerEvent)=>{
    if(u.pointerId!==id)return;
    removeEventListener("pointermove",move);removeEventListener("pointerup",end);removeEventListener("pointercancel",end);
    sheet.style.transition="";sheet.style.transform="";
    if(u.type==="pointerup"&&dy>Math.min(80,sheet.offsetHeight/3))setSheet("");
  };
  addEventListener("pointermove",move);addEventListener("pointerup",end);addEventListener("pointercancel",end);
});

function renderPanel(){
  const projects=[...sampleProjects,...(imported?[imported]:[])];
  datasetSelect.innerHTML=projects.map((p,i)=>`<option value="${i}"${p===project?" selected":""}>${esc(i>=sampleProjects.length?"Your data: "+p.name:p.name)}</option>`).join("")+
    `<option value="input">✎ Enter your own data…</option>`;
  siteName.textContent=project.name;
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
  toolbar.dataset.cpts=model.cpts.length?"yes":"";
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
  const line=lineOf(),along=line?"along":"straight";
  controlsBar.dataset.line=along;
  sectionView.dataset.line=along;
  toolbar.dataset.line=along;
  if(line){
    const ch=chainages(line),c0=ch[0],c1=ch[ch.length-1];
    view.chainage=Math.min(Math.max(view.chainage,c0),c1);
    chainageInput.min=String(c0);
    chainageInput.max=String(c1);
    chainageInput.value=String(view.chainage);
    controlsBar.querySelector(".chainage-out")!.textContent=fmt(view.chainage,c1-c0<100?1:0)+" m";
  }
  // The cut belongs to straight sections.
  toolbar.querySelector<HTMLInputElement>('[data-view="cut"]')!.disabled=!!line;
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
  panelToggles.forEach(b=>b.setAttribute("aria-pressed",String(view.panel)));
  sectionView.hidden=!view.panel;
  updateViewOffset();
  toolbar.querySelector<HTMLInputElement>('[data-view="flip"]')!.disabled=!cutting();
  invalidate();
}

function renderSectionPanel(){
  // Behind the input tab the panel has no size; it is drawn when the model tab is shown again.
  if(!view.panel||!section||document.body.dataset.mode==="input")return;
  sectionView.querySelector(".section-name")!.textContent=section.alignment?sectionTitle(section):`Section A–A′ · ${String(view.azimuth).padStart(3,"0")}° · ${view.offset>=0?"+":""}${Math.round(view.offset)} m`;
  sectionBody.innerHTML=sectionSvg(model,section,{width:sectionBody.clientWidth,height:sectionBody.clientHeight,theme:"dark",title:false,buffer:sectionBuffer,hidden:view.hidden,field:field??undefined,marker:section.alignment?view.chainage:undefined,crossings});
}

// The lines offered: straight, the project's alignments, and drawing or importing another.
function renderLineOptions(){
  const lines=project.alignments??[],line=lineOf();
  lineSelect.innerHTML=`<option value="-1">Straight</option>${lines.map((a,i)=>`<option value="${i}">${esc(a.name)}</option>`).join("")}<option value="draw">✎ Draw a line…</option><option value="import">Import a line…</option>${line?`<option value="remove">Remove ${esc(line.name)}…</option>`:""}`;
  lineSelect.value=String(line?view.alignment:-1);
}
// Shows the section along a line of the project, from its start, with the camera turned to look square at it.
function showLine(index:number){
  view.alignment=index;
  const line=lineOf();
  if(line){view.chainage=chainages(line)[0];faceLine(line)}
  renderLineOptions();
  syncControls();
  updateSection();
}
// Turns the camera to look square at a line, from the side it is on, at the same distance, aimed at the middle of the
// line in plan.
function faceLine(line:Alignment){
  const xs=line.points.map(p=>p.x),ys=line.points.map(p=>p.y);
  faceAcross(line.points[0],line.points[line.points.length-1],{x:(Math.min(...xs)+Math.max(...xs))/2,y:(Math.min(...ys)+Math.max(...ys))/2});
}
// Turns the camera to look square at the direction from a to b, aimed at `at`. A camera looking down, as when a line
// was drawn from above, comes down to look from the side.
function faceAcross(a:XY,b:XY,at:XY){
  const l=Math.hypot(b.x-a.x,b.y-a.y);
  if(l<1e-6)return;
  const n={x:(b.y-a.y)/l,y:-(b.x-a.x)/l},v=camera.position.clone().sub(controls.target),dist=v.length(),h=Math.hypot(v.x,v.y);
  const side=v.x*n.x+v.y*n.y>=0?1:-1,steep=h<dist*Math.sin(THREE.MathUtils.degToRad(20));
  const across=steep?dist*Math.cos(0.6):h,up=steep?dist*Math.sin(0.6):v.z;
  controls.target.set(at.x-origin.x,at.y-origin.y,controls.target.z);
  camera.position.set(controls.target.x+side*n.x*across,controls.target.y+side*n.y*across,controls.target.z+up);
  controls.update();
  invalidate();
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

// ---------- cross-validation ----------

const checkButton=ui.querySelector<HTMLButtonElement>(".run-check")!,checkStatus=ui.querySelector<HTMLSpanElement>(".check-status")!;
const checkResults=ui.querySelector<HTMLDivElement>(".check-results")!;
// One borehole at a time, letting the page draw between them; a new model or Stop ends the run.
async function runValidation(){
  const run=++validationRun,target=model,steps=crossValidation(project,model);
  checkButton.textContent="Stop";
  for(;;){
    const r=steps.next();
    if(run!==validationRun)return;
    if(r.done){validation=r.value;break}
    checkStatus.textContent=`${r.value.done} of ${r.value.total} boreholes`;
    await new Promise(resolve=>setTimeout(resolve,0));
    if(run!==validationRun||model!==target)return;
  }
  renderValidation();
  buildErrorMarkers();
}
// Mean absolute errors coloured up to the 90th percentile; larger ones fall in the top band.
function errorScale(v:CrossValidation):ColourScale{
  const e=v.boreholes.map(b=>b.mae).filter(Number.isFinite).sort((a,b)=>a-b);
  const top=Math.max(e[Math.min(e.length-1,Math.floor(e.length*0.9))]??1,0.1);
  return withTheme(colourScale(0,top,false,false,e[e.length-1]>top),true);
}
function renderValidation(){
  checkButton.textContent="Cross-validate";
  checkStatus.textContent="";
  const v=validation;
  if(!v){checkResults.innerHTML="";return}
  const inside=v.boreholes.filter(b=>!b.outside),outside=v.boreholes.length-inside.length;
  const pct=(x:number)=>Number.isFinite(x)?`${fmt(100*x,1)} %`:"–",m=(x:number)=>(x>0?"+":"")+fmt(x,1);
  const worst=[...inside].filter(b=>Number.isFinite(b.mae)).sort((a,b)=>b.mae-a.mae).slice(0,8);
  const scale=errorScale(v);
  checkResults.innerHTML=`<p>${inside.length} borehole${inside.length===1?"":"s"} inside the others: <b>${pct(v.share.inside)}</b> of the logged metres predicted in the unit logged${outside?`. ${outside} outside them, by extrapolation: ${pct(v.share.outside)}`:""}.${v.terrain?" The ground between boreholes is the terrain grid.":""}</p>
${v.inside.length?`<table class="check-table"><thead><tr><th>Surface</th><th>n</th><th>Bias</th><th>Mean</th><th>RMS</th><th>Largest</th></tr></thead><tbody>${v.inside.map(q=>`<tr><td>${esc(q.name)}</td><td>${q.n}</td><td>${m(q.bias)}</td><td>${fmt(q.mae,1)}</td><td>${fmt(q.rms,1)}</td><td title="${esc(q.at)}">${m(q.max)}</td></tr>`).join("")}</tbody></table>
<p class="check-note">Metres, predicted minus logged, at the boreholes inside the others: bias is the mean error, mean the mean absolute error.</p>`:""}
${worst.length?`<p>Furthest from their prediction:</p><ol class="check-worst">${worst.map(b=>`<li><button data-hole="${esc(b.id)}" title="Move the section through it">${esc(b.id)}</button> ${fmt(b.mae,1)} m${b.worst?`; ${esc(lowerFirst(v.surfaces[b.worst.k]))} ${m(b.worst.error)} m`:""}</li>`).join("")}</ol>`:""}
<label class="check-colour"><input type="checkbox" class="colour-errors"${showErrors?" checked":""}>Mark the boreholes by their mean error (m)</label>
<div class="check-legend"><div class="fl-bar">${scale.colors.map(c=>`<i style="background:${c}"></i>`).join("")}</div><div class="fl-ticks">${[0,Math.round(scale.colors.length/2),scale.colors.length].map(i=>`<span>${esc(scaleLabel(scale,scale.edges[i]))}</span>`).join("")}</div></div>
${v.notes.length?`<ul class="check-notes">${v.notes.map(n=>`<li>${esc(n)}</li>`).join("")}</ul>`:""}
<div class="check-actions"><button class="check-csv">Errors (CSV)</button></div>`;
}
// A marker over each collar, coloured by the borehole's mean error, with a dark rim that keeps it apart from the units
// behind it; kept round whatever the exaggeration.
function buildErrorMarkers(){
  for(const mesh of [errorMarkers,errorRims])if(mesh){content.remove(mesh);mesh.dispose()}
  errorMarkers=errorRims=null;
  errorMarked=[];
  const v=validation;
  if(v&&showErrors){
    const list=v.boreholes.filter(b=>Number.isFinite(b.mae)),scale=errorScale(v),c=new THREE.Color();
    const fill=new THREE.MeshBasicNodeMaterial(),rim=new THREE.MeshBasicNodeMaterial({color:0x071018,side:THREE.BackSide});
    fill.maskNode=rim.maskNode=keepFragment;
    const sphere=new THREE.SphereGeometry(1,14,10);
    errorMarkers=new THREE.InstancedMesh(sphere,fill,list.length);
    errorRims=new THREE.InstancedMesh(sphere,rim,list.length);
    list.forEach((b,i)=>errorMarkers!.setColorAt(i,c.set(scale.colorOf(b.mae)??"#888888")));
    errorMarked=list.map(b=>b.id);
    content.add(errorRims,errorMarkers);
  }
  placeErrorMarkers();
}
function placeErrorMarkers(){
  if(!errorMarkers||!errorRims)return;
  const r=extent*0.011,m=new THREE.Matrix4(),q=new THREE.Quaternion(),scale=new THREE.Vector3(r,r,r/view.ve),rim=scale.clone().multiplyScalar(1.3);
  errorMarked.forEach((id,i)=>{
    const bh=model.boreholes.find(b=>b.id===id)!,at=local(bh.x,bh.y,bh.z+2.2*r/view.ve);
    errorMarkers!.setMatrixAt(i,m.compose(at,q,scale));
    errorRims!.setMatrixAt(i,m.compose(at,q,rim));
  });
  errorMarkers.instanceMatrix.needsUpdate=errorRims.instanceMatrix.needsUpdate=true;
  errorMarkers.visible=errorRims.visible=view.boreholes;
  invalidate();
}
function validationCsv(v:CrossValidation){
  const rows:Array<Array<string|number>>=[["borehole","x","y","outside the others","surface","logged elevation (m)","predicted elevation (m)","error (m)"]];
  for(const b of v.boreholes)for(const q of b.contacts)rows.push([b.id,b.x,b.y,b.outside?"yes":"no",v.surfaces[q.k],Number(q.logged.toFixed(3)),Number(q.predicted.toFixed(3)),Number(q.error.toFixed(3))]);
  return toCsv(rows);
}
// The result of one borehole, for the read-out.
function validationLine(id:string){
  const b=validation?.boreholes.find(q=>q.id===id);
  if(!b)return "";
  return `<span>Predicted from the other boreholes${b.outside?", outside them":""}: mean error ${fmt(b.mae,2)} m${b.worst?`, largest at the ${esc(lowerFirst(validation!.surfaces[b.worst.k]))}, ${b.worst.error>0?"+":""}${fmt(b.worst.error,2)} m`:""}</span>`;
}
checkButton.onclick=()=>{
  if(checkButton.textContent==="Stop"){validationRun++;renderValidation();checkStatus.textContent="Stopped";return}
  void runValidation();
};
checkResults.addEventListener("click",e=>{
  const b=(e.target as Element).closest<HTMLButtonElement>("button");
  if(!b||!validation)return;
  if(b.classList.contains("check-csv")){download(`${project.name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"geomodel3d"}-cross-validation.csv`,validationCsv(validation),"text/csv");return}
  const bh=model.boreholes.find(h=>h.id===b.dataset.hole);
  if(bh){
    if(lineOf()){view.alignment=-1;renderLineOptions()}
    view.offset=offsetThrough(model,view.azimuth,bh);syncControls();queueSection();
  }
});
checkResults.addEventListener("change",e=>{
  const input=e.target as HTMLInputElement;
  if(input.classList.contains("colour-errors")){showErrors=input.checked;buildErrorMarkers()}
});

// The notes of the model, or an error. On a small screen notes open folded to their title, one line under the title
// bar, so they do not cover the model; an error opens in full.
function showNotice(title:string,lines:string[],error=false){
  if(!lines.length&&!error){notice.hidden=true;return}
  const shown=lines.length>12?lines.slice(0,10):lines,rest=lines.slice(shown.length);
  const list=(l:string[])=>`<ul>${l.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`;
  const folded=compact()&&!error;
  notice.className="notice"+(error?" error":"")+(folded?" folded":"");
  notice.innerHTML=`<div class="notice-head"><button class="notice-fold" aria-expanded="${!folded}"><b>${esc(title)}</b></button><button class="notice-close" aria-label="Dismiss">×</button></div><div class="notice-body">${list(shown)}${rest.length?`<details><summary>${rest.length} more</summary>${list(rest)}</details>`:""}</div>`;
  notice.hidden=false;
  notice.querySelector<HTMLButtonElement>(".notice-close")!.onclick=()=>{notice.hidden=true};
  const fold=notice.querySelector<HTMLButtonElement>(".notice-fold")!;
  fold.onclick=()=>fold.setAttribute("aria-expanded",String(!notice.classList.toggle("folded")));
}

let currentNotes:string[]=[];
// keepView rebuilds the same site (new terrain or rules) without moving the camera or resetting the controls.
function loadProject(p:GeoProject,importWarnings:string[]=[],keepView=false){
  const before={...origin};
  project=p;
  model=buildGeologicalModel(p);
  weights=unitWeights(model);
  if(!keepView){view.hidden.clear();view.field="units";view.alignment=-1}
  if(view.alignment>=(p.alignments?.length??0))view.alignment=-1;
  // A line being drawn belongs to the site shown before.
  if(drawing){drawing=null;renderDraw()}
  renderFieldOptions();
  renderLineOptions();
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
    view.labels=model.boreholes.length<=(compact()?20:40);
    toolbar.querySelector<HTMLInputElement>('[data-view="labels"]')!.checked=view.labels;
    view.map=publicSites.has(p)&&!!projectCrs(p);
  }
  sectionBuffer=Math.max(extent*0.12,1);
  validation=null;validationRun++;
  renderValidation();
  renderPanel();
  syncControls();
  updateSection();
  if(!keepView)fitCamera();
  const warnings=[...importWarnings,...model.warnings];
  currentNotes=warnings;
  showNotice(`${p.name}: ${warnings.length} note${warnings.length===1?"":"s"}`,warnings);
  // The status of the terrain and map of the site shown before is not this one's.
  setGeoStatus("");
  if(publicSites.has(p)&&!loggedGround.has(p)&&!p.terrain&&projectCrs(p)&&!keepView)void fetchSiteTerrain();
  void updateMap();
}

async function importFileList(list:FileList|File[]){
  try{
    const files=await Promise.all([...list].map(async f=>({name:f.name,text:decodeText(new Uint8Array(await f.arrayBuffer()))})));
    const result=importFiles(files,project);
    imported=result.project;
    // Lines or CPTs added to the site shown keep the view, and the first line is shown.
    const added=(!!result.alignments||!!result.cpts)&&result.project.boreholes===project.boreholes;
    loadProject(result.project,result.warnings,added);
    const first=result.alignments?.[0],index=first===undefined?-1:result.project.alignments?.findIndex(a=>a.name===first)??-1;
    if(index>=0&&document.body.dataset.mode!=="input")showLine(index);
    // Files picked from the input tab open there, for review before building.
    if(document.body.dataset.mode==="input")workspace.edit(result.project,`Imported ${files.map(f=>f.name).join(", ")}: check the tables, then build the model.${result.warnings.length?` ${result.warnings.length} note${result.warnings.length===1?"":"s"} under Checks.`:""}`,result.warnings);
  }catch(err){
    showNotice("Import failed",[(err as Error).message],true);
  }
}

function download(name:string,data:string|ArrayBuffer|Uint8Array<ArrayBuffer>,type:string){
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([data],{type}));
  a.download=name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
function exportAs(kind:string){
  const slugOf=(name:string)=>name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  const slug=slugOf(project.name)||"geomodel3d",line=lineOf();
  const tag=line?`${slugOf(line.name)||"line"}-profile`:`${String(view.azimuth).padStart(3,"0")}-${view.offset>=0?"p":"m"}${Math.abs(Math.round(view.offset))}`;
  if(kind==="chainage"||kind==="alignment"){
    if(!line){showNotice("Along a line",["Choose a line under Section, Line first: a straight section has no chainage."],true);return}
    if(kind==="chainage")download(`${slug}-${slugOf(line.name)||"line"}-by-chainage-${view.step}m.csv`,chainageCsv(model,section,view.step),"text/csv");
    else download(`${slug}-${slugOf(line.name)||"line"}.csv`,toAlignmentCsv(line),"text/csv");
    return;
  }
  if(kind==="project")download(`${slug}.geomodel3d.json`,toProjectJson(project),"application/json");
  if(kind==="boreholes")download(`${slug}-boreholes.csv`,toBoreholeCsv(project),"text/csv");
  if(kind==="tests")download(`${slug}-tests.csv`,toTestsCsv(project),"text/csv");
  if(kind==="cpts")download(`${slug}-cpts.csv`,toCptCsv(project),"text/csv");
  if(kind==="svg")download(`${slug}-section-${tag}.svg`,sectionSvg(model,section,{width:1600,height:900,theme:"light",legend:true,buffer:sectionBuffer,roundVe:true,hidden:view.hidden,field:field??undefined,crossings}),"image/svg+xml");
  if(kind==="section")download(`${slug}-section-${tag}.csv`,sectionCsv(model,section),"text/csv");
  if(kind==="field"){
    if(field)download(`${slug}-section-${tag}-${field.key}.csv`,sectionFieldCsv(model,section,field),"text/csv");
    else showNotice("Section field",["Choose a field under Colour on the section bar first: a stress or a measured property."],true);
  }
  if(kind.startsWith("report-"))void printReport(kind==="report-A4"?"A4":"A3");
  if(kind==="usdz"||kind==="glb")void exportModel(kind,slug);
}
// The model as shown, for augmented reality: 30 cm across, with the view's exaggeration and without the hidden units,
// carrying the credits of its data. Where Safari offers AR Quick Look, the USDZ opens in it.
async function exportModel(format:"usdz"|"glb",slug:string){
  try{
    const {scene,triangles}=arModel(project,{ve:view.ve,hidden:view.hidden});
    const credit=[project.terrain?.source?`Terrain: ${project.terrain.source}`:"",project.source?`Data: ${project.source}`:"",
      `Model: GeoModel3D ${pkg.version}, ${pkg.homepage}, vertical exaggeration ×${view.ve}`].filter(Boolean).join(". ");
    const data=format==="usdz"?await toUsdz(scene,credit):await toGlb(scene,credit);
    const name=`${slug}.${format}`,type=format==="usdz"?"model/vnd.usdz+zip":"model/gltf-binary";
    if(format==="usdz"&&quickLookAvailable()){
      // AR Quick Look opens a link marked rel="ar" that holds an image.
      const a=document.createElement("a"),img=document.createElement("img");
      img.src="data:image/gif;base64,R0lGODlhAQABAAAAACw=";
      a.rel="ar";a.href=URL.createObjectURL(new Blob([data],{type}));a.appendChild(img);
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(a.href),60_000);
    }else download(name,data,type);
    showNotice("3-D model",[`${name}: ${triangles.toLocaleString("en-US")} triangles, 30 cm across, vertical exaggeration ×${fmt(view.ve,1)}${view.hidden.size?", without the hidden units":""}.`,
      format==="usdz"?"It opens in AR Quick Look on iPhone and iPad.":"It opens in web viewers and 3-D software such as Blender.",
      "The four bundled sites can be opened in AR on a phone from kilickursat.github.io/GeoModel3D/ar/."]);
  }catch(err){showNotice("3-D model could not be made",[(err as Error).message],true)}
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
  updateViewOffset(true);
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
    credits:creditTexts(),notes:currentNotes,sectionBuffer,ve:view.ve,hidden:view.hidden,field:field??undefined,validation:validation??undefined,chainageStep:view.step});
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

datasetSelect.onchange=()=>{
  if(datasetSelect.value==="input"){datasetSelect.value=String([...sampleProjects,...(imported?[imported]:[])].indexOf(project));setMode("input");return}
  const i=Number(datasetSelect.value);loadProject(i<sampleProjects.length?sampleProjects[i]:imported!);
};
toolbar.querySelector<HTMLButtonElement>(".import")!.onclick=()=>fileInput.click();
toolbar.querySelector<HTMLButtonElement>(".input-data")!.onclick=()=>setMode("input");

const workspace=createInputWorkspace({
  current:()=>project,
  download,
  onImport:()=>fileInput.click(),
  onBuild:r=>{imported=r.project;setMode("model");loadProject(r.project,r.warnings)}
});
app.appendChild(workspace.element);
function setMode(mode:"model"|"input"){
  document.body.dataset.mode=mode;
  workspace.element.hidden=mode!=="input";
  modes.querySelectorAll<HTMLButtonElement>("button").forEach(b=>b.setAttribute("aria-selected",String(b.dataset.mode===mode)));
  hideTooltip();
  history.replaceState(null,"",mode==="input"?"#input":location.pathname+location.search);
  if(mode==="input"){setSheet("");if(drawing){drawing=null;renderDraw()}workspace.show()}
  else{renderSectionPanel();layoutCompact();invalidate()}
}
modes.addEventListener("click",e=>{const b=(e.target as HTMLElement).closest<HTMLButtonElement>("[data-mode]");if(b)setMode(b.dataset.mode as "model"|"input")});
// What the Files sheet starts (an import, an export) closes it, so the result is seen.
fileInput.onchange=()=>{if(fileInput.files?.length){importFileList(fileInput.files);if(compact())setSheet("")}fileInput.value=""};
app.addEventListener("click",e=>{
  const kind=(e.target as HTMLElement).closest<HTMLElement>("[data-export]")?.dataset.export;
  if(kind){exportAs(kind);toolbar.querySelector("details")!.open=false;if(compact()&&sheetOpen()==="files")setSheet("")}
});
toolbar.querySelectorAll<HTMLInputElement>("[data-view]").forEach(input=>{
  input.onchange=()=>{
    const key=input.dataset.view as "volumes"|"horizons"|"boreholes"|"cpts"|"labels"|"terrain"|"map"|"cut"|"flip"|"exact";
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
panelToggles.forEach(b=>b.onclick=()=>{view.panel=!view.panel;syncControls();renderSectionPanel()});
fieldSelect.onchange=()=>{view.field=fieldSelect.value;updateSection()};
lineSelect.onchange=()=>{
  const v=lineSelect.value,line=lineOf();
  if(v==="draw"){renderLineOptions();startDraw();return}
  if(v==="import"){renderLineOptions();fileInput.click();return}
  if(v==="remove"){
    renderLineOptions();
    if(line&&confirm(`Remove the line ${line.name} from this project?`)){
      project.alignments=(project.alignments??[]).filter(a=>a!==line);
      showLine(-1);
    }
    return;
  }
  showLine(Number(v));
};
// The marker follows the slider, redrawn once a frame at most.
let markerQueued=false;
chainageInput.oninput=()=>{
  view.chainage=Number(chainageInput.value);
  syncControls();
  if(!markerQueued){markerQueued=true;requestAnimationFrame(()=>{markerQueued=false;placeMarker();renderSectionPanel()})}
};
controlsBar.querySelector<HTMLButtonElement>(".cross-here")!.onclick=()=>{
  const line=lineOf();
  if(!line)return;
  const c=crossSectionAt(model,line,view.chainage),a=c.azimuth*Math.PI/180,dir={x:Math.sin(a),y:Math.cos(a)};
  view.alignment=-1;view.azimuth=c.azimuth;view.offset=c.offset;
  // The camera turns to the cross-section, aimed at the line crossing it.
  faceAcross({x:c.x-dir.x,y:c.y-dir.y},{x:c.x+dir.x,y:c.y+dir.y},c);
  renderLineOptions();syncControls();updateSection();
};
controlsBar.querySelector<HTMLSelectElement>(".table-step")!.onchange=e=>{view.step=Number((e.target as HTMLSelectElement).value)};
sectionView.querySelector<HTMLButtonElement>(".close")!.onclick=()=>{view.panel=false;syncControls()};

let dragDepth=0;
addEventListener("dragenter",e=>{if(e.dataTransfer?.types.includes("Files")){dragDepth++;dropZone.hidden=false}});
addEventListener("dragleave",()=>{if(--dragDepth<=0){dragDepth=0;dropZone.hidden=true}});
addEventListener("dragover",e=>e.preventDefault());
addEventListener("drop",e=>{e.preventDefault();dragDepth=0;dropZone.hidden=true;if(e.dataTransfer?.files.length)importFileList(e.dataTransfer.files)});

// ---------- hover ----------

const raycaster=new THREE.Raycaster();
// With a mouse the read-out follows the pointer. On a touch screen a tap shows it, above the finger, until the next
// touch; dragging to orbit shows nothing.
let pointer:{x:number;y:number;touch:boolean}|null=null,pointerMoved=false;
function hideTooltip(){tooltip.hidden=true;pointer=null}
// A press that neither moves nor lasts is a click or a tap: while a line is drawn it adds a point, and on a touch screen
// it shows the read-out.
let press:{x:number;y:number;t:number;id:number}|null=null;
renderer.domElement.addEventListener("pointerdown",e=>{
  // A second finger makes it a pinch, not a tap; other mouse buttons pan.
  press=e.isPrimary&&(e.pointerType!=="mouse"||e.button===0)?{x:e.clientX,y:e.clientY,t:performance.now(),id:e.pointerId}:null;
  if(e.pointerType!=="mouse")hideTooltip();
});
renderer.domElement.addEventListener("pointermove",e=>{
  if(press&&press.id===e.pointerId&&Math.hypot(e.clientX-press.x,e.clientY-press.y)>10)press=null;
  if(e.pointerType==="mouse"){pointer={x:e.clientX,y:e.clientY,touch:false};pointerMoved=true}
});
renderer.domElement.addEventListener("pointerleave",e=>{if(e.pointerType==="mouse")hideTooltip()});
renderer.domElement.addEventListener("pointerup",e=>{
  const p=press;
  press=null;
  if(!p||p.id!==e.pointerId||performance.now()-p.t>=600||Math.hypot(e.clientX-p.x,e.clientY-p.y)>10)return;
  if(drawing)addDrawPoint(e.clientX,e.clientY);
  else if(e.pointerType!=="mouse"){pointer={x:e.clientX,y:e.clientY,touch:true};pointerMoved=true}
});

// ---------- drawing a line ----------

// A line drawn on the model: each click, or tap, adds a point on the ground under it; near a borehole the point is the
// borehole's collar, so the line passes through it. While drawing, the model is shown whole.
let drawing:{points:XY[];holes:Array<string|undefined>}|null=null;
const drawBar=document.createElement("div");
drawBar.className="draw-bar";
drawBar.hidden=true;
drawBar.innerHTML=`<span class="draw-text" aria-live="polite"></span><span class="draw-actions"><button class="draw-undo">Undo</button><button class="draw-top" title="Look straight down on the model">From above</button><button class="draw-cancel">Cancel</button><button class="draw-done">Done</button></span>`;
app.appendChild(drawBar);
const drawPreview=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicNodeMaterial({color:0x78c9df}));
const drawPoints=new THREE.InstancedMesh(new THREE.SphereGeometry(1,12,8),new THREE.MeshBasicNodeMaterial({color:0x78c9df}),1000);
drawPoints.count=0;
drawPreview.frustumCulled=drawPoints.frustumCulled=false;
world.add(drawPreview,drawPoints);
sizes.observe(drawBar);
const groundLevel=()=>{const z=model.boreholes.map(b=>b.z).sort((a,b)=>a-b);return z.length?z[Math.floor(z.length/2)]:0};
const groundAt=(x:number,y:number)=>sampleModel(model,x,y)?.[0]??groundLevel();
function startDraw(){
  drawing={points:[],holes:[]};
  if(compact())setSheet("");
  hideTooltip();
  renderDraw();
  applyDisplay();
}
function renderDraw(){
  drawBar.hidden=!drawing;
  document.body.dataset.drawing=drawing?"on":"";
  const n=drawing?.points.length??0,verb=touchQuery.matches?"Tap":"Click";
  if(drawing){
    drawBar.querySelector(".draw-text")!.textContent=n?`${n} point${n===1?"":"s"}${n<2?`; ${verb.toLowerCase()} the next one`:""}`:`${verb} on the model to start the line; near a borehole it passes through the borehole`;
    drawBar.querySelector<HTMLButtonElement>(".draw-undo")!.disabled=!n;
    drawBar.querySelector<HTMLButtonElement>(".draw-done")!.disabled=n<2;
  }
  // The line along the ground, and its points, kept round whatever the exaggeration.
  const pos:number[]=[],r=extent*0.006,m=new THREE.Matrix4(),q=new THREE.Quaternion(),size=new THREE.Vector3(r,r,r/view.ve);
  drawing?.points.forEach((a,i)=>{
    const b=drawing!.points[i+1],steps=b?24:1;
    for(let k=0;k<steps;k++){const t=k/steps,x=a.x+(b?b.x-a.x:0)*t,y=a.y+(b?b.y-a.y:0)*t;pos.push(x-origin.x,y-origin.y,groundAt(x,y)-origin.z)}
    drawPoints.setMatrixAt(i,m.compose(local(a.x,a.y,groundAt(a.x,a.y)),q,size));
  });
  positions(drawPreview,pos);
  drawPoints.count=Math.min(n,1000);
  drawPoints.instanceMatrix.needsUpdate=true;
  drawPreview.visible=n>1;
  drawPoints.visible=n>0;
  layoutSoon();
  invalidate();
}
// The borehole whose collar is drawn within `radius` pixels of a screen point, the nearest.
function collarNear(px:number,py:number,radius=14){
  let best:{id:string;x:number;y:number;d:number}|null=null;
  const v=new THREE.Vector3();
  for(const b of model.boreholes){
    v.copy(local(b.x,b.y,b.z)).multiply(world.scale).project(camera);
    if(v.z>1)continue;
    const d=Math.hypot((v.x+1)/2*innerWidth-px,(1-v.y)/2*innerHeight-py);
    if(d<=radius&&(!best||d<best.d))best={id:b.id,x:b.x,y:b.y,d};
  }
  return best;
}
// The plan position under a screen point: on the model or the terrain, else on the level of the collars.
function planAt(px:number,py:number):XY|null{
  raycaster.setFromCamera(new THREE.Vector2(px/innerWidth*2-1,-py/innerHeight*2+1),camera);
  const hit=raycaster.intersectObjects([...volumeMeshes.filter(m=>m.visible),...(terrainMesh?.visible?[terrainMesh]:[])])[0];
  const p=hit?.point??raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,0,1),-(groundLevel()-origin.z)*view.ve),new THREE.Vector3());
  return p?{x:p.x+origin.x,y:p.y+origin.y}:null;
}
function addDrawPoint(px:number,py:number){
  if(!drawing)return;
  const hole=collarNear(px,py),at=hole??planAt(px,py),last=drawing.points[drawing.points.length-1];
  if(!at||(last&&Math.hypot(at.x-last.x,at.y-last.y)<1e-3))return;
  drawing.points.push({x:at.x,y:at.y});
  drawing.holes.push(hole?.id);
  renderDraw();
}
function undoDraw(){if(drawing?.points.length){drawing.points.pop();drawing.holes.pop();renderDraw()}}
function cancelDraw(){drawing=null;renderDraw();applyDisplay()}
function finishDraw(){
  if(!drawing||drawing.points.length<2)return;
  const holes=drawing.holes,base=holes.every(Boolean)?`Through ${holes[0]} to ${holes[holes.length-1]}`:"Drawn line";
  const taken=new Set((project.alignments??[]).map(a=>a.name));
  let name=base;
  for(let k=2;taken.has(name);k++)name=`${base} ${k}`;
  const line:Alignment={name,points:drawing.points.map(p=>({x:Math.round(p.x*1000)/1000,y:Math.round(p.y*1000)/1000})),source:"Drawn in GeoModel3D"};
  drawing=null;
  renderDraw();
  project.alignments=[...(project.alignments??[]),line];
  showLine(project.alignments.length-1);
}
function viewFromAbove(){
  const d=camera.position.distanceTo(controls.target);
  camera.position.set(controls.target.x,controls.target.y-d*1e-3,controls.target.z+d);
  controls.update();
  invalidate();
}
drawBar.querySelector<HTMLButtonElement>(".draw-undo")!.onclick=undoDraw;
drawBar.querySelector<HTMLButtonElement>(".draw-top")!.onclick=viewFromAbove;
drawBar.querySelector<HTMLButtonElement>(".draw-cancel")!.onclick=cancelDraw;
drawBar.querySelector<HTMLButtonElement>(".draw-done")!.onclick=finishDraw;
addEventListener("keydown",e=>{
  if(!drawing||(e.target as Element|null)?.closest?.("input,select,textarea"))return;
  if(e.key==="Escape")cancelDraw();
  else if(e.key==="Enter")finishDraw();
  else if(e.key==="Backspace"||e.key==="Delete")undoDraw();
  else return;
  e.preventDefault();
});
// What the read-out says about a stretch of a borehole: an interval of its log, or (-1) below the log.
function holeHtml(hole:number,interval:number){
  const bh=model.boreholes[hole],iv=bh.intervals[interval];
  const what=iv?`${esc(model.units.find(u=>u.id===iv.unit)?.name??iv.unit)} ${fmt(iv.from,2)}–${fmt(iv.to,2)} m`:"not logged";
  const spt=iv?(bh.spt??[]).filter(t=>t.depth>=iv.from&&t.depth<iv.to).map(t=>t.penetration>=300?String(t.blows):`${t.blows}/${fmt(t.penetration/10)} cm`):[];
  const logged=[iv?.name&&iv.name!==iv.unit?esc(iv.name):"",spt.length?`N ${spt.join(", ")}`:""].filter(Boolean).join(" · ");
  const water=bh.water?.length?` · water ${fmt(Math.min(...bh.water.map(w=>w.depth)),2)} m deep`:"";
  const where=bh.lat!==undefined&&bh.lon!==undefined?` (${fmt(bh.lat,5)}°, ${fmt(bh.lon,5)}°)`:"";
  return `<b>${esc(bh.id)}</b> · ${what}${logged?`<span>${logged}</span>`:""}<span>collar E ${fmt(bh.x,1)} N ${fmt(bh.y,1)}${where} · ${fmt(bh.z,2)} m · final depth ${fmt(boreholeDepth(bh),1)} m${water}</span>${validationLine(bh.id)}`;
}
// A borehole is a few pixels wide, too thin to hit exactly with a finger: a tap within `radius` pixels of one picks the
// nearest, at the depth nearest the tap. Boreholes cut away are left out, as when hovering.
function holeNear(px:number,py:number,radius:number){
  let best:{hole:number;interval:number;d:number}|null=null;
  const top=new THREE.Vector3(),bottom=new THREE.Vector3(),at=new THREE.Vector3(),dir=camera.getWorldDirection(new THREE.Vector3());
  const screen=(v:THREE.Vector3)=>{const p=v.clone().project(camera);return [(p.x+1)/2*innerWidth,(1-p.y)/2*innerHeight]};
  for(const [hole,bh] of model.boreholes.entries()){
    top.copy(local(bh.x,bh.y,bh.z)).multiply(world.scale);
    bottom.copy(local(bh.x,bh.y,bh.z-boreholeDepth(bh))).multiply(world.scale);
    if(cutting()&&clipPlane.distanceToPoint(top)<-1e-6)continue;
    if(at.copy(top).sub(camera.position).dot(dir)<=0||at.copy(bottom).sub(camera.position).dot(dir)<=0)continue;
    const [ax,ay]=screen(top),[bx,by]=screen(bottom),{d}=segmentDistance(px,py,ax,ay,bx,by);
    if(d>radius||(best&&d>=best.d))continue;
    raycaster.ray.distanceSqToSegment(top,bottom,undefined,at);
    const below=bh.z-(at.z/view.ve+origin.z);
    best={hole,interval:bh.intervals.findIndex(iv=>below>=iv.from-1e-6&&below<=iv.to+1e-6),d};
  }
  return best;
}
// What the read-out says about a CPT at a depth: the readings there, the test, and its log over the model's units.
function cptHtml(i:number,depth:number){
  const c=model.cpts[i],d=Math.min(Math.max(depth,c.depth[0]),cptDepth(c)),v=cptAt(c,d);
  return `<b>${esc(c.id)}</b> · CPT, ${fmt(d,2)} m deep, elevation ${fmt(c.z-d,2)} m<span>${readingsText(c,v)}</span><span>start ${fmt(c.z,2)} m · deepest reading ${fmt(cptDepth(c),2)} m${c.predrill?` · predrilled ${fmt(c.predrill,2)} m`:""}${c.date?` · ${esc(c.date)}`:""}</span>${cptLogSvg(c,{width:224,height:210,theme:"dark",marker:d,units:cptBands(c)})}`;
}
function readingsText(c:Cpt,v:ReturnType<typeof cptAt>){
  const value=(x:number,unit:string,d:number)=>Number.isFinite(x)?`${fmt(x,d)} ${unit}`:"no reading";
  return [`qc ${value(v.qc,"MPa",2)}`,...(c.fs?[`fs ${value(v.fs,"kPa",0)}`]:[]),...(c.fs||c.rf?[`Rf ${value(v.rf,"%",1)}`]:[]),...(c.u2?[`u2 ${value(v.u2,"kPa",0)}`]:[])].join(" · ");
}
// The model's units where a CPT stands, as elevation bands; none outside the model.
function cptBands(c:Cpt):CptBand[]{
  const z=sampleModel(model,c.x,c.y);
  if(!z)return [];
  return model.units.map((u,k)=>({top:z[k],bottom:z[k+1],color:u.color,name:u.name})).filter((b,k)=>b.top-b.bottom>1e-6&&!view.hidden.has(model.units[k].id));
}
// The CPT whose axis is drawn within `radius` pixels of a screen point, the nearest, at the depth nearest the point; a
// CPT further from the camera than `hidden` (where opaque units hide it) is left out.
function cptNear(px:number,py:number,radius:number,hidden=Infinity){
  let best:{index:number;depth:number;d:number}|null=null;
  const top=new THREE.Vector3(),bottom=new THREE.Vector3(),at=new THREE.Vector3(),dir=camera.getWorldDirection(new THREE.Vector3());
  const screen=(v:THREE.Vector3)=>{const p=v.clone().project(camera);return [(p.x+1)/2*innerWidth,(1-p.y)/2*innerHeight]};
  for(const [index,c] of model.cpts.entries()){
    top.copy(local(c.x,c.y,c.z)).multiply(world.scale);
    bottom.copy(local(c.x,c.y,c.z-cptDepth(c))).multiply(world.scale);
    if(cutting()&&clipPlane.distanceToPoint(top)<-1e-6)continue;
    if(at.copy(top).sub(camera.position).dot(dir)<=0||at.copy(bottom).sub(camera.position).dot(dir)<=0)continue;
    const [ax,ay]=screen(top),[bx,by]=screen(bottom),{d}=segmentDistance(px,py,ax,ay,bx,by);
    if(d>radius||(best&&d>=best.d))continue;
    raycaster.ray.distanceSqToSegment(top,bottom,undefined,at);
    if(at.distanceTo(camera.position)>hidden)continue;
    best={index,depth:c.z-(at.z/view.ve+origin.z),d};
  }
  return best;
}
function updateTooltip(){
  if(!pointerMoved)return;
  pointerMoved=false;
  if(!pointer){tooltip.hidden=true;return}
  raycaster.setFromCamera(new THREE.Vector2(pointer.x/innerWidth*2-1,-pointer.y/innerHeight*2+1),camera);
  const kept=(h:THREE.Intersection)=>!cutting()||clipPlane.distanceToPoint(h.point)>=-1e-6;
  let html="";
  const faceHit=sectionGroup.visible?raycaster.intersectObject(fence)[0]:undefined;
  const volumeHit=view.volumes?raycaster.intersectObjects(volumeMeshes.filter(m=>m.visible)).find(kept):undefined;
  // A borehole or a CPT, the nearer of the two; a finger picks the one drawn nearest the tap. The opaque units and
  // section face of the cut hide the CPTs behind them, whose panels are much wider than a borehole.
  const hidden=cutting()?Math.min(volumeHit?.distance??Infinity,faceHit?.distance??Infinity)+1e-6:Infinity;
  const holeHit=holeMesh?.visible?raycaster.intersectObject(holeMesh).find(kept):undefined;
  const cptHit=view.cpts&&cptAxes?raycaster.intersectObjects([...cptFills,cptAxes],false).find(h=>kept(h)&&h.distance<=hidden):undefined;
  if(cptHit&&(!holeHit||cptHit.distance<holeHit.distance)){
    const i=cptHit.object===cptAxes?cptHit.instanceId!:cptHit.object.userData.cpt as number;
    html=cptHtml(i,model.cpts[i].z-(cptHit.point.z/view.ve+origin.z));
  }else if(holeHit&&holeHit.instanceId!==undefined)html=holeHtml(holeInfo[holeHit.instanceId].hole,holeInfo[holeHit.instanceId].interval);
  else if(pointer.touch){
    const hole=holeMesh?.visible?holeNear(pointer.x,pointer.y,12):null,cpt=view.cpts?cptNear(pointer.x,pointer.y,12,hidden):null;
    if(cpt&&(!hole||cpt.d<hole.d))html=cptHtml(cpt.index,cpt.depth);
    else if(hole)html=holeHtml(hole.hole,hole.interval);
  }
  if(!html&&errorMarkers?.visible){
    const hit=raycaster.intersectObject(errorMarkers).find(kept);
    if(hit&&hit.instanceId!==undefined)html=`<b>${esc(errorMarked[hit.instanceId])}</b>${validationLine(errorMarked[hit.instanceId])}`;
  }
  // The section face, or a unit volume in front of it; along a line the units are see-through, and the face comes first.
  if(!html&&faceHit&&(!volumeHit||!!lineOf()||faceHit.distance<=volumeHit.distance+1e-6)){
    const along=alongOf(section,{x:faceHit.point.x+origin.x,y:faceHit.point.y+origin.y});
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
  showTooltip(html,pointer.x,pointer.y,pointer.touch);
}
// Beside the mouse, or centred above a finger so that the finger does not cover it.
function showTooltip(html:string,x:number,y:number,touch:boolean,above=false){
  tooltip.hidden=!html;
  if(!html)return;
  tooltip.innerHTML=html;
  const w=tooltip.offsetWidth,h=tooltip.offsetHeight,gap=touch?28:10;
  tooltip.style.left=(touch?Math.max(8,Math.min(x-w/2,innerWidth-w-8)):Math.min(x+14,innerWidth-w-8))+"px";
  // Above the point where there is room for it, else below.
  tooltip.style.top=(touch||above?(y-h-gap>=8?y-h-gap:Math.min(y+gap,innerHeight-h-8)):Math.min(y+14,innerHeight-h-8))+"px";
}

// What the section shows at a point: the unit, its depth, the stresses there and the field's value.
function sectionReadout(along:number,e:number){
  const c=columnAt(section,along);
  if(!c)return "";
  let k=-1;
  for(let i=0;i<model.units.length;i++)if(e<=c.z[i]+1e-6&&e>=c.z[i+1]-1e-6&&c.z[i]-c.z[i+1]>1e-9){k=i;break}
  if(k<0)return "";
  const st=stressAt(c.z,c.water,weights,e),assumed=weights.some(w=>w.source==="assumed");
  let html=`<b>${esc(model.units[k].name)}</b> · ${section.alignment?`chainage ${fmt(along,1)} m, `:""}${fmt(c.z[0]-e,1)} m deep, elevation ${fmt(e,1)} m`;
  // Along a line, its design levels there and the cover above them.
  const d=section.alignment?designAt(section.alignment.design,along):{};
  if(d.top!==undefined)html+=`<span>${d.bottom!==undefined?`crown ${fmt(d.top,2)} m, invert ${fmt(d.bottom,2)} m, cover ${fmt(c.z[0]-d.top,1)} m`:`design level ${fmt(d.top,2)} m, ${fmt(c.z[0]-d.top,1)} m below ground`}</span>`;
  const K0=model.units[k].params?.K0;
  if(st)html+=`<span>σv ${fmt(st.sv)} kPa · u ${fmt(st.u)} kPa · σ′v ${fmt(st.s)} kPa${K0!==undefined?` · σ′h ${fmt(K0*st.s)} kPa`:""}${assumed?" (some unit weights assumed)":""}</span>`;
  if(field&&!["sv","u","s","sh"].includes(field.key)){
    const v=field.at(along,e),p=propertyDef(field.key);
    html+=`<span>${esc(p.symbol)} ${Number.isFinite(v)?`${formatValue(field.key,field.log?10**v:v)}${p.unit?" "+esc(p.unit):""}, interpolated`:"not measured in this unit"}</span>`;
  }
  return html;
}
// The section read-out follows the mouse, or a finger moved along the section, and stays when the finger lifts.
function sectionTooltip(e:PointerEvent){
  const svg=sectionBody.querySelector("svg"),frame=svg?.dataset.frame?.split(",").map(Number);
  if(!svg||!frame){tooltip.hidden=true;return}
  const [l,t,pw,ph,s0,s1,z0,z1]=frame,r=svg.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
  const inside=x>=l&&x<=l+pw&&y>=t&&y<=t+ph,along=s0+(x-l)/pw*(s1-s0),level=z1-(y-t)/ph*(z1-z0);
  let html=inside?sectionReadout(along,level):"";
  // Over a CPT's trace, its readings at that level.
  if(inside){
    const w=cptTraceWidths(pw);
    let best:{c:Cpt;d:number}|null=null;
    for(const p of section.cpts){
      const xp=l+(p.s-s0)/(s1-s0)*pw,c=model.cpts[p.index],depth=c.z-level;
      if(x<xp-w.rf-2||x>xp+w.qc+2||depth<c.depth[0]-0.05||depth>cptDepth(c)+0.05)continue;
      if(!best||Math.abs(x-xp)<best.d)best={c,d:Math.abs(x-xp)};
    }
    if(best){
      const c=best.c,d=Math.min(Math.max(c.z-level,c.depth[0]),cptDepth(c)),readings=readingsText(c,cptAt(c,d));
      html=html?`${html}<span>CPT ${esc(c.id)}, ${fmt(d,2)} m deep: ${readings}</span>`:`<b>${esc(c.id)}</b> · CPT, ${fmt(d,2)} m deep, elevation ${fmt(level,1)} m<span>${readings}</span>`;
    }
  }
  showTooltip(html,e.clientX,e.clientY,e.pointerType!=="mouse",true);
}
sectionBody.addEventListener("pointermove",e=>{if(e.pointerType==="mouse"||e.buttons)sectionTooltip(e)});
sectionBody.addEventListener("pointerdown",e=>{if(e.pointerType!=="mouse")sectionTooltip(e)});
sectionBody.addEventListener("pointerleave",e=>{if(e.pointerType==="mouse")tooltip.hidden=true});
// The section drawing is redrawn at the size its panel takes, as panels open and close around it.
let sectionSize="";
new ResizeObserver(()=>{
  const size=sectionBody.clientWidth?`${sectionBody.clientWidth}×${sectionBody.clientHeight}`:"";
  if(size&&size!==sectionSize)renderSectionPanel();
  sectionSize=size;
}).observe(sectionBody);

addEventListener("resize",()=>{
  camera.aspect=innerWidth/innerHeight;
  renderer.setSize(innerWidth,innerHeight);
  labelRenderer.setSize(innerWidth,innerHeight);
  layoutCompact();
  updateViewOffset(true);
  invalidate();
});

controls.addEventListener("change",invalidate);
document.body.dataset.mode="model";
document.body.dataset.sheet="";
// The bars are measured before the first model is framed between them.
layoutCompact();
loadProject(project);
if(location.hash==="#input")setMode("input");
renderer.setAnimationLoop(()=>{
  // The 3-D view is not drawn behind the input tab.
  if(document.body.dataset.mode==="input")return;
  controls.update();
  stepShift();
  updateTooltip();
  if(!dirty)return;
  dirty--;
  faceCpts();
  if(cutting()&&updateCutSide())applyDisplay();
  renderer.render(scene,camera);
  labelRenderer.render(scene,camera);
});
