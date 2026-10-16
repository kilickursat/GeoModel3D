// Generates src/data/rotterdam-site.json: a real site from the Dutch Key Register of the Subsurface (BRO) on Maasvlakte 2,
// Port of Rotterdam: every geotechnical borehole (BHR-GT) in a 3.9 × 3.5 km rectangle over the Prinses Amaliahaven,
// with their field descriptions, groundwater levels and laboratory tests, and a choice of its cone penetration tests
// (CPT). The IMBRO XML is downloaded once into .cache/bro and .cache/bro-cpt and read with the viewer's own importer.
//   npx esbuild scripts/make-rotterdam-site.ts --bundle --platform=node --format=esm --outfile=.cache/make-rotterdam.mjs && node .cache/make-rotterdam.mjs [--discover|--discover-cpts]
// --discover lists the boreholes the BRO serves for the rectangle today, to pin below; --discover-cpts chooses the CPTs.
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {importFiles,toProjectJson} from "../src/io";
import {GeoProject,UnitDef,Borehole,Interval,Cpt} from "../src/geology";
import {findCrs,toGeographic} from "../src/crs";
import {thinned} from "../src/cpt";
import {soilBehaviour,cptLayers,waterTableAt,joinLayers} from "../src/sbt";
import {PINNED} from "./rotterdam-boreholes";
import {PINNED_CPTS} from "./rotterdam-cpts";

const RD=findCrs("EPSG:28992")!,BOX=[60800,440500,64700,443950];
const UA={"User-Agent":"GeoModel3D reference data (github.com/kilickursat/GeoModel3D)"};
const cache=new URL("../.cache/bro/",import.meta.url),cptCache=new URL("../.cache/bro-cpt/",import.meta.url);
mkdirSync(cache,{recursive:true});
mkdirSync(cptCache,{recursive:true});

// The CPTs: of those the BRO serves for the rectangle (searched in 4 × 4 parts, as it answers at most 2,000 objects a
// query), the ones made since 2018, as the boreholes were, of quality class 1 or 2 and at least 30 m deep, so they reach
// the Pleistocene sand; of these, the deepest in each 400 m square of the rectangle (then the latest, then by BRO ID).
if(process.argv.includes("--discover-cpts")){
  const found=new Map<string,{id:string;x:number;y:number;start:string;depth:number}>(),N=4;
  for(let i=0;i<N;i++)for(let j=0;j<N;j++){
    const x0=BOX[0]+(BOX[2]-BOX[0])*i/N,x1=BOX[0]+(BOX[2]-BOX[0])*(i+1)/N,y0=BOX[1]+(BOX[3]-BOX[1])*j/N,y1=BOX[1]+(BOX[3]-BOX[1])*(j+1)/N;
    const lower=toGeographic(RD,x0-30,y0-30),upper=toGeographic(RD,x1+30,y1+30);
    const r=await fetch("https://publiek.broservices.nl/sr/cpt/v1/characteristics/searches",{method:"POST",headers:{...UA,"Content-Type":"application/json"},
      body:JSON.stringify({area:{boundingBox:{lowerCorner:{lat:lower.lat,lon:lower.lon},upperCorner:{lat:upper.lat,lon:upper.lon}}}})});
    const xml=await r.text();
    if(/rejectionReason/.test(xml))throw new Error(`part ${i},${j}: ${xml.match(/rejectionReason>([^<]*)/)![1]}`);
    for(const doc of xml.match(/<CPT_C[\s\S]*?<\/CPT_C>/g)??[]){
      const get=(re:RegExp)=>doc.match(re)?.[1]??"";
      const pos=doc.match(/deliveredLocation[^>]*28992[^>]*>\s*<gml:pos>([\d.]+) ([\d.]+)/);
      if(!pos||get(/<brocom:deregistered>([^<]+)/)!=="nee"||!/^klasse[12]$/.test(get(/qualityClass[^>]*>([^<]+)/)))continue;
      const id=get(/<brocom:broId>([^<]+)/),x=Number(pos[1]),y=Number(pos[2]),start=get(/<startTime>([^<]+)/),depth=Number(get(/finalDepth[^>]*>([^<]+)/));
      if(x>=BOX[0]&&x<BOX[2]&&y>=BOX[1]&&y<BOX[3]&&start>="2018"&&depth>=30)found.set(id,{id,x,y,start,depth});
    }
    await new Promise(res=>setTimeout(res,400));
  }
  const best=new Map<string,{id:string;x:number;y:number;start:string;depth:number}>();
  for(const c of found.values()){
    const key=`${Math.floor((c.x-BOX[0])/400)},${Math.floor((c.y-BOX[1])/400)}`,b=best.get(key);
    if(!b||c.depth>b.depth||(c.depth===b.depth&&(c.start>b.start||(c.start===b.start&&c.id>b.id))))best.set(key,c);
  }
  const ids=[...best.values()].map(c=>c.id).sort();
  writeFileSync(new URL("../scripts/rotterdam-cpts.ts",import.meta.url),`// BRO IDs of the CPTs of the Maasvlakte site (see make-rotterdam-site.ts), chosen from those the BRO served on ${new Date().toISOString().slice(0,10)}: ${found.size} qualified.\nexport const PINNED_CPTS:string[]=${JSON.stringify(ids)};\n`);
  console.log(`${ids.length} CPTs pinned of ${found.size}`);
  process.exit(0);
}

