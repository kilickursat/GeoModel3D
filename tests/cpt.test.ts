import {describe,it,expect} from "vitest";
import {readGef,isGef,readBroCpt,isBroCpt,readDovCpt,isDovCpt,frictionRatio,cptAt,cptAverages,thinned,cptScale,pressureKpa} from "../src/cpt";
import {importFiles,toProjectJson,toCptCsv,isCptTable} from "../src/io";
import {buildGeologicalModel} from "../src/model";
import {computeSection} from "../src/section";
import {alignmentSection,chainageTable} from "../src/alignment";
import {sectionField,availableFields} from "../src/fields";
import {sectionSvg,chainageCsv} from "../src/sectionSvg";
import {cptLogSvg} from "../src/cptSvg";
import {reportHtml} from "../src/report";
import {tablesFromProject,projectFromTables} from "../src/tables";
import {findCrs,toGeographic,toProjected} from "../src/crs";
import {GeoProject,Cpt,valleyProject,antwerpProject,rotterdamProject,cptDepth} from "../src/geology";

const gef=(head:string,data:string)=>`#GEFID= 1, 1, 0\n${head}\n#EOH=\n${data}`;
const GEF=gef(`#COLUMN= 6
#COLUMNINFO= 1, m, Sondeerlengte, 1
#COLUMNINFO= 2, MPa, Conusweerstand, 2
#COLUMNINFO= 3, MPa, Plaatselijke wrijving, 3
#COLUMNINFO= 4, %, Wrijvingsgetal, 4
#COLUMNINFO= 5, MPa, Waterspanning u2, 6
#COLUMNINFO= 6, m, Gecorrigeerde diepte, 11
#COLUMNVOID= 2, -999999
#COLUMNVOID= 5, -999999
#COLUMNSEPARATOR= ;
#RECORDSEPARATOR= !
#TESTID= CPT-07
#STARTDATE= 2021, 3, 5
#XYID= 31000, 62000.00, 442000.00, 0.01, 0.01
#ZID= 31000, 4.50, 0.01
#MEASUREMENTVAR= 13, 1.0, m, voorgeboorde/voorgegraven diepte
#PROCEDURECODE= GEF-CPT-Report, 1, 1, 0, -`,`1.02;2.500;0.0125;0.5;0.0100;1.00;!
1.04;-999999;0.0130;0.6;0.0110;1.02;!
1.06;3.000;0.0300;1.0;-999999;1.04;!
`);

// A BRO CPT: records of the 25 parameters in their listed order, -999999 where there is no value.
const BRO_PARAMS=["penetrationLength","depth","elapsedTime","coneResistance","correctedConeResistance","netConeResistance","magneticFieldStrengthX","magneticFieldStrengthY","magneticFieldStrengthZ","magneticFieldStrengthTotal","electricalConductivity","inclinationEW","inclinationNS","inclinationX","inclinationY","inclinationResultant","magneticInclination","magneticDeclination","localFriction","poreRatio","temperature","porePressureU1","porePressureU2","porePressureU3","frictionRatio"];
const record=(v:Record<string,number>)=>BRO_PARAMS.map(p=>v[p]??-999999).join(",");
const bro=(o:{reference?:string;datum?:string;srs?:string;pos?:string;records:Array<Record<string,number>>})=>`<?xml version="1.0" encoding="UTF-8"?>
<dispatchDataResponse xmlns="http://www.broservices.nl/xsd/dscpt/1.1" xmlns:cptcommon="http://www.broservices.nl/xsd/cptcommon/1.1" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:brocom="http://www.broservices.nl/xsd/brocommon/3.0" xmlns:swe="http://www.opengis.net/swe/2.0" xmlns:om="http://www.opengis.net/om/2.0"><dispatchDocument><CPT_O gml:id="BRO_0001"><brocom:broId>CPT000000099999</brocom:broId>
<standardizedLocation><brocom:location srsName="urn:ogc:def:crs:EPSG::4258"><gml:pos>51.96 4.04</gml:pos></brocom:location></standardizedLocation>
<deliveredLocation><cptcommon:location srsName="urn:ogc:def:crs:EPSG::${o.srs??"28992"}"><gml:pos>${o.pos??"62000.00 442000.00"}</gml:pos></cptcommon:location></deliveredLocation>
<deliveredVerticalPosition><cptcommon:localVerticalReferencePoint>${o.reference??"maaiveld"}</cptcommon:localVerticalReferencePoint><cptcommon:offset uom="m">4.50</cptcommon:offset><cptcommon:verticalDatum>${o.datum??"NAP"}</cptcommon:verticalDatum></deliveredVerticalPosition>
<conePenetrometerSurvey><cptcommon:trajectory><cptcommon:predrilledDepth uom="m">0.50</cptcommon:predrilledDepth><cptcommon:finalDepth uom="m">0.56</cptcommon:finalDepth></cptcommon:trajectory>
<cptcommon:conePenetrationTest><om:phenomenonTime><gml:TimeInstant><gml:timePosition>2023-05-25</gml:timePosition></gml:TimeInstant></om:phenomenonTime>
<cptcommon:cptResult><swe:encoding><swe:TextEncoding decimalSeparator="." tokenSeparator="," blockSeparator=";"/></swe:encoding><cptcommon:values>${o.records.map(record).join(";")};</cptcommon:values></cptcommon:cptResult></cptcommon:conePenetrationTest>
<cptcommon:parameters>${BRO_PARAMS.map(p=>`<cptcommon:${p}>ja</cptcommon:${p}>`).join("")}</cptcommon:parameters></conePenetrometerSurvey></CPT_O></dispatchDocument></dispatchDataResponse>`;
const BRO=bro({records:[
  {penetrationLength:0.56,coneResistance:3.1,localFriction:0.031,porePressureU2:0.012,frictionRatio:1.0},
  {penetrationLength:0.52,coneResistance:2.0,localFriction:0.02,porePressureU2:0.01,frictionRatio:1.1},
  {penetrationLength:0.54,localFriction:0.025,porePressureU2:0.011}
]});

