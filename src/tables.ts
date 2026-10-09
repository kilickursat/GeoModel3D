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
    {label:"k (m/s)",csv:"k",numeric:true},{label:"K0",csv:"K0",numeric:true,hint:"Earth pressure coefficient at rest: the horizontal effective stress is K0 · σ′v"},
    {label:"Source",csv:"source",hint:"Where the values come from"}
  ]
};
// Design values given per unit in the Units table, keyed as in src/properties.ts.
export const DESIGN_KEYS=["c","phi","su","E","k","K0"];
export const TABLE_NAMES:Record<TableName,string>={boreholes:"Boreholes",logs:"Logs",water:"Water levels",spt:"SPT",tests:"Tests",units:"Units"};
export interface ProjectFields { name:string; description:string; source:string; crs:string; groundwaterDepth:string; base:string; margin:string }
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
    ...DESIGN_KEYS.map(k=>text(u.params?.[k])),u.source??""]);
  return {project:{name:p.name,description:p.description??"",source:p.source??"",crs:crs?(crs.code&&findCrs(crs.code)?crs.code:crs.proj4):p.crs??"",
    groundwaterDepth:text(p.groundwaterDepth),base:text(p.base),margin:text(p.margin)},rows};
}
export function emptyTables():EditorTables{
  return {project:{name:"New project",description:"",source:"",crs:"",groundwaterDepth:"",base:"",margin:""},
    rows:{boreholes:[["BH-01","","","","","",""]],logs:[["BH-01","0","","",""]],water:[],spt:[],tests:[],units:[COLUMNS.units.map(()=>"")]}};
}
// A small worked example on a local grid that uses every table: what a case typed in by hand looks like.
export function exampleTables():EditorTables{
  const holes:Array<[string,number,number,number,number,Array<[number,number,string,string]>,number]>=[
    ["BH-01",0,0,10.2,20,[[0,1.2,"Fill","Made ground: sandy gravel with brick"],[1.2,5,"Soft clay","Soft grey clay"],[5,11.5,"Sand","Medium dense sand"],[11.5,20,"Stiff clay","Stiff brown clay"]],1.8],
    ["BH-02",60,5,10.5,20,[[0,0.8,"Fill","Made ground: sandy gravel"],[0.8,3.6,"Soft clay","Soft grey clay"],[3.6,12.4,"Sand","Medium dense sand"],[12.4,20,"Stiff clay","Stiff brown clay"]],2.1],
    ["BH-03",5,55,9.8,18,[[0,1.5,"Fill","Made ground: clayey gravel"],[1.5,6.2,"Soft clay","Very soft grey clay, organic"],[6.2,10.8,"Sand","Medium dense sand"],[10.8,18,"Stiff clay","Stiff brown clay"]],1.5],
    ["BH-04",65,60,10,22,[[0,0.6,"Fill","Made ground: sandy gravel"],[0.6,13,"Sand","Medium dense to dense sand"],[13,22,"Stiff clay","Stiff brown clay"]],2.4]
  ];
  const spt:Record<string,Array<[number,number]>>={"BH-01":[[3,2],[6,14],[9,21],[13,32]],"BH-02":[[2,3],[5,12],[8,18],[11,26],[14,38]],"BH-03":[[4,2],[7.5,15],[12,30]],"BH-04":[[3,16],[7,22],[11,28],[15,40]]};
  const tests:Array<[string,number,string,number]>=[["BH-01",2.5,"w",62],["BH-01",2.5,"su",22],["BH-01",4,"w",55],["BH-01",4,"su",27],["BH-01",15,"w",24],["BH-01",15,"su",115],
    ["BH-02",2.5,"su",24],["BH-03",3,"w",68],["BH-03",3,"su",19],["BH-03",5,"gamma",16.2],["BH-03",14,"su",130]];
  const unit=(id:string,name:string,colour:string,v:Partial<Record<"gamma"|"gamma_sat"|"c"|"phi"|"su"|"E"|"k"|"K0",number>>)=>
    COLUMNS.units.map(c=>c.csv==="unit"?id:c.csv==="name"?name:c.csv==="colour"?colour:c.csv==="source"?"Example values":text(v[c.csv as keyof typeof v]));
  return {project:{name:"Worked example",description:"Four boreholes on a local grid: fill, soft clay, sand and stiff clay, with water levels, SPT, laboratory tests and design values for each unit. Example values, not a real site: change any cell and build the model again.",
    source:"",crs:"",groundwaterDepth:"",base:"",margin:""},
    rows:{
      boreholes:holes.map(([id,x,y,z,d])=>[id,String(x),String(y),"","",String(z),String(d)]),
      logs:holes.flatMap(([id,,,,,log])=>log.map(([a,b,u,desc])=>[id,String(a),String(b),u,desc])),
      water:holes.map(([id,,,,,,w])=>[id,String(w),"2026-09-15"]),
      spt:Object.entries(spt).flatMap(([id,list])=>list.map(([d,n])=>[id,String(d),String(n),"300"])),
      tests:tests.map(([id,d,p,v])=>[id,String(d),"",p,String(v)]),
      units:[unit("Fill","Made ground (fill)","#9a5b4f",{gamma:18,gamma_sat:19,phi:30,E:8,K0:0.5}),
        unit("Soft clay","Soft clay","#7d8a6a",{gamma:16,gamma_sat:16.5,su:25,E:3,k:1e-9,K0:0.6}),
        unit("Sand","Medium dense sand","#d9b871",{gamma:18,gamma_sat:20,phi:34,E:30,k:2e-4,K0:0.45}),
        unit("Stiff clay","Stiff clay","#6b7b90",{gamma:19.5,gamma_sat:20,c:10,phi:26,su:120,E:40,K0:0.7})]
    }};
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
  // A single borehole needs no position, and its ground level may be left at 0 m: a case for one log.
  const holes=t.rows.boreholes.filter(filled),notes:string[]=[];
  const rows={...t.rows,boreholes:t.rows.boreholes.map(r=>{
    if(holes.length!==1||r!==holes[0])return r;
    const q=[...r];
    if([1,2,3,4].every(c=>!q[c].trim())){q[1]="0";q[2]="0";notes.push(`${q[0]}: no position given; placed at 0, 0 on a local grid`)}
    if(!q[5].trim()){q[5]="0";notes.push(`${q[0]}: no ground level given; 0 m used, so elevations are minus depths`)}
    return q;
  })};
  const files=(Object.keys(COLUMNS) as TableName[]).filter(n=>n==="boreholes"||n==="logs"||rows[n].some(filled)).map(n=>csvOf(n,rows[n]));
  const result=importFiles(files,undefined,crs);
  result.warnings.push(...notes);
  const p=result.project,f=t.project,num=(s:string)=>s.trim()===""?undefined:Number(s.replace(",","."));
  p.name=f.name.trim()||"Untitled project";
  if(f.description.trim())p.description=f.description.trim();
  if(f.source.trim())p.source=f.source.trim();
  const gw=num(f.groundwaterDepth),bottom=num(f.base),margin=num(f.margin);
  if(gw!==undefined&&Number.isFinite(gw))p.groundwaterDepth=gw;
  if(bottom!==undefined&&Number.isFinite(bottom))p.base=bottom;
  if(margin!==undefined&&Number.isFinite(margin)&&margin>0)p.margin=margin;
  for(const [label,v] of [["Assumed groundwater depth",gw],["Model base",bottom],["Model extent",margin]] as Array<[string,number|undefined]>)
    if(v!==undefined&&!Number.isFinite(v))result.warnings.push(`${label}: “${label==="Model base"?f.base:label==="Model extent"?f.margin:f.groundwaterDepth}” is not a number and was ignored`);
  if(!crs){
    delete p.crsCode;delete p.crsProj4;p.crs=f.crs.trim()||undefined;
    if(p.crs)result.warnings.push(`Coordinate system “${p.crs}” is not a known one: the model is not georeferenced (no terrain or map). Type an EPSG code or paste a PROJ definition to place it`);
  }
  if(base){
    if(base.rules)p.rules=base.rules;
    if(base.terrain&&projectCrs(base)?.proj4===crs?.proj4)p.terrain=base.terrain;
    const before=new Map(base.units.map(u=>[u.id,u]));
    for(const u of p.units){
      const extra=Object.entries(before.get(u.id)?.params??{}).filter(([k])=>!DESIGN_KEYS.includes(k));
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