if(process.argv.includes("--discover")){
  const lower=toGeographic(RD,BOX[0],BOX[1]),upper=toGeographic(RD,BOX[2],BOX[3]);
  const r=await fetch("https://publiek.broservices.nl/sr/bhrgt/v2/characteristics/searches",{method:"POST",headers:{...UA,"Content-Type":"application/json"},
    body:JSON.stringify({area:{boundingBox:{lowerCorner:{lat:lower.lat,lon:lower.lon},upperCorner:{lat:upper.lat,lon:upper.lon}}}})});
  const xml=await r.text();
  const ids:string[]=[];
  for(const doc of xml.match(/<BHR_GT_C[\s\S]*?<\/BHR_GT_C>/g)??[]){
    const id=doc.match(/<brocom:broId>([^<]+)/)![1],pos=doc.match(/deliveredLocation[^>]*28992[^>]*>\s*<gml:pos>([\d.]+) ([\d.]+)/);
    if(/<brocom:deregistered>ja/.test(doc)||!pos)continue;
    const [x,y]=[Number(pos[1]),Number(pos[2])];
    if(x>=BOX[0]&&x<BOX[2]&&y>=BOX[1]&&y<BOX[3])ids.push(id);
  }
  ids.sort();
  writeFileSync(new URL("../scripts/rotterdam-boreholes.ts",import.meta.url),`// BRO IDs of the geotechnical boreholes of the Maasvlakte site, as the BRO served them on ${new Date().toISOString().slice(0,10)}.\nexport const PINNED:string[]=${JSON.stringify(ids)};\n`);
  console.log(`${ids.length} boreholes pinned`);
  process.exit(0);
}

const files:Array<{name:string;text:string}>=[];
for(const id of PINNED){
  const path=new URL(`${id}.xml`,cache);
  if(!existsSync(path)){
    const r=await fetch(`https://publiek.broservices.nl/sr/bhrgt/v2/objects/${id}`,{headers:UA});
    if(!r.ok)throw new Error(`${id}: HTTP ${r.status}`);
    writeFileSync(path,new Uint8Array(await r.arrayBuffer()));
    await new Promise(res=>setTimeout(res,250));
  }
  files.push({name:`${id}.xml`,text:readFileSync(path,"utf8")});
}

// The CPTs, every reading at least 0.1 m below the last one kept (of readings every 0.02 m) so that the site stays small;
// qc and qt to 0.01 MPa, fs and u2 to 1 kPa, which is finer than the tests measure, and the friction ratio as the BRO
// gives it. Their layers come from all the readings.
const cptFiles:Array<{name:string;text:string}>=[];
for(const id of PINNED_CPTS){
  const path=new URL(`${id}.xml`,cptCache);
  if(!existsSync(path)){
    const r=await fetch(`https://publiek.broservices.nl/sr/cpt/v1/objects/${id}`,{headers:UA});
    if(!r.ok)throw new Error(`${id}: HTTP ${r.status}`);
    writeFileSync(path,new Uint8Array(await r.arrayBuffer()));
    await new Promise(res=>setTimeout(res,250));
  }
  cptFiles.push({name:`${id}.xml`,text:readFileSync(path,"utf8")});
}
const round=(v:number,d:number)=>Number.isFinite(v)?Math.round(v*10**d)/10**d:NaN;
function slim(c:Cpt):Cpt{
  const keep=thinned(c,0.1),pick=(a:number[]|undefined,d:number)=>a&&keep.map(i=>round(a[i],d));
  const out:Cpt={id:c.id,x:c.x,y:c.y,z:c.z,depth:pick(c.depth,2)!,qc:pick(c.qc,2)!};
  if(c.fs)out.fs=pick(c.fs,0);
  if(c.u2)out.u2=pick(c.u2,0);
  if(c.rf)out.rf=pick(c.rf,2);
  if(c.qt)out.qt=pick(c.qt,2);
  if(c.a)out.a=c.a;
  if(c.predrill)out.predrill=c.predrill;
  if(c.date)out.date=c.date;
  if(c.layers)out.layers=c.layers;
  return out;
}

