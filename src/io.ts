import proj4 from "proj4";
import {Borehole,GeoProject,Interval,UnitDef,UnitRule,SptTest,WaterLevel,boreholeDepth} from "./geology";
import {TerrainGrid,isTerrainFile,readTerrain} from "./terrain";
import {Crs,findCrs,projectCrs,suggestCrs,toProjected,searchCrs} from "./crs";
import {isBoringXml,readBoringXml} from "./boringXml";
import {applyUnitRules,japaneseLithologyRules} from "./rules";

export interface TextFile { name:string; text:string }
export interface ImportResult { project:GeoProject; warnings:string[] }

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

const norm=(h:string)=>h.toLowerCase().replace(/[^a-z0-9]/g,"");
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

interface Collar { x:number; y:number; z:number; depth?:number; lon?:number; lat?:number; spt?:SptTest[]; water?:WaterLevel[] }
interface Tables { collars:Map<string,Collar>; intervals:Map<string,Interval[]>; units:UnitDef[]; warnings:string[] }

function readCsvTable(file:TextFile,t:Tables){
  const rows=parseCsv(file.text);
  if(rows.length<2){t.warnings.push(`${file.name}: no data rows`);return}
  const c=columns(rows[0]),has=(...f:Field[])=>f.every(k=>c[k]!==undefined);
  const data=rows.slice(1);
  const cell=(r:string[],f:Field)=>c[f]===undefined?undefined:r[c[f]!]?.trim();
  const collar=(r:string[]):Collar=>({x:num(cell(r,"x")),y:num(cell(r,"y")),z:num(cell(r,"z")),depth:num(cell(r,"depth")),lon:num(cell(r,"lon")),lat:num(cell(r,"lat"))});
  if(has("id","from","to","unit")){
    const combined=has("x","y","z")||has("lat","lon","z");
    for(const r of data){
      const id=cell(r,"id");
      if(!id){t.warnings.push(`${file.name}: row without a borehole id skipped`);continue}
      const from=num(cell(r,"from")),to=num(cell(r,"to")),unit=cell(r,"unit")??"";
      if(!t.intervals.has(id))t.intervals.set(id,[]);
      t.intervals.get(id)!.push({from,to,unit});
      if(combined&&!t.collars.has(id))t.collars.set(id,collar(r));
    }
  }else if(has("id","x","y")||has("id","lat","lon")){
    for(const r of data){
      const id=cell(r,"id");
      if(!id)continue;
      if(t.collars.has(id))t.warnings.push(`${file.name}: duplicate collar ${id}; first row kept`);
      else t.collars.set(id,collar(r));
    }
  }else if(c.unit!==undefined&&(["color","name","erosive","gamma","gammaSat"] as Field[]).some(f=>c[f]!==undefined)){
    for(const r of data){
      const id=cell(r,"unit");
      if(id)t.units.push(unitDef({id,name:cell(r,"name"),color:cell(r,"color"),erosive:cell(r,"erosive"),gamma:cell(r,"gamma"),gammaSat:cell(r,"gammaSat"),source:cell(r,"source")}));
    }
  }else{
    throw new Error(`${file.name}: unrecognised columns (${rows[0].join(", ")}). Expected a borehole table with hole id, x, y, z, from, to and unit columns, or separate collar (hole id, x, y, z) and interval (hole id, from, to, unit) tables.`);
  }
}

// ---------- AGS4 ----------

