// Ground properties measured in boreholes (laboratory tests on samples, in-situ tests) or given per unit, and their
// statistics per unit. Values are stored in the unit given here; readers convert to it.
import {Borehole,UnitDef,TestResult,sptN} from "./geology";

export interface PropertyDef {
  key:string; name:string; symbol:string; unit:string; decimals:number;
  // Plausible range, outside which a value is reported as a likely unit mistake; `log` properties span decades.
  range:[number,number]; log?:boolean;
  // Column names it is recognised by, normalised (lower case, letters and digits only, units in brackets removed).
  aliases:string[];
}

export const properties:PropertyDef[]=[
  {key:"N",name:"SPT N-value",symbol:"N",unit:"",decimals:0,range:[0,500],aliases:["n","spt","sptn","nvalue","nspt","n60","blowcount","isptnval"]},
  {key:"w",name:"Water content",symbol:"w",unit:"%",decimals:1,range:[0,1500],aliases:["w","wn","wc","mc","nmc","moisture","moisturecontent","watercontent","naturalwatercontent","naturalmoisturecontent","lnmcmc"]},
  {key:"gamma",name:"Bulk unit weight",symbol:"γ",unit:"kN/m³",decimals:1,range:[8,30],aliases:["gamma","γ","γt","gammat","unitweight","bulkunitweight","gammabulk"]},
  {key:"gammaDry",name:"Dry unit weight",symbol:"γd",unit:"kN/m³",decimals:1,range:[4,25],aliases:["gammad","gammadry","γd","dryunitweight"]},
  {key:"LL",name:"Liquid limit",symbol:"wL",unit:"%",decimals:0,range:[0,1000],aliases:["ll","wl","liquidlimit","llplll"]},
  {key:"PL",name:"Plastic limit",symbol:"wP",unit:"%",decimals:0,range:[0,500],aliases:["pl","wp","plasticlimit","llplpl"]},
  {key:"PI",name:"Plasticity index",symbol:"IP",unit:"%",decimals:0,range:[0,800],aliases:["pi","ip","plasticityindex","llplpi"]},
  {key:"fines",name:"Fines content",symbol:"F",unit:"%",decimals:0,range:[0,100],aliases:["fines","finescontent","fc","passing63um","passing75um","p200","gragfine"]},
  {key:"organic",name:"Organic content",symbol:"OC",unit:"%",decimals:1,range:[0,100],aliases:["organic","organiccontent","organicmatter","organicmattercontent","om","loi"]},
  {key:"su",name:"Undrained shear strength",symbol:"su",unit:"kPa",decimals:0,range:[0,5000],aliases:["su","cu","undrainedshearstrength","undrainedstrength","tritcu","lvanvnpk","ivanivan","lpenppen"]},
  {key:"qu",name:"Unconfined compressive strength",symbol:"qu",unit:"kPa",decimals:0,range:[0,50000],aliases:["qu","unconfinedcompressivestrength"]},
  {key:"ucs",name:"Uniaxial compressive strength",symbol:"σc",unit:"MPa",decimals:1,range:[0,500],aliases:["ucs","σc","sigmac","uniaxialcompressivestrength","rucsucs"]},
  {key:"c",name:"Effective cohesion",symbol:"c′",unit:"kPa",decimals:0,range:[0,1000],aliases:["c","ceff","cprime","cohesion","effectivecohesion","tregcoh","shbgpcoh"]},
  {key:"phi",name:"Effective friction angle",symbol:"φ′",unit:"°",decimals:1,range:[0,60],aliases:["phi","φ","phieff","phiprime","frictionangle","effectivefrictionangle","tregphi","shbgphi"]},
  {key:"E",name:"Young's modulus",symbol:"E",unit:"MPa",decimals:0,range:[0,200000],aliases:["e","emod","modulus","emodulus","youngsmodulus","e50"]},
  {key:"k",name:"Hydraulic conductivity",symbol:"k",unit:"m/s",decimals:2,range:[1e-14,1],log:true,aliases:["k","ksat","permeability","hydraulicconductivity","ptstk"]},
  {key:"qc",name:"Cone resistance",symbol:"qc",unit:"MPa",decimals:2,range:[0,200],aliases:["qc","qt","coneresistance","conetipresistance","scptres"]},
  {key:"Vs",name:"Shear-wave velocity",symbol:"Vs",unit:"m/s",decimals:0,range:[0,5000],aliases:["vs","shearwavevelocity"]},
  {key:"RQD",name:"Rock quality designation",symbol:"RQD",unit:"%",decimals:0,range:[0,100],aliases:["rqd"]}
];
const byKey=new Map(properties.map(p=>[p.key,p]));

// A catalogue property, or a plain description of a property that is not in the catalogue.
export function propertyDef(key:string):PropertyDef{
  return byKey.get(key)??{key,name:key,symbol:key,unit:"",decimals:2,range:[-Infinity,Infinity],aliases:[]};
}
export const propertyLabel=(key:string)=>{const p=propertyDef(key);return `${p.name}${p.symbol!==p.name?` ${p.symbol}`:""}${p.unit?` (${p.unit})`:""}`};
export function formatValue(key:string,v:number){
  const p=propertyDef(key);
  if(!Number.isFinite(v))return "";
  if(p.log||(v!==0&&Math.abs(v)<10**-p.decimals))return v.toExponential(1);
  return v.toLocaleString("en-US",{maximumFractionDigits:p.decimals});
}

