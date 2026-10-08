import {describe,it,expect} from "vitest";
import proj4 from "proj4";
import {readFileSync} from "node:fs";
import {crsRegistry,findCrs,toProjected,toGeographic,suggestCrs,searchCrs,customCrs,projectCrs} from "../src/crs";

describe("coordinate reference systems",()=>{
  // GSI survey calculator (https://vldb.gsi.go.jp/sokuchi/surveycalc/), JGD2011: X is the northing, Y the easting.
  const gsi:Array<[number,number,number,number,number]>=[
    [9,35.373472,139.520028,-69463.2814,-28467.7100],
    [9,35.681236,139.767125,-35363.2377,-5992.9196],
    [6,34.702485,135.495951,-143825.4140,-46175.2301],
    [12,43.068661,141.350755,-103071.8787,-73236.4925],
    [2,33.590355,130.420658,65619.9733,-53772.9167],
    [1,32.744839,129.873756,-28233.2909,35025.4933]
  ];
  it("matches the Geospatial Information Authority of Japan to the millimetre",()=>{
    for(const [zone,lat,lon,X,Y] of gsi){
      const crs=findCrs(`EPSG:${6668+zone}`)!;
      expect(crs.name).toMatch(/^JGD2011 \/ Japan Plane Rectangular CS/);
      const p=toProjected(crs,lon,lat);
      expect(Math.abs(p.x-Y)).toBeLessThan(0.001);
      expect(Math.abs(p.y-X)).toBeLessThan(0.001);
    }
  });

  it("can use every system in the registry, and returns to the same point",()=>{
    expect(crsRegistry.length).toBeGreaterThan(400);
    expect(new Set(crsRegistry.map(e=>e.code)).size).toBe(crsRegistry.length);
    for(const e of crsRegistry){
      const [w,s,east,n]=e.bbox,lon=w<=east?(w+east)/2:((w+east+360)/2+180)%360-180,lat=(s+n)/2;
      const p=toProjected(e,lon,lat);
      expect(Number.isFinite(p.x)&&Number.isFinite(p.y),e.code).toBe(true);
      const q=toGeographic(e,p.x,p.y);
      expect(Math.abs(q.lon-lon)+Math.abs(q.lat-lat),e.code).toBeLessThan(1e-6);
    }
  });

  // The library converts through geocentric coordinates even between identical datums, which costs about 1 mm.
  it("puts national grid origins at their false origins",()=>{
    const bng=findCrs("27700")!,rd=findCrs("epsg:28992")!;
    const airy=`+proj=longlat +ellps=airy ${bng.proj4.match(/\+towgs84=\S+/)![0]} +no_defs`;
    const [e,n]=proj4(airy,bng.proj4).forward([-2,49]);
    expect(Math.hypot(e-400000,n+100000)).toBeLessThan(0.01);
    const bessel=`+proj=longlat +ellps=bessel ${rd.proj4.match(/\+towgs84=\S+/)![0]} +no_defs`;
    const [x,y]=proj4(bessel,rd.proj4).forward([5.38763888888889,52.1561605555556]);
    expect(Math.hypot(x-155000,y-463000)).toBeLessThan(0.01);
    expect(bng.note).toMatch(/2 m/);
  });

  it("suggests the national system in use where a site lies, then the UTM zone",()=>{
    const cases:Array<[string,number,number,string]>=[
      ["Yokohama",139.52,35.37,"EPSG:6677"],["Osaka",135.496,34.702,"EPSG:6674"],["Sapporo",141.35,43.07,"EPSG:6680"],
      ["Nagasaki",129.87,32.74,"EPSG:6669"],["Naha",127.68,26.21,"EPSG:6683"],["London",-0.13,51.5,"EPSG:27700"],
      ["Dublin",-6.26,53.35,"EPSG:2157"],["Amsterdam",4.9,52.37,"EPSG:28992"],["Zurich",8.54,47.37,"EPSG:2056"],
      ["Munich",11.58,48.14,"EPSG:25832"],["Paris",2.35,48.86,"EPSG:2154"],["Lisbon",-9.14,38.72,"EPSG:3763"],
      ["Sydney",151.21,-33.87,"EPSG:7856"],["Auckland",174.76,-36.85,"EPSG:2193"],["Singapore",103.82,1.35,"EPSG:3414"],
      ["Hong Kong",114.17,22.3,"EPSG:2326"],["Seoul",126.98,37.57,"EPSG:5186"],["Taipei",121.56,25.03,"EPSG:3826"],
      ["São Paulo",-46.63,-23.55,"EPSG:31983"]
    ];
    for(const [city,lon,lat,code] of cases){
      const s=suggestCrs(lon,lat);
      expect(s[0].code,city).toBe(code);
      expect(s.at(-1)!.name,city).toMatch(/^WGS 84 \/ UTM zone/);
    }
    expect(suggestCrs(139.52,35.37).findIndex(e=>/^Tokyo/.test(e.name))).toBeGreaterThan(suggestCrs(139.52,35.37).findIndex(e=>e.code==="EPSG:6677"));
    expect(suggestCrs(25,0).map(e=>e.code)).toEqual(["EPSG:32635"]);
  });

  it("finds systems by code, name or country",()=>{
    expect(searchCrs("japan IX").map(e=>e.code)).toContain("EPSG:6677");
    expect(searchCrs("27700")[0].code).toBe("EPSG:27700");
    expect(searchCrs("switzerland lv95").map(e=>e.code)).toEqual(["EPSG:2056"]);
    expect(searchCrs("  ")).toEqual([]);
  });

  it("accepts projected custom definitions in metres only, and resolves a project's system",()=>{
    const def="+proj=tmerc +lat_0=0 +lon_0=30 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs";
    expect(customCrs(def,"Site grid").proj4).toBe(def);
    expect(()=>customCrs("+proj=longlat +datum=WGS84")).toThrow(/projected/);
    expect(()=>customCrs("+proj=tmerc +lon_0=30 +units=us-ft")).toThrow(/metres/);
    expect(projectCrs({crsCode:"EPSG:6677"})!.name).toBe("JGD2011 / Japan Plane Rectangular CS IX");
    expect(projectCrs({crsCode:"EPSG:6677",crsProj4:def,crs:"Site grid"})!.proj4).toBe(def);
    expect(projectCrs({crs:"Local grid (m)"})).toBeNull();
  });
});