const DOV=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns4:dov-schema xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:ns4="http://kern.schemas.dov.vlaanderen.be"><sondering><sondeernummer>GEO-15/133-S54</sondeernummer><dataidentifier><permkey>2015-073113</permkey></dataidentifier>
<datum_aanvang>2015-12-01</datum_aanvang><ligging><gml:Point srsName="urn:ogc:def:crs:EPSG::6190" srsDimension="3"><gml:pos>151000.00 212000.00 5.71</gml:pos></gml:Point></ligging>
<sondeonderzoek><penetratietest><meetdata><lengte>1.00</lengte><diepte>0.99</diepte><qc>2.500</qc><fs>25</fs><u>12</u></meetdata><meetdata><lengte>1.02</lengte><diepte>1.01</diepte><qc>3.000</qc><fs>30</fs><u>13</u></meetdata></penetratietest></sondeonderzoek></sondering></ns4:dov-schema>`;

describe("reading CPT files",()=>{
  it("reads GEF: columns by quantity number, separators, voids, units, position and dates",()=>{
    expect(isGef(GEF)).toBe(true);
    const [{cpt,crs,notes}]=readGef(GEF,"cpt-07.gef");
    expect(cpt).toMatchObject({id:"CPT-07",x:62000,y:442000,z:4.5,date:"2021-03-05",predrill:1});
    expect(crs).toBe("EPSG:28992");
    // The corrected depth is the depth; MPa become kPa for fs and u2; voids are no reading.
    expect(cpt.depth).toEqual([1,1.02,1.04]);
    expect(cpt.qc).toEqual([2.5,NaN,3]);
    expect(cpt.fs).toEqual([12.5,13,30]);
    expect(cpt.u2).toEqual([10,11,NaN]);
    expect(cpt.rf).toEqual([0.5,0.6,1]);
    expect(notes).toEqual([]);
  });

  it("reads GEF in white space, downwards depths and kPa, and says what it assumed",()=>{
    const text=gef(`#COLUMNINFO= 1, m, penetration length, 1
