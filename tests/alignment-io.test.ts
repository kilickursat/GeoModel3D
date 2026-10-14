import {describe,it,expect} from "vitest";
import {importFiles,toProjectJson,toAlignmentCsv,lineTableKind} from "../src/io";
import {chainages} from "../src/alignment";
import {valleyProject,sakaeProject,referenceProject} from "../src/geology";
import {projectCrs,toProjected} from "../src/crs";

const valley={...valleyProject};

describe("importing alignments",()=>{
  it("reads a line with chainage and crown and invert levels, and adds it to the project shown",()=>{
    const text="point,x,y,chainage,crown,invert\nP1,100,100,1+000,30,24\nP2,250,180,1+170.5,28,22\nP3,380,260,1+323,26,20\n";
    const r=importFiles([{name:"tunnel.csv",text}],valley);
    expect(r.alignments).toEqual(["tunnel"]);
    const a=r.project.alignments![0];
    expect(a.points.map(p=>p.chainage)).toEqual([1000,1170.5,1323]);
    expect(a.design).toEqual([{chainage:1000,top:30,bottom:24},{chainage:1170.5,top:28,bottom:22},{chainage:1323,top:26,bottom:20}]);
    expect(r.project.boreholes).toBe(valley.boreholes);
    expect(r.warnings[0]).toMatch(/^Alignment tunnel: 3 points, chainage 1000–1323 m, 3 design levels \(crown and invert\)/);
  });

  it("converts feet, reads kilometre columns, and makes crown and invert from an axis and a diameter",()=>{
    const ft=importFiles([{name:"route.csv",text:"Easting (ft),Northing (ft),Elevation (ft)\n0,0,100\n1000,0,90\n"}],valley);
    const a=ft.project.alignments![0];
    expect(a.points[1].x).toBeCloseTo(304.8,6);
    expect(a.design![1].top).toBeCloseTo(27.432,6);
    expect(ft.warnings.join(" ")).toMatch(/converted from feet to metres/);
    expect(ft.warnings.join(" ")).toMatch(/Elevation \(ft\) is read as the design level/);
    const km=importFiles([{name:"line.csv",text:"x,y,KP,axis,diameter\n0,0,2.5,10,8\n100,0,2.6,12,8\n"}],valley).project.alignments![0];
    expect(km.points.map(p=>p.chainage)).toEqual([2500,2600]);
    expect(km.design![0]).toEqual({chainage:2500,top:14,bottom:6});
  });

  it("attaches design levels by chainage to the line read before",()=>{
    const withLine=importFiles([{name:"centreline.csv",text:"x,y\n0,0\n300,0\n"}],valley).project;
    const r=importFiles([{name:"profile.csv",text:"chainage,crown,invert\n0,20,14\n150,18,12\n300,15,9\n"}],withLine);
    expect(r.project.alignments![0].design!.map(d=>d.top)).toEqual([20,18,15]);
    expect(r.warnings.join(" ")).toMatch(/3 design levels for centreline/);
  });

  it("leaves collar and log tables to the borehole importer",()=>{
    expect(lineTableKind({name:"collars.csv",text:"id,x,y,z\nA,0,0,10\n"})).toBeNull();
    expect(lineTableKind({name:"logs.csv",text:"hole_id,from,to,unit\n"})).toBeNull();
    expect(lineTableKind({name:"points.csv",text:"Easting,Northing\n0,0\n"})).toBe("line");
    expect(lineTableKind({name:"levels.csv",text:"chainage,level\n0,10\n"})).toBe("profile");
    const r=importFiles([{name:"collars.csv",text:"id,x,y,z\nA,0,0,10\nB,50,0,11\n"},{name:"logs.csv",text:"id,from,to,unit\nA,0,5,Sand\nB,0,6,Sand\n"}]);
    expect(r.project.boreholes.length).toBe(2);
    expect(r.project.alignments).toBeUndefined();
  });

  it("reads GeoJSON lines in longitude and latitude into the project's coordinate system",()=>{
    const crs=projectCrs(sakaeProject)!;
    const doc={type:"FeatureCollection",features:[{type:"Feature",properties:{name:"Route 1"},geometry:{type:"LineString",coordinates:[[139.5480,35.3560,40],[139.5530,35.3510,35]]}}]};
    const r=importFiles([{name:"route.geojson",text:JSON.stringify(doc)}],sakaeProject);
    const a=r.project.alignments![0],p=toProjected(crs,139.5480,35.3560);
    expect(a.name).toBe("Route 1");
    expect(a.points[0].x).toBeCloseTo(p.x,6);
    expect(a.points[0].y).toBeCloseTo(p.y,6);
    expect(a.design!.map(d=>d.top)).toEqual([40,35]);
    expect(r.warnings.join(" ")).toMatch(/heights of the points are read as design levels/);
    expect(()=>importFiles([{name:"route.geojson",text:JSON.stringify(doc)}],referenceProject)).toThrow(/coordinate system/);
  });

  it("reads DXF polylines, following arcs, and prefers layers named as lines",()=>{
    const pairs=(list:Array<[number,string|number]>)=>list.map(([c,v])=>`${String(c).padStart(3)}\n${v}`).join("\n")+"\n";
    const dxf=pairs([[0,"SECTION"],[2,"HEADER"],[9,"$INSUNITS"],[70,6],[0,"ENDSEC"],[0,"SECTION"],[2,"ENTITIES"],
      [0,"LWPOLYLINE"],[8,"CL_TUNNEL"],[90,3],[70,0],[10,0],[20,0],[42,1],[10,20],[20,0],[10,40],[20,0],
      [0,"POLYLINE"],[8,"Kerb"],[66,1],[70,0],[0,"VERTEX"],[8,"Kerb"],[10,5],[20,5],[0,"VERTEX"],[8,"Kerb"],[10,15],[20,5],[0,"SEQEND"],
      [0,"ENDSEC"],[0,"EOF"]]);
    const r=importFiles([{name:"plan.dxf",text:dxf}],valley),lines=r.project.alignments!;
    expect(lines.map(a=>a.name)).toEqual(["CL_TUNNEL"]);
    const pts=lines[0].points,arc=pts.slice(0,pts.findIndex(p=>p.x===20&&p.y===0)+1);
    expect(arc.length).toBeGreaterThan(20);
    for(const p of arc)expect(Math.hypot(p.x-10,p.y)).toBeCloseTo(10,9);
    expect(Math.min(...arc.map(p=>p.y))).toBeCloseTo(-10,1);
    for(let k=1;k<arc.length;k++){const m={x:(arc[k].x+arc[k-1].x)/2,y:(arc[k].y+arc[k-1].y)/2};expect(10-Math.hypot(m.x-10,m.y)).toBeLessThanOrEqual(0.02)}
    expect(pts[pts.length-1]).toEqual({x:40,y:0});
    expect(r.warnings.join(" ")).toMatch(/drawing units metres/);
    const kerb=pairs([[0,"SECTION"],[2,"ENTITIES"],[0,"POLYLINE"],[8,"Kerb"],[66,1],[70,0],[0,"VERTEX"],[8,"Kerb"],[10,5],[20,5],[0,"VERTEX"],[8,"Kerb"],[10,15],[20,5],[0,"SEQEND"],[0,"ENDSEC"],[0,"EOF"]]);
    const k=importFiles([{name:"kerb.dxf",text:kerb}],valley);
    expect(k.project.alignments![0].points).toEqual([{x:5,y:5},{x:15,y:5}]);
    expect(k.warnings.join(" ")).toMatch(/does not state its units/);
  });

  it("keeps alignments in the project file, and writes them as CSV",()=>{
    const line={name:"Road A",start:500,points:[{x:0,y:0},{x:100,y:0},{x:100,y:80}],design:[{chainage:500,top:12},{chainage:680,top:15}]};
    const again=importFiles([{name:"p.geomodel3d.json",text:toProjectJson({...referenceProject,alignments:[line]})}]).project.alignments;
    expect(again).toEqual([line]);
    const csv=toAlignmentCsv(line).trim().split("\n");
    expect(csv[0]).toBe("x,y,chainage_m,level_m");
    expect(csv[2]).toBe("100,0,600,13.667");
    expect(chainages(line)).toEqual([500,600,680]);
  });

  it("says what is wrong with a line",()=>{
    expect(()=>importFiles([{name:"short.csv",text:"x,y,chainage\n0,0,0\n"}],valley)).toThrow(/two points/);
    expect(()=>importFiles([{name:"back.csv",text:"x,y,chainage\n0,0,10\n50,0,5\n"}],valley)).toThrow(/does not increase/);
    expect(()=>importFiles([{name:"odd.csv",text:"x,y,chainage\n0,0,12+50\n50,0,13+00\n"}],valley)).toThrow(/12\+345/);
    expect(()=>importFiles([{name:"geo.csv",text:"lat,lon,chainage\n35,139,0\n35.1,139,100\n"}],valley)).toThrow(/Coordinates/);
  });
});

describe("the alignment templates",()=>{
  it("import as the README describes them",async()=>{
    const {readFileSync}=await import("node:fs");
    const read=(f:string)=>({name:f,text:readFileSync(new URL(`../docs/templates/${f}`,import.meta.url),"utf8")});
    const withLine=importFiles([read("alignment.csv")],valley);
    const a=withLine.project.alignments![0];
    expect(a.name).toBe("alignment");
    expect(a.points.map(p=>p.chainage)).toEqual([1000,1117,1255.9]);
    expect(a.design![0]).toEqual({chainage:1000,top:30.5,bottom:24});
    const levels=importFiles([read("profile.csv")],withLine.project).project.alignments![0].design!;
    expect(levels.map(d=>d.chainage)).toEqual([1000,1100,1255.9]);
  });
});
