// Cone penetration tests (CPT; CPTu with pore pressure), read from GEF files (the Dutch Geotechnical Exchange Format),
// from the Dutch Key Register of the Subsurface (BRO, IMBRO XML) and from DOV (Databank Ondergrond Vlaanderen) XML,
// and what follows from their readings without interpretation: the friction ratio, the readings at a depth, averages
// over depth, and fewer readings for drawing.
import {parseXml,withoutPrefixes,XmlNode,descendants,childNodes,textOf} from "./xml";
import {Cpt} from "./schema";

// A CPT as read from a file. Its position is in the coordinate system `crs` (an EPSG code) where the file names one,
// else by latitude and longitude, else in the project's coordinates; `notes` say what was converted or assumed, and
// `source` names the register it comes from.
export interface CptRead { cpt:Cpt; crs?:string; notes:string[]; source?:string }

const finite=(v:number|undefined):v is number=>v!==undefined&&Number.isFinite(v);
// Converted values keep six significant figures, so 0.052 MPa reads as 52 kPa.
const scaled=(v:number,f:number)=>f===1||!Number.isFinite(v)?v:Number((v*f).toPrecision(6));

// ---------- what the readings give ----------

// The scales CPTs are drawn at: qc up to a round value at or above the largest reading, Rf up to 10 % (larger ratios,
// as in peat, at the edge).
export const RF_SCALE=10;
export function cptScale(max:number){return [5,10,15,20,25,30,40,50,60,80,100,150,200].find(v=>v>=max-1e-9)??Math.ceil(max/50)*50}

// The readings shown as fields and in the read-outs, by their keys in src/properties.ts.
export const CPT_KEYS=["qc","fs","Rf","u2"] as const;
export type CptKey=typeof CPT_KEYS[number];

const ratios=new WeakMap<Cpt,number[]>();
// The friction ratio at each reading in percent: as the data give it, else fs/qc (fs in kPa, qc in MPa).
export function frictionRatio(c:Cpt):number[]{
  let r=ratios.get(c);
  if(!r){
    r=c.qc.map((q,i)=>{const g=c.rf?.[i];if(finite(g))return g;const f=c.fs?.[i];return finite(f)&&q>0?f/(10*q):NaN});
    ratios.set(c,r);
  }
  return r;
}
export function cptSeries(c:Cpt,key:CptKey):number[]|undefined{
  return key==="qc"?c.qc:key==="fs"?c.fs:key==="u2"?c.u2:c.fs||c.rf?frictionRatio(c):undefined;
}
// The keys a CPT has readings for.
export const cptKeys=(c:Cpt)=>CPT_KEYS.filter(k=>cptSeries(c,k)?.some(Number.isFinite));

export interface CptValues { qc:number; fs:number; u2:number; rf:number }
// The readings at a depth, linear between the readings either side; NaN outside the test, or where a reading is missing.
export function cptAt(c:Cpt,depth:number):CptValues{
  const d=c.depth,n=d.length;
  if(!n||depth<d[0]-1e-9||depth>d[n-1]+1e-9)return {qc:NaN,fs:NaN,u2:NaN,rf:NaN};
  let lo=0,hi=n-1;
  while(hi-lo>1){const m=(lo+hi)>>1;if(d[m]<=depth)lo=m;else hi=m}
  const t=d[hi]>d[lo]?Math.min(1,Math.max(0,(depth-d[lo])/(d[hi]-d[lo]))):0;
  const at=(a?:number[])=>a?a[lo]+t*(a[hi]-a[lo]):NaN;
  return {qc:at(c.qc),fs:at(c.fs),u2:at(c.u2),rf:at(c.fs||c.rf?frictionRatio(c):undefined)};
}

