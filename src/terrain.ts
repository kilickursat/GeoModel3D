import {XY} from "./tin";

// Regular elevation grid: z[r*ncols+c] is the elevation at the cell centre (x0+c·dx, y0+r·dy); row 0 is the
// southernmost row. NaN marks cells without data.
export interface TerrainGrid { x0:number; y0:number; dx:number; dy:number; ncols:number; nrows:number; z:number[]; source?:string }

const MAX_CELLS=1_000_000;

// Bilinear elevation; cells without data are left out of the weights. NaN outside the grid.
export function terrainZ(t:TerrainGrid,x:number,y:number){
  const fx=(x-t.x0)/t.dx,fy=(y-t.y0)/t.dy;
  if(fx<-0.5||fy<-0.5||fx>t.ncols-0.5||fy>t.nrows-0.5)return NaN;
  const cx=Math.min(Math.max(fx,0),t.ncols-1),cy=Math.min(Math.max(fy,0),t.nrows-1);
  const c0=Math.min(Math.floor(cx),t.ncols-2),r0=Math.min(Math.floor(cy),t.nrows-2);
  if(c0<0||r0<0)return t.z[Math.round(cy)*t.ncols+Math.round(cx)];
  const u=cx-c0,v=cy-r0;
  let sum=0,weight=0;
  for(const [dc,dr,w] of [[0,0,(1-u)*(1-v)],[1,0,u*(1-v)],[0,1,(1-u)*v],[1,1,u*v]]){
    const z=t.z[(r0+dr)*t.ncols+c0+dc];
    if(Number.isFinite(z)&&w>0){sum+=z*w;weight+=w}
  }
  return weight>0?sum/weight:NaN;
}

export function terrainBounds(t:TerrainGrid){
  return {minX:t.x0-t.dx/2,maxX:t.x0+(t.ncols-0.5)*t.dx,minY:t.y0-t.dy/2,maxY:t.y0+(t.nrows-0.5)*t.dy};
}

// Average blocks of cells so the grid holds at most `maxCells` cells.
export function coarsenTerrain(t:TerrainGrid,maxCells=MAX_CELLS):TerrainGrid{
  const f=Math.ceil(Math.sqrt(t.ncols*t.nrows/maxCells));
  if(f<=1)return t;
  const ncols=Math.ceil(t.ncols/f),nrows=Math.ceil(t.nrows/f),z:number[]=new Array(ncols*nrows).fill(NaN);
  for(let r=0;r<nrows;r++)for(let c=0;c<ncols;c++){
    let s=0,n=0;
    for(let rr=r*f;rr<Math.min((r+1)*f,t.nrows);rr++)for(let cc=c*f;cc<Math.min((c+1)*f,t.ncols);cc++){
      const v=t.z[rr*t.ncols+cc];
      if(Number.isFinite(v)){s+=v;n++}
    }
    if(n)z[r*ncols+c]=s/n;
  }
  return {...t,x0:t.x0+(f-1)*t.dx/2,y0:t.y0+(f-1)*t.dy/2,dx:t.dx*f,dy:t.dy*f,ncols,nrows,z};
}

// ESRI ASCII grid (.asc): a short header, then rows from north to south.
export function parseAsciiGrid(text:string,source?:string):TerrainGrid{
  const tokens=text.trim().split(/\s+/);
  const header=new Map<string,number>();
  let i=0;
  while(i<tokens.length-1&&/^[a-z_]+$/i.test(tokens[i])){header.set(tokens[i].toLowerCase(),Number(tokens[i+1]));i+=2}
  const ncols=header.get("ncols"),nrows=header.get("nrows");
  const dx=header.get("cellsize")??header.get("dx"),dy=header.get("cellsize")??header.get("dy");
  if(!ncols||!nrows||!dx||!dy||ncols<2||nrows<2)throw new Error("Not an ESRI ASCII grid: ncols, nrows and cellsize (or dx/dy) are required");
  const xc=header.get("xllcenter"),yc=header.get("yllcenter"),xl=header.get("xllcorner"),yl=header.get("yllcorner");
  if((xc??xl)===undefined||(yc??yl)===undefined)throw new Error("ESRI ASCII grid has no xllcorner/xllcenter or yllcorner/yllcenter");
  const nodata=header.get("nodata_value");
  if(tokens.length-i<ncols*nrows)throw new Error(`ESRI ASCII grid holds ${tokens.length-i} values; ${ncols}×${nrows} expected`);
  const z:number[]=new Array(ncols*nrows);
  for(let rf=0;rf<nrows;rf++)for(let c=0;c<ncols;c++){
    const v=Number(tokens[i+rf*ncols+c]);
    z[(nrows-1-rf)*ncols+c]=Number.isFinite(v)&&v!==nodata?v:NaN;
  }
  return {x0:xc??xl!+dx/2,y0:yc??yl!+dy/2,dx,dy,ncols,nrows,z,source};
}