export function parseAgs4(text:string){
  if(/^\s*"\*\*/.test(text))throw new Error("AGS 3 files are not supported; export the data as AGS4");
  const groups=new Map<string,Array<Record<string,string>>>();
  let group="",heading:string[]=[];
  for(const r of parseCsv(text,",")){
    if(r[0]==="GROUP"){group=r[1];heading=[];if(!groups.has(group))groups.set(group,[])}
    else if(r[0]==="HEADING")heading=r;
    else if(r[0]==="DATA"&&group)groups.get(group)!.push(Object.fromEntries(heading.slice(1).map((h,i)=>[h,r[i+1]??""])));
  }
  return groups;
}
function readAgs4(file:TextFile):ImportResult{
  const g=parseAgs4(file.text),warnings:string[]=[];
  const loca=g.get("LOCA")??[],geol=g.get("GEOL")??[];
  if(!loca.length||!geol.length)throw new Error(`${file.name}: an AGS4 model needs LOCA (locations) and GEOL (field geological descriptions) groups`);
  const key=["GEOL_GEOL","GEOL_GEO2","GEOL_LEG"].find(k=>geol.some(r=>r[k]?.trim()));
  if(!key)throw new Error(`${file.name}: GEOL rows carry no GEOL_GEOL, GEOL_GEO2 or GEOL_LEG unit codes`);
  const names=new Map((g.get("ABBR")??[]).filter(r=>r.ABBR_HDNG===key).map(r=>[r.ABBR_CODE,r.ABBR_DESC]));
  const t:Tables={collars:new Map(),intervals:new Map(),units:[],warnings};
  let local=false;
  for(const r of loca){
    let x=num(r.LOCA_NATE),y=num(r.LOCA_NATN),z=num(r.LOCA_GL);
    const lon=num(r.LOCA_LON),lat=num(r.LOCA_LAT);
    if((!Number.isFinite(x)||!Number.isFinite(y))&&!(Number.isFinite(lon)&&Number.isFinite(lat))){x=num(r.LOCA_LOCX);y=num(r.LOCA_LOCY);z=Number.isFinite(z)?z:num(r.LOCA_LOCZ);local=local||Number.isFinite(x)}
    t.collars.set(r.LOCA_ID,{x,y,z,depth:num(r.LOCA_FDEP),lon,lat});
  }
  if(local)warnings.push("Some locations have no national grid coordinates; local LOCA_LOCX/LOCA_LOCY were used for them");
  for(const r of geol){
    const code=r[key]?.trim();
    if(!code){warnings.push(`${r.LOCA_ID}: GEOL ${r.GEOL_TOP}–${r.GEOL_BASE} m has no ${key}; skipped`);continue}
    if(!t.intervals.has(r.LOCA_ID))t.intervals.set(r.LOCA_ID,[]);
    t.intervals.get(r.LOCA_ID)!.push({from:num(r.GEOL_TOP),to:num(r.GEOL_BASE),unit:code});
  }
  t.units=[...new Set(geol.map(r=>r[key]?.trim()).filter(Boolean))].filter(c=>names.has(c)).map(c=>({id:c,name:names.get(c)!,color:""}));
  const proj=g.get("PROJ")?.[0];
  const grefs=[...new Set(loca.map(r=>r.LOCA_GREF).filter(Boolean))];
  const named=grefs.length===1?crsFromName(grefs[0]):undefined;
  const result=assemble(t,proj?.PROJ_NAME||file.name.replace(/\.[^.]+$/,""),named?named.name:grefs.length===1?grefs[0]:undefined,true,named);
  result.project.description=`Imported from AGS4 (${file.name}); units from ${key}.`;
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
function unitDef(u:{id:string;name?:unknown;color?:unknown;erosive?:unknown;gamma?:unknown;gammaSat?:unknown;source?:unknown}):UnitDef{
  const out:UnitDef={id:u.id,name:typeof u.name==="string"&&u.name.trim()?u.name.trim():u.id,color:normaliseColor(u.color)??""};
  if(u.erosive===true||typeof u.erosive==="string"&&/^(y|yes|true|1|x)$/i.test(u.erosive.trim()))out.erosive=true;
  const gamma=typeof u.gamma==="number"?u.gamma:num(u.gamma as string|undefined);
  const gammaSat=typeof u.gammaSat==="number"?u.gammaSat:num(u.gammaSat as string|undefined);
  if(Number.isFinite(gamma))out.gamma=gamma;
  if(Number.isFinite(gammaSat))out.gammaSat=gammaSat;
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
      spt:list(b.spt,["depth","blows","penetration"]),water:list(b.water,["depth"])});
    t.intervals.set(id,(b.intervals??[]).map((i:any)=>({from:Number(i.from),to:Number(i.to),unit:String(i.unit??"").trim(),...(typeof i.name==="string"?{name:i.name}:{})})));
  }
  const rules:UnitRule[]|undefined=Array.isArray(doc.rules)?doc.rules.filter((r:any)=>r&&typeof r.match==="string"&&typeof r.unit==="string"):undefined;
  const crs=doc.crsProj4?{name:doc.crs||doc.crsCode||"Custom",code:doc.crsCode,proj4:String(doc.crsProj4)}:doc.crsCode?findCrs(String(doc.crsCode)):undefined;
  if(doc.crsCode&&!crs)t.warnings.push(`${file}: coordinate system ${doc.crsCode} is not known here; the model is shown without a map`);
  const result=assemble(t,doc.name||file,doc.crs,!t.units.length,crs??undefined,rules);
  if(doc.description)result.project.description=String(doc.description);
  if(doc.source)result.project.source=String(doc.source);
  if(Number.isFinite(doc.base))result.project.base=Number(doc.base);
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
    base:p.base,units:p.units,rules:p.rules,boreholes:p.boreholes,terrain:p.terrain};
  return JSON.stringify(doc,null,1).replace(/"z": \[[^\]]*\]/,m=>m.replace(/\s+/g,""))+"\n";
}
export function toBoreholeCsv(p:GeoProject){
  const rows:Array<Array<string|number|undefined>>=[["hole_id","x","y","z","depth","from","to","unit"]];
  for(const b of p.boreholes)for(const i of b.intervals)rows.push([b.id,b.x,b.y,b.z,b.depth,i.from,i.to,i.unit]);
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

function assemble(t:Tables,name:string,crsName:string|undefined,inferUnits:boolean,declared?:Crs,rules?:UnitRule[]):ImportResult{
  const warnings=t.warnings,boreholes:Borehole[]=[];
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
    if(collar.spt?.length)b.spt=collar.spt;
    if(collar.water?.length)b.water=collar.water;
    boreholes.push(b);
  }
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
  [/made ground|fill|埋土|盛土/i,"#7d6f86"],[/topsoil|表土/i,"#5b4a3a"],[/peat|organic|泥炭|腐植/i,"#4a3b2a"],
  [/sandstone|砂岩/i,"#b9925c"],[/siltstone/i,"#8a8170"],[/mudstone|shale|claystone|泥岩|頁岩/i,"#6f7686"],
  [/limestone|石灰岩/i,"#9fb4c0"],[/chalk/i,"#ddd8c8"],[/coal|石炭/i,"#3a3a3a"],[/conglomerate|礫岩/i,"#b07a4f"],
  [/granite|花崗岩/i,"#a3999c"],[/basalt|andesite|玄武岩|安山岩/i,"#5f6366"],[/tuff|凝灰岩/i,"#b5a99a"],
  [/schist|gneiss|片岩|片麻岩/i,"#7f8a7a"],[/weathered|風化/i,"#8f806d"],[/alluvi|沖積/i,"#c2ab7c"],
  [/gravel|礫/i,"#d08a4c"],[/clay|粘土/i,"#9c7a5b"],[/silt|シルト/i,"#a89a7a"],[/sand|砂/i,"#d9b871"]
];
const PALETTE=["#c2ab7c","#8f806d","#d08a4c","#6f7686","#b9925c","#a3999c","#7f8a7a","#9fb4c0","#9c7a5b","#b5a99a","#7d6f86","#5f6366"];
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

// ---------- entry point ----------

// Terrain grids (.asc, gridded .xyz) attach to the boreholes imported with them, or to `current` when they come alone.
export function importFiles(files:TextFile[],current?:GeoProject):ImportResult{
  if(!files.length)throw new Error("No files to import");
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
  return assemble(t,files.length===1?files[0].name.replace(/\.[^.]+$/,""):"Imported boreholes",undefined,false);
}
function readStructured(f:TextFile):ImportResult{
  if(/^\s*"GROUP"/.test(f.text)||/\.ags$/i.test(f.name))return readAgs4(f);
  let doc:any;
  try{doc=JSON.parse(f.text)}catch(e){throw new Error(`${f.name}: not valid JSON (${(e as Error).message})`)}
  if(Array.isArray(doc?.boreholes)&&doc.boreholes.some((b:any)=>b&&"borehole_id" in b))return readGeoreport3D(doc,f.name);
  if(Array.isArray(doc?.boreholes))return readProjectJson(doc,f.name);
  throw new Error(`${f.name}: expected a GeoModel3D project or a Georeport3D extraction (an object with a "boreholes" array)`);
}
