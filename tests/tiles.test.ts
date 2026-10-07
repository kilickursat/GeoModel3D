import {describe,it,expect} from "vitest";
import {tileXY,lonLatOfTile,parseGsiTile,decodeTerrarium,fetchTerrain,mapTiles,elevationSources,mapSources,covers,ElevationSource} from "../src/tiles";
import {findCrs,toProjected} from "../src/crs";
import {terrainZ} from "../src/terrain";

const crs=findCrs("EPSG:6677")!;
// An elevation field to build synthetic tiles from (metres, by longitude and latitude).
const field=(lon:number,lat:number)=>40+800*(lat-35.37)-600*(lon-139.52);
function tileFrom(z:number,tx:number,ty:number){
  const out=new Float32Array(256*256);
  for(let r=0;r<256;r++)for(let c=0;c<256;c++){const g=lonLatOfTile(tx+(c+0.5)/256,ty+(r+0.5)/256,z);out[r*256+c]=field(g.lon,g.lat)}
  return out;
}

describe("map tiles",()=>{
  it("finds the tile of a place, and back",()=>{
    const t=tileXY(139.767,35.681,15);
    expect([Math.floor(t.x),Math.floor(t.y)]).toEqual([29105,12903]);
    const g=lonLatOfTile(t.x,t.y,15);
    expect(g.lon).toBeCloseTo(139.767,9);
    expect(g.lat).toBeCloseTo(35.681,9);
  });
  it("reads GSI text tiles and Terrarium PNG pixels",()=>{
    const rows=Array.from({length:256},(_,r)=>Array.from({length:256},(_,c)=>r===0&&c===1?"e":String(r+c/100)).join(","));
    const g=parseGsiTile(rows.join("\n"));
    expect(g[0]).toBe(0);
    expect(g[1]).toBeNaN();
    expect(g[2*256+50]).toBeCloseTo(2.5,5);
    const rgba=new Uint8Array(256*256*4);
    rgba.set([128,0,0,255],0);rgba.set([128,100,128,255],4);
    const t=decodeTerrarium(rgba);
    expect([t[0],t[1]]).toEqual([0,100.5]);
  });
  it("offers Japanese sources only in Japan",()=>{
    expect(elevationSources.filter(s=>covers(s,139.5,35.4)).map(s=>s.id)).toEqual(["gsi-dem5a","gsi-dem10b","terrarium"]);
    expect(elevationSources.filter(s=>covers(s,-0.1,51.5)).map(s=>s.id)).toEqual(["terrarium"]);
    expect(mapSources.filter(s=>covers(s,-0.1,51.5)).map(s=>s.id)).toEqual(["osm"]);
  });
});

describe("terrain from elevation tiles",()=>{
  const centre=toProjected(crs,139.52,35.373);
  const box={minX:centre.x-600,minY:centre.y-400,maxX:centre.x+600,maxY:centre.y+400};
  it("resamples the tiles into a grid in the project's coordinate system",async()=>{
    const requested:string[]=[];
    const grid=await fetchTerrain(crs,box,[elevationSources[0]],async(s,z,x,y)=>{requested.push(`${z}/${x}/${y}`);return tileFrom(z,x,y)});
    expect([grid.dx,grid.ncols,grid.nrows]).toEqual([5,241,161]);
    expect(new Set(requested).size).toBe(requested.length);
    expect(requested.every(r=>r.startsWith("15/"))).toBe(true);
    for(const [x,y] of [[box.minX,box.minY],[centre.x,centre.y],[box.maxX-3,box.maxY-7]]){
      const g={lon:0,lat:0};
      Object.assign(g,(await import("../src/crs")).toGeographic(crs,x,y));
      expect(Math.abs(terrainZ(grid,x,y)-field(g.lon,g.lat))).toBeLessThan(0.02);
    }
    expect(grid.source).toBe(elevationSources[0].attribution);
  });
  it("fills what the first source lacks from the next one",async()=>{
    const coarse:ElevationSource={...elevationSources[1]};
    const grid=await fetchTerrain(crs,box,[elevationSources[0],coarse],async(s,z,x,y)=>s.id==="gsi-dem5a"&&x%2===0?null:tileFrom(z,x,y));
    expect(grid.z.every(Number.isFinite)).toBe(true);
    expect(grid.source).toContain("DEM10B");
    await expect(fetchTerrain(crs,box,[elevationSources[0]],async()=>null)).rejects.toThrow(/no data/);
  });
  it("chooses a map zoom with a bounded number of tiles",()=>{
    const t=mapTiles(crs,box,mapSources[0]);
    expect((t.x1-t.x0+1)*(t.y1-t.y0+1)).toBeLessThanOrEqual(64);
    expect((t.x1-t.x0+1)*256).toBeLessThanOrEqual(2048*1.5);
    expect(t.z).toBeGreaterThan(12);
  });
});
