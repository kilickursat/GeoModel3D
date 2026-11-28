import {describe,it,expect} from "vitest";
import {dutchXml} from "./fixtures/bro/synthetic";
import {collars,formal,descriptions} from "./fixtures/dov/synthetic";
import {readBroXml,isBroXml,soilName} from "../src/broXml";
import {readDovXml,isDovXml,stratigraphicName,formationOf} from "../src/dovXml";
import {importFiles} from "../src/io";
import {buildGeologicalModel} from "../src/model";
import {toGeographic,findCrs} from "../src/crs";
import {antwerpProject,rotterdamProject,deepleadsProject} from "../src/geology";

describe("Dutch BRO geotechnical boreholes",()=>{
  it("writes soil names English first, principal soil leading",()=>{
    expect(soilName("zwakSiltigZandMetGrind")).toBe("Sand, slightly silty, with gravel (zwak siltig zand met grind)");
    expect(soilName("sterkZandigeKlei")).toBe("Clay, strongly sandy (sterk zandige klei)");
    expect(soilName("kleiigVeen")).toBe("Peat, clayey (kleiig veen)");
    expect(soilName("zand")).toBe("Sand (zand)");
  });

  it("reads the position, levels, layers, groundwater and laboratory tests",()=>{
    const f=dutchXml[0];
    expect(isBroXml(f.text)).toBe(true);
    const [log]=readBroXml(f.text,f.name);
    expect(log).toMatchObject({id:"FICTION-NL-A",x:155000,y:463000,z:-2.75,datum:"NAP",depth:6.5});
    // The standardized ETRS89 position agrees with the RD coordinates to the centimetre.
    const g=toGeographic(findCrs("EPSG:28992")!,log.x,log.y);
    expect(Math.abs(g.lat-log.lat)*111e3).toBeLessThan(0.5);
    expect(log.intervals[0]).toEqual({from:0,to:2.5,name:"Clay (klei)"});
    expect(log.tests.find(t=>t.property==="w")).toEqual({depth:1.4,to:1.7,property:"w",value:34.2});
    expect(log.tests.filter(t=>t.property==="LL").map(t=>t.value)).toEqual([45,48]);
    expect(log.tests.find(t=>t.property==="gamma")?.value).toBeCloseTo(1.7*9.80665,4);
    // Water contents of the liquid-limit points are not water contents of the sample.
    expect(log.tests.filter(t=>t.property==="w").length).toBe(1);
    const [dry]=readBroXml(dutchXml[1].text,"x");
    expect(dry.water).toBe(1.8);
    expect(dry.intervals[0].name).toBe("Made ground: Sand (zand)");
  });

  it("imports into RD New with NAP heights, grouping the soils by principal soil",()=>{
    const {project,warnings}=importFiles(dutchXml);
    expect(project.crsCode).toBe("EPSG:28992");
    expect(project.units.map(u=>u.id)).toEqual(["Made ground","Clay","Sand"]);
    expect(project.boreholes.find(b=>b.id==="FICTION-NL-B")!.water).toEqual([{depth:1.8}]);
    expect(project.boreholes.find(b=>b.id==="FICTION-NL-A")!.tests!.length).toBe(9);
    expect(project.source).toMatch(/BRO/);
    expect(warnings).toContain("Elevations are in metres NAP (Normaal Amsterdams Peil)");
    const bed=importFiles([{name:"bed.xml",text:dutchXml[0].text.replace(">maaiveld<",">waterbodem<")}]);
    expect(bed.warnings).toContain("FICTION-NL-A: levels are from the water bottom, not the ground surface");
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
    const b=collars[0],i=formal[0];
    expect(isDovXml(b.text)&&isDovXml(i.text)).toBe(true);
    expect(readDovXml(b.text,b.name).borings).toEqual([{id:"FICTION-BE-A",permkey:"invented-0",file:b.name,x:150000,y:180000,z:12,srs:"urn:ogc:def:crs:EPSG::6190",depth:15,date:"2040-02-15"}]);
    expect(readDovXml(i.text,i.name).interpretations[0]).toMatchObject({kind:"formelestratigrafie",boring:"FICTION-BE-A",date:"2040-04-12",
      layers:[{from:0,to:1.25,code:"A"},{from:1.25,to:7.75,code:"Kd"},{from:7.75,to:15,code:"BcAn",name:"Antwerpen Member (Berchem Formation)"}]});
  });

  it("joins boreholes and formal stratigraphy, modelling formations and keeping members in the names",()=>{
    const {project,warnings}=importFiles([...collars,...formal,descriptions]);
    expect(project.crsCode).toBe("EPSG:31370");
    expect(project.boreholes.map(b=>b.id).sort()).toEqual(["FICTION-BE-A","FICTION-BE-B","FICTION-BE-C"]);
    const first=project.boreholes.find(b=>b.id==="FICTION-BE-A")!;
    expect(first).toMatchObject({x:150000,y:180000,z:12});
    expect(first.intervals.map(i=>[i.unit,i.name])).toEqual([["A","Made ground (anthropogenic)"],["Kd","Kattendijk Formation"],["Bc","Antwerpen Member (Berchem Formation)"]]);
    expect(project.units.find(u=>u.id==="Bc")!.name).toBe("Berchem Formation");
    expect(warnings).toContain("Layers from the formal stratigraphy; also in the files: lithological description");
  });

  it("falls back to described layers, and asks for the borehole files that give the positions",()=>{
    const r=importFiles([collars[0],descriptions]);
    expect(r.project.boreholes[0].intervals.map(i=>i.unit)).toEqual(["Made ground","Sand","Gravel","Clay","Matière inconnue"]);
    expect(r.warnings.join(" ")).toMatch(/no rule assigns to a unit are modelled as units of their own: Matière inconnue \(1\)/);
    expect(()=>importFiles([formal[0]])).toThrow(/no matching borehole files/);
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
    expect(m.warnings.join("\n")).toMatch(/final depth in 27 logs\. BHR000000338403 \(12–30 m\), CPT000000155923 \(32\.07–32\.17 m\)/);
  });
});

describe("reference site in Australia",()=>{
  it("models the Creswick deep leads in MGA zone 54 from NGIS hydrostratigraphy, every log in order",()=>{
    const m=buildGeologicalModel(deepleadsProject);
    expect(deepleadsProject.crsCode).toBe("EPSG:28354");
    expect(m.boreholes.length).toBe(150);
    expect(m.units.map(u=>u.id)).toEqual(["Alluvium","Upper basalt","Interbasalt clay","Lower basalt","Clay","Deep lead","Bedrock"]);
    // Several drilled depths extend below the last classified interval in the source data.
    const tails=deepleadsProject.boreholes.map(b=>({id:b.id,from:Math.max(...b.intervals.map(i=>i.to)),to:b.depth??0}))
      .filter(t=>t.to>t.from+1e-6);
    expect(tails).toHaveLength(47);
    expect(m.warnings).toHaveLength(1);
    expect(m.warnings[0]).toContain("inferred to final depth in 47 logs.");
    for(const t of tails)expect(m.warnings[0]).toContain(`${t.id} (${t.from}–${t.to} m)`);
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
