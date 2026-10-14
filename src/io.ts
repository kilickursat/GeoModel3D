import proj4 from "proj4";
import {Borehole,GeoProject,Interval,UnitDef,UnitRule,SptTest,WaterLevel,TestResult,Alignment,AlignmentPoint,DesignLevel,boreholeDepth,sptN} from "./schema";
import {TerrainGrid,isTerrainFile,readTerrain} from "./terrain";
import {Crs,findCrs,projectCrs,suggestCrs,toProjected,toGeographic,searchCrs} from "./crs";
import {alignmentProblem,chainages,designAt} from "./alignment";
import {isLandXml,readLandXml} from "./landxml";
import {XY} from "./tin";
import {isBoringXml,readBoringXml} from "./boringXml";
import {isBroXml,readBroXml} from "./broXml";
import {isDovXml,readDovXml,interpretationKinds,kindNames,formationOf,stratigraphicName,DovInterpretation} from "./dovXml";
import {applyUnitRules,japaneseLithologyRules,lithologyRules} from "./rules";
import {propertyFromHeader,propertyKey,propertyDef,implausibleTests} from "./properties";

export interface TextFile { name:string; text:string }
// `alignments` names the lines read, when alignment files were among those imported.
export interface ImportResult { project:GeoProject; warnings:string[]; alignments?:string[] }

// ---------- decoding ----------

// Text from file bytes: UTF-8 (or UTF-16 with a byte-order mark) when valid, else the encoding an XML declaration
// names, else Shift_JIS, which Japanese spreadsheets and borehole logs commonly use, else Windows-1252.
export function decodeText(bytes:Uint8Array):string{
  if(bytes[0]===0xff&&bytes[1]===0xfe)return new TextDecoder("utf-16le").decode(bytes);
  if(bytes[0]===0xfe&&bytes[1]===0xff)return new TextDecoder("utf-16be").decode(bytes);
  const declared=new TextDecoder("latin1").decode(bytes.subarray(0,200)).match(/^<\?xml[^>]*encoding=["']([\w.:-]+)["']/i)?.[1];
  const attempt=(label:string)=>{try{return new TextDecoder(label,{fatal:true}).decode(bytes)}catch{return null}};
  return (declared&&!/^utf-?8$/i.test(declared)?attempt(declared):null)??attempt("utf-8")??attempt("shift_jis")??new TextDecoder("windows-1252").decode(bytes);
}

// ---------- CSV ----------

export function parseCsv(text:string,delimiter?:string):string[][]{
  text=text.replace(/^﻿/,"");
  const d=delimiter??sniffDelimiter(text);
  const rows:string[][]=[];
  let row:string[]=[],field="",quoted=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(quoted){
      if(ch==='"'&&text[i+1]==='"'){field+='"';i++}
      else if(ch==='"')quoted=false;
      else field+=ch;
    }else if(ch==='"')quoted=true;
    else if(ch===d){row.push(field);field=""}
    else if(ch==="\n"||ch==="\r"){
      if(ch==="\r"&&text[i+1]==="\n")i++;
      row.push(field);field="";
      if(row.some(f=>f.trim()!==""))rows.push(row);
      row=[];
    }else field+=ch;
  }
  row.push(field);
  if(row.some(f=>f.trim()!==""))rows.push(row);
  return rows;
}
function sniffDelimiter(text:string){
  const line=text.split(/\r?\n/).find(l=>l.trim())??"";
  const count=(c:string)=>line.split('"').filter((_,i)=>i%2===0).join("").split(c).length-1;
  return [",",";","\t"].reduce((best,c)=>count(c)>count(best)?c:best,",");
}
function csvField(v:string|number|undefined){
  const s=v===undefined||Number.isNaN(v)?"":String(v);
  return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
}
export function toCsv(rows:Array<Array<string|number|undefined>>){return rows.map(r=>r.map(csvField).join(",")).join("\n")+"\n"}

// Header names are matched without case, punctuation or a unit in brackets: "Depth From (m)" is "depthfrom".
const norm=(h:string)=>h.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g,"").replace(/[^a-z0-9]/g,"");
// A length is in metres unless its unit names feet (the international foot, or the US survey foot written "US ft"),
// centimetres or millimetres; any other unit, such as m, mbgl, mAOD or m NAP, is read as metres.
const LENGTH_UNITS:Array<[RegExp,number,string]>=[
  [/^(us(survey)?(ft|feet|foot)|ftus|survey(ft|feet|foot))$/,1200/3937,"US survey feet"],
  [/^(international)?(ft|feet|foot)$/,0.3048,"feet"],
  [/^cm$/,0.01,"centimetres"],
  [/^mm$/,0.001,"millimetres"]
];
export function lengthUnit(unit:string){
  const u=unit.toLowerCase().replace(/[\s._-]/g,""),hit=LENGTH_UNITS.find(([re])=>re.test(u));
  return hit?{scale:hit[1],name:hit[2]}:undefined;
}
const bracketed=(h:string)=>h.match(/\(([^)]*)\)|\[([^\]]*)\]/)?.slice(1).find(v=>v!==undefined)??"";
// Converted lengths are kept to the millimetre.
const toMetres=(v:number,scale:number)=>Math.round(v*scale*1000)/1000;
// Lengths converted while reading a file, by column header and the unit converted from.
class Conversions {
  private found=new Map<string,{name:string;order:number}>();
  // The value in metres; `header` and `unit` say where it came from, and `order` places its column in the notes.
  metres(v:number,header:string,unit:string,order=this.found.size){
    const u=lengthUnit(unit);
    if(!u||!Number.isFinite(v))return v;
    if(!this.found.has(header))this.found.set(header,{name:u.name,order});
    return toMetres(v,u.scale);
  }
  // The notes naming the columns converted, and asking for a metric coordinate system where eastings and northings
  // were in feet.
  notes(file:string,coordinates:string[]){
    if(!this.found.size)return [];
    const by=new Map<string,string[]>();
    for(const [header,{name}] of [...this.found].sort((a,b)=>a[1].order-b[1].order))by.set(name,[...(by.get(name)??[]),header]);
    const notes=[`${file}: ${[...by].map(([name,headers])=>`${headers.join(", ")} converted from ${name} to metres`).join("; ")}`];
    const xy=coordinates.filter(h=>this.found.has(h));
    if(xy.length)notes.push(`${file}: the eastings and northings are now in metres, so choose the metric version of their coordinate system, such as the State Plane zone in metres${xy.some(h=>this.found.get(h)!.name==="feet")?". “ft” is read as the international foot; write “US ft” for US survey feet":""}`);
    return notes;
  }
}
const round=(v:number)=>Math.round(v*100)/100;
const ALIASES={
  id:["holeid","boreholeid","bhid","hole","borehole","bh","boreholename","boreholeno","holeno","locaid","locationid","location","pointid","name","id"],
  x:["x","easting","east","e","xcoord","xcoordinate","collarx","locanate","locx"],
  y:["y","northing","north","n","ycoord","ycoordinate","collary","locanatn","locy"],
  z:["z","elevation","elev","collarz","collarelevation","groundlevel","groundelevation","gl","rl","collarrl","locagl","zcoord","level","height"],
  depth:["depth","totaldepth","finaldepth","eoh","holedepth","enddepth","locafdep","maxdepth"],
  lat:["lat","latitude","localat","latdeg","ylat"],
  lon:["lon","long","lng","longitude","localon","londeg","xlon"],
  from:["from","depthfrom","fromdepth","top","topdepth","depthtop","geoltop"],
  to:["to","depthto","todepth","bottom","base","basedepth","bottomdepth","depthbase","depthbottom","geolbase"],
  unit:["unit","unitid","unitcode","stratigraphicunit","geologicalunit","formation","stratum","geology","lithology","litho","lith","lithcode","geolgeol","geolleg","layer","soil","material","code"],
  name:["name","unitname","description","desc"],
  description:["description","desc","soildescription","logdescription","geoldesc","lithologydescription"],
  water:["water","waterdepth","waterlevel","depthtowater","gwl","groundwater","groundwaterdepth","groundwaterlevel","wstgdpth"],
  date:["date","waterdate","readingdate","measured","datetime"],
  testDepth:["depth","testdepth","sampledepth","sampletop","depthtop","specdpth","samptop","isptop","from","top","depthm"],
  testTo:["to","samplebase","depthbase","base","bottom","sampbase","specbase"],
  blows:["blows","blowcount","totalblows","sptblows"],
  penetration:["penetration","penetrationmm","pen","totalpenetration"],
  property:["property","parameter","test","quantity","measurand"],
  value:["value","result","reading","measuredvalue"],
  color:["color","colour","hex","rgb"],
  erosive:["erosive","erosion","erosivebase","unconformity"],
  gamma:["gamma","unitweight","bulkunitweight","gammabulk","gammaknm3"],
  gammaSat:["gammasat","saturatedunitweight","gammasaturated","satunitweight"],
  source:["source","reference","ref","provenance"]
};
type Field=keyof typeof ALIASES;
function columns(header:string[]){
  const h=header.map(norm),found:Partial<Record<Field,number>>={};
  for(const f of Object.keys(ALIASES) as Field[])for(const a of ALIASES[f]){const i=h.indexOf(a);if(i>=0){found[f]=i;break}}
  return found;
}
function num(v:string|undefined){
  if(v===undefined)return NaN;
  const s=v.trim();
  if(s==="")return NaN;
  return Number(/^-?\d+,\d+$/.test(s)?s.replace(",","."):s);
}