const normalise=(h:string)=>h.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g,"").replace(/[^a-z0-9α-ω]/g,"");
const G=9.80665;
// The property a column header names, with the factor that converts its values to the catalogue unit. A density
// column (Mg/m³, g/cm³, t/m³ or kg/m³) becomes a unit weight.
export function propertyFromHeader(header:string):{key:string;scale:number}|undefined{
  const h=normalise(header),unit=(header.match(/\(([^)]*)\)|\[([^\]]*)\]/)?.slice(1).find(Boolean)??"").toLowerCase().replace(/\s/g,"");
  if(/^(bulk|dry)?density$|^ρ$|^rho$|^lden[bd]den$/.test(h)){
    const scale=/^kg/.test(unit)?G/1000:G;
    return {key:/dry|dden/.test(h)?"gammaDry":"gamma",scale};
  }
  const p=properties.find(q=>q.aliases.includes(h));
  if(!p)return undefined;
  // Strengths and moduli are sometimes given in the other of kPa and MPa.
  const scale=p.unit==="kPa"&&unit==="mpa"?1000:p.unit==="MPa"&&unit==="kpa"?1/1000:p.unit==="MPa"&&unit==="gpa"?1000:1;
  return {key:p.key,scale};
}
// The catalogue key for a property name given as text (a key, a symbol or an alias), or the name itself.
export function propertyKey(name:string){
  const t=name.trim();
  if(byKey.has(t))return t;
  return propertyFromHeader(t)?.key??(properties.find(p=>p.name.toLowerCase()===t.toLowerCase())?.key??t);
}

// Every value measured in a borehole, with the SPT N-values as property N.
export function boreholeTests(b:Borehole):TestResult[]{
  const spt=(b.spt??[]).map(t=>({depth:t.depth,property:"N",value:sptN(t)}));
  return [...spt,...(b.tests??[])];
}
export const testDepth=(t:TestResult)=>t.to!==undefined&&t.to>t.depth?(t.depth+t.to)/2:t.depth;
// The unit of the logged interval that holds a depth.
export function unitAt(b:Borehole,depth:number){
  return b.intervals.find(i=>depth>=i.from&&depth<i.to)?.unit??(depth===b.intervals.at(-1)?.to?b.intervals.at(-1)!.unit:undefined);
}

// Measured properties in catalogue order, then the others by name.
export function measuredProperties(boreholes:Borehole[]){
  const found=new Set(boreholes.flatMap(b=>boreholeTests(b).map(t=>t.property)));
  return [...properties.map(p=>p.key).filter(k=>found.has(k)),...[...found].filter(k=>!byKey.has(k)).sort()];
}

export interface PropertyStats { n:number; mean:number; min:number; max:number; sd:number }
function stats(values:number[],log=false):PropertyStats{
  const v=log?values.filter(x=>x>0).map(Math.log10):values,n=v.length;
  const m=v.reduce((a,b)=>a+b,0)/n,sd=n>1?Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/(n-1)):0;
  const back=(x:number)=>log?10**x:x;
  return {n,mean:back(m),min:back(Math.min(...v)),max:back(Math.max(...v)),sd:log?NaN:sd};
}
// Statistics of the values measured in each unit, by the logged interval each test lies in. A log-scaled property
// (hydraulic conductivity) gets the geometric mean.
export function unitStatistics(boreholes:Borehole[],units:UnitDef[]){
  const values=new Map<string,Map<string,number[]>>(units.map(u=>[u.id,new Map()]));
  for(const b of boreholes)for(const t of boreholeTests(b)){
    const u=unitAt(b,testDepth(t));
    if(u===undefined||!values.has(u)||!Number.isFinite(t.value))continue;
    const m=values.get(u)!;
    if(!m.has(t.property))m.set(t.property,[]);
    m.get(t.property)!.push(t.value);
  }
  const out=new Map<string,Map<string,PropertyStats>>();
  for(const [u,m] of values){
    const s=new Map<string,PropertyStats>();
    for(const key of measuredProperties(boreholes))if(m.get(key)?.length)s.set(key,stats(m.get(key)!,propertyDef(key).log));
    out.set(u,s);
  }
  return out;
}

// Values outside a property's plausible range, which usually means a unit mistake.
export function implausibleTests(boreholes:Borehole[]){
  const out:string[]=[];
  for(const b of boreholes)for(const t of b.tests??[]){
    const p=propertyDef(t.property);
    if(t.value<p.range[0]||t.value>p.range[1])out.push(`${b.id}: ${p.name} ${t.value}${p.unit?" "+p.unit:""} at ${t.depth} m is outside ${p.range[0]}–${p.range[1]}${p.unit?" "+p.unit:""}; check the units`);
  }
  return out;
}