const units:UnitDef[]=[
  {id:"Sand",name:"Sand: reclamation fill and Holocene sea-bed sand",color:"#e3cf8c"},
  {id:"Holocene clay",name:"Holocene clay and peat",color:"#7d8a6a"},
  {id:"Pleistocene",name:"Pleistocene sand and gravel",color:"#c9955a"}
];
// An interpretation of each log as a sequence (the BRO describes soils, not formations): sand, with the paving of the
// quays and the sand logged as made ground, down to the first clay, silt or peat whose top is more than 16 m below NAP,
// which starts the basal
// Holocene clay and peat; that complex runs on through thin sand partings (under 0.6 m) to the first thicker sand;
// below lies Pleistocene sand and gravel. Logs without the complex change from sand to Pleistocene at 21 m below NAP.
const FINE=/^(peat|clay|silt|loam)/i;
function interpret(b:Borehole):Borehole{
  const top=(i:Interval)=>b.z-i.from,thick=(i:Interval)=>i.to-i.from,name=(i:Interval)=>(i.name??"").replace(/^Made ground: /,"");
  const iv=b.intervals;
  const first=iv.findIndex(i=>FINE.test(name(i))&&top(i)<-16);
  let last=first;
  if(first>=0)for(let j=first+1;j<iv.length;j++){
    if(FINE.test(name(iv[j])))last=j;
    else if(thick(iv[j])>=0.6||!iv.slice(j+1).some(k=>FINE.test(name(k))&&top(k)>b.z-iv[j].to-0.6))break;
  }
  return {...b,intervals:iv.map((i,j)=>({...i,unit:first<0?(top(i)>-21?"Sand":"Pleistocene"):j<first?"Sand":j<=last?"Holocene clay":"Pleistocene"}))};
}
// A CPT's layers by its soil behaviour type (src/sbt.ts), interpreted as the logs are: the basal Holocene clay and peat
// from its first clay, silt or peat below 16 m below NAP, through thin sand partings, to the first thicker sand. A CPT
// without the complex changes from sand to Pleistocene at 21 m below NAP, taken in pieces of at most 1 m as the app's
// rules take a layer.
function interpretCpt(project:GeoProject,c:Cpt):Cpt{
  const whole=cptLayers(c,soilBehaviour(c,waterTableAt(project,c.x,c.y,c.z)));
  const done=interpret({id:c.id,x:c.x,y:c.y,z:c.z,intervals:whole}).intervals;
  if(done.some(i=>i.unit==="Holocene clay"))return {...c,layers:done};
  const pieces:Interval[]=[];
  for(const i of done){
    const parts=Math.max(1,Math.ceil(i.to-i.from-1e-9)),h=(i.to-i.from)/parts;
    for(let k=0;k<parts;k++){
      const from=round(i.from+k*h,3),to=k===parts-1?i.to:round(i.from+(k+1)*h,3);
      pieces.push({...i,from,to,unit:c.z-from>-21?"Sand":"Pleistocene"});
    }
  }
  return {...c,layers:joinLayers(pieces)};
}
const {project:raw,warnings}=importFiles([...files,...cptFiles]);
const cpts=(raw.cpts??[]).map(c=>slim(interpretCpt(raw,c))),years=cpts.map(c=>c.date?.slice(0,4)).filter(Boolean).sort();
const project:GeoProject={
  name:"Maasvlakte 2, Rotterdam (BRO)",
  description:`${raw.boreholes.length} geotechnical boreholes of the Port of Rotterdam on Maasvlakte 2, 2017–2024, from the Dutch Key Register of the Subsurface (BRO), with their groundwater levels and ${raw.boreholes.reduce((n,b)=>n+(b.tests?.length??0),0)} laboratory test results, and ${cpts.length} of its cone penetration tests (CPT), ${years[0]}–${years[years.length-1]}: the deepest in each 400 m square, of those since 2018 of quality class 1 or 2 and at least 30 m deep, with a reading every 0.1 m. Land reclaimed in 2008–2013 from the North Sea: sand fill and sea-bed sand over the basal Holocene clay and peat, on Pleistocene sand and gravel. The units are an interpretation of each described log as a sequence (scripts/make-rotterdam-site.ts), with the paving of the quays in the sand; the logs keep the BRO soil names. The CPTs' layers, by their soil behaviour type (Robertson 2009), are interpreted by the same sequence, and the model is built with them and the boreholes. Boreholes in the harbour basins start at its bed, 17–21 m below NAP. Heights in metres NAP.`,
  source:"BRO, Basisregistratie Ondergrond: geotechnical borehole research (BHR-GT) and cone penetration tests (CPT), public domain (CC0)",
  crs:raw.crs,crsCode:raw.crsCode,
  units,boreholes:raw.boreholes.map(interpret),cpts,cptLayers:true
};
writeFileSync(new URL("../src/data/rotterdam-site.json",import.meta.url),toProjectJson(project));
console.log(`${project.boreholes.length} boreholes, ${cpts.length} CPTs (${cpts.reduce((n,c)=>n+c.depth.length,0)} readings)`);
console.log(warnings.join("\n"));
