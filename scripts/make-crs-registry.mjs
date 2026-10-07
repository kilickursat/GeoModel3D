// Generates src/data/crs.json: the coordinate reference systems offered by the viewer, with their PROJ definitions
// and areas of use, from the EPSG dataset as served by epsg.io. Run with network access; the output is committed so
// the viewer works offline. WGS 84 / UTM zones are generated here and need no download.
import {writeFileSync} from "node:fs";

const range=(a,b)=>Array.from({length:b-a+1},(_,i)=>a+i);
// [region, EPSG codes, optional name filter for scanned code ranges]
const groups=[
  ["Japan",[...range(6669,6687),...range(2443,2461),...range(30161,30179)]],
  ["United Kingdom",[27700]],
  ["Ireland",[2157,29903]],
  ["Netherlands",[28992]],
  ["Belgium",[31370,3812]],
  ["Luxembourg",[2169]],
  ["France",[2154,...range(3942,3950)]],
  ["Germany",[25832,25833,31466,31467,31468,31469]],
  ["Switzerland",[2056,21781]],
  ["Austria",[31254,31255,31256,31287]],
  ["Italy",[6707,6708,6709,3003,3004]],
  ["Spain",[25829,25830,25831]],
  ["Portugal",[3763]],
  ["Nordic countries",[25834,25835,3006,3067]],
  ["Poland",[2180,2176,2177,2178,2179]],
  ["Hungary",[23700]],
  ["Romania",[3844]],
  ["Greece",[2100]],
  ["Türkiye",range(5253,5259)],
  ["Israel",[2039]],
  ["United Arab Emirates",[3997]],
  ["China",range(4534,4554)],
  ["Hong Kong",[2326]],
  ["Taiwan",[3826,3825]],
  ["South Korea",[5185,5186,5187,5188,5179]],
  ["Singapore",[3414]],
  ["Malaysia",[3375,3376]],
  ["Australia",[...range(7846,7859),...range(28348,28358)]],
  ["New Zealand",[2193]],
  ["United States",range(26903,26923),/^NAD83 \/ UTM zone \d+N$/],
  ["United States",[...range(26929,26998),...range(32100,32161)],/^NAD83 \/ (?!.*\((?:ft|ftUS)\)).*$/],
  ["Canada",[...range(2955,2962),...range(3154,3160),3761],/^NAD83\(CSRS\) \/ UTM zone/],
  ["Mexico",[6372]],
  ["Colombia",[9377]],
  ["Brazil",range(31972,31985),/^SIRGAS 2000 \/ UTM zone/],
  ["Argentina",range(5343,5349),/^POSGAR 2007 \/ Argentina/],
];
// Datum shifts given by grid files that the browser library cannot load are replaced by the EPSG Helmert
// transformation to WGS 84, with its stated accuracy.
const helmert=[
  [/^OSGB36\b|OSGB 1936/,"446.448,-125.157,542.06,0.15,0.247,0.842,-20.489","2 m (OSTN15 grid not applied)"],
  [/^DHDN\b/,"598.1,73.7,418.2,0.202,0.045,-2.455,6.7","3 m (BETA2007 grid not applied)"],
  [/^MGI\b/,"577.326,90.129,463.919,5.137,1.474,5.297,2.4232","1.5 m (grid not applied)"],
  [/^CH1903\b/,"674.374,15.056,405.346,0,0,0,0","1 m (CHENyx06 grid not applied)"],
  [/^CH1903\+/,"674.374,15.056,405.346,0,0,0,0","1 m (CHENyx06 grid not applied)"],
  [/^Monte Mario\b/,"-104.1,-49.1,-9.9,0.971,-2.917,0.714,-11.68","3 m (grid not applied)"],
  [/^Belge 1972\b/,"-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747","1 m (grid not applied)"],
  [/^Tokyo\b/,"-146.414,507.337,680.507,0,0,0,0","9 m (TKY2JGD grid not applied)"],
  [/^TM75\b/,"482.5,-130.6,564.6,-1.042,-0.214,-0.631,8.15","1 m"],
  [/^HD72\b/,"52.17,-71.82,-14.9,0,0,0,0","1 m"],
];

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(url){
  for(let attempt=0;attempt<3;attempt++){
    try{const r=await fetch(url,{headers:{"User-Agent":"GeoModel3D CRS registry (github.com/kilickursat/GeoModel3D)"}});if(r.ok)return r;if(r.status===404)return null}catch{}
    await sleep(1500);
  }
  return null;
}

const entries=[],skipped=[];
for(const [region,codes,filter] of groups){
  for(const code of codes){
    const meta=await get(`https://epsg.io/${code}.json`);
    if(!meta){skipped.push(`${code}: not found`);continue}
    const json=await meta.json();
    if(json.type!=="ProjectedCRS"){skipped.push(`${code}: ${json.type}`);continue}
    if(filter&&!filter.test(json.name)){skipped.push(`${code}: ${json.name} (filtered)`);continue}
    let proj4=(await (await get(`https://epsg.io/${code}.proj4`)).text()).trim().replace(/\s*\+type=crs/,"");
    const base=json.base_crs?.name??"";
    const h=helmert.find(([re])=>re.test(json.name)||re.test(base));
    if(/\+nadgrids=/.test(proj4)||(!/\+towgs84=|\+datum=/.test(proj4)&&!/GRS80|WGS84/.test(proj4))){
      if(!h){skipped.push(`${code}: ${json.name}: datum shift unavailable (${proj4})`);continue}
      proj4=proj4.replace(/\s*\+nadgrids=\S+/,"").replace(/\s*\+towgs84=\S+/,"").replace(" +units"," +towgs84="+h[1]+" +units");
    }
    const note=h?`Datum shift to WGS 84 accurate to about ${h[2]}`:undefined;
    if(!/\+units=m\b/.test(proj4)){skipped.push(`${code}: ${json.name}: not in metres`);continue}
    const b=json.bbox??json.usages?.find(u=>u.bbox)?.bbox;
    entries.push({code:`EPSG:${code}`,name:json.name,region,proj4,bbox:b?[b.west_longitude,b.south_latitude,b.east_longitude,b.north_latitude]:null,...(note?{note}:{})});
    process.stdout.write(".");
    await sleep(150);
  }
}
// A system without an area of use (some legacy ones) takes it from a system with the same projection name.
for(const e of entries.filter(e=>!e.bbox)){
  const same=entries.find(f=>f.bbox&&f.name.split(" / ")[1]===e.name.split(" / ")[1]);
  if(same)e.bbox=same.bbox;else skipped.push(`${e.code}: ${e.name}: no area of use`);
}
for(let z=1;z<=60;z++)for(const south of [false,true]){
  const w=-180+(z-1)*6;
  entries.push({code:`EPSG:${(south?32700:32600)+z}`,name:`WGS 84 / UTM zone ${z}${south?"S":"N"}`,region:"World (UTM)",
    proj4:`+proj=utm +zone=${z}${south?" +south":""} +datum=WGS84 +units=m +no_defs`,bbox:[w,south?-80:0,w+6,south?0:84]});
}
writeFileSync(new URL("../src/data/crs.json",import.meta.url),JSON.stringify(entries.filter(e=>e.bbox)).replace(/\},\{/g,"},\n{")+"\n");
console.log(`\n${entries.length} systems written; skipped:\n${skipped.join("\n")}`);
