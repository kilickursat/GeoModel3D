// Coordinate reference systems. A project's x, y are eastings and northings in metres in its system; geographic
// coordinates (WGS 84 and the national realisations that agree with it to within a metre or two, such as JGD2011,
// ETRS89, GDA2020 and NAD83) are converted to and from it with PROJ definitions.
import proj4 from "proj4";
import registry from "./data/crs.json";

export interface Crs { code?:string; name:string; proj4:string; note?:string }
export interface CrsEntry extends Crs { code:string; region:string; bbox:[number,number,number,number] }
export const crsRegistry=registry as CrsEntry[];

const WGS84="+proj=longlat +datum=WGS84 +no_defs";
const converters=new Map<string,proj4.Converter>();
function converter(def:string){
  let c=converters.get(def);
  if(!c){c=proj4(WGS84,def);converters.set(def,c)}
  return c;
}
export function toProjected(crs:Crs,lon:number,lat:number){const [x,y]=converter(crs.proj4).forward([lon,lat]);return {x,y}}
export function toGeographic(crs:Crs,x:number,y:number){const [lon,lat]=converter(crs.proj4).inverse([x,y]);return {lon,lat}}

const normCode=(c:string)=>{const m=c.trim().match(/^(?:epsg\s*:?\s*)?(\d+)$/i);return m?`EPSG:${m[1]}`:c.trim()};
export const findCrs=(code:string)=>crsRegistry.find(e=>e.code===normCode(code));
// Throws if PROJ cannot use the definition, or it is not a projected system in metres.
export function customCrs(definition:string,name="Custom"):Crs{
  const def=definition.trim();
  if(!/\+proj=/.test(def)||/\+proj=longlat\b/.test(def))throw new Error("A projected PROJ definition is needed, e.g. +proj=tmerc … +units=m");
  if(/\+units=(?!m\b)/.test(def)||/\+to_meter=/.test(def))throw new Error("Coordinates must be in metres (+units=m)");
  try{converter(def).forward([0,0])}catch(e){throw new Error(`PROJ cannot use this definition: ${(e as Error).message}`)}
  return {name,proj4:def};
}
// The system a project declares: a PROJ definition stored with it, or a code from the registry.
export function projectCrs(p:{crs?:string;crsCode?:string;crsProj4?:string}):Crs|null{
  if(p.crsProj4)return {code:p.crsCode,name:p.crs||p.crsCode||"Custom",proj4:p.crsProj4};
  return p.crsCode?findCrs(p.crsCode)??null:null;
}

const inside=(b:CrsEntry["bbox"],lon:number,lat:number)=>lat>=b[1]&&lat<=b[3]&&(b[0]<=b[2]?lon>=b[0]&&lon<=b[2]:lon>=b[0]||lon<=b[2]);
const area=(b:CrsEntry["bbox"])=>((b[2]-b[0]+360)%360||360)*(b[3]-b[1]);
// Superseded datums kept for existing data; offered, but never first.
const LEGACY=/^(Tokyo|JGD2000|DHDN|Monte Mario|MGI|CH1903 \/|TM75|Belge 1972|GDA94)\b/;
function centralMeridian(def:string){
  const zone=def.match(/\+zone=(\d+)/);
  if(zone)return -183+6*Number(zone[1]);
  const m=def.match(/\+lon_0=(-?[\d.]+)/);
  return m?Number(m[1]):NaN;
}
// Systems whose area of use contains the point. Current systems come before superseded ones; among them, the
// country with the most specific system first, then the zone whose central meridian is nearest, then the order of
// the registry, which lists each country's main system first. The WGS 84 / UTM zone comes last.
export function suggestCrs(lon:number,lat:number):CrsEntry[]{
  const national=crsRegistry.filter(e=>e.region!=="World (UTM)"&&inside(e.bbox,lon,lat));
  const specific=new Map<string,number>();
  for(const e of national)specific.set(e.region,Math.min(specific.get(e.region)??Infinity,area(e.bbox)));
  const key=(e:CrsEntry)=>[LEGACY.test(e.name)?1:0,specific.get(e.region)!,Math.abs((centralMeridian(e.proj4)||lon)-lon),crsRegistry.indexOf(e)];
  national.sort((a,b)=>{const p=key(a),q=key(b);return p[0]-q[0]||p[1]-q[1]||p[2]-q[2]||p[3]-q[3]});
  const zone=Math.min(60,Math.max(1,Math.floor((lon+180)/6)+1));
  const utm=findCrs(`EPSG:${(lat<0?32700:32600)+zone}`);
  return [...national,...(utm?[utm]:[])];
}
// Every whitespace-separated word must appear in the code, name or region.
export function searchCrs(query:string,limit=50):CrsEntry[]{
  const words=query.toLowerCase().split(/\s+/).filter(Boolean);
  if(!words.length)return [];
  return crsRegistry.filter(e=>{const s=`${e.code} ${e.name} ${e.region}`.toLowerCase();return words.every(w=>s.includes(w))}).slice(0,limit);
}
