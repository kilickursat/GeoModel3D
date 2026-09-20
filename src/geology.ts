export type Lithology = "Clay"|"Sandstone"|"Granite";

export interface Interval { from:number; to:number; lithology:Lithology }
export interface Borehole { id:string; x:number; y:number; z:number; intervals:Interval[] }

export interface ContactPoint { x:number; y:number; z:number; unit:Lithology }

export const COLORS:Record<Lithology,number>={Clay:0x9b7653,Sandstone:0xc8a96b,Granite:0x8b9299};

export function contactsFromBoreholes(boreholes:Borehole[]):ContactPoint[]{
  const out:ContactPoint[]=[];
  for(const b of boreholes){
    let depth=0;
    for(const i of b.intervals){
      depth+=i.from;
      out.push({x:b.x,y:b.y,z:b.z-depth,unit:i.lithology});
      depth=i.to;
    }
  }
  return out;
}

function idw(x:number,y:number,points:ContactPoint[],unit:Lithology,p=2):number{
  let n=0,d=0;
  for(const q of points){
    if(q.unit!==unit) continue;
    const dist=Math.hypot(x-q.x,y-q.y);
    const w=1/Math.max(dist**p,1e-6);
    n+=w*q.z; d+=w;
  }
  return d?n/d:0;
}

export function interpolateSurface(points:ContactPoint[],unit:Lithology,nx=18,ny=18){
  const same=points.filter(p=>p.unit===unit);
  if(same.length<3) return {positions:new Float32Array(),indices:new Uint32Array()};
  const minX=Math.min(...same.map(p=>p.x)),maxX=Math.max(...same.map(p=>p.x));
  const minY=Math.min(...same.map(p=>p.y)),maxY=Math.max(...same.map(p=>p.y));
  const pos:number[]=[];
  for(let j=0;j<ny;j++) for(let i=0;i<nx;i++){
    const x=minX+(maxX-minX)*i/(nx-1), y=minY+(maxY-minY)*j/(ny-1);
    pos.push(x,y,idw(x,y,same,unit));
  }
  const ind:number[]=[];
  for(let j=0;j<ny-1;j++) for(let i=0;i<nx-1;i++){
    const a=j*nx+i,b=a+1,c=a+nx,d=c+1;
    ind.push(a,c,b,b,c,d);
  }
  return {positions:new Float32Array(pos),indices:new Uint32Array(ind)};
}

export const sampleBoreholes:Borehole[]=[
{id:"BH-01",x:0,y:0,z:100,intervals:[{from:0,to:12,lithology:"Clay"},{from:12,to:30,lithology:"Sandstone"},{from:30,to:60,lithology:"Granite"}]},
{id:"BH-02",x:70,y:5,z:100,intervals:[{from:0,to:18,lithology:"Clay"},{from:18,to:34,lithology:"Sandstone"},{from:34,to:60,lithology:"Granite"}]},
{id:"BH-03",x:8,y:65,z:100,intervals:[{from:0,to:8,lithology:"Clay"},{from:8,to:28,lithology:"Sandstone"},{from:28,to:60,lithology:"Granite"}]},
{id:"BH-04",x:72,y:68,z:100,intervals:[{from:0,to:15,lithology:"Clay"},{from:15,to:31,lithology:"Sandstone"},{from:31,to:60,lithology:"Granite"}]},
{id:"BH-05",x:38,y:36,z:100,intervals:[{from:0,to:10,lithology:"Clay"},{from:10,to:25,lithology:"Sandstone"},{from:25,to:60,lithology:"Granite"}]}
];