interface Collar { x:number; y:number; z:number; depth?:number; lon?:number; lat?:number; spt?:SptTest[]; water?:WaterLevel[]; tests?:TestResult[] }
// Tests and water readings per borehole, from tables other than the collars. `rules` group logged descriptions into
// units when the intervals carry descriptions only.
interface Tables { collars:Map<string,Collar>; intervals:Map<string,Interval[]>; units:UnitDef[]; warnings:string[]; measured?:Map<string,Measured>; rules?:UnitRule[] }
interface Measured { spt:SptTest[]; water:WaterLevel[]; tests:TestResult[] }
function measuredOf(t:Tables,id:string){
  t.measured??=new Map();
  if(!t.measured.has(id))t.measured.set(id,{spt:[],water:[],tests:[]});
  return t.measured.get(id)!;
}
// A value of a property at a depth: SPT N-values join the borehole's SPT tests (as complete 300 mm tests).
// Converted values keep six significant figures, so a density of 1.95 Mg/m³ reads as a unit weight of 19.123.
export const converted=(v:number,scale:number)=>scale===1?v:Number((v*scale).toPrecision(6));
function addTest(m:Measured,depth:number,to:number,key:string,value:number){
  if(!Number.isFinite(depth)||!Number.isFinite(value))return;
  if(key==="N")m.spt.push({depth,blows:value,penetration:300});
  else m.tests.push({depth,...(Number.isFinite(to)&&to>depth?{to}:{}),property:key,value});
}

const TABLES="a borehole table (hole id, x, y, z, from, to, unit or description), or separate collar (hole id, x, y or latitude, longitude, z), interval (hole id, from, to, unit or description), unit, test (hole id, depth and a column per property, or property and value columns), SPT (hole id, depth, N) or water-level (hole id, water depth) tables";
function readCsvTable(file:TextFile,t:Tables){
  const rows=parseCsv(file.text);
  if(rows.length<2){t.warnings.push(`${file.name}: no data rows`);return}
  const c=columns(rows[0]),has=(...f:Field[])=>f.every(k=>c[k]!==undefined);
  const data=rows.slice(1);
  const cell=(r:string[],f:Field)=>c[f]===undefined?undefined:r[c[f]!]?.trim();
  // Lengths in metres: converted where the header names another unit in brackets, such as "Depth From (ft)".
  const lengths=new Conversions(),header=(f:Field)=>rows[0][c[f]!].trim();
  const len=(r:string[],f:Field)=>c[f]===undefined?NaN:lengths.metres(num(cell(r,f)),header(f),bracketed(rows[0][c[f]!]),c[f]);
  const water=(r:string[])=>{
    const d=len(r,"water"),date=cell(r,"date");
    return Number.isFinite(d)?[{depth:d,...(date?{date}:{})}]:undefined;
  };
  const collar=(r:string[]):Collar=>({x:len(r,"x"),y:len(r,"y"),z:len(r,"z"),depth:len(r,"depth"),lon:num(cell(r,"lon")),lat:num(cell(r,"lat")),water:water(r)});
  // Property columns are the columns not taken by an identifying field; in a table of located boreholes, "E" and "N"
  // are eastings and northings, elsewhere a modulus and SPT N-values.
  const located=has("x","y")||has("lat","lon");
  const taken=new Set((["id","testDepth","testTo","unit","from","to","description","name","color","source","water","date",...(located?["x","y","z","lat","lon","depth"]:[])] as Field[]).map(f=>c[f]));
  const props=rows[0].map((h,i)=>({i,p:propertyFromHeader(h)})).filter(q=>q.p&&!taken.has(q.i)) as Array<{i:number;p:{key:string;scale:number}}>;
  const described=c.description!==undefined&&c.description!==c.unit;
  if(has("id","from","to")&&(has("unit")||described)&&!props.length){
    const combined=has("x","y","z")||has("lat","lon","z");
    for(const r of data){
      const id=cell(r,"id");
      if(!id){t.warnings.push(`${file.name}: row without a borehole id skipped`);continue}
      const from=len(r,"from"),to=len(r,"to"),unit=cell(r,"unit")??"",name=described?cell(r,"description"):undefined;
      if(!t.intervals.has(id))t.intervals.set(id,[]);
      t.intervals.get(id)!.push({from,to,unit,...(name?{name}:{})});
      if(combined&&!t.collars.has(id))t.collars.set(id,collar(r));
    }
    if(!has("unit"))t.rules=lithologyRules;
  }else if(has("id")&&located){
    for(const r of data){
      const id=cell(r,"id");
      if(!id)continue;
      if(t.collars.has(id))t.warnings.push(`${file.name}: duplicate collar ${id}; first row kept`);
      else t.collars.set(id,collar(r));
    }
  }else if(has("id","testDepth","property","value")){
    for(const r of data){
      const id=cell(r,"id"),name=cell(r,"property");
      if(!id||!name)continue;
      const unit=c.unit!==undefined?cell(r,"unit"):"",property=propertyFromHeader(unit?`${name} (${unit})`:name);
      addTest(measuredOf(t,id),len(r,"testDepth"),len(r,"testTo"),property?.key??propertyKey(name),converted(num(cell(r,"value")),property?.scale??1));
    }
  }else if(c.unit!==undefined&&(props.length||(["color","name","erosive","gamma","gammaSat","source"] as Field[]).some(f=>c[f]!==undefined))){
    for(const r of data){
      const id=cell(r,"unit");
      if(!id)continue;
      const params:Record<string,number>={};
      for(const {i,p} of props)if(p.key!=="gamma"&&Number.isFinite(num(r[i])))params[p.key]=converted(num(r[i]),p.scale);
      t.units.push(unitDef({id,name:cell(r,"name"),color:cell(r,"color"),erosive:cell(r,"erosive"),gamma:cell(r,"gamma"),gammaSat:cell(r,"gammaSat"),source:cell(r,"source"),params}));
    }
  }else if(has("id","testDepth")&&(props.length||has("blows"))){
    for(const r of data){
      const id=cell(r,"id");
      if(!id)continue;
      const m=measuredOf(t,id),depth=len(r,"testDepth"),to=len(r,"testTo");
      for(const {i,p} of props)addTest(m,depth,to,p.key,converted(num(r[i]),p.scale));
      if(has("blows")){
        const blows=num(cell(r,"blows")),pen=num(cell(r,"penetration"));
        if(Number.isFinite(depth)&&Number.isFinite(blows))m.spt.push({depth,blows,penetration:Number.isFinite(pen)?pen:300});
      }
    }
  }else if(has("id","water")){
    for(const r of data){
      const id=cell(r,"id"),w=water(r);
      if(id&&w)measuredOf(t,id).water.push(...w);
    }
  }else{
    throw new Error(`${file.name}: unrecognised columns (${rows[0].join(", ")}). Expected ${TABLES}.`);
  }
  t.warnings.push(...lengths.notes(file.name,(["x","y"] as Field[]).filter(f=>c[f]!==undefined).map(header)));
}

// ---------- AGS4 ----------

