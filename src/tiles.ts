// Web Mercator tiles (the XYZ scheme of OpenStreetMap, GSI and Terrain Tiles): map sources for the basemap, and
// elevation sources resampled into a terrain grid in the project's coordinate system. Network access is passed in,
// so the resampling runs anywhere.
import {Crs,toGeographic} from "./crs";
import {TerrainGrid} from "./terrain";

const JAPAN:[number,number,number,number]=[122,20,154,46.5];
export interface TileSource { id:string; name:string; url:string; zoom:number; attribution:string; link:string; region?:[number,number,number,number] }
export interface ElevationSource extends TileSource { format:"gsi"|"terrarium"; cell:number }

export const mapSources:TileSource[]=[
  {id:"osm",name:"OpenStreetMap",url:"https://tile.openstreetmap.org/{z}/{x}/{y}.png",zoom:19,attribution:"© OpenStreetMap contributors",link:"https://www.openstreetmap.org/copyright"},
  {id:"gsi-pale",name:"GSI pale map (Japan)",url:"https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png",zoom:18,attribution:"地理院タイル (GSI)",link:"https://maps.gsi.go.jp/development/ichiran.html",region:JAPAN},
  {id:"gsi-photo",name:"GSI aerial photographs (Japan)",url:"https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",zoom:18,attribution:"地理院タイル (GSI)",link:"https://maps.gsi.go.jp/development/ichiran.html",region:JAPAN}
];
// In order of preference; where one has no data, the next is used.
export const elevationSources:ElevationSource[]=[
  {id:"gsi-dem5a",name:"GSI 5 m DEM (laser survey)",url:"https://cyberjapandata.gsi.go.jp/xyz/dem5a/{z}/{x}/{y}.txt",zoom:15,cell:5,format:"gsi",
    attribution:"地理院タイル 標高 DEM5A (GSI)",link:"https://maps.gsi.go.jp/development/ichiran.html",region:JAPAN},
  {id:"gsi-dem10b",name:"GSI 10 m DEM",url:"https://cyberjapandata.gsi.go.jp/xyz/dem/{z}/{x}/{y}.txt",zoom:14,cell:10,format:"gsi",
    attribution:"地理院タイル 標高 DEM10B (GSI)",link:"https://maps.gsi.go.jp/development/ichiran.html",region:JAPAN},
  {id:"terrarium",name:"Terrain Tiles (global; about 30 m, finer where national surveys exist)",url:"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",zoom:14,cell:10,format:"terrarium",
    attribution:"Terrain Tiles (Mapzen, AWS Open Data; SRTM, GMTED2010, ETOPO1 and national sources)",link:"https://github.com/tilezen/joerd/blob/master/docs/attribution.md"}
];
export const covers=(s:TileSource,lon:number,lat:number)=>!s.region||(lon>=s.region[0]&&lon<=s.region[2]&&lat>=s.region[1]&&lat<=s.region[3]);
export const tileUrl=(s:TileSource,z:number,x:number,y:number)=>s.url.replace("{z}",String(z)).replace("{x}",String(x)).replace("{y}",String(y));

// Position in tiles at zoom z (fractional), and back.
export function tileXY(lon:number,lat:number,z:number){
  const n=2**z,phi=Math.max(-85.0511,Math.min(85.0511,lat))*Math.PI/180;
  return {x:(lon+180)/360*n,y:(1-Math.log(Math.tan(phi)+1/Math.cos(phi))/Math.PI)/2*n};
}
export function lonLatOfTile(x:number,y:number,z:number){
  const n=2**z;
  return {lon:x/n*360-180,lat:Math.atan(Math.sinh(Math.PI*(1-2*y/n)))*180/Math.PI};
}

// Elevation tiles, 256 × 256 values row by row from the north-west, NaN where there is no data.
export function parseGsiTile(text:string){
  const out=new Float32Array(256*256).fill(NaN);
  text.trim().split(/\r?\n/).slice(0,256).forEach((line,r)=>line.split(",").slice(0,256).forEach((v,c)=>{const z=Number(v);if(v!=="e"&&v!==""&&Number.isFinite(z))out[r*256+c]=z}));
  return out;
}
// Terrarium encoding: elevation = R × 256 + G + B / 256 − 32768, from RGBA pixels.
export function decodeTerrarium(rgba:Uint8ClampedArray|Uint8Array){
  const out=new Float32Array(256*256);
  for(let i=0;i<out.length;i++)out[i]=rgba[i*4]*256+rgba[i*4+1]+rgba[i*4+2]/256-32768;
  return out;
}

export type TileLoader=(source:ElevationSource,z:number,x:number,y:number)=>Promise<Float32Array|null>;

