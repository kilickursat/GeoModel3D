// Generates src/data/deepleads-site.json: a real site in central Victoria, Australia, from the National Groundwater
// Information System (NGIS) v1.1 of the Bureau of Meteorology (CC BY 3.0 AU): every bore with a hydrostratigraphic
// log in about 10 × 10 km of the basalt plains north-east of Creswick, where lava flows filled valleys cut into
// Palaeozoic bedrock and buried the gravels of the old rivers, the deep leads. The logs are the interpretation of the
// Victorian Department of Primary Industries; scripts/extract-ngis-deepleads.py reads them from the NGIS geodatabase.
//   npx esbuild scripts/make-deepleads-site.ts --bundle --platform=node --format=esm --outfile=.cache/make-deepleads.mjs && node .cache/make-deepleads.mjs
import {readFileSync,writeFileSync} from "node:fs";
import {toProjectJson} from "../src/io";
import {GeoProject,UnitDef,Borehole,Interval} from "../src/geology";
import {buildGeologicalModel} from "../src/model";
import {findCrs,toProjected} from "../src/crs";

interface Row { from:number; to:number; description:string; hgu:string|null }
interface Bore { id:string; lat:number; lon:number; datum:string; elevation:number; elevationMethod:string; depth:number|null; log:Row[] }
const data=JSON.parse(readFileSync(new URL("../.cache/au/deepleads-ngis.json",import.meta.url),"utf8")) as {bores:Bore[]};
const MGA54=findCrs("EPSG:28354")!;

const units:UnitDef[]=[
  {id:"Alluvium",name:"Surface alluvium",color:"#d8c48c"},
  {id:"Upper basalt",name:"Basalt, upper flows",color:"#4d5561"},
  {id:"Interbasalt clay",name:"Interbasalt clay",color:"#b08458"},
  {id:"Lower basalt",name:"Basalt, lower flows",color:"#68709a"},
  {id:"Clay",name:"Sub-basaltic clay",color:"#a7a582"},
  {id:"Deep lead",name:"Deep lead: buried river sand and gravel",color:"#dfa43a"},
  {id:"Bedrock",name:"Palaeozoic bedrock",color:"#7f8c78"}
];
// The interpretation's names, as logged in NGIS (lower case), and the units they are.
const UNIT:Record<string,string>={
  "surface alluvium":"Alluvium","tertiary basalt (upper)":"Upper basalt","interbasalt clay":"Interbasalt clay",
  "tertiary basalt (lower)":"Lower basalt","clay":"Clay","deep lead":"Deep lead","bedrock":"Bedrock"
};

// A row may hold several units, written "a:b:c::from|to:from|to:from|to" with depths in metres.
function rowIntervals(r:Row):Interval[]{
  const m=r.description.match(/^(.*?)::(.*)$/);
  const parts=m?m[1].split(":").map((name,k)=>{const [from,to]=m[2].split(":")[k].split("|").map(Number);return {name,from,to}}):[{name:r.description,from:r.from,to:r.to}];
  return parts.flatMap(p=>{
    const name=p.name.trim(),unit=UNIT[name.toLowerCase()];
    if(!unit){if(!/^unknown$/i.test(name))throw new Error(`Unexpected unit “${name}”`);return []}
    return [{from:p.from,to:p.to,unit,name:name[0].toUpperCase()+name.slice(1)}];
  });
}

const boreholes:Borehole[]=data.bores.map(b=>{
  const {x,y}=toProjected(MGA54,b.lon,b.lat);
  const intervals=b.log.flatMap(rowIntervals).filter(i=>i.to>i.from).sort((p,q)=>p.from-q.from);
  const end=Math.max(...intervals.map(i=>i.to));
  return {id:b.id,x:Math.round(x*100)/100,y:Math.round(y*100)/100,z:b.elevation,lon:b.lon,lat:b.lat,...(b.depth&&b.depth>end+0.05?{depth:b.depth}:{}),intervals};
}).filter(b=>b.intervals.length);

const methods=new Map<string,number>();
for(const b of data.bores)methods.set(b.elevationMethod,(methods.get(b.elevationMethod)??0)+1);
const project:GeoProject={
  name:"Creswick deep leads, Victoria (NGIS)",
  description:`${boreholes.length} groundwater bores on the basalt plains north-east of Creswick, central Victoria, from the National Groundwater Information System (NGIS v1.1, 2013). Basalt lava flows filled valleys cut into Palaeozoic bedrock and buried the sand and gravel of the old rivers, the deep leads, once mined for gold. The units are the hydrostratigraphic interpretation of each log by the Victorian Department of Primary Industries, as published in NGIS; each interval keeps its name. Ground elevations in metres AHD, from LiDAR (${methods.get("LID")??0}), a terrain model (${methods.get("DEM")??0}) or GPS (${methods.get("GPS")??0}). Terrain from Terrain Tiles, fetched when the project opens.`,
  source:"National Groundwater Information System v1.1, © Commonwealth of Australia (Bureau of Meteorology), CC BY 3.0 AU, via data.gov.au; bore data © State of Victoria",
  crs:MGA54.name,crsCode:MGA54.code,
  units,boreholes
};
writeFileSync(new URL("../src/data/deepleads-site.json",import.meta.url),toProjectJson(project));
const model=buildGeologicalModel(project);
console.log(`${boreholes.length} boreholes, ${model.triangles.length} triangles, base ${model.base} m`);
console.log(model.warnings.join("\n"));