#COLUMNINFO= 2, kPa, cone resistance, 2
#COLUMNINFO= 3, kPa, sleeve friction, 3
#COLUMNINFO= 4, deg, inclination, 8
#XYID= 31000, 62010, 442010`,"-0.50  1500  15  0.5\n-1.00  2500  30  0.7\n");
    const [{cpt,notes}]=readGef(text,"s.gef");
    expect(cpt.id).toBe("s");
    expect(cpt.depth).toEqual([0.5,1]);
    expect(cpt.qc).toEqual([1.5,2.5]);
    expect(cpt.fs).toEqual([15,30]);
    expect(Number.isNaN(cpt.z)).toBe(true);
    expect(notes).toEqual(["depth is the penetration length: the file has no depth corrected for inclination","depths are written as negative numbers; read downwards"]);
    expect(()=>readGef(gef("#REPORTCODE= GEF-BORE-Report, 1, 0, 0","0;1\n"),"b.gef")).toThrow(/GEF borehole log/);
    expect(()=>readGef(gef("#COLUMNINFO= 1, m, penetration length, 1","0.1\n"),"x.gef")).toThrow(/cone resistance/);
  });

  it("reads BRO CPT XML: the parameters in their order, sorted by depth, MPa to kPa for fs and u2",()=>{
    expect(isBroCpt(BRO)).toBe(true);
    const [{cpt,crs,notes}]=readBroCpt(BRO,"x.xml");
    expect(cpt).toMatchObject({id:"CPT000000099999",x:62000,y:442000,z:4.5,lat:51.96,lon:4.04,date:"2023-05-25",predrill:0.5});
    expect(crs).toBe("EPSG:28992");
    expect(cpt.depth).toEqual([0.52,0.54,0.56]);
    expect(cpt.qc).toEqual([2,NaN,3.1]);
    expect(cpt.fs).toEqual([20,25,31]);
    expect(cpt.u2).toEqual([10,11,12]);
    expect(cpt.rf).toEqual([1.1,NaN,1]);
    expect(notes).toEqual([]);
    // Delivered in WGS 84 at the water bed: placed by its ETRS89 position, and said so.
    const sea=readBroCpt(bro({reference:"waterbodem",datum:"LAT",srs:"4326",pos:"51.9 3.9",records:[{penetrationLength:1,coneResistance:1}]}),"s.xml")[0];
    expect(Number.isNaN(sea.cpt.x)).toBe(true);
    expect(sea.crs).toBeUndefined();
    expect([sea.cpt.lat,sea.cpt.lon]).toEqual([51.96,4.04]);
    expect(sea.notes).toEqual(["depths start at the water bed, not the ground surface","levels are in LAT, not NAP"]);
  });

  it("reads DOV CPT XML in Lambert 72 and TAW, fs and u in kPa",()=>{
    expect(isDovCpt(DOV)).toBe(true);
    expect(isDovCpt('<x xmlns="http://kern.schemas.dov.vlaanderen.be"><interpretatie><sondering>https://…</sondering></interpretatie></x>')).toBe(false);
    const [{cpt,crs,notes}]=readDovCpt(DOV,"d.xml");
    expect(cpt).toMatchObject({id:"GEO-15/133-S54",x:151000,y:212000,z:5.71,date:"2015-12-01",depth:[0.99,1.01],qc:[2.5,3],fs:[25,30],u2:[12,13]});
    expect(crs).toBe("EPSG:31370");
    expect(notes.join(" ")).toMatch(/metres TAW.*does not say where/);
  });

  it("gives the friction ratio, readings at a depth, averages over depth and the readings to draw",()=>{
    const c:Cpt={id:"c",x:0,y:0,z:10,depth:[0,0.1,0.2,0.3,0.6],qc:[1,2,NaN,4,5],fs:[10,40,30,40,50]};
    expect(frictionRatio(c)).toEqual([1,2,NaN,1,1]);
    expect(frictionRatio({...c,rf:[3,NaN,NaN,NaN,NaN]})[0]).toBe(3);
    expect(cptAt(c,0.05)).toEqual({qc:1.5,fs:25,u2:NaN,rf:1.5});
    expect(Number.isNaN(cptAt(c,0.7).qc)).toBe(true);
    const a=cptAverages(c,0.5);
    expect(a.length).toBe(2);
    expect(a[0].qc).toBeCloseTo(7/3,9);
    expect(a[0].rf).toBeCloseTo(30/(10*7/3),9);
    expect(a[1]).toMatchObject({depth:0.6,qc:5,fs:50,rf:1});
    expect(thinned(c,0.25)).toEqual([0,3,4]);
    expect([cptScale(17),cptScale(40),cptScale(79.2),cptScale(320)]).toEqual([20,40,80,350]);
    expect([pressureKpa("MPa"),pressureKpa("kN/m²"),pressureKpa("tsf"),pressureKpa("bar"),pressureKpa("furlong")]).toEqual([1000,1,95.7605,100,null]);
  });
});

