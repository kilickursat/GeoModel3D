import {describe,it,expect} from "vitest";
import {delaunay,triangleArea,boundaryEdges,uniqueEdges,Triangle} from "../src/tin";
import {randomPoints,convexHullArea} from "./helpers";

const key=(t:Triangle)=>{const v=[t.a,t.b,t.c];const i=v.indexOf(Math.min(...v));return [v[i],v[(i+1)%3],v[(i+2)%3]].join(",")};

describe("delaunay",()=>{
  const points=randomPoints(80,7);
  const tris=delaunay(points);

  it("returns counter-clockwise, non-degenerate triangles",()=>{
    expect(tris.length).toBeGreaterThan(0);
    for(const t of tris){
      expect(new Set([t.a,t.b,t.c]).size).toBe(3);
      expect(triangleArea(points,t)).toBeGreaterThan(0);
    }
  });

  it("leaves every circumcircle empty",()=>{
    for(const t of tris){
      const [a,b,c]=[points[t.a],points[t.b],points[t.c]];
      const d=2*(a.x*(b.y-c.y)+b.x*(c.y-a.y)+c.x*(a.y-b.y));
      const cx=((a.x**2+a.y**2)*(b.y-c.y)+(b.x**2+b.y**2)*(c.y-a.y)+(c.x**2+c.y**2)*(a.y-b.y))/d;
      const cy=((a.x**2+a.y**2)*(c.x-b.x)+(b.x**2+b.y**2)*(a.x-c.x)+(c.x**2+c.y**2)*(b.x-a.x))/d;
      const r2=(a.x-cx)**2+(a.y-cy)**2;
      points.forEach((p,i)=>{if(i!==t.a&&i!==t.b&&i!==t.c)expect((p.x-cx)**2+(p.y-cy)**2).toBeGreaterThan(r2*(1-1e-9))});
    }
  });

  it("tiles the convex hull exactly once",()=>{
    const area=tris.reduce((s,t)=>s+triangleArea(points,t),0);
    expect(area).toBeCloseTo(convexHullArea(points),6);
    const hullVertices=new Set(boundaryEdges(tris).flat()).size;
    expect(tris.length).toBe(2*points.length-2-hullVertices);
    expect(uniqueEdges(tris).length).toBe(3*points.length-3-hullVertices);
  });

  it("triangulates a regular grid of cocircular points",()=>{
    const grid=Array.from({length:30},(_,i)=>({x:(i%6)*20,y:Math.floor(i/6)*25}));
    const t=delaunay(grid);
    expect(t.length).toBe(40);
    expect(t.reduce((s,q)=>s+triangleArea(grid,q),0)).toBeCloseTo(100*100,6);
  });

  it("gives the same triangulation in projected coordinates",()=>{
    const shifted=points.map(p=>({x:p.x+456732.21,y:p.y+3987210.64}));
    expect(delaunay(shifted).map(key).sort()).toEqual(tris.map(key).sort());
  });

  it("covers the whole hull for many random layouts",()=>{
    for(let seed=1;seed<=300;seed++){
      const p=randomPoints(10+seed%90,seed);
      const t=delaunay(p);
      expect(t.reduce((s,q)=>s+triangleArea(p,q),0)/convexHullArea(p)).toBeCloseTo(1,9);
      expect(new Set(t.flatMap(q=>[q.a,q.b,q.c])).size).toBe(p.length);
    }
  });

  it("covers the hull of boreholes along a curved alignment",()=>{
    const road=Array.from({length:40},(_,i)=>({x:i*25,y:0.002*(i*25-500)**2/50+(i%2)*3}));
    const t=delaunay(road);
    expect(t.reduce((s,q)=>s+triangleArea(road,q),0)).toBeCloseTo(convexHullArea(road),6);
  });

  it("ignores repeated positions",()=>{
    const p=[...points.slice(0,20),{...points[3]},{...points[11]}];
    const t=delaunay(p);
    expect(t.some(q=>[q.a,q.b,q.c].some(i=>i>=20))).toBe(false);
    expect(t.length).toBe(delaunay(points.slice(0,20)).length);
  });

  it("returns nothing for fewer than three or collinear points",()=>{
    expect(delaunay(points.slice(0,2))).toEqual([]);
    expect(delaunay([0,1,2,3].map(i=>({x:i*10,y:i*5})))).toEqual([]);
  });
});
