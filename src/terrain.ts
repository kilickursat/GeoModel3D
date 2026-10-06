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

// Convex hull, counter-clockwise, of points that may carry extra fields. Points on a hull edge are kept, as they
// are vertices of the triangulation's boundary.
export function convexHull<P extends XY>(points:P[]):P[]{
  const p=[...points].sort((a,b)=>a.x-b.x||a.y-b.y);
  const cross=(o:XY,a:XY,b:XY)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
  const lower:P[]=[],upper:P[]=[];
  for(const q of p){while(lower.length>=2&&cross(lower[lower.length-2],lower[lower.length-1],q)<0)lower.pop();lower.push(q)}
  for(const q of [...p].reverse()){while(upper.length>=2&&cross(upper[upper.length-2],upper[upper.length-1],q)<0)upper.pop();upper.push(q)}
  return [...lower.slice(0,-1),...upper.slice(0,-1)];
}
const side=(a:XY,b:XY,p:XY)=>(b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);

// Collar residual for terrain beyond the model: the residual at the nearest point of the footprint boundary,
// interpolated along the boundary edge exactly as inside the model, so the two surfaces meet without a step.
export function boundaryResidual(hull:Array<XY&{r:number}>){
  return (x:number,y:number)=>{
    if(hull.length===1)return hull[0].r;
    let best=Infinity,value=0;
    for(let i=0;i<hull.length;i++){
      const a=hull[i],b=hull[(i+1)%hull.length],dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy;
      const t=len2?Math.min(Math.max(((x-a.x)*dx+(y-a.y)*dy)/len2,0),1):0;
      const d2=(a.x+t*dx-x)**2+(a.y+t*dy-y)**2;
      if(d2<best){best=d2;value=a.r+t*(b.r-a.r)}
    }
    return value;
  };
}

interface Vertex extends XY { z:number; id:number }
function clipHalf(poly:Vertex[],a:XY,b:XY,outside:boolean){
  const out:Vertex[]=[];
  for(let i=0;i<poly.length;i++){
    const p=poly[i],q=poly[(i+1)%poly.length],sp=side(a,b,p),sq=side(a,b,q);
    if(outside?sp<0:sp>=0)out.push(p);
    if((sp<0)!==(sq<0)){
      const t=sp/(sp-sq);
      out.push({x:p.x+t*(q.x-p.x),y:p.y+t*(q.y-p.y),z:p.z+t*(q.z-p.z),id:-1});
    }
  }
  return out;
}
// The parts of a triangle outside a convex counter-clockwise polygon, as disjoint convex pieces: each piece is
// outside one edge and inside all the edges before it.
function outsideConvex(tri:Vertex[],hull:XY[]){
  const pieces:Vertex[][]=[];
  let rest=tri;
  for(let i=0;i<hull.length&&rest.length>=3;i++){
    const a=hull[i],b=hull[(i+1)%hull.length],out=clipHalf(rest,a,b,true);
    if(out.length>=3)pieces.push(out);
    rest=clipHalf(rest,a,b,false);
  }
  return pieces;
}

// Terrain around a model footprint (a convex counter-clockwise polygon), within `margin` of its bounding box:
// triangles crossing the footprint edge are clipped exactly, so the context meets the model without gaps or overlap.
// Positions are in the grid's coordinates; at most maxSide grid lines are used along each side.
export function terrainOutside(t:TerrainGrid,at:(x:number,y:number)=>number,hull:XY[],margin:number,maxSide=256){
  const positions:number[]=[],index:number[]=[];
  if(hull.length<3)return {positions,index};
  const xs=hull.map(p=>p.x),ys=hull.map(p=>p.y);
  const box={minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)};
  const c0=Math.max(0,Math.floor((box.minX-margin-t.x0)/t.dx)),c1=Math.min(t.ncols-1,Math.ceil((box.maxX+margin-t.x0)/t.dx));
  const r0=Math.max(0,Math.floor((box.minY-margin-t.y0)/t.dy)),r1=Math.min(t.nrows-1,Math.ceil((box.maxY+margin-t.y0)/t.dy));
  if(c1<=c0||r1<=r0)return {positions,index};
  const step=Math.max(1,Math.ceil(Math.max(c1-c0,r1-r0)/maxSide));
  const cols=Math.floor((c1-c0)/step)+1,rows=Math.floor((r1-r0)/step)+1;
  const grid:Vertex[]=[];
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
    const x=t.x0+(c0+c*step)*t.dx,y=t.y0+(r0+r*step)*t.dy;
    grid.push({x,y,z:at(x,y),id:-1});
  }
  const emitted=new Map<number,number>();
  const vertex=(v:Vertex,g:number)=>{
    if(g>=0&&emitted.has(g))return emitted.get(g)!;
    positions.push(v.x,v.y,v.z);
    const k=positions.length/3-1;
    if(g>=0)emitted.set(g,k);
    return k;
  };
  for(let r=0;r<rows-1;r++)for(let c=0;c<cols-1;c++){
    const ids=[r*cols+c,r*cols+c+1,(r+1)*cols+c+1,(r+1)*cols+c];
    if(ids.some(i=>!Number.isFinite(grid[i].z)))continue;
    for(const tri of [[ids[0],ids[1],ids[2]],[ids[0],ids[2],ids[3]]]){
      const v=tri.map(i=>({...grid[i],id:i}));
      const clear=Math.max(...v.map(p=>p.x))<=box.minX||Math.min(...v.map(p=>p.x))>=box.maxX||Math.max(...v.map(p=>p.y))<=box.minY||Math.min(...v.map(p=>p.y))>=box.maxY;
      for(const piece of clear?[v]:outsideConvex(v,hull)){
        const k=piece.map(p=>vertex(p,p.id));
        for(let j=1;j<piece.length-1;j++){
          const area=side(piece[0],piece[j],piece[j+1]);
          if(area>1e-9)index.push(k[0],k[j],k[j+1]);
        }
      }
    }
  }
  return {positions,index};
}
