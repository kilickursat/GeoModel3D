import {describe,it,expect} from "vitest";
import {readFileSync,readdirSync} from "node:fs";
import {readBroXml,isBroXml,soilName} from "../src/broXml";
import {readDovXml,isDovXml,stratigraphicName,formationOf} from "../src/dovXml";
import {importFiles} from "../src/io";
import {buildGeologicalModel} from "../src/model";
import {toGeographic,findCrs} from "../src/crs";
import {antwerpProject,rotterdamProject,deepleadsProject} from "../src/geology";

const fixture=(dir:string,name:string)=>({name,text:readFileSync(new URL(`./fixtures/${dir}/${name}`,import.meta.url),"utf8")});
const all=(dir:string)=>readdirSync(new URL(`./fixtures/${dir}/`,import.meta.url)).filter(f=>f.endsWith(".xml")).map(f=>fixture(dir,f));

describe("Dutch BRO geotechnical boreholes",()=>{
  it("writes soil names English first, principal soil leading",()=>{
    expect(soilName("zwakSiltigZandMetGrind")).toBe("Sand, slightly silty, with gravel (zwak siltig zand met grind)");
    expect(soilName("sterkZandigeKlei")).toBe("Clay, strongly sandy (sterk zandige klei)");
    expect(soilName("kleiigVeen")).toBe("Peat, clayey (kleiig veen)");
    expect(soilName("zand")).toBe("Sand (zand)");
  });

  it("reads the position, levels, layers, groundwater and laboratory tests",()=>{
    const f=fixture("bro","BHR000000470183.xml");
    expect(isBroXml(f.text)).toBe(true);
    const [log]=readBroXml(f.text,f.name);
    expect(log).toMatchObject({id:"BHR000000470183",x:63841.23,y:442453.32,z:-20.55,datum:"NAP",depth:10});
    // The standardized ETRS89 position agrees with the RD coordinates to the centimetre.
    const g=toGeographic(findCrs("EPSG:28992")!,log.x,log.y);
    expect(Math.abs(g.lat-log.lat)*111e3).toBeLessThan(0.5);
    expect(log.intervals[0]).toEqual({from:0,to:1,name:"Clay (klei)"});
    expect(log.tests.find(t=>t.property==="w")).toEqual({depth:0.97,to:1.04,property:"w",value:166.4});
    expect(log.tests.filter(t=>t.property==="LL").length).toBe(2);
    // Water contents of the liquid-limit points are not water contents of the sample.
    expect(log.tests.filter(t=>t.property==="w").length).toBeLessThan(15);
    const [dry]=readBroXml(fixture("bro","BHR000000361914.xml").text,"x");
    expect(dry.water).toBe(3.3);
    expect(dry.intervals[0].name).toBe("Made ground: Sand (zand)");
  });

  it("imports into RD New with NAP heights, grouping the soils by principal soil",()=>{
    const {project,warnings}=importFiles(all("bro"));
    expect(project.crsCode).toBe("EPSG:28992");
    expect(project.units.map(u=>u.id)).toEqual(["Made ground","Clay","Sand"]);
    expect(project.boreholes.find(b=>b.id==="BHR000000361914")!.water).toEqual([{depth:3.3}]);
    expect(project.boreholes.find(b=>b.id==="BHR000000470183")!.tests!.length).toBeGreaterThan(10);
    expect(project.source).toMatch(/BRO/);
    expect(warnings).toContain("Elevations are in metres NAP (Normaal Amsterdams Peil)");
    const bed=importFiles([{name:"bed.xml",text:fixture("bro","BHR000000470183.xml").text.replace(">maaiveld<",">waterbodem<")}]);
    expect(bed.warnings).toContain("BHR000000470183: levels are from the water bottom, not the ground surface");
  });
});

