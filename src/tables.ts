// The data editor's tables: a project as rows of text a person can type or paste, and back. A project is rebuilt from
// the tables through the CSV importer, so data typed in are checked exactly as imported files are.
import {GeoProject,UnitRule,Borehole} from "./geology";
import {ImportResult,importFiles,toCsv} from "./io";
import {Crs,projectCrs,findCrs,searchCrs,customCrs} from "./crs";
import {applyUnitRules,lithologyRules} from "./rules";

export type TableName="boreholes"|"logs"|"water"|"spt"|"tests"|"units";
// Column headers as shown, and as written to CSV (the importer's names).
export const COLUMNS:Record<TableName,Array<{label:string;csv:string;numeric?:boolean;hint?:string}>>={
  boreholes:[
    {label:"Borehole",csv:"hole_id"},{label:"Easting (m)",csv:"x",numeric:true},{label:"Northing (m)",csv:"y",numeric:true},
    {label:"Latitude",csv:"lat",numeric:true,hint:"Decimal degrees, used where there is no easting and northing"},{label:"Longitude",csv:"lon",numeric:true},
    {label:"Ground level (m)",csv:"z",numeric:true},{label:"Final depth (m)",csv:"depth",numeric:true,hint:"When the hole went deeper than the log"}
  ],
  logs:[
    {label:"Borehole",csv:"hole_id"},{label:"From (m)",csv:"from",numeric:true},{label:"To (m)",csv:"to",numeric:true},
    {label:"Unit",csv:"unit",hint:"A unit of the Units table; new ones are added at the bottom of the column"},{label:"Description",csv:"description"}
  ],
  water:[{label:"Borehole",csv:"hole_id"},{label:"Depth to water (m)",csv:"water_depth",numeric:true},{label:"Date",csv:"date"}],
  spt:[{label:"Borehole",csv:"hole_id"},{label:"Depth (m)",csv:"depth",numeric:true},{label:"Blows",csv:"blows",numeric:true,hint:"Blows for the test drive, N for a complete 300 mm test"},
    {label:"Penetration (mm)",csv:"penetration",numeric:true,hint:"300 for a complete test; less where it stopped"}],
  tests:[{label:"Borehole",csv:"hole_id"},{label:"Depth (m)",csv:"depth",numeric:true},{label:"To (m)",csv:"to",numeric:true,hint:"Base of a sample over a depth range"},
    {label:"Property",csv:"property"},{label:"Value",csv:"value",numeric:true}],
  units:[
    {label:"Unit",csv:"unit"},{label:"Name",csv:"name"},{label:"Colour",csv:"colour"},{label:"Erosive",csv:"erosive",hint:"yes: its base cuts down into older units"},
    {label:"γ (kN/m³)",csv:"gamma",numeric:true},{label:"γsat (kN/m³)",csv:"gamma_sat",numeric:true},{label:"c′ (kPa)",csv:"c",numeric:true},
    {label:"φ′ (°)",csv:"phi",numeric:true},{label:"su (kPa)",csv:"su",numeric:true},{label:"E (MPa)",csv:"E",numeric:true},
    {label:"k (m/s)",csv:"k",numeric:true},{label:"Source",csv:"source",hint:"Where the values come from"}
  ]
};
export const TABLE_NAMES:Record<TableName,string>={boreholes:"Boreholes",logs:"Logs",water:"Water levels",spt:"SPT",tests:"Tests",units:"Units"};
export interface ProjectFields { name:string; description:string; source:string; crs:string; groundwaterDepth:string; base:string }
export interface EditorTables { project:ProjectFields; rows:Record<TableName,string[][]> }

const text=(v:unknown)=>v===undefined||v===null||(typeof v==="number"&&!Number.isFinite(v))?"":String(v);

export function tablesFromProject(p:GeoProject):EditorTables{
  const crs=projectCrs(p);
  const rows:Record<TableName,string[][]>={boreholes:[],logs:[],water:[],spt:[],tests:[],units:[]};
  for(const b of p.boreholes){
    rows.boreholes.push([b.id,text(b.x),text(b.y),text(b.lat),text(b.lon),text(b.z),text(b.depth)]);
    for(const i of b.intervals)rows.logs.push([b.id,text(i.from),text(i.to),i.unit,i.name??""]);
    for(const w of b.water??[])rows.water.push([b.id,text(w.depth),w.date??""]);
    for(const t of b.spt??[])rows.spt.push([b.id,text(t.depth),text(t.blows),text(t.penetration)]);
    for(const t of b.tests??[])rows.tests.push([b.id,text(t.depth),text(t.to),t.property,text(t.value)]);
  }
  for(const u of p.units)rows.units.push([u.id,u.name,u.color,u.erosive?"yes":"",text(u.gamma),text(u.gammaSat),
    ...["c","phi","su","E","k"].map(k=>text(u.params?.[k])),u.source??""]);
  return {project:{name:p.name,description:p.description??"",source:p.source??"",crs:crs?(crs.code&&findCrs(crs.code)?crs.code:crs.proj4):p.crs??"",
    groundwaterDepth:text(p.groundwaterDepth),base:text(p.base)},rows};
}
export function emptyTables():EditorTables{
  return {project:{name:"New project",description:"",source:"",crs:"",groundwaterDepth:"",base:""},
    rows:{boreholes:[["BH-01","","","","","",""]],logs:[["BH-01","0","","",""]],water:[],spt:[],tests:[],units:[["","","","","","","","","","","",""]]}};
}