// Positions published with national data in two systems: the BRO gives RD New coordinates with their ETRS89 position
// (RDNAPTRANS2018), DOV gives Belgian Lambert 72 with Lambert 2008 (ETRS89).
describe("datum shifts against published positions",()=>{
  const read=(dir:string,file:string)=>readFileSync(new URL(`./fixtures/${dir}/${file}`,import.meta.url),"utf8");
  const metres=(a:{lon:number;lat:number},b:{lon:number;lat:number})=>Math.hypot((a.lon-b.lon)*111320*Math.cos(a.lat*Math.PI/180),(a.lat-b.lat)*110574);
  it("places RD New within a decimetre of RDNAPTRANS2018",()=>{
    for(const f of ["BHR000000361914.xml","BHR000000470183.xml"]){
      const s=read("bro",f),rd=s.match(/EPSG::28992"[^>]*>\s*<gml:pos>([\d.]+) ([\d.]+)/)!,etrs=s.match(/EPSG::4258"[^>]*>\s*<gml:pos>([\d.]+) ([\d.]+)/)!;
      expect(metres(toGeographic(findCrs("EPSG:28992")!,+rd[1],+rd[2]),{lat:+etrs[1],lon:+etrs[2]})).toBeLessThan(0.15);
    }
  });
  it("places Belgian Lambert 72 within a decimetre of Lambert 2008",()=>{
    for(const f of ["boring-1931-084105.xml","boring-1948-120680.xml","boring-2016-147736.xml"]){
      const s=read("dov",f),a=s.match(/EPSG::6190"[^>]*>\s*<gml:pos>([\d.]+) ([\d.]+)/)!,b=s.match(/EPSG::8370"[^>]*>\s*<gml:pos>([\d.]+) ([\d.]+)/)!;
      expect(metres(toGeographic(findCrs("EPSG:31370")!,+a[1],+a[2]),toGeographic(findCrs("EPSG:3812")!,+b[1],+b[2]))).toBeLessThan(0.15);
    }
  });
});
