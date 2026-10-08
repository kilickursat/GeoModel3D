// Generates src/data/antwerp-site.json: a real site from DOV (Databank Ondergrond Vlaanderen) in the centre of Antwerp,
// Belgium: the formal lithostratigraphic interpretation of every borehole at least 15 m deep in a 3 × 3 km square over
// the old town and the Scheldt. The borehole and interpretation XML are downloaded once into .cache/dov and read with the
// viewer's own importer.
//   npx esbuild scripts/make-antwerp-site.ts --bundle --platform=node --format=esm --outfile=.cache/make-antwerp.mjs && node .cache/make-antwerp.mjs [--discover]
// --discover lists the interpretations DOV serves for the square today, to pin below.
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {importFiles,toProjectJson} from "../src/io";
import {GeoProject,UnitDef} from "../src/geology";
import {PINNED} from "./antwerp-interpretations";

const BOX=[150500,210750,153500,213750],MIN_DEPTH=15;
const UA={"User-Agent":"GeoModel3D reference data (github.com/kilickursat/GeoModel3D)"};
const cache=new URL("../.cache/dov/",import.meta.url);
mkdirSync(cache,{recursive:true});

async function get(url:string,file:string){
  const path=new URL(file,cache);
  if(!existsSync(path)){
    const r=await fetch(url,{headers:UA});
    if(!r.ok)throw new Error(`${url}: HTTP ${r.status}`);
    writeFileSync(path,new Uint8Array(await r.arrayBuffer()));
    await new Promise(res=>setTimeout(res,250));
  }
  return readFileSync(path,"utf8");
}

if(process.argv.includes("--discover")){
  const wfs=`https://www.dov.vlaanderen.be/geoserver/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=interpretaties:formele_stratigrafie&outputFormat=application/json&srsName=EPSG:31370&bbox=${BOX.join(",")},EPSG:31370`;
  const features=JSON.parse(await (await fetch(wfs,{headers:UA})).text()).features.map((f:any)=>f.properties);
  // The latest interpretation of each borehole (DOV keeps earlier ones).
  const latest=new Map<string,any>();
  for(const p of features){
    if(p.Type_proef!=="Boring"||Number(p.diepte_tot_m)<MIN_DEPTH)continue;
    const prev=latest.get(p.Proeffiche);
    if(!prev||`${p.Datum}|${p.Interpretatiefiche}`>`${prev.Datum}|${prev.Interpretatiefiche}`)latest.set(p.Proeffiche,p);
  }
  const pairs=[...latest.values()].map(p=>[p.Proeffiche.split("/").pop(),p.Interpretatiefiche.split("/").pop()]).sort();
  writeFileSync(new URL("../scripts/antwerp-interpretations.ts",import.meta.url),`// Borehole and formal-stratigraphy interpretation keys of the Antwerp site, as DOV served them on ${new Date().toISOString().slice(0,10)}.\nexport const PINNED:Array<[string,string]>=${JSON.stringify(pairs)};\n`);
  console.log(`${pairs.length} boreholes pinned`);
  process.exit(0);
}

const files:Array<{name:string;text:string}>=[];
for(const [boring,interpretation] of PINNED){
  files.push({name:`boring-${boring}.xml`,text:await get(`https://www.dov.vlaanderen.be/data/boring/${boring}.xml`,`boring-${boring}.xml`)});
  files.push({name:`interpretatie-${interpretation}.xml`,text:await get(`https://www.dov.vlaanderen.be/data/interpretatie/${interpretation}.xml`,`interpretatie-${interpretation}.xml`)});
}
const {project:imported,warnings}=importFiles(files);

// The model's units: the Neogene and Paleogene formations as interpreted; the thin and patchy Quaternary formations of
// the newer interpretations (Vlaanderen, Arenberg, Eeklo, Gent) together with the undifferentiated Quaternary in one
// erosive unit, whose base is the unconformity cut into the Neogene; disturbed ground with made ground. Intervals
// interpreted as unknown or as undifferentiated Neogene are left as gaps in the logs. Every interval keeps DOV's name.
const GROUP:Record<string,string>={A:"Made ground",G:"Made ground",Q:"Quaternary",QH:"Quaternary",QP:"Quaternary",Vl:"Quaternary",Ab:"Quaternary",El:"Quaternary",Gt:"Quaternary",
  Kd:"Kattendijk",Bc:"Berchem",Bm:"Boom"};
const GAPS=new Set(["U","Ne"]);
// Colours after the Belgian geological maps: Quaternary pale yellow, the Pliocene and the glauconitic Miocene sands in
// yellow-green and green, the Oligocene Boom Clay blue-grey.
const units:UnitDef[]=[
  {id:"Made ground",name:"Made ground and disturbed ground",color:"#9a5b4f"},
  {id:"Quaternary",name:"Quaternary deposits",color:"#e9dba0",erosive:true},
  {id:"Kattendijk",name:"Kattendijk Formation (Pliocene)",color:"#c4c27a"},
  {id:"Berchem",name:"Berchem Formation (Miocene)",color:"#6f9e6b"},
  {id:"Boom",name:"Boom Formation (Oligocene)",color:"#6b7b90"}
];
const unknown=new Set(imported.boreholes.flatMap(b=>b.intervals.map(i=>i.unit)).filter(u=>!GROUP[u]&&!GAPS.has(u)));
if(unknown.size)throw new Error(`Units not grouped: ${[...unknown].join(", ")}`);
// Below the deepest interpreted layer nothing is known: the holes end there, so the model base is the deepest
// interpreted contact rather than the bottom of the few holes drilled 170 m deep.
const boreholes=imported.boreholes.map(b=>{
  const {depth:_,...hole}=b;
  return {...hole,intervals:b.intervals.filter(i=>!GAPS.has(i.unit)).map(i=>({...i,unit:GROUP[i.unit]}))};
}).filter(b=>b.intervals.length);
const dates=files.filter(f=>f.name.startsWith("interpretatie-")).map(f=>f.text.match(/<datum>(\d{4}-\d\d-\d\d)<\/datum>/)?.[1]).filter(Boolean).sort();
const project:GeoProject={
  name:"Antwerp, Belgium (DOV)",
  description:`${boreholes.length} boreholes in the centre of Antwerp, 15 m deep or more, with DOV's formal lithostratigraphic interpretation of each (${dates[0]?.slice(0,4)}–${dates.at(-1)?.slice(0,4)}): made ground and Quaternary deposits over the Pliocene Kattendijk and Miocene Berchem sands and the Oligocene Boom Clay. The thin Quaternary formations are one unit here; each interval keeps DOV's name. Heights in metres TAW. Terrain from Terrain Tiles, fetched when the project opens.`,
  source:"Databank Ondergrond Vlaanderen (DOV): formal stratigraphy, Flemish Government (VPO); consulted on 07/10/2026, on https://www.dov.vlaanderen.be. Free reuse under the Flemish model licence for free reuse.",
  crs:imported.crs,crsCode:imported.crsCode,
  units,boreholes
};
writeFileSync(new URL("../src/data/antwerp-site.json",import.meta.url),toProjectJson(project));
console.log(`${project.boreholes.length} boreholes`);
console.log(warnings.join("\n"));