// The coordinate system typed in the project tab: an EPSG code, a name or a PROJ definition. Any other text names a
// local system: the model is then not georeferenced.
export function crsFromText(value:string):Crs|undefined{
  const v=value.trim();
  if(!v)return undefined;
  if(v.startsWith("+"))return customCrs(v);
  const code=v.match(/(?:EPSG:?\s*)?(\d{4,5})\b/i)?.[1];
  if(code&&findCrs(code))return findCrs(code)!;
  const found=searchCrs(v,2);
  return found.length===1?found[0]:undefined;
}
const filled=(r:string[])=>r.some(c=>c.trim()!=="");
const csvOf=(name:TableName,rows:string[][])=>({name:`${name}.csv`,text:toCsv([COLUMNS[name].map(c=>c.csv),...rows.filter(filled)])});
export const tableCsv=(t:EditorTables,name:TableName)=>csvOf(name,t.rows[name]).text;

// A project from the tables. What the tables do not show (terrain, unit rules, other unit parameters) is kept from the
// project being edited.
export function projectFromTables(t:EditorTables,base?:GeoProject):ImportResult{
  const crs=crsFromText(t.project.crs);
  const files=(Object.keys(COLUMNS) as TableName[]).filter(n=>n==="boreholes"||n==="logs"||t.rows[n].some(filled)).map(n=>csvOf(n,t.rows[n]));
  const result=importFiles(files,undefined,crs);
  const p=result.project,f=t.project,num=(s:string)=>s.trim()===""?undefined:Number(s.replace(",","."));
  p.name=f.name.trim()||"Untitled project";
  if(f.description.trim())p.description=f.description.trim();
  if(f.source.trim())p.source=f.source.trim();
  const gw=num(f.groundwaterDepth),bottom=num(f.base);
  if(gw!==undefined&&Number.isFinite(gw))p.groundwaterDepth=gw;
  if(bottom!==undefined&&Number.isFinite(bottom))p.base=bottom;
  if(!crs){
    delete p.crsCode;delete p.crsProj4;p.crs=f.crs.trim()||undefined;
    if(p.crs)result.warnings.push(`Coordinate system “${p.crs}” is not a known one: the model is not georeferenced (no terrain or map). Type an EPSG code or paste a PROJ definition to place it`);
  }
  if(base){
    if(base.rules)p.rules=base.rules;
    if(base.terrain&&projectCrs(base)?.proj4===crs?.proj4)p.terrain=base.terrain;
    const before=new Map(base.units.map(u=>[u.id,u]));
    for(const u of p.units){
      const extra=Object.entries(before.get(u.id)?.params??{}).filter(([k])=>!["c","phi","su","E","k"].includes(k));
      if(extra.length)u.params={...Object.fromEntries(extra),...u.params};
    }
  }
  return result;
}

// Units for log rows that have a description but no unit, by the project's rules or by principal soil.
export function fillUnits(t:EditorTables,rules?:UnitRule[]){
  const ruleSet=rules?.length?rules:lithologyRules;
  const holes=new Map<string,Borehole>(t.rows.boreholes.map(r=>[r[0],{id:r[0],x:0,y:0,z:Number(r[5])||0,intervals:[],spt:[]}]));
  for(const r of t.rows.spt){const b=holes.get(r[0]);if(b)b.spt!.push({depth:Number(r[1]),blows:Number(r[2]),penetration:Number(r[3])||300})}
  let n=0;
  for(const r of t.rows.logs){
    if(r[3].trim()||!r[4].trim())continue;
    const b=holes.get(r[0])??{id:r[0],x:0,y:0,z:0,intervals:[]};
    const [mapped]=applyUnitRules([{...b,intervals:[{from:Number(r[1]),to:Number(r[2]),unit:"",name:r[4]}]}],ruleSet).boreholes;
    r[3]=mapped.intervals[0].unit;n++;
  }
  return n;
}
