import {expect,it} from "vitest";
import {matchCollarSchedules,readCollarSchedules} from "../src/docread/collarSchedule";
import {type ReadLog,textLine} from "../src/docread/reconstruct";

const cell=(text:string,x:number,y:number)=>textLine(text,x,y,x+text.length*5,y+10);
const header=(e="Easting (m)",n="Northing (m)",z="Ground elevation (m)")=>[
  cell("Borehole ID",10,30),cell(e,150,30),cell("Depth (m)",275,30),cell(n,390,30),cell(z,520,30)
];
const data=(id:string,x:string,y:string,z:string,top:number)=>[
  cell(id,10,top),cell(x,150,top),cell("10",275,top),cell(y,390,top),cell(z,520,top)
];
const log=(id:string,extra:Partial<ReadLog>={}):ReadLog=>({kind:"table",id,pages:[7],layers:[],flagged:[],
  src:{id:{...cell(id,15,20),page:7}},...extra});
const page={page:3,lines:[...header(),...data("BH-04","301025.5","6010335","-1.20",47),...data("BH-4","301045","6010201","12.6",62)]};

it("matches an exact log ID with printed metric columns, omitting adjacent depth and retaining evidence",()=>{
  const rows=readCollarSchedules([page]),[first,other]=rows;
  expect(first.id).toBe("BH-04");
  expect(first.fields).toMatchObject({x:{value:301025.5,line:{text:"301025.5",page:3,x0:150},heading:{text:"Easting (m)",page:3}},
    y:{value:6010335},ground:{value:-1.2,line:{text:"-1.20",page:3}}});
  expect(other.id).toBe("BH-4");
  const input=log("BH-04");
  const matches=matchCollarSchedules([input,log("BH04"),log("bh-04"),log("BH-4")],rows);
  expect(matches.map(m=>m.status)).toEqual(["proposed","missing","missing","proposed"]);
  expect(matches[0].candidates).toEqual([first]);
  expect(input.x).toBeUndefined();
  expect(matchCollarSchedules([log("BH-04",{src:{}})],rows)[0].status).toBe("missing");
});
it("does not join duplicate identifiers, overwrite conflicting headers, or infer a conversion",()=>{
  const other={page:4,lines:[...header(),...data("BH-04","301026","6010335","-1.20",47)]};
  const duplicates=readCollarSchedules([page,other]),original=readCollarSchedules([page]);
  expect(matchCollarSchedules([log("BH-04")],duplicates)[0]).toMatchObject({status:"ambiguous",candidates:[{page:3},{page:4}]});
  expect(matchCollarSchedules([log("BH-04"),log("BH-04")],original).map(m=>m.status)).toEqual(["ambiguous","ambiguous"]);
  expect(matchCollarSchedules([log("BH-04",{x:301025.5,y:6010335,ground:-1.2})],original)[0].status).toBe("confirmed");
  expect(matchCollarSchedules([log("BH-04",{ground:30})],original)[0].status).toBe("conflict");
  expect(matchCollarSchedules([log("BH-04",{lat:53,lon:-7})],original)[0].status).toBe("conflict");
});
it("requires genuine schedule columns and verified coordinate units",()=>{
  const note=cell("Survey coordinates in metres (UTM zone 32N)",10,15);
  const unlabelled={page:2,lines:[...header("Easting","Northing","Ground elevation"),...data("BH-04","300001","6000001","17",47)]};
  const [row]=readCollarSchedules([unlabelled]);
  expect(row.fields).toEqual({});
  expect(matchCollarSchedules([log("BH-04")],[row])[0].status).toBe("conflict");
  const [qualified]=readCollarSchedules([{page:2,lines:[note,...unlabelled.lines]}]);
  expect(qualified.context).toContainEqual({...note,page:2});
  expect(qualified.fields.x?.value).toBe(300001);
  expect(qualified.fields.ground).toBeUndefined();
  expect(readCollarSchedules([{page:1,lines:[cell("The borehole has an easting and northing.",10,30),...data("BH-04","6","7","8",47)]}])).toEqual([]);
  const [feet]=readCollarSchedules([{page:1,lines:[...header("Easting (ft)","Northing (ft)"),...data("BH-04","300001","6000001","17",47)]}]);
  expect(feet.fields.x).toBeUndefined();
  expect(matchCollarSchedules([log("BH-04")],[feet])[0].status).toBe("conflict");
});
it("reads decimal latitude and longitude with a declared WGS84 datum and an explicit western hemisphere",()=>{
  const fields=[cell("Well ID",10,30),cell("Latitude",120,30),cell("Longitude (W)",240,30),
    cell("W1",10,45),cell("40.215",120,45),cell("96.548",240,45)];
  expect(readCollarSchedules([{page:2,lines:fields}])[0].fields).toEqual({});
  const [row]=readCollarSchedules([{page:2,lines:[cell("WGS 84",10,15),...fields]}]);
  expect(row.fields).toMatchObject({lat:{value:40.215},lon:{value:-96.548}});
});

