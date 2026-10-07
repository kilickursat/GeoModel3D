import {describe,it,expect} from "vitest";
import {parseAsciiGrid,parseXyzGrid,terrainZ,coarsenTerrain,isTerrainFile,TerrainGrid,terrainOutside,convexHull} from "../src/terrain";
import {buildGeologicalModel} from "../src/model";
import {valleyProject} from "../src/geology";
import {boundaryEdges} from "../src/tin";

const plane=(x:number,y:number)=>100+0.2*x-0.1*y;
function planeGrid(ncols=6,nrows=5,d=10):TerrainGrid{
  const z:number[]=[];
  for(let r=0;r<nrows;r++)for(let c=0;c<ncols;c++)z.push(plane(1000+c*d,2000+r*d));
  return {x0:1000,y0:2000,dx:d,dy:d,ncols,nrows,z};
}

describe("terrain grids",()=>{
  it("reads an ESRI ASCII grid with corner or centre registration, north row first",()=>{
    const asc="ncols 3\nnrows 2\nxllcorner 100\nyllcorner 200\ncellsize 10\nNODATA_value -9999\n1 2 3\n4 -9999 6\n";
    const g=parseAsciiGrid(asc);
    expect([g.x0,g.y0,g.dx,g.ncols,g.nrows]).toEqual([105,205,10,3,2]);
    expect(g.z.slice(0,3)).toEqual([4,NaN,6]);
    expect(g.z.slice(3)).toEqual([1,2,3]);
    expect(parseAsciiGrid(asc.replace("xllcorner","xllcenter").replace("yllcorner","yllcenter")).x0).toBe(100);
    expect(()=>parseAsciiGrid("ncols 3\nnrows 2\ncellsize 1\n1 2 3")).toThrow(/xllcorner/);
    expect(()=>parseAsciiGrid("ncols 3\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 1\n1 2 3")).toThrow(/3×2 expected/);
  });

  it("reads gridded XYZ in any order, leaving missing points empty, and refuses scattered points",()=>{
    const pts:string[]=[];
    for(let r=0;r<4;r++)for(let c=0;c<5;c++)if(!(r===2&&c===3))pts.push(`${500+c*2} ${800+r*2} ${r*10+c}`);
    const g=parseXyzGrid("x y z\n"+pts.reverse().join("\n"));
    expect([g.x0,g.y0,g.dx,g.dy,g.ncols,g.nrows]).toEqual([500,800,2,2,5,4]);
    expect(g.z[2*5+3]).toBeNaN();
    expect(g.z[3*5+4]).toBe(34);
    expect(()=>parseXyzGrid("0 0 1\n1 0 1\n0 1 1\n1.37 1.91 1\n2.5 0.2 1")).toThrow(/scattered|grid/);
  });

  it("interpolates a plane exactly and returns NaN outside the grid",()=>{
    const g=planeGrid();
    for(const [x,y] of [[1003.3,2017.9],[1041,2002],[1000,2000],[1050,2040]])expect(terrainZ(g,x,y)).toBeCloseTo(plane(x,y),9);
    expect(terrainZ(g,990,2000)).toBeNaN();
    expect(terrainZ(g,1000,2046)).toBeNaN();
  });

  it("leaves cells without data out of the interpolation",()=>{
    const g=planeGrid();
    g.z[1*6+1]=NaN;
    const v=terrainZ(g,1015,2015);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeCloseTo((plane(1020,2010)+plane(1010,2020)+plane(1020,2020))/3,9);
  });

  it("coarsens large grids by block averaging",()=>{
    const g=coarsenTerrain(planeGrid(40,30,1),300);
    expect(g.ncols*g.nrows).toBeLessThanOrEqual(300);
    expect(terrainZ(g,1020,2015)).toBeCloseTo(plane(1020,2015),6);
  });

  it("recognises terrain files",()=>{
    expect(isTerrainFile("dem.asc","")).toBe(true);
    expect(isTerrainFile("lidar.xyz","")).toBe(true);
    expect(isTerrainFile("grid.txt","ncols 4\n")).toBe(true);
    expect(isTerrainFile("points.txt","500.0 800.0 12.3\n502.0 800.0 12.4\n")).toBe(true);
    expect(isTerrainFile("boreholes.csv","hole_id,x,y,z\n")).toBe(false);
  });
});

describe("terrain around the model",()=>{
  const g=planeGrid(41,31,5),at=(x:number,y:number)=>terrainZ(g,x,y);
  const hull=convexHull([{x:1050,y:2030},{x:1150,y:2040},{x:1130,y:2120},{x:1060,y:2110},{x:1100,y:2035}]);
  const area=(pos:number[],idx:number[])=>{
    let a=0;
    for(let i=0;i<idx.length;i+=3){
      const [p,q,r]=[idx[i]*3,idx[i+1]*3,idx[i+2]*3];
      a+=((pos[q]-pos[p])*(pos[r+1]-pos[p+1])-(pos[q+1]-pos[p+1])*(pos[r]-pos[p]))/2;
    }
    return a;
  };
  const shoelace=(h:Array<{x:number;y:number}>)=>h.reduce((s,p,i)=>{const q=h[(i+1)%h.length];return s+(p.x*q.y-q.x*p.y)/2},0);

  it("keeps hull points that lie on an edge, counter-clockwise",()=>{
    expect(hull.length).toBe(5);
    expect(shoelace(hull)).toBeGreaterThan(0);
  });

  it("covers the window exactly once outside the footprint, and nothing inside it",()=>{
    const {positions,index}=terrainOutside(g,at,hull,1000);
    expect(area(positions,index)).toBeCloseTo(200*150-shoelace(hull),6);
    for(let i=0;i<index.length;i+=3){
      const c=[0,1].map(k=>(positions[index[i]*3+k]+positions[index[i+1]*3+k]+positions[index[i+2]*3+k])/3);
      const inside=hull.every((a,j)=>{const b=hull[(j+1)%hull.length];return (b.x-a.x)*(c[1]-a.y)-(b.y-a.y)*(c[0]-a.x)>1e-9});
      expect(inside).toBe(false);
    }
    for(let i=0;i<positions.length;i+=3)expect(positions[i+2]).toBeCloseTo(plane(positions[i],positions[i+1]),9);
  });

  it("limits the context to a margin around the footprint",()=>{
    const {positions}=terrainOutside(g,at,hull,10);
    for(let i=0;i<positions.length;i+=3){
      expect(positions[i]).toBeGreaterThanOrEqual(1040-1e-9);
      expect(positions[i]).toBeLessThanOrEqual(1160+1e-9);
    }
  });

  it("meets the model's ground exactly along the footprint boundary",()=>{
    const m=buildGeologicalModel(valleyProject);
    const onBoundary=new Set(boundaryEdges(m.triangles).flat().filter(n=>n<m.meshNodes));
    expect(onBoundary.size).toBeGreaterThan(50);
    for(const n of onBoundary)expect(m.terrainAt!(m.nodes[n].x,m.nodes[n].y)).toBeCloseTo(m.horizons[0].z[n],9);
  });
});