// Gridded XYZ text (one "x y z" point per line on a regular lattice, any order; missing points become no-data).
export function parseXyzGrid(text:string,source?:string):TerrainGrid{
  const pts:number[][]=[];
  for(const line of text.split(/\r?\n/)){
    const f=line.trim().split(/[\s,;]+/).map(Number);
    if(f.length>=3&&f.slice(0,3).every(Number.isFinite))pts.push(f.slice(0,3));
  }
  if(pts.length<4)throw new Error("No x y z points found");
  const axis=(k:number)=>{
    const v=[...new Set(pts.map(p=>Math.round(p[k]*1000)/1000))].sort((a,b)=>a-b);
    let step=Infinity;
    for(let j=1;j<v.length;j++)step=Math.min(step,v[j]-v[j-1]);
    return {min:v[0],step,count:v.length>1?Math.round((v[v.length-1]-v[0])/step)+1:1};
  };
  const ax=axis(0),ay=axis(1);
  if(ax.count<2||ay.count<2)throw new Error("XYZ points do not span a two-dimensional grid");
  if(ax.count*ay.count>4*MAX_CELLS)throw new Error(`XYZ grid of ${ax.count}×${ay.count} points is too large; resample it to a coarser spacing`);
  const z:number[]=new Array(ax.count*ay.count).fill(NaN);
  let off=0;
  for(const [x,y,v] of pts){
    const c=(x-ax.min)/ax.step,r=(y-ay.min)/ay.step;
    if(Math.abs(c-Math.round(c))>1e-3||Math.abs(r-Math.round(r))>1e-3){off++;continue}
    z[Math.round(r)*ax.count+Math.round(c)]=v;
  }
  if(off>pts.length*0.01)throw new Error(`${off} of ${pts.length} XYZ points are off a regular grid; scattered points are not supported, grid them first`);
  if(pts.length<0.5*z.length)throw new Error("XYZ points fill less than half of their grid; scattered points are not supported, grid them first");
  return {x0:ax.min,y0:ay.min,dx:ax.step,dy:ay.step,ncols:ax.count,nrows:ay.count,z,source};
}

export function readTerrain(name:string,text:string):TerrainGrid{
  const grid=/^\s*ncols\b/i.test(text)?parseAsciiGrid(text,name):parseXyzGrid(text,name);
  return coarsenTerrain(grid);
}
export function isTerrainFile(name:string,text:string){
  if(/\.(asc|xyz)$/i.test(name))return true;
  if(/^\s*ncols\b/i.test(text))return true;
  return /\.txt$/i.test(name)&&/^\s*-?[\d.]+[\s,;]+-?[\d.]+[\s,;]+-?[\d.]+\s*$/m.test(text.slice(0,200))&&!/[a-z]/i.test(text.slice(0,200));
}

// Inverse-distance weighted residual between surveyed collars and the terrain, for points outside the model.
export function residualField(points:Array<XY&{r:number}>){
  return (x:number,y:number)=>{
    let num=0,den=0;
    for(const p of points){
      const d2=(p.x-x)**2+(p.y-y)**2;
      if(d2<1e-12)return p.r;
      num+=p.r/d2;den+=1/d2;
    }
    return den?num/den:0;
  };
}