export interface CptAverage { depth:number; qc:number; fs:number; u2:number; rf:number }
// The mean readings over each `step` metres of depth (0 to step, step to 2·step…), at the mean depth of the readings
// in it. The friction ratio is the mean of the ratios the data give, else the ratio of the means.
export function cptAverages(c:Cpt,step:number):CptAverage[]{
  const out:CptAverage[]=[],sum={d:0,qc:0,fs:0,u2:0,rf:0},count={d:0,qc:0,fs:0,u2:0,rf:0};
  let bin=NaN;
  const flush=()=>{
    if(!count.d)return;
    const mean=(k:"qc"|"fs"|"u2"|"rf")=>count[k]?sum[k]/count[k]:NaN;
    const qc=mean("qc"),fs=mean("fs");
    out.push({depth:sum.d/count.d,qc,fs,u2:mean("u2"),rf:count.rf?mean("rf"):Number.isFinite(fs)&&qc>0?fs/(10*qc):NaN});
    for(const k of Object.keys(sum) as Array<keyof typeof sum>){sum[k]=0;count[k]=0}
  };
  c.depth.forEach((d,i)=>{
    if(!Number.isFinite(d))return;
    const b=Math.floor(d/step+1e-9);
    if(b!==bin){flush();bin=b}
    sum.d+=d;count.d++;
    for(const [k,a] of [["qc",c.qc],["fs",c.fs],["u2",c.u2],["rf",c.rf]] as const){const v=a?.[i];if(finite(v)){sum[k]+=v;count[k]++}}
  });
  flush();
  return out;
}

// The readings to draw: the first, the last, and between them none closer than `step` metres to the one before.
export function thinned(c:Cpt,step:number):number[]{
  const d=c.depth,keep:number[]=[];
  for(let i=0;i<d.length;i++)if(!keep.length||i===d.length-1||d[i]-d[keep[keep.length-1]]>=step-1e-9)keep.push(i);
  return keep;
}

// Readings in order of depth, with the rows that have no depth, or no reading at all, left out.
export interface CptRow { depth:number; qc:number; fs:number; u2:number; rf:number; qt?:number }
export function cptReadings(id:string,rows:CptRow[]):Pick<Cpt,"depth"|"qc"|"fs"|"u2"|"rf"|"qt">{
  const kept=rows.filter(r=>Number.isFinite(r.depth)&&[r.qc,r.fs,r.u2,r.rf].some(Number.isFinite)).sort((a,b)=>a.depth-b.depth);
  if(!kept.some(r=>Number.isFinite(r.qc)))throw new Error(`${id}: no cone resistance (qc) readings`);
  const col=(k:"fs"|"u2"|"rf"|"qt")=>kept.some(r=>Number.isFinite(r[k]??NaN))?{[k]:kept.map(r=>r[k]??NaN)}:{};
  return {depth:kept.map(r=>r.depth),qc:kept.map(r=>r.qc),...col("fs"),...col("u2"),...col("rf"),...col("qt")};
}
// Depths written as negative numbers (downwards) are made positive.
function downwards(rows:Array<{depth:number}>,notes:string[]){
  const d=rows.map(r=>r.depth).filter(Number.isFinite);
  if(d.filter(v=>v<0).length>d.length/2){for(const r of rows)r.depth=-r.depth;notes.push("depths are written as negative numbers; read downwards")}
}
const isoDate=(y:string,m:string,d:string)=>/^\d{4}$/.test(y)&&Number(m)>=1&&Number(m)<=12&&Number(d)>=1&&Number(d)<=31?`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`:undefined;
const baseName=(file:string)=>file.replace(/^.*[\\/]/,"").replace(/\.[^.]+$/,"");

// ---------- GEF ----------

export const isGef=(text:string)=>/^\s*#GEFID\s*=/i.test(text.slice(0,500));
// GEF quantity numbers of the columns read (GEF-CPT-Report): penetration length, cone resistance, sleeve friction,
// friction ratio, pore pressures u1, u2 and u3, the resultant inclination, the depth corrected for inclination, and the
// corrected cone resistance qt.
const Q={length:1,qc:2,fs:3,rf:4,u1:5,u2:6,u3:7,inclination:8,depth:11,qt:13};
// The factor from a unit of pressure to kPa: SI, bar, kgf/cm², and the US units tsf (short tons per square foot), ksf
// and psi; null for any other.
const PRESSURE_UNITS:Array<[RegExp,number]>=[[/^(mpa|mn\/m2|n\/mm2)$/,1000],[/^(kpa|kn\/m2)$/,1],[/^(pa|n\/m2)$/,0.001],[/^bar$/,100],
  [/^(kgf\/cm2|kg\/cm2)$/,98.0665],[/^tsf$/,95.7605],[/^ksf$/,47.8803],[/^psi$/,6.89476]];
