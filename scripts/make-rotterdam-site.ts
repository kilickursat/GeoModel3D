// Generates src/data/rotterdam-site.json: a real site from the Dutch Key Register of the Subsurface (BRO) on Maasvlakte 2,
// Port of Rotterdam: every geotechnical borehole (BHR-GT) in a 3.9 × 3.5 km rectangle over the Prinses Amaliahaven,
// with their field descriptions, groundwater levels and laboratory tests. The IMBRO XML is downloaded once into
// .cache/bro and read with the viewer's own importer.
//   npx esbuild scripts/make-rotterdam-site.ts --bundle --platform=node --format=esm --outfile=.cache/make-rotterdam.mjs && node .cache/make-rotterdam.mjs [--discover]
// --discover lists the boreholes the BRO serves for the rectangle today, to pin below.
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {importFiles,toProjectJson} from "../src/io";
import {GeoProject,UnitDef,Borehole,Interval} from "../src/geology";
import {findCrs,toGeographic} from "../src/crs";
import {PINNED} from "./rotterdam-boreholes";

const RD=findCrs("EPSG:28992")!,BOX=[60800,440500,64700,443950];
const UA={"User-Agent":"GeoModel3D reference data (github.com/kilickursat/GeoModel3D)"};
const cache=new URL("../.cache/bro/",import.meta.url);
mkdirSync(cache,{recursive:true});

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
const {project:raw,warnings}=importFiles(files);
const project:GeoProject={
  name:"Maasvlakte 2, Rotterdam (BRO)",
  description:`${raw.boreholes.length} geotechnical boreholes of the Port of Rotterdam on Maasvlakte 2, 2017–2024, from the Dutch Key Register of the Subsurface (BRO), with their groundwater levels and ${raw.boreholes.reduce((n,b)=>n+(b.tests?.length??0),0)} laboratory test results. Land reclaimed in 2008–2013 from the North Sea: sand fill and sea-bed sand over the basal Holocene clay and peat, on Pleistocene sand and gravel. The units are an interpretation of each described log as a sequence (scripts/make-rotterdam-site.ts), with the paving of the quays in the sand; the logs keep the BRO soil names. Boreholes in the harbour basins start at its bed, 17–21 m below NAP. Heights in metres NAP.`,
  source:"BRO, Basisregistratie Ondergrond: geotechnical borehole research (BHR-GT), public domain (CC0)",
  crs:raw.crs,crsCode:raw.crsCode,
  units,boreholes:raw.boreholes.map(interpret)
};
writeFileSync(new URL("../src/data/rotterdam-site.json",import.meta.url),toProjectJson(project));
console.log(`${project.boreholes.length} boreholes`);
console.log(warnings.join("\n"));