// The groups' rows, by heading; `units` holds each group's UNIT row.
export function parseAgs4(text:string){
  if(/^\s*"\*\*/.test(text))throw new Error("AGS 3 files are not supported; export the data as AGS4");
  const groups=new Map<string,Array<Record<string,string>>>(),units=new Map<string,Record<string,string>>();
  let group="",heading:string[]=[];
  const record=(r:string[])=>Object.fromEntries(heading.slice(1).map((h,i)=>[h,r[i+1]??""]));
  for(const r of parseCsv(text,",")){
    if(r[0]==="GROUP"){group=r[1];heading=[];if(!groups.has(group))groups.set(group,[])}
    else if(r[0]==="HEADING")heading=r;
    else if(r[0]==="UNIT"&&group)units.set(group,record(r));
    else if(r[0]==="DATA"&&group)groups.get(group)!.push(record(r));
  }
  return Object.assign(groups,{units});
}
// Laboratory and in-situ results read from AGS4: group, heading, property and the factor to the catalogue unit.
// Laboratory groups give the specimen depth (SPEC_DPTH) or the sample top (SAMP_TOP).
const G=9.80665;
const AGS_TESTS:Array<[string,string,string,number]>=[
  ["LNMC","LNMC_MC","w",1],["LDEN","LDEN_BDEN","gamma",G],["LDEN","LDEN_DDEN","gammaDry",G],
  ["LLPL","LLPL_LL","LL",1],["LLPL","LLPL_PL","PL",1],["LLPL","LLPL_PI","PI",1],["GRAG","GRAG_FINE","fines",1],
  ["TRIT","TRIT_CU","su",1],["LVAN","LVAN_VNPK","su",1],["LPEN","LPEN_PPEN","su",1],["IVAN","IVAN_IVAN","su",1],
  ["TREG","TREG_COH","c",1],["TREG","TREG_PHI","phi",1],["SHBG","SHBG_PCOH","c",1],["SHBG","SHBG_PHI","phi",1],
  ["RUCS","RUCS_UCS","ucs",1],["RUCS","RUCS_E","E",1000],["PTST","PTST_K","k",1]
];
function readAgs4(file:TextFile):ImportResult{
  const g=parseAgs4(file.text),warnings:string[]=[];
  const loca=g.get("LOCA")??[],geol=g.get("GEOL")??[];
  if(!loca.length||!geol.length)throw new Error(`${file.name}: an AGS4 model needs LOCA (locations) and GEOL (field geological descriptions) groups`);
  const key=["GEOL_GEOL","GEOL_GEO2","GEOL_LEG"].find(k=>geol.some(r=>r[k]?.trim()));
  if(!key&&!geol.some(r=>r.GEOL_DESC?.trim()))throw new Error(`${file.name}: GEOL rows carry no GEOL_GEOL, GEOL_GEO2 or GEOL_LEG unit codes and no GEOL_DESC descriptions`);
  const names=new Map((g.get("ABBR")??[]).filter(r=>r.ABBR_HDNG===key).map(r=>[r.ABBR_CODE,r.ABBR_DESC]));
  const t:Tables={collars:new Map(),intervals:new Map(),units:[],warnings};
  // Lengths in metres, converted where the group's UNIT row gives feet, centimetres or millimetres.
  const lengths=new Conversions();
  const len=(group:string,r:Record<string,string>,heading:string)=>{const unit=g.units.get(group)?.[heading]??"";return lengths.metres(num(r[heading]),`${heading} (${unit})`,unit)};
  let local=false;
  for(const r of loca){
    let x=len("LOCA",r,"LOCA_NATE"),y=len("LOCA",r,"LOCA_NATN"),z=len("LOCA",r,"LOCA_GL");
    const lon=num(r.LOCA_LON),lat=num(r.LOCA_LAT);
    if((!Number.isFinite(x)||!Number.isFinite(y))&&!(Number.isFinite(lon)&&Number.isFinite(lat))){x=len("LOCA",r,"LOCA_LOCX");y=len("LOCA",r,"LOCA_LOCY");z=Number.isFinite(z)?z:len("LOCA",r,"LOCA_LOCZ");local=local||Number.isFinite(x)}
    t.collars.set(r.LOCA_ID,{x,y,z,depth:len("LOCA",r,"LOCA_FDEP"),lon,lat});
  }
  if(local)warnings.push("Some locations have no national grid coordinates; local LOCA_LOCX/LOCA_LOCY were used for them");
  // Without unit codes, the descriptions are grouped by their principal soil or rock.
  for(const r of geol){
    const code=key?r[key]?.trim():"",desc=r.GEOL_DESC?.trim();
    if(key&&!code){warnings.push(`${r.LOCA_ID}: GEOL ${r.GEOL_TOP}–${r.GEOL_BASE} m has no ${key}; skipped`);continue}
    if(!t.intervals.has(r.LOCA_ID))t.intervals.set(r.LOCA_ID,[]);
    t.intervals.get(r.LOCA_ID)!.push({from:len("GEOL",r,"GEOL_TOP"),to:len("GEOL",r,"GEOL_BASE"),unit:code??"",...(desc?{name:desc}:{})});
  }
  if(key)t.units=[...new Set(geol.map(r=>r[key]?.trim()).filter(Boolean))].filter(c=>names.has(c)).map(c=>({id:c,name:names.get(c)!,color:""}));
  for(const r of g.get("ISPT")??[])addTest(measuredOf(t,r.LOCA_ID),len("ISPT",r,"ISPT_TOP"),NaN,"N",num(r.ISPT_NVAL));
  // Water: the level a strike rose to (WSTD_POST) where recorded, else the depth of the strike.
  const rose=new Set((g.get("WSTD")??[]).filter(r=>Number.isFinite(num(r.WSTD_POST))).map(r=>r.LOCA_ID));
  for(const r of g.get("WSTD")??[])if(Number.isFinite(num(r.WSTD_POST)))measuredOf(t,r.LOCA_ID).water.push({depth:len("WSTD",r,"WSTD_POST")});
  for(const r of g.get("WSTG")??[])if(!rose.has(r.LOCA_ID)&&Number.isFinite(num(r.WSTG_DPTH)))measuredOf(t,r.LOCA_ID).water.push({depth:len("WSTG",r,"WSTG_DPTH"),...(r.WSTG_DTIM?{date:r.WSTG_DTIM.slice(0,10)}:{})});
  for(const [group,heading,property,scale] of AGS_TESTS)for(const r of g.get(group)??[]){
    const depth=group==="IVAN"?len(group,r,"IVAN_DPTH"):Number.isFinite(num(r.SPEC_DPTH))?len(group,r,"SPEC_DPTH"):len(group,r,"SAMP_TOP");
    addTest(measuredOf(t,r.LOCA_ID),depth,len(group,r,"SPEC_BASE"),property,converted(num(r[heading]),scale));
  }
  warnings.push(...lengths.notes(file.name,["LOCA_NATE","LOCA_NATN"].map(h=>`${h} (${g.units.get("LOCA")?.[h]??""})`)));
  const proj=g.get("PROJ")?.[0];
  const grefs=[...new Set(loca.map(r=>r.LOCA_GREF).filter(Boolean))];
  const named=grefs.length===1?crsFromName(grefs[0]):undefined;
  const result=assemble(t,proj?.PROJ_NAME||file.name.replace(/\.[^.]+$/,""),named?named.name:grefs.length===1?grefs[0]:undefined,true,named,key?undefined:lithologyRules);
  result.project.description=`Imported from AGS4 (${file.name}); units from ${key??"the GEOL_DESC descriptions, grouped by principal soil or rock"}.`;
  return result;
}

// ---------- JSON ----------

function readGeoreport3D(doc:any,file:string):ImportResult{
  const t:Tables={collars:new Map(),intervals:new Map(),units:[],warnings:[]};
  const crs=new Set<string>();
  for(const b of doc.boreholes){
    const id=String(b.borehole_id??"").trim();
    if(!id){t.warnings.push(`${file}: borehole without borehole_id skipped`);continue}
    const c=b.collar??{};
    const missing=["easting","northing","elevation"].filter(k=>typeof c[k]!=="number");
    if(missing.length){t.warnings.push(`${id}: collar ${missing.join(", ")} not in the extraction; not placed (coordinates are never invented)`);continue}
    if(c.crs)crs.add(c.crs);
    t.collars.set(id,{x:c.easting,y:c.northing,z:c.elevation,depth:typeof b.total_depth==="number"?b.total_depth:undefined});
    t.intervals.set(id,(b.intervals??[]).map((i:any)=>({from:i.depth_from,to:i.depth_to,unit:String(i.lithology??"").trim()})));
  }
  if(crs.size>1)t.warnings.push(`Collars use more than one CRS (${[...crs].join(", ")}); positions may not be comparable`);
  const result=assemble(t,doc.document_id?`Georeport3D: ${doc.document_id}`:file,crs.size===1?[...crs][0]:undefined,true);
  result.project.description=`Imported from a Georeport3D extraction (${file}).`;
  return result;
}
// A unit definition from loosely typed input: booleans as yes/no/true/1, numbers as text or numbers.
function unitDef(u:{id:string;name?:unknown;color?:unknown;erosive?:unknown;gamma?:unknown;gammaSat?:unknown;source?:unknown;params?:unknown}):UnitDef{
  const out:UnitDef={id:u.id,name:typeof u.name==="string"&&u.name.trim()?u.name.trim():u.id,color:normaliseColor(u.color)??""};
  if(u.erosive===true||typeof u.erosive==="string"&&/^(y|yes|true|1|x)$/i.test(u.erosive.trim()))out.erosive=true;
  const gamma=typeof u.gamma==="number"?u.gamma:num(u.gamma as string|undefined);
  const gammaSat=typeof u.gammaSat==="number"?u.gammaSat:num(u.gammaSat as string|undefined);
  if(Number.isFinite(gamma))out.gamma=gamma;
  if(Number.isFinite(gammaSat))out.gammaSat=gammaSat;
  if(u.params&&typeof u.params==="object"){
    const params=Object.fromEntries(Object.entries(u.params as Record<string,unknown>).map(([k,v])=>[propertyKey(k),Number(v)]).filter(([,v])=>Number.isFinite(v)));
    if(Object.keys(params).length)out.params=params;
  }
  if(typeof u.source==="string"&&u.source.trim())out.source=u.source.trim();
  return out;
}
function checkProperties(units:UnitDef[],warnings:string[]){
  for(const u of units){
    for(const [key,v] of [["unit weight",u.gamma],["saturated unit weight",u.gammaSat]] as Array<[string,number|undefined]>)
      if(v!==undefined&&(v<10||v>30))warnings.push(`${u.name}: ${key} ${v} kN/m³ is outside 10–30 kN/m³; check the units`);
    if(u.gamma!==undefined&&u.gammaSat!==undefined&&u.gammaSat<u.gamma)warnings.push(`${u.name}: saturated unit weight is below the bulk unit weight`);
  }
}
function readProjectJson(doc:any,file:string):ImportResult{
  const t:Tables={collars:new Map(),intervals:new Map(),units:[],warnings:[]};
  for(const u of doc.units??[]){
    const id=String(u.id??u.name??"").trim();
    if(id)t.units.push(unitDef({...u,id}));
  }
  for(const b of doc.boreholes??[]){
    const id=String(b.id??"").trim();
    if(!id)continue;
    const list=(v:unknown,keys:string[])=>Array.isArray(v)?v.filter(o=>o&&keys.every(k=>Number.isFinite(Number(o[k])))):undefined;
    t.collars.set(id,{x:Number(b.x),y:Number(b.y),z:Number(b.z),depth:b.depth===undefined?undefined:Number(b.depth),
      lon:b.lon===undefined?undefined:Number(b.lon),lat:b.lat===undefined?undefined:Number(b.lat),
      spt:list(b.spt,["depth","blows","penetration"]),water:list(b.water,["depth"]),
      tests:list(b.tests,["depth","value"])?.filter((o:any)=>typeof o.property==="string"&&o.property.trim())
        .map((o:any)=>({depth:Number(o.depth),...(Number.isFinite(Number(o.to))&&o.to!==undefined&&o.to!==null?{to:Number(o.to)}:{}),property:propertyKey(o.property),value:Number(o.value)}))});
    t.intervals.set(id,(b.intervals??[]).map((i:any)=>({from:Number(i.from),to:Number(i.to),unit:String(i.unit??"").trim(),...(typeof i.name==="string"?{name:i.name}:{})})));
  }
  const rules:UnitRule[]|undefined=Array.isArray(doc.rules)?doc.rules.filter((r:any)=>r&&typeof r.match==="string"&&typeof r.unit==="string"):undefined;
  const crs=doc.crsProj4?{name:doc.crs||doc.crsCode||"Custom",code:doc.crsCode,proj4:String(doc.crsProj4)}:doc.crsCode?findCrs(String(doc.crsCode)):undefined;
  if(doc.crsCode&&!crs)t.warnings.push(`${file}: coordinate system ${doc.crsCode} is not known here; the model is shown without a map`);
  const result=assemble(t,doc.name||file,doc.crs,!t.units.length,crs??undefined,rules);
  if(doc.description)result.project.description=String(doc.description);
  if(doc.source)result.project.source=String(doc.source);
  if(Number.isFinite(doc.base))result.project.base=Number(doc.base);
  if(Number.isFinite(doc.groundwaterDepth))result.project.groundwaterDepth=Number(doc.groundwaterDepth);
  if(Number.isFinite(doc.margin)&&doc.margin>0)result.project.margin=Number(doc.margin);
  // Alignments: lines with a problem are left out, and named in the notes.
  if(Array.isArray(doc.alignments)){
    const lines:Alignment[]=[];
    for(const a of doc.alignments){
      const line:Alignment={name:String(a?.name??`Line ${lines.length+1}`),points:Array.isArray(a?.points)?a.points.map((p:any)=>({x:Number(p?.x),y:Number(p?.y),...(p?.chainage!==undefined&&p?.chainage!==null?{chainage:Number(p.chainage)}:{})})):[],
        ...(Number.isFinite(a?.start)?{start:Number(a.start)}:{}),...(typeof a?.source==="string"?{source:a.source}:{}),
        ...(Array.isArray(a?.design)&&a.design.length?{design:a.design.map((d:any)=>({chainage:Number(d?.chainage),top:Number(d?.top),...(d?.bottom!==undefined&&d?.bottom!==null?{bottom:Number(d.bottom)}:{})}))}:{})};
      const problem=alignmentProblem(line);
      if(problem)result.warnings.push(`${file}: alignment ${line.name} left out: ${problem}`);
      else lines.push(line);
    }
    if(lines.length)result.project.alignments=lines;
  }
  const g=doc.terrain;
  if(g){
    const ok=["x0","y0","dx","dy","ncols","nrows"].every(k=>Number.isFinite(g[k]))&&Array.isArray(g.z)&&g.z.length===g.ncols*g.nrows;
    if(ok)result.project.terrain={x0:g.x0,y0:g.y0,dx:g.dx,dy:g.dy,ncols:g.ncols,nrows:g.nrows,z:g.z.map((v:unknown)=>typeof v==="number"?v:NaN),source:g.source};
    else result.warnings.push(`${file}: terrain grid is incomplete and was ignored`);
  }
  return result;
}
// JSON has no NaN, so terrain cells without data are written as null.
export function toProjectJson(p:GeoProject){
  const doc={format:"geomodel3d-project",version:1,name:p.name,description:p.description,source:p.source,crs:p.crs,crsCode:p.crsCode,crsProj4:p.crsProj4,
    base:p.base,groundwaterDepth:p.groundwaterDepth,margin:p.margin,units:p.units,rules:p.rules,boreholes:p.boreholes,alignments:p.alignments,terrain:p.terrain};
  return JSON.stringify(doc,null,1).replace(/"z": \[[^\]]*\]/,m=>m.replace(/\s+/g,""))+"\n";
}
// One row per interval with the collar, the logged description where there is one, and the shallowest water level.
export function toBoreholeCsv(p:GeoProject){
  const described=p.boreholes.some(b=>b.intervals.some(i=>i.name)),wet=p.boreholes.some(b=>b.water?.length);
  const rows:Array<Array<string|number|undefined>>=[["hole_id","x","y","z","depth",...(wet?["water_depth"]:[]),"from","to","unit",...(described?["description"]:[])]];
  for(const b of p.boreholes){
    const water=b.water?.length?Math.min(...b.water.map(w=>w.depth)):undefined;
    for(const i of b.intervals)rows.push([b.id,b.x,b.y,b.z,b.depth,...(wet?[water]:[]),i.from,i.to,i.unit,...(described?[i.name]:[])]);
  }
  return toCsv(rows);
}
// Tests in long form, one row per value; SPT tests as N-values.
export function toTestsCsv(p:GeoProject){
  const rows:Array<Array<string|number|undefined>>=[["hole_id","depth","to","property","value","unit"]];
  for(const b of p.boreholes){
    const all=[...(b.spt??[]).map(t=>({depth:t.depth,to:undefined as number|undefined,property:"N",value:Math.round(sptN(t)*10)/10})),...(b.tests??[])].sort((q,r)=>q.depth-r.depth);
    for(const t of all)rows.push([b.id,t.depth,t.to,t.property,t.value,propertyDef(t.property).unit]);
  }
  return toCsv(rows);
}

