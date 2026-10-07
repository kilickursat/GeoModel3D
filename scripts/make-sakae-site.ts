// Generates src/data/sakae-site.json: a real site from KuniJiban borehole logs around Sakae-ku, Yokohama.
// The logs are downloaded once into .cache/kunijiban (politely, one at a time) and read with the viewer's own importer.
//   npx esbuild scripts/make-sakae-site.ts --bundle --platform=node --format=esm --outfile=.cache/make-sakae.mjs && node .cache/make-sakae.mjs
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {importFiles,decodeText,toProjectJson} from "../src/io";
import {GeoProject,UnitDef,UnitRule} from "../src/geology";
import {projectCrs} from "../src/crs";

// Every KuniJiban borehole of MLIT's Yokohama National Highway Office within 1.5 km of 35.3740° N, 139.5150° E,
// as listed on 2026-10-07.
const IDS=[148301107,148307968,148308424,148309627,148310342,148311676,148312744,148313237,148314501,148315610,357875393,357876192,357877715,
  357878475,357879694,357880996,357881998,357882761,357883181,357884398,357885345,357886732,492907130,492908031,492909100,493185095,493186013,
  493187955,493188031,493189217,493190991,493191302,493192513,493193893,509132859,509133692,509134961,509135046,509155875,509156398,509157933,
  509158124,509159694,509160008,509161721,509162656,509179657,509180124,509181927,509182818,509183488,572815021,572816619,572817691,572818939,
  572819927,572820069,572821314,816451406,816452761,816453437,816454014,816455013,816456105,816457940,816458469,816459197,816460740,816461957,
  816462030,816463247,816464096,816465288,816466444,816467660,816468478,816469143,816470609,816471831,816472586];
// Rock-core logs that describe sandy mudstone from the collar down, where every neighbouring log shows 10–15 m of
// soft alluvium first.
const EXCLUDED=["H29-17-1","H29-17-2","H29-18-1","H29-18-2","H29-18-3"];

const units:UnitDef[]=[
  {id:"Fill",name:"Fill (盛土・埋土)",color:"#a59a8f"},
  {id:"Alluvium",name:"Alluvium (沖積層)",color:"#c7b07a",erosive:true},
  {id:"Kanto Loam",name:"Kanto Loam (関東ローム)",color:"#b8683f"},
  {id:"Pleistocene",name:"Pleistocene sediments (洪積層)",color:"#e0c36a"},
  {id:"Kazusa",name:"Kazusa Group (上総層群)",color:"#5f7186"}
];
// An interpretation of the logged names, N-values and elevations; the logs name no formations.
const rules:UnitRule[]=[
  {match:"盛土|埋土|表土|客土|コンクリート|アスファルト|舗装|砕石|改良土",unit:"Fill"},
  {match:"岩|固結|凝固|硬質",unit:"Kazusa"},
  {match:".",minN:50,unit:"Kazusa"},
  {match:"凝灰質|火山灰",minN:30,unit:"Kazusa"},
  {match:"ローム|黒ボク|軽石|浮石|火山灰|凝灰質",unit:"Kanto Loam"},
  {match:"腐植|泥炭|有機質",maxZ:25,unit:"Alluvium"},
  {match:"シルト|粘土|粘性土",maxN:5,maxZ:25,unit:"Alluvium"},
  {match:"砂|礫",maxN:20,maxZ:25,unit:"Alluvium"},
  {match:".",unit:"Pleistocene"}
];

const cache=new URL("../.cache/kunijiban/",import.meta.url);
mkdirSync(cache,{recursive:true});
const files=[];
for(const id of IDS){
  const path=new URL(`${id}.xml`,cache);
  if(!existsSync(path)){
    const r=await fetch(`https://www.kunijiban.pwri.go.jp/viewer/refer/?data=boring&type=xml&id=${id}`,{headers:{"User-Agent":"GeoModel3D reference data (github.com/kilickursat/GeoModel3D)"}});
    if(!r.ok)throw new Error(`${id}: HTTP ${r.status}`);
    writeFileSync(path,new Uint8Array(await r.arrayBuffer()));
    await new Promise(res=>setTimeout(res,500));
  }
  files.push({name:`${id}.xml`,text:decodeText(new Uint8Array(readFileSync(path)))});
}

const base:GeoProject={name:"",units,rules,boreholes:[]};
const {project:raw,warnings}=importFiles(files,base);
const boreholes=raw.boreholes.filter(b=>!EXCLUDED.includes(b.id));
const crs=projectCrs(raw)!;
const years=files.map(f=>f.text.match(/<調査期間_終了年月日>(\d{4})/)?.[1]).filter(Boolean).map(Number);
const project:GeoProject={
  name:"Sakae, Yokohama (KuniJiban)",
  description:`${boreholes.length} borehole logs from road surveys around Sakae-ku, Yokohama, Japan (Yokohama Circular South Route, Ken-O-Do and Yokohama-Shonan Road; MLIT Yokohama National Highway Office, ${Math.min(...years)}–${Math.max(...years)}). The units are an interpretation of the logged soil names, SPT N-values and elevations by the unit rules, not formations named in the logs: Alluvium is the organic soils, clay and silt with N < 5 and sand and gravel with N < 20 below the 25 m valley floors; the Kazusa Group starts at the first mudstone, cemented silt or layer with N ≥ 50 (the bearing stratum). Terrain: GSI 5 m DEM, fetched when the project opens. Left out: five rock-core logs (${EXCLUDED.join(", ")}) that describe mudstone from the collar down, where every neighbouring log shows 10–15 m of soft alluvium first.`,
  source:"国土地盤情報検索サイト「KuniJiban」の地盤情報 (KuniJiban ground information: MLIT, PWRI, PARI). Individual logs carry no copyright.",
  crs:crs.name,crsCode:crs.code,
  units,rules,boreholes
};
writeFileSync(new URL("../src/data/sakae-site.json",import.meta.url),toProjectJson(project));
console.log(`${boreholes.length} boreholes in ${crs.name}; ${raw.boreholes.length-boreholes.length} left out`);
console.log(warnings.filter(w=>!/intervals reach/.test(w)).join("\n"));