// A terrain grid over a rectangle of the project's coordinate system. Each node takes the first source, in order,
// that covers it and has data there, interpolated bilinearly between pixel centres.
export async function fetchTerrain(crs:Crs,box:{minX:number;minY:number;maxX:number;maxY:number},sources:ElevationSource[],load:TileLoader,maxCells=1_000_000):Promise<TerrainGrid>{
  if(!sources.length)throw new Error("No elevation source covers this site");
  let d=Math.min(...sources.map(s=>s.cell));
  while(((box.maxX-box.minX)/d+1)*((box.maxY-box.minY)/d+1)>maxCells)d*=1.5;
  const ncols=Math.floor((box.maxX-box.minX)/d)+1,nrows=Math.floor((box.maxY-box.minY)/d)+1;
  const geo=new Float64Array(ncols*nrows*2);
  for(let r=0;r<nrows;r++)for(let c=0;c<ncols;c++){const g=toGeographic(crs,box.minX+c*d,box.minY+r*d);geo[(r*ncols+c)*2]=g.lon;geo[(r*ncols+c)*2+1]=g.lat}
  const z=new Array<number>(ncols*nrows).fill(NaN);
  const used=new Set<string>();
  for(const s of sources){
    const todo:number[]=[];
    for(let k=0;k<z.length;k++)if(Number.isNaN(z[k])&&covers(s,geo[k*2],geo[k*2+1]))todo.push(k);
    if(!todo.length)continue;
    // Pixel coordinates at the source's zoom; the tiles holding the four pixels around each node.
    const px=new Float64Array(todo.length*2),need=new Set<string>();
    todo.forEach((k,i)=>{
      const t=tileXY(geo[k*2],geo[k*2+1],s.zoom),x=t.x*256-0.5,y=t.y*256-0.5;
      px[i*2]=x;px[i*2+1]=y;
      for(const yy of [Math.floor(y),Math.floor(y)+1])for(const xx of [Math.floor(x),Math.floor(x)+1])need.add(`${Math.floor(xx/256)},${Math.floor(yy/256)}`);
    });
    const tiles=new Map<string,Float32Array|null>();
    const keys=[...need];
    for(let i=0;i<keys.length;i+=6)await Promise.all(keys.slice(i,i+6).map(async key=>{
      const [tx,ty]=key.split(",").map(Number);
      tiles.set(key,await load(s,s.zoom,tx,ty).catch(()=>null));
    }));
    const pixel=(x:number,y:number)=>{const t=tiles.get(`${Math.floor(x/256)},${Math.floor(y/256)}`);return t?t[(y-Math.floor(y/256)*256)*256+(x-Math.floor(x/256)*256)]:NaN};
    todo.forEach((k,i)=>{
      const x=px[i*2],y=px[i*2+1],x0=Math.floor(x),y0=Math.floor(y),fx=x-x0,fy=y-y0;
      const v=(1-fx)*(1-fy)*pixel(x0,y0)+fx*(1-fy)*pixel(x0+1,y0)+(1-fx)*fy*pixel(x0,y0+1)+fx*fy*pixel(x0+1,y0+1);
      if(Number.isFinite(v)){z[k]=v;used.add(s.attribution)}
    });
  }
  if(!used.size)throw new Error("The elevation sources have no data for this site");
  return {x0:box.minX,y0:box.minY,dx:d,dy:d,ncols,nrows,z,source:[...used].join("; ")};
}

// The tiles covering a rectangle of the project's system at a zoom that gives about `pixels` across it.
export function mapTiles(crs:Crs,box:{minX:number;minY:number;maxX:number;maxY:number},source:TileSource,pixels=2048,maxTiles=64){
  const corners=[[box.minX,box.minY],[box.maxX,box.minY],[box.minX,box.maxY],[box.maxX,box.maxY],[(box.minX+box.maxX)/2,box.minY],[(box.minX+box.maxX)/2,box.maxY],[box.minX,(box.minY+box.maxY)/2],[box.maxX,(box.minY+box.maxY)/2]]
    .map(([x,y])=>toGeographic(crs,x,y));
  let z=source.zoom;
  const range=(zoom:number)=>{
    const t=corners.map(g=>tileXY(g.lon,g.lat,zoom));
    return {x0:Math.floor(Math.min(...t.map(p=>p.x))),x1:Math.floor(Math.max(...t.map(p=>p.x))),y0:Math.floor(Math.min(...t.map(p=>p.y))),y1:Math.floor(Math.max(...t.map(p=>p.y)))};
  };
  let r=range(z);
  while(z>1&&((r.x1-r.x0+1)*256>pixels*1.5||(r.x1-r.x0+1)*(r.y1-r.y0+1)>maxTiles)){z--;r=range(z)}
  return {z,...r};
}