it("presents two conflicting coordinate pairs from a synthetic schedule separately and leaves the ellipsoidal height out of ground level",()=>{
  const fields=(a:string,b:string,y:number)=>[cell(a,115,y),cell(b,300,y)];
  const details={page:3,lines:[cell("Hole ID",10,30),cell("DEMO-7",115,30),
    cell("Site ID",10,45),cell("Test grid",115,45),cell("Location",10,60),
    ...fields("Longitude (GDA94)","147.000000°",60),...fields("Latitude (GDA94)","-30.000000°",75),
    ...fields("Easting (MGAZ55S)","500030",90),...fields("Northing (MGAZ55S)","6681254.65",105),
    ...fields("Elevation (ellipsoidal)","98 m",120),cell("Drilled length",10,135),cell("42.8 m",115,135),
    cell("Casing",10,150),cell("Steel",115,150),cell("Deviation",10,165),cell("Vertical",115,165)]};
  const planned={...details,page:8,lines:[cell("Proposed coordinates for drilling",10,12),...details.lines]};
  const options=readCollarSchedules([details,planned]);
  expect(options).toHaveLength(2);
  const [grid,geo]=options;
  expect(grid).toMatchObject({id:"DEMO-7",page:3,coordinateKind:"projected",coordinateConflict:true,crsCode:"EPSG:28355",
    fields:{x:{value:500030},y:{value:6681254.65}}});
  expect(geo).toMatchObject({id:"DEMO-7",page:3,coordinateKind:"geographic",coordinateConflict:true,crsCode:"EPSG:28355",
    fields:{lat:{value:-30},lon:{value:147}}});
  expect(geo.projectedFromGeographic!.x).toBeCloseTo(500000,2);
  expect(geo.projectedFromGeographic!.y).toBeCloseTo(6681214.65,2);
  expect(geo.fields.x).toBeUndefined();expect(grid.fields.lon).toBeUndefined();
  expect(grid.fields.ground).toBeUndefined();expect(geo.fields.ground).toBeUndefined();
  expect(geo.context?.map(l=>l.text)).toEqual(expect.arrayContaining(["98 m","Vertical","42.8 m"]));
  expect(geo.finalDepth).toMatchObject({value:42.8,line:{text:"42.8 m",page:3},heading:{text:"Drilled length",page:3}});
  expect(grid.finalDepth).toBe(geo.finalDepth);
  expect(matchCollarSchedules([log("DEMO-7")],options)[0]).toMatchObject({status:"conflict"});
  expect(grid.notes.join(" ")).toContain("50.00 m");
});
it("does not discard a second row bearing the same ID when its coordinate cells are marked missing",()=>{
  const [result]=matchCollarSchedules([log("BH-04")],readCollarSchedules([{page:3,
    lines:[...header(),...data("BH-04","301025","6010335","12",47),...data("BH-04","—","—","12",62)]}]));
  expect(result.status).toBe("ambiguous");
  expect(result.candidates).toHaveLength(2);
  expect(result.candidates[1].fields.x).toBeUndefined();
});
it("keeps an explicit supported EPSG reference and abstains on conflicting zones",()=>{
  const explicit={page:1,lines:[cell("Collar survey (EPSG:32632)",10,15),...header("Easting","Northing"),...data("B23","300000","5250000","18",47)]};
  expect(readCollarSchedules([explicit])[0]).toMatchObject({crsCode:"EPSG:32632",fields:{x:{value:300000},y:{value:5250000}}});
  const conflicting={page:1,lines:[cell("GDA94",10,15),...header("Easting (MGAZ55S)","Northing (MGAZ56S)"),...data("B23","300000","5250000","18",47)]};
  const [row]=readCollarSchedules([conflicting]);
  expect(row.crsCode).toBeUndefined();
  expect(row.fields.x).toBeUndefined();
  expect(matchCollarSchedules([log("B23")],[row])[0].status).toBe("conflict");
});
it("skips planned rows within a completed survey table without losing the subsequent as-drilled row",()=>{
  const rows=readCollarSchedules([{page:1,lines:[...header(),cell("Status",650,30),
    ...data("BH-04","310000","6030000","5",47),cell("Planned",650,47),
    ...data("BH-04","310040","6030022","5",62),cell("As drilled",650,62)]}]);
  expect(rows).toHaveLength(1);
  expect(rows[0].fields.x?.value).toBe(310040);
});
it("reads only a positive completed metric depth and withholds along-hole length for an inclined hole",()=>{
  const rowFor=(heading:string,value:string,dip?:string)=>{
    const column=[cell(heading,650,30),...(dip?[cell("Inclination",820,30)]:[])];
    const records=[cell(value,650,47),...(dip?[cell(dip,820,47)]:[])];
    return readCollarSchedules([{page:2,lines:[...header(),...column,...data("BH-1","300000","6000000","12.4",47),...records]}])[0];
  };
  expect(rowFor("Final depth (m)","12.5").finalDepth?.value).toBe(12.5);
  expect(rowFor("Completed vertical depth (m)","8","-55°").finalDepth?.value).toBe(8);
  for(const [title,value] of [["Final depth (m)","-9"],["Drilled length","9"],["Final depth (ft)","50"],["Estimated final depth (m)","10"],
    ["Mud rotary drilled length (m)","8"],["Depth to basement (m)","15"],["Drilled length (m)","~12.5"],["Drilled length (m)","12–15"]]){
    expect(rowFor(title,value)?.finalDepth).toBeUndefined();
  }
  const inclined=rowFor("Drilled length","120 m","60 degrees");
  expect(inclined.finalDepth).toBeUndefined();
  expect(inclined.notes.join(" ")).toContain("Verify vertical depth");
});