// Two units over a square of four boreholes; CPTs come in tables.
const layered:GeoProject={
  name:"Two layers",
  units:[{id:"clay",name:"Clay",color:"#9c7a5b"},{id:"sand",name:"Sand",color:"#d9b871"}],
  boreholes:[[0,0],[100,0],[0,100],[100,100]].map(([x,y],i)=>({id:`B${i}`,x,y,z:10,intervals:[{from:0,to:4,unit:"clay"},{from:4,to:20,unit:"sand"}]}))
};
// A CPT at the centre: soft in the clay, dense in the sand.
const readings=(id:string,x:number,y:number,z:number|"")=>Array.from({length:181},(_,i)=>{const d=Math.round(i)/10;return `${id},${x},${y},${z},${d},${d<4?1:10},${d<4?50:80},${d<4?40:20}`}).join("\n");
const cptTable=(rows:string)=>({name:"cpts.csv",text:`cpt_id,x,y,z,depth (m),qc (MPa),fs (kPa),u2 (kPa)\n${rows}\n`});

describe("importing CPTs",()=>{
  it("adds a CPT table to the project shown, by its own positions",()=>{
    expect(isCptTable(["CPT","X","Y","Depth","qc","fs"])).toBe(true);
    expect(isCptTable(["hole_id","depth","qc"])).toBe(false);
    const r=importFiles([cptTable(readings("C1",50,50,10))],layered);
    expect(r.cpts).toEqual(["C1"]);
    expect(r.project.boreholes).toBe(layered.boreholes);
    const c=r.project.cpts![0];
    expect(c).toMatchObject({id:"C1",x:50,y:50,z:10});
    expect(c.depth.length).toBe(181);
    expect(c.qc[0]).toBe(1);
    expect(c.fs![100]).toBe(80);
    expect(r.warnings[0]).toMatch(/^CPTs: 1 placed, 1 with pore pressure u2; C1 \(18 m\)/);
    // Pressures in other units are converted; a CPT table needs boreholes to join.
    const tsf=importFiles([{name:"c.csv",text:"cpt,x,y,z,depth,qc (tsf),fs (tsf)\nC2,40,40,10,1,10,0.5\n"}],layered).project.cpts![0];
    expect(tsf.qc[0]).toBeCloseTo(0.957605,6);
    expect(tsf.fs![0]).toBeCloseTo(47.88,2);
    expect(()=>importFiles([cptTable(readings("C1",50,50,10))])).toThrow(/import boreholes before adding CPTs/);
  });

  it("places CPTs by a collar table imported with them, and with boreholes from the same files",()=>{
    const collars={name:"collars.csv",text:"id,x,y,z\nB0,0,0,10\nB1,100,0,10\nB2,0,100,10\nC1,50,50,10\n"};
    const logs={name:"logs.csv",text:"id,from,to,unit\nB0,0,4,clay\nB0,4,20,sand\nB1,0,4,clay\nB1,4,20,sand\nB2,0,4,clay\nB2,4,20,sand\n"};
    const table={name:"cpt.csv",text:"cpt_id,depth,qc,fs\nC1,1,1.2,30\nC1,2,1.4,35\n"};
    const r=importFiles([collars,logs,table]);
    expect(r.project.boreholes.length).toBe(3);
    expect(r.project.cpts![0]).toMatchObject({id:"C1",x:50,y:50,z:10,depth:[1,2],qc:[1.2,1.4],fs:[30,35]});
    expect(r.warnings.join(" ")).not.toMatch(/collar without intervals/);
  });

  it("converts GEF positions from RD to the project's system, and leaves out CPTs of another site",()=>{
    // A CPT 30 m east of an Antwerp borehole, in RD New coordinates as a Dutch GEF file gives them.
    const b=antwerpProject.boreholes[0],lambert=findCrs("EPSG:31370")!,rd=findCrs("EPSG:28992")!;
    const g=toGeographic(lambert,b.x+30,b.y),p=toProjected(rd,g.lon,g.lat);
    const file=GEF.replace("#XYID= 31000, 62000.00, 442000.00",`#XYID= 31000, ${p.x.toFixed(3)}, ${p.y.toFixed(3)}`);
    const r=importFiles([{name:"a.gef",text:file}],antwerpProject);
    expect(r.project.cpts![0].x).toBeCloseTo(b.x+30,2);
    expect(r.project.cpts![0].y).toBeCloseTo(b.y,2);
    expect(r.warnings).toContain("1 CPT position converted from Amersfoort / RD New to BD72 / Belgian Lambert 72");
    // The same file at its own position, near Rotterdam, is about 90 km from the Antwerp boreholes.
    expect(()=>importFiles([{name:"r.gef",text:GEF}],antwerpProject)).toThrow(/None of the CPTs lies near the boreholes of Antwerp/);
    // A file that cannot be read says why; next to one that can, it is named in the notes.
    const bore=gef("#REPORTCODE= GEF-BORE-Report, 1, 0, 0","0;1\n");
    expect(()=>importFiles([{name:"b.gef",text:bore}],rotterdamProject)).toThrow(/b\.gef: a GEF borehole log/);
    expect(importFiles([{name:"b.gef",text:bore},{name:"a.gef",text:GEF}],rotterdamProject).warnings.join(" ")).toMatch(/b\.gef: a GEF borehole log/);
  });

  it("names a second CPT of one name apart, replaces a CPT read again, and reads DOV and BRO files",()=>{
    const near=GEF.replace("62000.00, 442000.00","62100.00, 442100.00");
    const r=importFiles([{name:"a.gef",text:GEF},{name:"b.gef",text:near}],rotterdamProject);
    const added=r.project.cpts!.slice(-2).map(c=>c.id);
    expect(added).toEqual(["CPT-07","CPT-07 (2)"]);
    const again=importFiles([{name:"a.gef",text:GEF}],r.project);
    expect(again.project.cpts!.filter(c=>c.id==="CPT-07").length).toBe(1);
    expect(again.warnings.join(" ")).toMatch(/CPTs read again replace the earlier ones: CPT-07/);
    const both=importFiles([{name:"x.xml",text:BRO}],rotterdamProject);
    expect(both.project.cpts!.at(-1)!.id).toBe("CPT000000099999");
    const dov=importFiles([{name:"d.xml",text:DOV.replace("151000.00 212000.00",`${antwerpProject.boreholes[0].x} ${antwerpProject.boreholes[0].y}`)}],antwerpProject);
    expect(dov.project.cpts!.at(-1)).toMatchObject({id:"GEO-15/133-S54",x:antwerpProject.boreholes[0].x});
  });

  it("reads CPTs from AGS4 with the boreholes, and alone into the project shown",()=>{
    const ags=[
      '"GROUP","PROJ"','"HEADING","PROJ_ID","PROJ_NAME"','"UNIT","",""','"TYPE","ID","X"','"DATA","P1","Riverside test"','',
      '"GROUP","LOCA"','"HEADING","LOCA_ID","LOCA_TYPE","LOCA_NATE","LOCA_NATN","LOCA_GREF","LOCA_GL","LOCA_FDEP"','"UNIT","","","m","m","","m","m"','"TYPE","ID","PA","2DP","2DP","PA","2DP","2DP"',
      '"DATA","BH1","CP","523145.00","178456.00","OSGB","21.50","15.00"','"DATA","BH2","CP","523190.00","178460.00","OSGB","21.10","12.00"','"DATA","BH4","CP","523170.00","178520.00","OSGB","22.00","9.00"','"DATA","CPT1","CPT","523165.00","178470.00","OSGB","21.30","8.00"','',
      '"GROUP","GEOL"','"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC","GEOL_GEOL"','"UNIT","","m","m","",""','"TYPE","ID","2DP","2DP","X","PA"',
      '"DATA","BH1","0.00","9.50","Stiff grey CLAY","LC"','"DATA","BH1","9.50","15.00","Dense SAND","LMB"','"DATA","BH2","0.00","8.00","Stiff grey CLAY","LC"','"DATA","BH2","8.00","12.00","Dense SAND","LMB"','"DATA","BH4","0.00","9.00","Stiff CLAY","LC"','',
      '"GROUP","SCPG"','"HEADING","LOCA_ID","SCPG_TESN","SCPG_TYPE"','"UNIT","","",""','"TYPE","ID","X","PA"','"DATA","CPT1","1","CPTU"','',
      '"GROUP","SCPT"','"HEADING","LOCA_ID","SCPG_TESN","SCPT_DPTH","SCPT_RES","SCPT_FRES","SCPT_PWP2","SCPT_FRR"','"UNIT","","","m","MN/m2","kN/m2","kN/m2","%"','"TYPE","ID","X","2DP","3DP","1DP","1DP","2DP"',
      '"DATA","CPT1","1","1.00","0.800","20.0","30.0","2.50"','"DATA","CPT1","1","5.00","15.000","90.0","40.0","0.60"'
    ].join("\r\n");
    const r=importFiles([{name:"site.ags",text:ags}]);
    expect(r.project.boreholes.map(b=>b.id)).toEqual(["BH1","BH2","BH4"]);
    expect(r.project.cpts).toEqual([{id:"CPT1",x:523165,y:178470,z:21.3,depth:[1,5],qc:[0.8,15],fs:[20,90],u2:[30,40],rf:[2.5,0.6]}]);
    expect(r.warnings.join(" ")).not.toMatch(/CPT1: collar without intervals/);
    // CPTs alone, in MPa as AGS 4.1 gives them, join the project shown.
    const alone=ags.split("\r\n").filter(l=>!/^"(DATA|HEADING|UNIT|TYPE|GROUP)","(BH|GEOL|LOCA_ID","GEOL)/.test(l)||/"GROUP","(?!GEOL)/.test(l)).join("\r\n")
      .replace('"UNIT","","","m","MN/m2","kN/m2","kN/m2","%"','"UNIT","","","m","MPa","MPa","MPa","%"').replace('"0.800","20.0","30.0"','"0.800","0.020","0.030"').replace('"15.000","90.0","40.0"','"15.000","0.090","0.040"');
    expect(alone).not.toMatch(/"GEOL"/);
    const added=importFiles([{name:"cpt.ags",text:alone}],r.project);
    expect(added.cpts).toEqual(["CPT1"]);
    expect(added.project.cpts![0]).toMatchObject({fs:[20,90],u2:[30,40]});
  });

  it("keeps CPTs through the project file, the CPT table and the input tables",()=>{
    const p=importFiles([cptTable(readings("C1",50,50,10)+"\n"+readings("C2",20,80,"").replace(/,1,50,40$/gm,",,50,40"))],layered).project;
    const back=importFiles([{name:"p.json",text:toProjectJson(p)}]).project;
    expect(back.cpts!.length).toBe(2);
    expect(back.cpts![0]).toEqual(p.cpts![0]);
    expect(Number.isNaN(back.cpts![1].z)).toBe(true);
    expect(toProjectJson(p)).toMatch(/"qc":\[1,1,1,/);
    const csv=toCptCsv(p);
    expect(csv.split("\n")[0]).toBe("cpt_id,x,y,z,depth (m),elevation (m),qc (MPa),fs (kPa),u2 (kPa),Rf (%)");
    const again=importFiles([{name:"cpts.csv",text:csv}],layered).project.cpts!;
    expect(again[0].qc).toEqual(p.cpts![0].qc);
    expect(again[0].fs).toEqual(p.cpts![0].fs);
    expect(again[0].rf![0]).toBeCloseTo(5,9);
    const kept=projectFromTables(tablesFromProject(p),p);
    expect(kept.project.cpts).toBe(p.cpts);
  });
});

describe("CPTs on the model",()=>{
  const p=importFiles([cptTable(readings("C1",50,50,10)+"\n"+readings("C2",200,50,""))],layered).project;
  const m=buildGeologicalModel(p);

  it("starts a CPT without a level at the model's ground, and leaves out one that cannot be placed",()=>{
    expect(m.cpts.map(c=>c.id)).toEqual(["C1"]);
    expect(m.warnings.join(" ")).toMatch(/C2: no start level, and outside the model; CPT not shown/);
    const grounded=buildGeologicalModel({...p,cpts:[{...p.cpts![0],z:NaN}]});
    expect(grounded.cpts[0].z).toBeCloseTo(10,9);
    expect(grounded.warnings.join(" ")).toMatch(/CPTs without a start level start at the model's ground: C1 \(10 m\)/);
  });

  it("projects CPTs onto straight sections and alignments",()=>{
    const s=computeSection(m,{azimuth:90,offset:0},20);
    expect(s.cpts).toEqual([{index:0,s:expect.closeTo(0,9),offset:expect.closeTo(0,9),top:10,bottom:-8}]);
    expect(computeSection(m,{azimuth:90,offset:30},20).cpts).toEqual([]);
    const a=alignmentSection(m,{name:"L",points:[{x:0,y:40},{x:100,y:40}],start:1000},20);
    expect(a.cpts[0]).toMatchObject({index:0,s:expect.closeTo(1050,9),offset:expect.closeTo(-10,9)});
  });

  it("interpolates qc, fs, Rf and u2 within units from the CPT readings",()=>{
    expect(availableFields(m).filter(f=>/CPT/.test(f.label)).map(f=>f.key)).toEqual(["qc","fs","Rf","u2"]);
    const s=computeSection(m,{azimuth:90,offset:0},20),qc=sectionField(m,s,"qc")!;
    expect(qc.at(0,8)).toBeCloseTo(1,9);
    expect(qc.at(0,-2)).toBeCloseTo(10,9);
    expect(qc.at(-40,5)).toBeCloseTo(10,9);
    // Readings every 0.1 m down to 18 m: 36 bins of 0.5 m, and the last reading in a bin of its own.
    expect(qc.notes.join(" ")).toMatch(/37 means of the readings over 0.5 m in 1 CPT/);
    expect(sectionField(m,s,"Rf")!.at(0,-2)).toBeCloseTo(0.8,9);
    expect(sectionField(m,s,"Rf")!.notes.join(" ")).toMatch(/Rf = fs\/qc/);
  });

  it("gives qc at the design levels and the nearest CPT in the table by chainage",()=>{
    const line={name:"T",points:[{x:0,y:40},{x:100,y:40}],start:0,design:[{chainage:0,top:7,bottom:3},{chainage:100,top:7,bottom:3}]};
    const s=alignmentSection(m,line,20),rows=chainageTable(m,s,50);
    expect(rows.map(r=>[r.chainage,r.qcTop,r.qcBottom])).toEqual([[expect.closeTo(0,9),expect.closeTo(1,6),expect.closeTo(10,6)],[50,expect.closeTo(1,6),expect.closeTo(10,6)],[100,expect.closeTo(1,6),expect.closeTo(10,6)]]);
    expect(rows[1].cpt).toEqual({id:"C1",distance:expect.closeTo(10,9)});
    const csv=chainageCsv(m,s,50).split("\n");
    expect(csv[0]).toMatch(/unit_at_invert,qc_at_crown_MPa,qc_at_invert_MPa,.*nearest_cpt,nearest_cpt_distance_m/);
    expect(csv[2]).toMatch(/,1,10,.*,C1,10,/);
  });

  it("draws CPTs on the section, in their log, and in the report",()=>{
    const s=computeSection(m,{azimuth:90,offset:0},20);
    const svg=sectionSvg(m,s,{width:900,height:500,theme:"light",legend:true,buffer:20});
    expect(svg).toContain("C1: CPT, 0 m right of the section; final depth 18 m");
    expect(svg).toContain("CPTs: qc 0–10 MPa to the right of each test, friction ratio Rf 0–10 % to the left");
    expect((svg.match(/<path d="M/g)??[]).length).toBe(4);
    const log=cptLogSvg(m.cpts[0],{width:220,height:200,marker:5,units:[{top:10,bottom:6,color:"#9c7a5b",name:"Clay"},{top:6,bottom:-10,color:"#d9b871",name:"Sand"}]});
    expect(log).toContain("qc 0–10 MPa");
    expect(log).toContain("<title>Clay</title>");
    const html=reportHtml(m,s,{paper:"A3",date:"2026-10-15",version:"0.15.0",credits:[],notes:[],sectionBuffer:20,ve:1});
    expect(html).toContain("<h2>Cone penetration tests</h2>");
    expect(html).toContain("<th>CPTs</th><td>1</td>");
    expect(html).toMatch(/Clay<\/td><td class="num">1<\/td><td class="num">1\.00 <span class="muted">\(1\.00–1\.00\)/);
  });
});

describe("the Maasvlakte CPTs",()=>{
  it("are 26 BRO CPTs in RD New, by depth, in the site's rectangle",()=>{
    const cpts=rotterdamProject.cpts!;
    expect(cpts.length).toBe(26);
    for(const c of cpts){
      expect(c.id).toMatch(/^CPT\d{12}$/);
      expect(c.x>60800&&c.x<64700&&c.y>440500&&c.y<443950).toBe(true);
      expect(cptDepth(c)).toBeGreaterThanOrEqual(30);
      for(let i=1;i<c.depth.length;i++)expect(c.depth[i]).toBeGreaterThan(c.depth[i-1]);
      expect(c.qc.filter(Number.isFinite).length/c.qc.length).toBeGreaterThan(0.9);
      expect(c.date!>="2018").toBe(true);
    }
    expect(buildGeologicalModel(rotterdamProject).cpts.length).toBe(26);
  });
});