// ---------- assembling a project ----------

// Collars given only by latitude and longitude are placed in the declared coordinate system, or in the one suggested
// for their location.
function georeference(t:Tables,declared?:Crs):Crs|undefined{
  const geo=[...t.collars.values()].filter(c=>!(Number.isFinite(c.x)&&Number.isFinite(c.y))&&Number.isFinite(c.lon)&&Number.isFinite(c.lat));
  if(!geo.length)return declared;
  const mean=(k:"lon"|"lat")=>geo.reduce((a,c)=>a+c[k]!,0)/geo.length;
  const crs=declared??suggestCrs(mean("lon"),mean("lat"))[0];
  for(const c of geo)Object.assign(c,toProjected(crs,c.lon!,c.lat!));
  t.warnings.push(`${geo.length} collar position${geo.length>1?"s":""} converted from latitude and longitude to ${crs.name}${crs.code?` (${crs.code})`:""}${declared?"":", suggested for their location"}${crs.note?`. ${crs.note}`:""}`);
  return crs;
}

function assemble(t:Tables,name:string,crsName:string|undefined,inferUnits:boolean,declared?:Crs,ruleSet?:UnitRule[]):ImportResult{
  const warnings=t.warnings,boreholes:Borehole[]=[],rules=ruleSet??t.rules;
  const crs=georeference(t,declared);
  for(const [id,raw] of t.intervals){
    const collar=t.collars.get(id);
    if(!collar||![collar.x,collar.y,collar.z].every(Number.isFinite)){warnings.push(`${id}: no collar position and elevation; not placed`);continue}
    const intervals:Interval[]=[];
    for(const i of raw){
      // A description without a unit is given one by the rules below.
      const label=i.unit||(rules?.length?i.name:undefined);
      if(!label||!Number.isFinite(i.from)||!Number.isFinite(i.to)||i.from<0||i.to<=i.from){
        warnings.push(`${id}: interval ${i.from}–${i.to} m${label?" ("+label+")":""} is incomplete or inverted; skipped`);continue;
      }
      intervals.push(i);
    }
    intervals.sort((p,q)=>p.from-q.from);
    if(!intervals.length){warnings.push(`${id}: no usable intervals; not placed`);continue}
    const b:Borehole={id,x:collar.x,y:collar.y,z:collar.z,intervals};
    if(collar.depth!==undefined&&Number.isFinite(collar.depth)&&collar.depth>boreholeDepth(b))b.depth=collar.depth;
    if(Number.isFinite(collar.lon)&&Number.isFinite(collar.lat)){b.lon=collar.lon;b.lat=collar.lat}
    const m=t.measured?.get(id),byDepth=(p:{depth:number},q:{depth:number})=>p.depth-q.depth;
    const spt=[...collar.spt??[],...m?.spt??[]].sort(byDepth),water=[...collar.water??[],...m?.water??[]],tests=[...collar.tests??[],...m?.tests??[]].sort(byDepth);
    if(spt.length)b.spt=spt;
    if(water.length)b.water=water;
    if(tests.length)b.tests=tests;
    boreholes.push(b);
  }
  for(const id of t.measured?.keys()??[])if(!t.intervals.has(id))warnings.push(`${id}: tests or water levels for a borehole without a log; ignored`);
  warnings.push(...implausibleTests(boreholes));
  if(rules?.length){
    const mapped=applyUnitRules(boreholes,rules);
    boreholes.splice(0,boreholes.length,...mapped.boreholes);
    if(mapped.unmatched.size)warnings.push(`Descriptions that no rule assigns to a unit are modelled as units of their own: ${[...mapped.unmatched].map(([n,c])=>`${n} (${c})`).join(", ")}`);
  }
  for(const id of t.collars.keys())if(!t.intervals.has(id))warnings.push(`${id}: collar without intervals; ignored`);
  const logged=new Set(boreholes.flatMap(b=>b.intervals.map(i=>i.unit)));
  let units:UnitDef[];
  if(inferUnits||!t.units.length){
    const {order,conflicts}=inferUnitOrder(boreholes);
    const known=new Map(t.units.map(u=>[u.id,u]));
    units=order.map(id=>known.get(id)??{id,name:id,color:""});
    warnings.push(...conflicts);
  }else{
    const declared=new Set(t.units.map(u=>u.id));
    const extra=[...logged].filter(u=>!declared.has(u));
    units=[...t.units];
    if(extra.length){
      const {order}=inferUnitOrder(boreholes);
      units.push(...order.filter(u=>extra.includes(u)).map(id=>({id,name:id,color:""})));
      warnings.push(`Units logged but not in the unit table were appended at the bottom of the column: ${extra.join(", ")}`);
    }
  }
  assignColors(units);
  checkProperties(units,warnings);
  const project:GeoProject={name,crs:crs?.name??crsName,units,boreholes};
  if(crs?.code&&findCrs(crs.code))project.crsCode=crs.code;
  else if(crs)project.crsProj4=crs.proj4;
  if(rules?.length)project.rules=rules;
  return {project,warnings};
}

// Stratigraphic order from the logs: "A directly above B" in any hole means A is younger. Ties and conflicting
// orders (repeated or inverted units) fall back to the shallower median depth, and are reported.
export function inferUnitOrder(boreholes:Borehole[]){
  const above=new Map<string,Map<string,string>>(),depths=new Map<string,number[]>();
  for(const b of boreholes){
    let prev:string|undefined;
    for(const i of [...b.intervals].sort((p,q)=>p.from-q.from)){
      if(!depths.has(i.unit))depths.set(i.unit,[]);
      depths.get(i.unit)!.push(i.from);
      if(prev&&prev!==i.unit){
        if(!above.has(prev))above.set(prev,new Map());
        if(!above.get(prev)!.has(i.unit))above.get(prev)!.set(i.unit,b.id);
      }
      prev=i.unit;
    }
  }
  const median=(v:number[])=>{const s=[...v].sort((a,b)=>a-b);return s[Math.floor((s.length-1)/2)]};
  const remaining=new Set(depths.keys()),order:string[]=[],conflicts:string[]=[];
  const byDepth=(a:string,b:string)=>median(depths.get(a)!)-median(depths.get(b)!)||a.localeCompare(b);
  while(remaining.size){
    const free=[...remaining].filter(u=>![...remaining].some(v=>v!==u&&above.get(v)?.has(u)));
    let next:string;
    if(free.length)next=free.sort(byDepth)[0];
    else{
      next=[...remaining].sort(byDepth)[0];
      const blockers=[...remaining].filter(v=>v!==next&&above.get(v)?.has(next));
      conflicts.push(`Logs disagree on the order of ${[next,...blockers].join(", ")} (e.g. ${blockers.map(v=>`${above.get(v)!.get(next)}: ${v} above ${next}`).join("; ")}); ${next} placed first by median depth`);
    }
    order.push(next);remaining.delete(next);
  }
  return {order,conflicts};
}