function schedule(headings:string[],records:string[][],declaration?:string){
  const line=(values:string[],y:number)=>values.flatMap((v,i)=>v?[cell(v,10+160*i,y)]:[]);
  return {page:3,lines:[...(declaration?[cell(declaration,10,15)]:[]),...line(headings,30),
    ...records.flatMap((values,i)=>line(values,47+15*i))]};
}
it("keeps each row’s declared EPSG or MGA zone separate and withholds an unknown or blank reference",()=>{
  const h=["Borehole ID","Easting (m)","Northing (m)","EPSG code"];
  const rows=readCollarSchedules([schedule(h,[
    ["BH-1","310000","6300000","28355"],["BH-2","310000","6300000","EPSG:28356"],
    ["BH-3","300000","6300000","Historical local grid"],["BH-4","301000","6300000",""],
    ["BH-5","312000","6300300","EPSG:28355"],
  ])]);
  expect(rows.map(r=>r.crsCode)).toEqual(["EPSG:28355","EPSG:28356",undefined,undefined,"EPSG:28355"]);
  expect(rows[1].fields.x?.value).toBe(310000);
  for(const i of [2,3]){
    expect(rows[i].fields).toEqual({});
    expect(matchCollarSchedules([log(rows[i].id)],rows)[0].status).toBe("conflict");
    expect(rows[i].notes.join(" ")).toContain("EPSG code");
  }
  expect(rows[2].context).toContainEqual(expect.objectContaining({text:"Historical local grid",page:3,x0:490}));
  const zones=readCollarSchedules([schedule([...h.slice(0,3),"MGA Zone"],[
    ["BH-1","310000","6300000","55"],["BH-2","310000","6300000","56"],
    ["BH-3","310000","6300000","Uncertain"],
  ],"Survey datum GDA94")]);
  expect(zones.map(r=>r.crsCode)).toEqual(["EPSG:28355","EPSG:28356",undefined]);
  expect(zones[2].fields.x).toBeUndefined();
});
it("withholds a row reference that conflicts with the common EPSG, datum or coordinate type",()=>{
  const h=["Well ID","Easting (m)","Northing (m)","CRS"];
  for(const [global,local] of [["Collar survey EPSG:32631","EPSG:32632"],["GDA94 survey","EPSG:32655"],
    ["WGS84 / UTM zone 55S","EPSG:32655"],["Zone 33N","EPSG:32632"],["Collar survey EPSG 32631","EPSG:32632"],
    ["EPSG:32631","EPSG:4326"],["WGS84 survey","unspecified grid"],["","EPSG:4326"]]){
    const [row]=readCollarSchedules([schedule(h,[["W-1","450000","3200000",local]],global)]);
    expect(row.fields).toEqual({});
    expect(row.context).toContainEqual(expect.objectContaining({text:local,page:3,x0:490}));
  }
  const [geo]=readCollarSchedules([schedule(["Well ID","Latitude","Longitude","CRS"],[["W-1","43.5","-89.1","EPSG:4326"]])]);
  expect(geo.fields).toMatchObject({lat:{value:43.5},lon:{value:-89.1}});
});
it("scopes horizontal and depth unit columns to the printed row and retains withheld values as evidence",()=>{
  const rows=readCollarSchedules([schedule(["Hole ID","Easting (m)","Northing (m)","Horizontal coordinate units","Final depth (m)","Depth units"],[
    ["BH-1","300000","5250000","ft","14","m"],
    ["BH-2","300020","5250010","m","43","ft"],
    ["BH-3","300040","5250020","","21","m"],
  ],"Survey EPSG:32632")]);
  expect(rows[0].fields.x).toBeUndefined();expect(rows[0].finalDepth?.value).toBe(14);
  expect(rows[0].context).toEqual(expect.arrayContaining([
    expect.objectContaining({text:"300000",page:3}),expect.objectContaining({text:"ft",x0:490,page:3})]));
  expect(rows[1].fields.x?.value).toBe(300020);expect(rows[1].finalDepth).toBeUndefined();
  expect(rows[2].fields.y).toBeUndefined();expect(rows[2].finalDepth?.value).toBe(21);
  const [row]=readCollarSchedules([schedule(["Hole ID","Easting (m)","Northing (m)","Ground elevation (m)","Vertical datum"],
    [["BH-1","300000","5250000","75.5","Local assumed"]])]);
  expect(row.fields.x?.value).toBe(300000);expect(row.fields.ground).toBeUndefined();
  expect(row.context).toContainEqual(expect.objectContaining({text:"Local assumed",x0:650,page:3}));
});