describe("Flemish DOV boreholes and interpretations",()=>{
  it("names Flemish lithostratigraphic units in English and finds the formation of a member",()=>{
    expect(stratigraphicName("Bm")).toBe("Boom Formation");
    expect(stratigraphicName("BcAn")).toBe("Antwerpen Member (Berchem Formation)");
    expect(stratigraphicName("Q")).toBe("Quaternary deposits");
    expect(formationOf("BcEd")).toBe("Bc");
    expect(formationOf("Bm")).toBe("Bm");
  });

  it("reads boreholes and interpretations",()=>{
    const b=fixture("dov","boring-1948-120680.xml"),i=fixture("dov","interpretatie-2023-372255.xml");
    expect(isDovXml(b.text)&&isDovXml(i.text)).toBe(true);
    expect(readDovXml(b.text,b.name).borings).toEqual([{id:"kb15d28w-B292",permkey:"1948-120680",file:b.name,x:152026,y:212719,z:7,srs:"urn:ogc:def:crs:EPSG::6190",depth:20,date:"1948-04-19"}]);
    expect(readDovXml(i.text,i.name).interpretations[0]).toMatchObject({kind:"formelestratigrafie",boring:"kb15d28w-B292",date:"2023-04-14",
      layers:[{from:0,to:5.5,code:"A"},{from:5.5,to:10.5,code:"Kd"},{from:10.5,to:20,code:"BcAn",name:"Antwerpen Member (Berchem Formation)"}]});
  });

  it("joins boreholes and formal stratigraphy, modelling formations and keeping members in the names",()=>{
    const {project,warnings}=importFiles(all("dov"));
    expect(project.crsCode).toBe("EPSG:31370");
    expect(project.boreholes.map(b=>b.id).sort()).toEqual(["kb15d28w-B100","kb15d28w-B187","kb15d28w-B292"]);
    const b292=project.boreholes.find(b=>b.id==="kb15d28w-B292")!;
    expect(b292).toMatchObject({x:152026,y:212719,z:7});
    expect(b292.intervals.map(i=>[i.unit,i.name])).toEqual([["A","Made ground (anthropogenic)"],["Kd","Kattendijk Formation"],["Bc","Antwerpen Member (Berchem Formation)"]]);
    expect(project.units.find(u=>u.id==="Bc")!.name).toBe("Berchem Formation");
    expect(warnings).toContain("Layers from the formal stratigraphy; also in the files: lithological description");
  });

  it("falls back to described layers, and asks for the borehole files that give the positions",()=>{
    const r=importFiles([fixture("dov","boring-2016-147736.xml"),fixture("dov","interpretatie-2016-252597.xml")]);
    // French descriptions: "Terrain rapporté", "Sable jaune", "Banc de pierres", "Argile verte très dure"…
    expect(r.project.boreholes[0].intervals.map(i=>i.unit)).toEqual(["Made ground","Sand","Sand","Sand","Sand","Sand","Sand","Gravel","Clay","Couche de pyrite","Clay","Gravel","Clay","Gravel","Clay","Sand"]);
    expect(r.warnings.join(" ")).toMatch(/no rule assigns to a unit are modelled as units of their own: Couche de pyrite \(1\)/);
    expect(()=>importFiles([fixture("dov","interpretatie-2023-372255.xml")])).toThrow(/no matching borehole files/);
  });
});

describe("reference sites in Belgium and the Netherlands",()=>{
  it("models Antwerp in Belgian Lambert 72 with few notes",()=>{
    const m=buildGeologicalModel(antwerpProject);
    expect(antwerpProject.crsCode).toBe("EPSG:31370");
    expect(m.boreholes.length).toBeGreaterThan(150);
    expect(m.units.map(u=>u.id)).toEqual(["Made ground","Quaternary","Kattendijk","Berchem","Boom"]);
    expect(m.warnings.length).toBeLessThan(30);
    expect(m.warnings.some(w=>/out of stratigraphic order/.test(w))).toBe(false);
  });
  it("models Maasvlakte 2 in RD New, with laboratory tests and groundwater",()=>{
    const m=buildGeologicalModel(rotterdamProject);
    expect(rotterdamProject.crsCode).toBe("EPSG:28992");
    expect(m.units.map(u=>u.id)).toEqual(["Sand","Holocene clay","Pleistocene"]);
    expect(rotterdamProject.boreholes.reduce((n,b)=>n+(b.tests?.length??0),0)).toBeGreaterThan(3000);
    expect(m.water!.source).toMatch(/water levels logged in \d+ of 100 boreholes/);
    expect(m.warnings.length).toBeLessThan(5);
  });
});

describe("reference site in Australia",()=>{
  it("models the Creswick deep leads in MGA zone 54 from NGIS hydrostratigraphy, every log in order",()=>{
    const m=buildGeologicalModel(deepleadsProject);
    expect(deepleadsProject.crsCode).toBe("EPSG:28354");
    expect(m.boreholes.length).toBe(150);
    expect(m.units.map(u=>u.id)).toEqual(["Alluvium","Upper basalt","Interbasalt clay","Lower basalt","Clay","Deep lead","Bedrock"]);
    expect(m.warnings).toEqual([]);
    // Positions: the collars carry their geographic position, inside the MGA zone 54 area of use.
    for(const b of deepleadsProject.boreholes){
      expect(b.lon!).toBeGreaterThan(143.85);expect(b.lon!).toBeLessThan(143.98);
      expect(b.lat!).toBeGreaterThan(-37.41);expect(b.lat!).toBeLessThan(-37.3);
    }
    // No source or licence fields of NGIS are carried: intervals hold only depths, units and names.
    expect(deepleadsProject.boreholes.every(b=>b.intervals.every(i=>Object.keys(i).every(k=>["from","to","unit","name"].includes(k))))).toBe(true);
    expect(deepleadsProject.source).toMatch(/Bureau of Meteorology.*CC BY 3\.0 AU/);
  });
});