const KEYWORD_COLORS:Array<[RegExp,string]>=[
  [/made ground|fill|埋土|盛土/i,"#9a5b4f"],[/topsoil|表土/i,"#5b4a3a"],[/peat|organic|泥炭|腐植/i,"#4a3b2a"],
  [/sandstone|砂岩/i,"#b9925c"],[/siltstone/i,"#8a8170"],[/mudstone|shale|claystone|泥岩|頁岩/i,"#6f7686"],
  [/limestone|石灰岩/i,"#9fb4c0"],[/chalk/i,"#ddd8c8"],[/coal|石炭/i,"#3a3a3a"],[/conglomerate|礫岩/i,"#b07a4f"],
  [/granite|花崗岩/i,"#a3999c"],[/basalt|andesite|玄武岩|安山岩/i,"#5f6366"],[/tuff|凝灰岩/i,"#b5a99a"],
  [/schist|gneiss|片岩|片麻岩/i,"#7f8a7a"],[/weathered|風化/i,"#8f806d"],[/alluvi|沖積/i,"#c2ab7c"],
  [/gravel|礫/i,"#d08a4c"],[/clay|粘土/i,"#9c7a5b"],[/silt|シルト/i,"#a89a7a"],[/sand|砂/i,"#d9b871"]
];
const PALETTE=["#c2ab7c","#8f806d","#d08a4c","#6f7686","#b9925c","#a3999c","#7f8a7a","#9fb4c0","#9c7a5b","#b5a99a","#8e6c9c","#5f6366"];
function normaliseColor(c:unknown){
  if(typeof c!=="string")return undefined;
  const s=c.trim();
  if(/^#?[0-9a-f]{6}$/i.test(s))return (s.startsWith("#")?s:"#"+s).toLowerCase();
  if(/^#?[0-9a-f]{3}$/i.test(s)){const h=s.replace("#","");return ("#"+h[0]+h[0]+h[1]+h[1]+h[2]+h[2]).toLowerCase()}
  return undefined;
}
export function assignColors(units:UnitDef[]){
  const used=new Set(units.map(u=>u.color).filter(Boolean));
  let p=0;
  for(const u of units){
    if(u.color)continue;
    const k=KEYWORD_COLORS.find(([re])=>re.test(u.name)||re.test(u.id));
    if(k&&!used.has(k[1]))u.color=k[1];
    else{
      while(p<PALETTE.length&&used.has(PALETTE[p]))p++;
      u.color=p<PALETTE.length?PALETTE[p]:hslHex((units.indexOf(u)*137)%360,0.3,0.55);
    }
    used.add(u.color);
  }
  return units;
}
function hslHex(h:number,s:number,l:number){
  const f=(n:number)=>{const k=(n+h/30)%12,c=l-s*Math.min(l,1-l)*Math.max(-1,Math.min(k-3,9-k,1));return Math.round(c*255).toString(16).padStart(2,"0")};
  return "#"+f(0)+f(8)+f(4);
}

// ---------- Japanese borehole logs ----------

const TOKYO="+proj=longlat +ellps=bessel +towgs84=-146.414,507.337,680.507,0,0,0,0 +no_defs";
// Units come from the descriptions through the current project's rules or, for a new project, a first grouping of
// the soil names by principal material.
function readBoringLogs(files:TextFile[],current?:GeoProject):ImportResult{
  // A project with rules declares its units and their order; a new one infers the order from the logs.
  const t:Tables={collars:new Map(),intervals:new Map(),units:current?.rules?current.units.map(u=>({...u})):[],warnings:[]};
  let tokyo=0,jgd2000=0;
  for(const f of files){
    let log;
    try{log=readBoringXml(f.text,f.name)}catch(e){t.warnings.push((e as Error).message);continue}
    let id=log.id;
    if(t.collars.has(id))id=`${log.id} (${f.name.replace(/\.[^.]+$/,"")})`;
    for(const n of log.notes)t.warnings.push(`${id}: ${n}`);
    let {lon,lat}=log;
    if(log.datum==="Tokyo"){[lon,lat]=proj4(TOKYO,"WGS84").forward([lon,lat]);tokyo++}
    if(log.datum==="JGD2000")jgd2000++;
    t.collars.set(id,{x:NaN,y:NaN,z:log.z,depth:log.depth,lon,lat,spt:log.spt,water:log.water});
    t.intervals.set(id,log.intervals.map(i=>({...i,unit:""})));
  }
  if(tokyo)t.warnings.push(`${tokyo} log${tokyo>1?"s use":" uses"} the Tokyo datum; shifted to JGD2011 to about 9 m (the TKY2JGD grid is not applied)`);
  if(jgd2000)t.warnings.push(`${jgd2000} log${jgd2000>1?"s use":" uses"} JGD2000, taken as JGD2011 (they differ by up to a few metres in eastern Japan since 2011)`);
  const rules=current?.rules??japaneseLithologyRules;
  const result=assemble(t,files.length===1?files[0].name.replace(/\.[^.]+$/,""):"Imported borehole logs",undefined,!current?.rules,projectCrs(current??{})??undefined,rules);
  if(!current?.rules)result.warnings.push("Units are a first grouping of the soil names by principal material (lithology, not formations); edit the unit rules to model the stratigraphy");
  result.warnings.push("Collar elevations are as logged (孔口標高), normally T.P.; river and port surveys may use a local datum such as A.P. or O.P.");
  result.project.description=`Imported from ${files.length} Japanese borehole log${files.length>1?"s":""} (電子納品 XML).`;
  return result;
}

// ---------- Dutch BRO geotechnical boreholes ----------

// Units come from the descriptions through the current project's rules or, for a new project, a first grouping of
// the soil names by principal soil.
function readBroLogs(files:TextFile[],current?:GeoProject):ImportResult{
  const t:Tables={collars:new Map(),intervals:new Map(),units:current?.rules?current.units.map(u=>({...u})):[],warnings:[]};
  let rd=0;
  for(const f of files){
    let logs;
    try{logs=readBroXml(f.text,f.name)}catch(e){t.warnings.push((e as Error).message);continue}
    for(const log of logs){
      if(t.collars.has(log.id)){t.warnings.push(`${log.id}: in more than one file; ${f.name} ignored`);continue}
      for(const n of log.notes)t.warnings.push(`${log.id}: ${n}`);
      if(Number.isFinite(log.x))rd++;
      t.collars.set(log.id,{x:log.x,y:log.y,z:log.z,depth:log.depth,lon:log.lon,lat:log.lat,water:log.water!==undefined?[{depth:log.water}]:undefined,tests:log.tests});
      t.intervals.set(log.id,log.intervals.map(i=>({...i,unit:""})));
    }
  }
  const rules=current?.rules??lithologyRules;
  const declared=rd?findCrs("EPSG:28992"):projectCrs(current??{})??undefined;
  const result=assemble(t,files.length===1?files[0].name.replace(/\.[^.]+$/,""):"Imported BRO boreholes",undefined,!current?.rules,declared,rules);
  if(!current?.rules)result.warnings.push("Units are a first grouping of the soil names by principal soil (lithology, not formations); edit the unit rules to model the stratigraphy");
  result.warnings.push("Elevations are in metres NAP (Normaal Amsterdams Peil)");
  result.project.description=`Imported from ${t.collars.size} BRO geotechnical borehole${t.collars.size===1?"":"s"} (BHR-GT, IMBRO XML).`;
  result.project.source="BRO, Basisregistratie Ondergrond (BHR-GT)";
  return result;
}

// ---------- Flemish DOV boreholes and interpretations ----------

// Boreholes give the positions, interpretations the layers; they are joined by the borehole's identifier. The most
// geological kind of interpretation present is used for every borehole (the latest one where there are several), so
// the units are consistent; formal stratigraphy is modelled by formation, with members kept in the descriptions.
function readDovFiles(files:TextFile[],current?:GeoProject):ImportResult{
  const t:Tables={collars:new Map(),intervals:new Map(),units:current?.rules?current.units.map(u=>({...u})):[],warnings:[]};
  const borings=new Map<string,{x:number;y:number;z:number;depth:number}>(),found:DovInterpretation[]=[];
  for(const f of files){
    try{const r=readDovXml(f.text,f.name);for(const b of r.borings)borings.set(b.id,b);found.push(...r.interpretations)}
    catch(e){t.warnings.push((e as Error).message)}
  }
  const kind=interpretationKinds.find(k=>found.some(i=>i.kind===k&&borings.has(i.boring)));
  if(!kind){
    if(found.length)throw new Error("The DOV interpretations have no matching borehole files: add the borehole XML (dov.vlaanderen.be/data/boring/…), which holds the positions");
    throw new Error("No DOV interpretation among the files: add the interpretations (dov.vlaanderen.be/data/interpretatie/…), which hold the layers");
  }
  const latest=new Map<string,DovInterpretation>();
  for(const i of found)if(i.kind===kind){
    const prev=latest.get(i.boring);
    if(!prev||i.date>prev.date||(i.date===prev.date&&i.permkey>prev.permkey))latest.set(i.boring,i);
  }
  const coded=kind==="formelestratigrafie"||kind==="quartairstratigrafie";
  for(const [id,i] of latest){
    const b=borings.get(id);
    if(!b){t.warnings.push(`${id}: interpretation ${i.permkey} without its borehole file; not placed`);continue}
    t.collars.set(id,{x:b.x,y:b.y,z:b.z,depth:b.depth});
    t.intervals.set(id,i.layers.map(l=>coded?{from:l.from,to:l.to,unit:formationOf(l.code),name:l.name}:{from:l.from,to:l.to,unit:"",name:l.name}));
  }
  for(const id of borings.keys())if(!latest.has(id))t.warnings.push(`${id}: no ${kindNames[kind]} among the files; not placed`);
  const others=new Set(found.filter(i=>i.kind!==kind).map(i=>kindNames[i.kind]));
  if(others.size)t.warnings.push(`Layers from the ${kindNames[kind]}; also in the files: ${[...others].join(", ")}`);
  const rules=coded?undefined:current?.rules??lithologyRules;
  const result=assemble(t,files.length===1?files[0].name.replace(/\.[^.]+$/,""):"Imported DOV boreholes",undefined,true,findCrs("EPSG:31370"),rules);
  if(coded)for(const u of result.project.units)if(u.name===u.id)u.name=stratigraphicName(u.id);
  result.warnings.push("Elevations are in metres TAW (Tweede Algemene Waterpassing), about 2.3 m below NAP and mean sea level");
  result.project.description=`Imported from DOV: ${latest.size} borehole${latest.size===1?"":"s"} with their ${kindNames[kind]}.`;
  result.project.source="Databank Ondergrond Vlaanderen (DOV)";
  return result;
}

// The coordinate system an AGS4 LOCA_GREF or similar label names, if it can be recognised.
export function crsFromName(label:string):Crs|undefined{
  const code=label.match(/epsg\D{0,3}(\d{4,5})/i);
  if(code)return findCrs(code[1]);
  const aliases:Array<[RegExp,string]>=[[/osgb|british national grid|\bbng\b|ostn/i,"27700"],[/\bitm\b|irish transverse/i,"2157"],[/irish grid|tm75|tm65/i,"29903"],
    [/hk ?1980|hk80/i,"2326"],[/svy21/i,"3414"],[/nztm/i,"2193"],[/rd new|amersfoort/i,"28992"],[/lv95|ch1903\+/i,"2056"],[/lambert.?93/i,"2154"]];
  const hit=aliases.find(([re])=>re.test(label));
  if(hit)return findCrs(hit[1]);
  const found=searchCrs(label,2);
  return found.length===1?found[0]:undefined;
}

// ---------- alignments ----------

// An alignment table holds the points of a line in plan (x and y, or latitude and longitude) and, if given, their
// chainage and design levels: a crown and an invert, an axis level and a height, or one level, such as a road or rail
// level. A profile table holds design levels by chainage alone, for a line imported before. A column naming the line
// splits a table into several lines.
const LINE_ALIASES={
  chainage:["chainage","ch","chain","station","sta","stationing","kp","km","pk","kilometrage","kilometrepoint","kilometerpoint","measure"],
  crown:["crown","crownlevel","crownelevation","tunnelcrown","roof","rooflevel","top","toplevel"],
  invert:["invert","invertlevel","invertelevation","tunnelinvert","bottom","bottomlevel","floor","floorlevel"],
  axis:["axis","axislevel","axiselevation","tunnelaxis","axisz"],
  size:["diameter","tunnelheight","excavationheight","height"],
  level:["level","designlevel","designelevation","formationlevel","formation","roadlevel","raillevel","railtop","toprail","gradeline","grade","profilelevel","z","elevation","elev"],
  line:["alignment","alignmentname","line","linename","route"]
};
type LineField=keyof typeof LINE_ALIASES;
function lineColumns(header:string[]){
  const h=header.map(norm),found:Partial<Record<LineField,number>>={},taken=new Set<number>();
  for(const f of Object.keys(LINE_ALIASES) as LineField[])for(const a of LINE_ALIASES[f]){const i=h.indexOf(a);if(i>=0&&!taken.has(i)){found[f]=i;taken.add(i);break}}
  return found;
}
// Columns that only borehole tables have, and names that only an alignment would carry.
const BOREHOLE_COLUMNS=new Set(["holeid","boreholeid","bhid","hole","borehole","bh","boreholename","boreholeno","holeno","locaid","locationid","from","to","depthfrom","depthto","fromdepth","todepth","depth","unit","description","lithology","geology","soil","blows","waterdepth"]);
const ID_COLUMNS=new Set(["id","name","point","pointid","no","number","label"]);
const LINE_NAME=/align|centre.?line|center.?line|route|tunnel|track|chainage|profile|線形|中心線|路線|縦断/i;
const CHAINAGE_LIKE=/^(-?\d+)\+(\d{3}(?:\.\d+)?)$/;
// "line" for an alignment table, "profile" for design levels by chainage, or null for any other table. A table of
// points with a borehole-like id column is a collar table, unless it also has a chainage or a design level, or the
// file is named as a line.
export function lineTableKind(file:TextFile):"line"|"profile"|null{
  if(!/\.(csv|tsv|txt)$/i.test(file.name))return null;
  const header=parseCsv(file.text.split(/\r?\n/,1)[0]??"")[0]??[];
  const h=header.map(norm),c=columns(header),l=lineColumns(header);
  if(h.some(v=>BOREHOLE_COLUMNS.has(v)))return null;
  const located=(c.x!==undefined&&c.y!==undefined)||(c.lat!==undefined&&c.lon!==undefined);
  const strong=[l.crown,l.invert,l.axis].some(i=>i!==undefined)||(l.level!==undefined&&!["z","elevation","elev","level"].includes(h[l.level]));
  if(located)return l.chainage!==undefined||strong||LINE_NAME.test(file.name)||!h.some(v=>ID_COLUMNS.has(v))?"line":null;
  return l.chainage!==undefined&&(strong||l.level!==undefined)?"profile":null;
}
// Chainage in metres: a number, or kilometres and metres written 12+345.6; a column headed km, KP or PK holds kilometres.
function chainageOf(v:string|undefined,km:boolean){
  const s=(v??"").trim();
  if(!s)return NaN;
  const m=s.replace(/^(ch|sta|km|kp)\.?\s*/i,"").match(CHAINAGE_LIKE);
  if(m)return Number(m[1])*1000+(m[1].startsWith("-")?-1:1)*Number(m[2]);
  const n=num(s);
  return km?n*1000:n;
}
// Design levels from a row: crown and invert, axis ± half the height, or one level.
function levelsOf(r:string[],l:Partial<Record<LineField,number>>,len:(r:string[],i?:number)=>number){
  const crown=len(r,l.crown),invert=len(r,l.invert),axis=len(r,l.axis),size=len(r,l.size),level=len(r,l.level);
  if(Number.isFinite(crown)&&Number.isFinite(invert))return {top:crown,bottom:invert};
  if(Number.isFinite(axis)&&Number.isFinite(size)&&size>0)return {top:axis+size/2,bottom:axis-size/2};
  if(Number.isFinite(crown))return {top:crown};
  if(Number.isFinite(level))return {top:level};
  if(Number.isFinite(axis))return {top:axis};
  return null;
}
// The points of a line with the same place twice in a row kept once.
function cleanPoints(points:AlignmentPoint[],name:string,notes:string[]){
  const out=points.filter((p,i)=>i===0||Math.hypot(p.x-points[i-1].x,p.y-points[i-1].y)>=1e-3);
  if(out.length<points.length)notes.push(`${name}: ${points.length-out.length} repeated point${points.length-out.length>1?"s":""} dropped`);
  return out;
}
function checked(a:Alignment,file:string){
  const problem=alignmentProblem(a);
  if(problem)throw new Error(`${file}: ${a.name}: ${problem}`);
  return a;
}
function readLineTable(file:TextFile,crs:Crs|null,notes:string[]):Alignment[]{
  const rows=parseCsv(file.text),header=rows[0],data=rows.slice(1).filter(r=>r.some(v=>v.trim()));
  const c=columns(header),l=lineColumns(header),h=header.map(norm),lengths=new Conversions();
  const len=(r:string[],i?:number)=>i===undefined?NaN:lengths.metres(num(r[i]),header[i].trim(),bracketed(header[i]),i);
  const km=l.chainage!==undefined&&["km","kp","pk"].includes(h[l.chainage]);
  const chainage=(r:string[])=>{
    if(l.chainage===undefined)return undefined;
    const v=chainageOf(r[l.chainage],km);
    if(!Number.isFinite(v))throw new Error(`${file.name}: chainage “${r[l.chainage]}” is not in metres, nor in kilometres and metres written as 12+345`);
    return lengths.metres(v,header[l.chainage].trim(),bracketed(header[l.chainage]),l.chainage);
  };
  const projected=c.x!==undefined&&c.y!==undefined;
  if(!projected&&!crs)throw new Error(`${file.name}: positions by latitude and longitude need the project's coordinate system; choose it under Coordinates first`);
  const groups=new Map<string,string[][]>(),base=file.name.replace(/\.[^.]+$/,"");
  for(const r of data){const key=l.line!==undefined?r[l.line]?.trim()||base:base;groups.set(key,[...(groups.get(key)??[]),r])}
  const lines=[...groups].map(([name,list])=>{
    const points:AlignmentPoint[]=list.map(r=>{
      const at=projected?{x:len(r,c.x),y:len(r,c.y)}:toProjected(crs!,num(r[c.lon!]),num(r[c.lat!]));
      const ch=chainage(r);
      return ch===undefined?at:{...at,chainage:ch};
    }).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
    const a:Alignment={name,points:cleanPoints(points,name,notes),source:file.name};
    // Design levels at the points, at their own chainage.
    const ch=alignmentProblem({...a,design:undefined})?[]:chainages(a);
    const design:DesignLevel[]=[];
    list.forEach(r=>{
      const lv=levelsOf(r,l,len);
      if(!lv)return;
      const at=projected?{x:len(r,c.x),y:len(r,c.y)}:toProjected(crs!,num(r[c.lon!]),num(r[c.lat!]));
      const k=a.points.findIndex(p=>Math.hypot(p.x-at.x,p.y-at.y)<1e-3);
      if(k>=0&&!design.some(d=>d.chainage===ch[k]))design.push({chainage:ch[k],...lv});
    });
    if(design.length)a.design=design;
    return checked(a,file.name);
  });
  if(!projected)notes.push(`${file.name}: positions converted from latitude and longitude to ${crs!.name}`);
  if(km)notes.push(`${file.name}: the ${header[l.chainage!].trim()} column is read as kilometres`);
  if(l.axis!==undefined&&l.size!==undefined)notes.push(`${file.name}: crown and invert are the axis level plus and minus half the ${header[l.size].trim()}`);
  else if(l.level!==undefined&&l.crown===undefined)notes.push(`${file.name}: ${header[l.level].trim()} is read as the design level along the line`);
  notes.push(...lengths.notes(file.name,[c.x,c.y].filter(i=>i!==undefined).map(i=>header[i!].trim())));
  return lines;
}
function readProfileTable(file:TextFile,notes:string[]):DesignLevel[]{
  const rows=parseCsv(file.text),header=rows[0],l=lineColumns(header),h=header.map(norm),lengths=new Conversions();
  const len=(r:string[],i?:number)=>i===undefined?NaN:lengths.metres(num(r[i]),header[i].trim(),bracketed(header[i]),i);
  const km=["km","kp","pk"].includes(h[l.chainage!]);
  const design:DesignLevel[]=[];
  for(const r of rows.slice(1)){
    if(!r.some(v=>v.trim()))continue;
    const c=lengths.metres(chainageOf(r[l.chainage!],km),header[l.chainage!].trim(),bracketed(header[l.chainage!]),l.chainage);
    const lv=levelsOf(r,l,len);
    if(Number.isFinite(c)&&lv)design.push({chainage:c,...lv});
  }
  design.sort((p,q)=>p.chainage-q.chainage);
  if(!design.length)throw new Error(`${file.name}: no design levels with a chainage`);
  notes.push(...lengths.notes(file.name,[]));
  return design;
}

// GeoJSON lines: LineString and MultiLineString features. Positions are longitude and latitude, as GeoJSON has them,
// unless the file names a projected system (the older "crs" member); heights of the points are read as design levels.
export const isGeoJsonLines=(f:TextFile)=>/\.geojson$/i.test(f.name)||(/\.json$/i.test(f.name)&&/"(Multi)?LineString"/.test(f.text)&&!/"boreholes"\s*:/.test(f.text));
function readGeoJsonLines(file:TextFile,crs:Crs|null,notes:string[]):Alignment[]{
  let doc:any;
  try{doc=JSON.parse(file.text)}catch(e){throw new Error(`${file.name}: not valid JSON (${(e as Error).message})`)}
  const features:any[]=doc?.type==="FeatureCollection"?doc.features??[]:doc?.type==="Feature"?[doc]:[{geometry:doc,properties:{}}];
  const named=String(doc?.crs?.properties?.name??"").match(/EPSG\D{0,3}(\d{4,5})/i)?.[1];
  const fileCrs=named?findCrs(named):undefined;
  if(named&&!fileCrs)throw new Error(`${file.name}: its coordinate system EPSG:${named} is not known here`);
  const lonLat=(x:number,y:number)=>Math.abs(x)<=180&&Math.abs(y)<=90;
  const out:Alignment[]=[];
  let heights=false,local=false;
  features.forEach((f,i)=>{
    const g=f?.geometry,parts:number[][][]=g?.type==="LineString"?[g.coordinates]:g?.type==="MultiLineString"?g.coordinates:[];
    parts.forEach((coords,j)=>{
      const pts=(coords??[]).filter(c=>Array.isArray(c)&&Number.isFinite(c[0])&&Number.isFinite(c[1]));
      if(pts.length<2)return;
      const place=(c:number[]):XY=>{
        if(fileCrs){
          if(crs&&fileCrs.code===crs.code)return {x:c[0],y:c[1]};
          if(!crs){local=true;return {x:c[0],y:c[1]}}
          const g=toGeographic(fileCrs,c[0],c[1]);return toProjected(crs,g.lon,g.lat);
        }
        if(!lonLat(c[0],c[1])){local=true;return {x:c[0],y:c[1]}}
        if(!crs)throw new Error(`${file.name}: GeoJSON positions are longitude and latitude, which need the project's coordinate system; choose it under Coordinates first`);
        return toProjected(crs,c[0],c[1]);
      };
      const label=f?.properties?.name??f?.properties?.title??f?.properties?.id;
      const name=`${label??file.name.replace(/\.[^.]+$/,"")}${parts.length>1?` ${j+1}`:label?"":features.length>1?` ${i+1}`:""}`;
      const a:Alignment={name,points:cleanPoints(pts.map(place),name,notes),source:file.name};
      if(pts.every(c=>Number.isFinite(c[2]))&&!alignmentProblem(a)){
        const ch=chainages(a);
        a.design=pts.length===a.points.length?pts.map((c,k)=>({chainage:ch[k],top:c[2]})):undefined;
        heights||=!!a.design;
      }
      out.push(checked(a,file.name));
    });
  });
  if(!out.length)throw new Error(`${file.name}: no LineString with two points or more`);
  if(heights)notes.push(`${file.name}: the heights of the points are read as design levels`);
  if(local)notes.push(`${file.name}: positions are read in the project's coordinates`);
  return out;
}

// DXF polylines (LWPOLYLINE, and POLYLINE with its VERTEX entities), with arcs (bulges) followed within 2 cm. Positions
// are read in the project's coordinates, in the drawing's units.
export const isDxf=(f:TextFile)=>/\.dxf$/i.test(f.name)||/^\s*0\s*\r?\n\s*SECTION\s*\r?\n\s*2\s*\r?\n\s*HEADER/.test(f.text);
const DXF_UNITS:Record<number,[number,string]>={1:[0.0254,"inches"],2:[0.3048,"feet"],3:[1609.344,"miles"],4:[0.001,"millimetres"],5:[0.01,"centimetres"],6:[1,"metres"],7:[1000,"kilometres"],10:[0.9144,"yards"]};
function arcPoints(p:XY,q:XY,bulge:number):XY[]{
  const dx=q.x-p.x,dy=q.y-p.y,c=Math.hypot(dx,dy),theta=4*Math.atan(bulge);
  if(c<1e-9||Math.abs(theta)<1e-9)return [];
  const d=c/2/Math.tan(theta/2),cx=(p.x+q.x)/2-dy/c*d,cy=(p.y+q.y)/2+dx/c*d,r=Math.hypot(p.x-cx,p.y-cy);
  const a0=Math.atan2(p.y-cy,p.x-cx),step=2*Math.acos(Math.max(-1,1-0.02/r)),n=Math.min(720,Math.max(1,Math.ceil(Math.abs(theta)/step)));
  return Array.from({length:n-1},(_,k)=>({x:cx+r*Math.cos(a0+theta*(k+1)/n),y:cy+r*Math.sin(a0+theta*(k+1)/n)}));
}
function readDxfLines(file:TextFile,notes:string[]):Alignment[]{
  if(/^AutoCAD Binary DXF/.test(file.text))throw new Error(`${file.name}: binary DXF is not read; save the drawing as ASCII DXF`);
  // Group codes and values in pairs, gathered into the entities of the ENTITIES section.
  const lines=file.text.split(/\r?\n/),entities:Array<{type:string;codes:Array<[number,string]>}>=[];
  let section="",units=0,entity:typeof entities[number]|null=null;
  for(let i=0;i+1<lines.length;i+=2){
    const code=Number(lines[i].trim()),value=lines[i+1].trim();
    if(code===0){
      if(entity){entities.push(entity);entity=null}
      if(value==="SECTION"){section=Number(lines[i+2]?.trim())===2?(lines[i+3]??"").trim():""}
      else if(value==="ENDSEC")section="";
      else if(section==="ENTITIES")entity={type:value,codes:[]};
    }else if(entity)entity.codes.push([code,value]);
    else if(section==="HEADER"&&code===9&&value==="$INSUNITS"&&Number(lines[i+2]?.trim())===70)units=Number(lines[i+3]);
  }
  if(entity)entities.push(entity);
  const polylines:Array<{layer:string;closed:boolean;v:Array<XY&{bulge:number}>}>=[];
  for(let i=0;i<entities.length;i++){
    const e=entities[i],p={layer:"0",closed:false,v:[] as Array<XY&{bulge:number}>};
    if(e.type==="LWPOLYLINE"){
      for(const [code,value] of e.codes){
        if(code===8)p.layer=value;
        else if(code===70)p.closed=(Number(value)&1)===1;
        else if(code===10)p.v.push({x:Number(value),y:NaN,bulge:0});
        else if(code===20&&p.v.length)p.v[p.v.length-1].y=Number(value);
        else if(code===42&&p.v.length)p.v[p.v.length-1].bulge=Number(value);
      }
      polylines.push(p);
    }else if(e.type==="POLYLINE"){
      // Its VERTEX entities follow it up to SEQEND; meshes and spline frame points are no line.
      let mesh=false;
      for(const [code,value] of e.codes){if(code===8)p.layer=value;else if(code===70){p.closed=(Number(value)&1)===1;mesh=(Number(value)&(16|64))!==0}}
      while(entities[i+1]?.type==="VERTEX"){
        const q={x:NaN,y:NaN,bulge:0};
        let flags=0;
        for(const [code,value] of entities[++i].codes){if(code===10)q.x=Number(value);else if(code===20)q.y=Number(value);else if(code===42)q.bulge=Number(value);else if(code===70)flags=Number(value)}
        if(!(flags&(16|64|128)))p.v.push(q);
      }
      if(!mesh)polylines.push(p);
    }
  }
  const [scale,unitName]=DXF_UNITS[units]??[1,""];
  const traced=polylines.map(p=>{
    const v=p.v.filter(q=>Number.isFinite(q.x)&&Number.isFinite(q.y)),pts:XY[]=[];
    const n=p.closed?v.length:v.length-1;
    v.forEach((q,k)=>{pts.push({x:q.x,y:q.y});if(k<n&&q.bulge)pts.push(...arcPoints(q,v[(k+1)%v.length],q.bulge))});
    if(p.closed&&v.length>2)pts.push({x:v[0].x,y:v[0].y});
    return {layer:p.layer||"0",points:pts.map(q=>({x:q.x*scale,y:q.y*scale}))};
  }).filter(p=>p.points.length>=2);
  if(!traced.length)throw new Error(`${file.name}: no polyline (LWPOLYLINE or POLYLINE) in the drawing; draw the alignment as one polyline`);
  // A whole drawing has many polylines: those on layers named as lines come first, and at most 20 are kept.
  const length=(p:{points:XY[]})=>p.points.reduce((s,q,k)=>k?s+Math.hypot(q.x-p.points[k-1].x,q.y-p.points[k-1].y):0,0);
  const named=traced.filter(p=>LINE_NAME.test(p.layer)||/^(cl|c\/l|axis)$/i.test(p.layer));
  let kept=named.length?named:traced;
  if(kept.length>20){kept=[...kept].sort((p,q)=>length(q)-length(p)).slice(0,20);notes.push(`${file.name}: the 20 longest of ${traced.length} polylines are kept`)}
  else if(named.length&&named.length<traced.length)notes.push(`${file.name}: ${named.length} polyline${named.length>1?"s":""} on layers named as lines kept; ${traced.length-named.length} other polylines ignored`);
  const count=new Map<string,number>();
  for(const p of kept)count.set(p.layer,(count.get(p.layer)??0)+1);
  const seen=new Map<string,number>();
  const out=kept.map(p=>{
    const k=(seen.get(p.layer)??0)+1;seen.set(p.layer,k);
    const name=count.get(p.layer)!>1?`${p.layer} ${k}`:p.layer;
    return checked({name,points:cleanPoints(p.points,name,notes),source:file.name},file.name);
  });
  notes.push(unitName?`${file.name}: drawing units ${unitName}${scale!==1?", converted to metres":""}; positions are read in the project's coordinates`:`${file.name}: the drawing does not state its units; positions are read as metres in the project's coordinates`);
  return out;
}
// LandXML and J-LandXML alignments, in the coordinate system the file names, converted to the project's where both
// are known; otherwise read in the project's coordinates.
function readLandXmlLines(file:TextFile,crs:Crs|null,notes:string[]):Alignment[]{
  const r=readLandXml(file.text,file.name),fileCrs=r.crsCode?findCrs(r.crsCode):undefined;
  notes.push(...r.notes);
  if(fileCrs&&crs&&fileCrs.code!==crs.code){
    for(const a of r.alignments)a.points=a.points.map(p=>{const g=toGeographic(fileCrs,p.x,p.y);return {...p,...toProjected(crs,g.lon,g.lat)}});
    notes.push(`${file.name}: positions converted from ${fileCrs.name} (${fileCrs.code}) to ${crs.name}`);
  }else if(r.crsCode&&!fileCrs)notes.push(`${file.name}: its coordinate system ${r.crsCode} is not known here; positions are read in the project's coordinates`);
  else if(!r.crsCode)notes.push(`${file.name}: the file does not name its coordinate system; positions are read in the project's coordinates`);
  else if(!crs)notes.push(`${file.name}: positions in ${fileCrs!.name}, read as the project's coordinates`);
  return r.alignments.map(a=>checked(a,file.name));
}
// Alignments as CSV: the points with their chainage, and the design levels at them where given.
export function toAlignmentCsv(a:Alignment){
  const ch=chainages(a),band=a.design?.some(d=>d.bottom!==undefined),design=!!a.design?.length;
  const rows:Array<Array<string|number|undefined>>=[["x","y","chainage_m",...(design?band?["crown_m","invert_m"]:["level_m"]:[])]];
  a.points.forEach((p,k)=>{
    const d=designAt(a.design,ch[k]);
    rows.push([round3(p.x),round3(p.y),round3(ch[k]),...(design?band?[d.top===undefined?undefined:round3(d.top),d.bottom===undefined?undefined:round3(d.bottom)]:[d.top===undefined?undefined:round3(d.top)]:[])]);
  });
  return toCsv(rows);
}
const round3=(v:number)=>Math.round(v*1000)/1000;

// Alignment files attach to the project imported with them, or to `current`; a profile table attaches its design
// levels to the line named in it, or else to the last line.
function readAlignmentFiles(lineFiles:TextFile[],profiles:TextFile[],project:GeoProject,warnings:string[]){
  const crs=projectCrs(project),added:Alignment[]=[];
  for(const f of lineFiles){
    const read=isLandXml(f.text)?readLandXmlLines(f,crs,warnings):isDxf(f)?readDxfLines(f,warnings):isGeoJsonLines(f)?readGeoJsonLines(f,crs,warnings):readLineTable(f,crs,warnings);
    added.push(...read);
  }
  const all=[...(project.alignments??[]),...added];
  for(const f of profiles){
    const header=parseCsv(f.text.split(/\r?\n/,1)[0]??"")[0]??[],l=lineColumns(header);
    const named=l.line!==undefined?parseCsv(f.text)[1]?.[l.line]?.trim():undefined;
    const target=all.find(a=>a.name===named)??all[all.length-1];
    if(!target)throw new Error(`${f.name}: design levels by chainage need a line; import the alignment first`);
    const design=readProfileTable(f,warnings),i=all.indexOf(target),next={...target,design};
    const problem=alignmentProblem(next);
    if(problem)throw new Error(`${f.name}: ${problem}`);
    all[i]=next;
    if(added.includes(target))added[added.indexOf(target)]=next;
    else added.push(next);
    warnings.push(`${f.name}: ${design.length} design level${design.length>1?"s":""} for ${target.name}`);
  }
  // A line read again under the same name replaces the earlier one.
  const names=new Set(added.map(a=>a.name));
  project.alignments=[...(project.alignments??[]).filter(a=>!names.has(a.name)),...added.filter((a,k)=>added.findIndex(b=>b.name===a.name)===k)];
  for(const a of added){
    const ch=chainages(a);
    warnings.unshift(`Alignment ${a.name}: ${a.points.length} points, chainage ${Math.round(ch[0])}–${Math.round(ch[ch.length-1])} m${a.design?.length?`, ${a.design.length} design level${a.design.length>1?"s":""}${a.design.some(d=>d.bottom!==undefined)?" (crown and invert)":""}`:""}`);
  }
  return [...names];
}

// ---------- entry point ----------

// Terrain grids (.asc, gridded .xyz) attach to the boreholes imported with them, or to `current` when they come alone;
// so do alignments (CSV, GeoJSON, DXF) and design profiles. `declared` is the coordinate system of CSV tables
// (positions given by latitude and longitude are placed in it).
export function importFiles(files:TextFile[],current?:GeoProject,declared?:Crs):ImportResult{
  if(!files.length)throw new Error("No files to import");
  const lineFiles=files.filter(f=>!isTerrainFile(f.name,f.text)&&(isLandXml(f.text)||isDxf(f)||isGeoJsonLines(f)||lineTableKind(f)==="line"));
  const profiles=files.filter(f=>!isTerrainFile(f.name,f.text)&&lineTableKind(f)==="profile");
  if(lineFiles.length||profiles.length){
    const rest=files.filter(f=>!lineFiles.includes(f)&&!profiles.includes(f));
    const result=rest.length?importFiles(rest,current,declared):current?{project:{...current},warnings:[]}:null;
    if(!result)throw new Error("Load or import boreholes before adding an alignment");
    result.alignments=readAlignmentFiles(lineFiles,profiles,result.project,result.warnings);
    return result;
  }
  const grids=files.filter(f=>isTerrainFile(f.name,f.text)),rest=files.filter(f=>!grids.includes(f));
  if(grids.length){
    const terrain:TerrainGrid=readTerrain(grids[0].name,grids[0].text);
    const note=`Terrain from ${grids[0].name}: ${terrain.ncols} × ${terrain.nrows} cells of ${round(terrain.dx)} × ${round(terrain.dy)} m`;
    const result=rest.length?importFiles(rest):current?{project:{...current},warnings:[]}:null;
    if(!result)throw new Error("Load or import boreholes before adding a terrain grid");
    result.project.terrain=terrain;
    result.warnings.unshift(note,...grids.slice(1).map(f=>`Only one terrain grid is used; ${f.name} was ignored`));
    return result;
  }
  for(const [is,read,what] of [[isBroXml,readBroLogs,"BRO borehole"],[isDovXml,readDovFiles,"DOV"]] as const){
    const xml=files.filter(f=>is(f.text));
    if(!xml.length)continue;
    const result=read(xml,current);
    if(xml.length<files.length)result.warnings.unshift(`Only the ${what} files were read; ${files.length-xml.length} other file${files.length-xml.length>1?"s were":" was"} ignored`);
    return result;
  }
  const logs=files.filter(f=>isBoringXml(f.text));
  if(logs.length){
    const result=readBoringLogs(logs,current);
    if(logs.length<files.length)result.warnings.unshift(`Only the borehole logs were read; ${files.length-logs.length} other file${files.length-logs.length>1?"s were":" was"} ignored`);
    return result;
  }
  const structured=files.filter(f=>/\.(json|ags)$/i.test(f.name)||/^\s*[{[]/.test(f.text)||/^\s*"GROUP"/.test(f.text));
  if(structured.length){
    const f=structured[0];
    const result=readStructured(f);
    if(files.length>1)result.warnings.unshift(`Only ${f.name} was read; import CSV tables on their own`);
    return result;
  }
  const t:Tables={collars:new Map(),intervals:new Map(),units:[],warnings:[]};
  for(const f of files)readCsvTable(f,t);
  if(!t.intervals.size)throw new Error("No interval table found: the CSV files need hole id, from, to and unit columns");
  return assemble(t,files.length===1?files[0].name.replace(/\.[^.]+$/,""):"Imported boreholes",undefined,false,declared);
}
function readStructured(f:TextFile):ImportResult{
  if(/^\s*"GROUP"/.test(f.text)||/\.ags$/i.test(f.name))return readAgs4(f);
  let doc:any;
  try{doc=JSON.parse(f.text)}catch(e){throw new Error(`${f.name}: not valid JSON (${(e as Error).message})`)}
  if(Array.isArray(doc?.boreholes)&&doc.boreholes.some((b:any)=>b&&"borehole_id" in b))return readGeoreport3D(doc,f.name);
  if(Array.isArray(doc?.boreholes))return readProjectJson(doc,f.name);
  throw new Error(`${f.name}: expected a GeoModel3D project or a Georeport3D extraction (an object with a "boreholes" array)`);
}
