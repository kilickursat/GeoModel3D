import {describe,it,expect} from "vitest";
import {parseAsciiGrid,parseXyzGrid,terrainZ,coarsenTerrain,isTerrainFile,TerrainGrid} from "../src/terrain";

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