export function pressureKpa(unit:string){
  const u=unit.toLowerCase().replace(/\s/g,"").replace(/²/g,"2");
  return PRESSURE_UNITS.find(([re])=>re.test(u))?.[1]??null;
}
// The factor from a GEF column's unit to MPa or kPa; GEF gives pressures in MPa, so an unstated unit is MPa.
function pressureFactor(unit:string,to:"MPa"|"kPa"){
  const k=unit.trim()?pressureKpa(unit):1000;
  return k===null?null:to==="MPa"?k/1000:k;
}

export function readGef(text:string,file:string):CptRead[]{
  const lines=text.replace(/^﻿/,"").split(/\r?\n/),end=lines.findIndex(l=>/^\s*#EOH\s*=?/i.test(l));
  if(end<0)throw new Error(`${file}: no end of the GEF header (#EOH)`);
  const raw=new Map<string,string[]>();
  for(const l of lines.slice(0,end)){
    const m=l.match(/^\s*#([A-Z0-9_]+)\s*=\s?(.*)$/i);
    if(m)raw.set(m[1].toUpperCase(),[...(raw.get(m[1].toUpperCase())??[]),m[2]]);
  }
  const values=(key:string)=>(raw.get(key)??[]).map(v=>v.split(",").map(s=>s.trim()));
  const first=(key:string)=>values(key)[0]??[];
  const code=[...first("REPORTCODE"),...first("PROCEDURECODE")].join(" ");
  if(/GEF-BORE/i.test(code))throw new Error(`${file}: a GEF borehole log (GEF-BORE-Report); only GEF files of cone penetration tests (GEF-CPT-Report) are read`);
  if(/GEF-DISS/i.test(code))throw new Error(`${file}: a GEF dissipation test; only GEF files of cone penetration tests (GEF-CPT-Report) are read`);
  const notes:string[]=[],id=first("TESTID").filter(Boolean).join(", ")||baseName(file);
  // Columns: number, unit, name and quantity number (last, as a name may hold a comma); and the value that marks a
  // reading as missing.
  const info=values("COLUMNINFO").map(v=>({col:Number(v[0]),unit:v[1]??"",q:Number(v[v.length-1])})).filter(c=>c.col>0);
  const voids=new Map(values("COLUMNVOID").map(v=>[Number(v[0]),Number(v[1])]));
  const column=(q:number)=>info.find(c=>c.q===q);
  if(!column(Q.qc))throw new Error(`${file}: no cone resistance column (GEF quantity 2) in the header`);
  if(!column(Q.length)&&!column(Q.depth))throw new Error(`${file}: no penetration length or depth column (GEF quantity 1 or 11) in the header`);
  // Separators: a column separator character, else white space; a record separator, else the end of the line.
  const sepOf=(key:string)=>(raw.get(key)?.[0]??"").trim().charAt(0);
  const colSep=sepOf("COLUMNSEPARATOR"),recSep=sepOf("RECORDSEPARATOR");
  const body=lines.slice(end+1).join("\n");
  const records=(recSep?body.split(recSep).flatMap(r=>r.split("\n")):body.split("\n")).map(r=>r.trim()).filter(Boolean);
  const table=records.map(r=>{
    const f=(colSep?r.split(colSep):r.split(/\s+/)).map(s=>s.trim());
    while(f.length&&f[f.length-1]==="")f.pop();
    return f;
  });
  const read=(q:number,to?:"MPa"|"kPa",what?:string)=>{
    const c=column(q);
    if(!c)return undefined;
    let factor=1;
    if(to){
      const f=pressureFactor(c.unit,to);
      if(f===null)notes.push(`${what} is in “${c.unit}”; read as MPa, the GEF unit`);
      factor=f??(to==="kPa"?1000:1);
    }
    const v=voids.get(c.col);
    return table.map(r=>{const x=Number(r[c.col-1]);return r[c.col-1]===undefined||r[c.col-1]===""||!Number.isFinite(x)||(v!==undefined&&Math.abs(x-v)<1e-9)?NaN:scaled(x,factor)});
  };
  const corrected=read(Q.depth),length=read(Q.length);
  const useCorrected=!!corrected?.some(Number.isFinite);
  if(!useCorrected&&column(Q.inclination))notes.push("depth is the penetration length: the file has no depth corrected for inclination");
  const depth=useCorrected?corrected!:length!;
  const qc=read(Q.qc,"MPa","qc")!,fs=read(Q.fs,"kPa","fs"),u2=read(Q.u2,"kPa","u2"),rf=read(Q.rf),qt=read(Q.qt,"MPa","qt");
  if(!u2&&(column(Q.u1)||column(Q.u3)))notes.push(`pore pressure ${column(Q.u1)?"u1":"u3"} is not read; only u2, behind the cone`);
  const rows=depth.map((d,i)=>({depth:d,qc:qc[i],fs:fs?.[i]??NaN,u2:u2?.[i]??NaN,rf:rf?.[i]??NaN,qt:qt?.[i]??NaN}));
  downwards(rows,notes);
  const cpt:Cpt={id,x:NaN,y:NaN,z:NaN,...cptReadings(id,rows)};
  // Position: XYID gives the coordinate system code (31000 is RD, the Dutch national grid), then x and y; ZID the
  // vertical datum code (31000 is NAP) and the level the depths start from.
  const xy=first("XYID"),zid=first("ZID");
  let crs:string|undefined;
  if(xy.length>=3){
    cpt.x=Number(xy[1]);cpt.y=Number(xy[2]);
    const c=xy[0].replace(/^0+(?=\d)/,"");
    crs=c==="31000"?"EPSG:28992":/^\d{4,5}$/.test(c)?`EPSG:${c}`:undefined;
    if(!crs)notes.push(`coordinate system code ${xy[0]||"(none)"} is not known; positions are read in the project's coordinates`);
  }
  if(zid.length>=2&&Number.isFinite(Number(zid[1]))){
    cpt.z=Number(zid[1]);
    if(zid[0].replace(/^0+(?=\d)/,"")!=="31000")notes.push(`levels are in vertical datum code ${zid[0]}, not NAP (31000)`);
  }
  const date=first("STARTDATE"),vars=values("MEASUREMENTVAR"),level=values("MEASUREMENTTEXT").find(v=>Number(v[0])===9);
  const pre=vars.find(v=>Number(v[0])===13),area=vars.find(v=>Number(v[0])===3);
  const day=date.length>=3?isoDate(date[0],date[1],date[2]):undefined;
  if(day)cpt.date=day;
  if(pre&&Number(pre[1])>0)cpt.predrill=Number(pre[1]);
  // The net area ratio of the cone (MEASUREMENTVAR 3), which corrects qc for the pore pressure behind it.
  if(area&&Number(area[1])>0&&Number(area[1])<=1)cpt.a=Number(area[1]);
  if(level&&/water|bodem|seabed|sea ?bed|mudline/i.test(level[1]??""))notes.push("depths start at the water bed");
  return [{cpt,crs,notes}];
}

// ---------- BRO ----------

export const isBroCpt=(text:string)=>/broservices\.nl\/xsd\/(?:dscpt|cptcommon|isbro-cpt)/.test(text.slice(0,4000));
// The columns of a BRO CPT result record, in the order the BRO lists its parameters.
const BRO_COLUMNS=["penetrationLength","depth","elapsedTime","coneResistance","correctedConeResistance","netConeResistance",
  "magneticFieldStrengthX","magneticFieldStrengthY","magneticFieldStrengthZ","magneticFieldStrengthTotal","electricalConductivity",
  "inclinationEW","inclinationNS","inclinationX","inclinationY","inclinationResultant","magneticInclination","magneticDeclination",
  "localFriction","poreRatio","temperature","porePressureU1","porePressureU2","porePressureU3","frictionRatio"];
const srsCode=(n?:XmlNode)=>n?.attrs.srsName?.match(/(\d+)\s*$/)?.[1]??"";
const posOf=(n?:XmlNode)=>n?textOf(n,"pos").split(/\s+/).map(Number):[NaN,NaN];

export function readBroCpt(text:string,file:string):CptRead[]{
  const doc=withoutPrefixes(parseXml(text)),objects=descendants(doc,"CPT_O");
  if(!objects.length)throw new Error(`${file}: no BRO cone penetration test (CPT_O) in the file`);
  return objects.map(o=>{
    const notes:string[]=[],id=textOf(o,"broId")||baseName(file);
    // The delivered position where it is in RD New; the standardized ETRS89 latitude and longitude otherwise.
    const delivered=descendants(childNodes(o,"deliveredLocation")[0]??{tag:"",attrs:{},children:[],text:""},"location")[0];
    const standard=descendants(childNodes(o,"standardizedLocation")[0]??{tag:"",attrs:{},children:[],text:""},"location")[0];
    const cpt:Cpt={id,x:NaN,y:NaN,z:NaN,depth:[],qc:[]};
    let crs:string|undefined;
    if(srsCode(delivered)==="28992"){[cpt.x,cpt.y]=posOf(delivered);crs="EPSG:28992"}
    const [lat,lon]=standard?posOf(standard):["4258","4326"].includes(srsCode(delivered))?posOf(delivered):[NaN,NaN];
    if(Number.isFinite(lat)&&Number.isFinite(lon)){cpt.lat=lat;cpt.lon=lon}
    const vertical=childNodes(o,"deliveredVerticalPosition")[0];
    const reference=vertical?textOf(vertical,"localVerticalReferencePoint"):"",datum=vertical?textOf(vertical,"verticalDatum"):"";
    const z=vertical?Number(textOf(vertical,"offset")||NaN):NaN;
    if(Number.isFinite(z))cpt.z=z;
    if(reference&&reference!=="maaiveld")notes.push(`depths start at the ${reference==="waterbodem"?"water bed":reference}, not the ground surface`);
    if(datum&&datum!=="NAP")notes.push(`levels are in ${datum}, not NAP`);
    const survey=childNodes(o,"conePenetrometerSurvey")[0]??o;
    const pre=Number(textOf(survey,"predrilledDepth")||NaN),day=textOf(survey,"timePosition").slice(0,10);
    if(pre>0)cpt.predrill=pre;
    if(/^\d{4}-\d{2}-\d{2}$/.test(day))cpt.date=day;
    // The readings: records of tokens, columns in the order of the parameters listed with them; -999999 is no value.
    const result=descendants(survey,"cptResult")[0];
    if(!result)throw new Error(`${file}: ${id} has no readings (cptResult)`);
    const enc=descendants(result,"TextEncoding")[0]?.attrs??{},token=enc.tokenSeparator||",",block=enc.blockSeparator||";",dec=enc.decimalSeparator||".";
    const listed=descendants(survey,"parameters")[0]?.children.map(c=>c.tag)??[],names=listed.length===BRO_COLUMNS.length?listed:BRO_COLUMNS;
    const records=textOf(result,"values").split(block).map(r=>r.trim()).filter(Boolean)
      .map(r=>r.split(token).map(v=>{const x=Number(dec==="."?v:v.split(dec).join("."));return Number.isFinite(x)&&x>-99999?x:NaN}));
    const at=(name:string,r:number[])=>{const k=names.indexOf(name);return k<0?NaN:r[k]??NaN};
    const useDepth=records.some(r=>Number.isFinite(at("depth",r)));
    if(!useDepth&&records.some(r=>Number.isFinite(at("inclinationResultant",r))))notes.push("depth is the penetration length: the BRO gives no depth corrected for inclination");
    const rows=records.map(r=>({depth:at(useDepth?"depth":"penetrationLength",r),qc:at("coneResistance",r),fs:scaled(at("localFriction",r),1000),
      u2:scaled(at("porePressureU2",r),1000),rf:at("frictionRatio",r),qt:at("correctedConeResistance",r)}));
    // The net area ratio of the cone, which corrects qc for the pore pressure behind it.
    const area=Number(textOf(survey,"coneSurfaceQuotient")||NaN);
    if(area>0&&area<=1)cpt.a=area;
    return {cpt:{...cpt,...cptReadings(id,rows)},crs,notes,source:"BRO, Basisregistratie Ondergrond: cone penetration tests (CPT), public domain (CC0)"};
  });
}

// ---------- DOV ----------

// A DOV CPT (sondering), as DOV serves it at dov.vlaanderen.be/data/sondering/…: an interpretation only refers to one.
export const isDovCpt=(text:string)=>/kern\.schemas\.dov\.vlaanderen\.be/.test(text.slice(0,3000))&&/<sondering>\s*<sondeernummer>/.test(text);
// DOV's positions: Belgian Lambert 72 (6190 with Ostend heights) or Lambert 2008 (8370), heights in metres TAW.
const DOV_CRS:Record<string,string>={"6190":"EPSG:31370","31370":"EPSG:31370","8370":"EPSG:3812","3812":"EPSG:3812"};

export function readDovCpt(text:string,file:string):CptRead[]{
  const doc=withoutPrefixes(parseXml(text));
  const tests=descendants(doc,"sondering").filter(s=>childNodes(s,"sondeernummer").length);
  if(!tests.length)throw new Error(`${file}: no DOV cone penetration test (sondering) in the file`);
  const num=(s:string)=>s===""?NaN:Number(s.replace(",","."));
  return tests.map(s=>{
    const notes:string[]=["levels are in metres TAW"],id=textOf(s,"sondeernummer");
    const points=descendants(childNodes(s,"ligging")[0]??s,"Point"),point=points.find(p=>DOV_CRS[srsCode(p)]);
    const [x,y,z]=posOf(point);
    const cpt:Cpt={id,x:point?x:NaN,y:point?y:NaN,z:Number.isFinite(z)?z:NaN,depth:[],qc:[]};
    const survey=childNodes(s,"sondeonderzoek")[0]??s,day=textOf(s,"datum_aanvang").slice(0,10),pit=num(textOf(survey,"diepte_put")),area=num(textOf(survey,"net_area_ratio"));
    if(/^\d{4}-\d{2}-\d{2}$/.test(day))cpt.date=day;
    if(pit>0)cpt.predrill=pit;
    if(area>0&&area<=1)cpt.a=area;
    // Readings: penetration length and depth in m, qc in MPa, fs and u in kPa. DOV does not say where on the cone u is
    // measured.
    const data=descendants(s,"meetdata");
    const useDepth=data.some(m=>Number.isFinite(num(textOf(m,"diepte"))));
    const rows=data.map(m=>({depth:num(textOf(m,useDepth?"diepte":"lengte")),qc:num(textOf(m,"qc")),fs:num(textOf(m,"fs")),u2:num(textOf(m,"u")),rf:NaN}));
    if(rows.some(r=>Number.isFinite(r.u2)))notes.push("DOV does not say where on the cone the pore pressure u is measured; it is shown as u2");
    if(!useDepth)notes.push("depth is the penetration length: no depth corrected for inclination is given");
    return {cpt:{...cpt,...cptReadings(id,rows)},crs:point?DOV_CRS[srsCode(point)]:undefined,notes,source:"Databank Ondergrond Vlaanderen (DOV): cone penetration tests"};
  });
}
