import {describe,it,expect} from "vitest";
import {japaneseXml} from "./fixtures/kunijiban/synthetic";
import {parseXml,textOf,descendants} from "../src/xml";
import {readBoringXml,isBoringXml} from "../src/boringXml";
import {applyUnitRules,japaneseLithologyRules} from "../src/rules";
import {sptN,Borehole} from "../src/geology";
import {importFiles,toProjectJson,decodeText,crsFromName} from "../src/io";


describe("reading XML",()=>{
  it("reads elements, attributes, entities and CDATA, and skips declarations, doctypes and comments",()=>{
    const doc=parseXml(`<?xml version="1.0"?><!DOCTYPE a SYSTEM "a.dtd" [<!ENTITY x "y">]><!-- note --><a v="1 &gt; 0"><b>x &amp; y &#26085;</b><c/><b><![CDATA[<raw>]]></b></a>`);
    const a=doc.children[0];
    expect(a.tag).toBe("a");
    expect(a.attrs.v).toBe("1 > 0");
    expect(descendants(a,"b").map(b=>b.text)).toEqual(["x & y 日","<raw>"]);
    expect(a.children.map(c=>c.tag)).toEqual(["b","c","b"]);
    expect(textOf(a,"missing")).toBe("");
  });
});

describe("Japanese borehole logs (KuniJiban)",()=>{
  it("reads a version 4 log: position, elevation, intervals, SPT and water level",()=>{
    const text=japaneseXml[0].text;
    expect(isBoringXml(text)).toBe(true);
    const log=readBoringXml(text,japaneseXml[0].name);
    expect(log.version).toBe("4.00");
    expect(log.id).toBe("FICTION-4");
    expect(log.datum).toBe("JGD2011");
    expect(log.lon).toBeCloseTo(139+50/60,9);
    expect(log.lat).toBeCloseTo(36,9);
    // The log states a total depth of 7.00 m but describes the ground to 7.5 m: the deeper value is kept, and noted.
    expect([log.z,log.depth,log.angle]).toEqual([37,7.5,0]);
    expect(log.intervals.slice(0,2)).toEqual([{from:0,to:1.25,name:"埋土"},{from:1.25,to:3.75,name:"中砂"}]);
    expect(log.intervals.every((iv,k)=>k===0?iv.from===0:iv.from===log.intervals[k-1].to)).toBe(true);
    expect(log.intervals.at(-1)!.to).toBe(7.5);
    expect(log.spt[0]).toEqual({depth:2,blows:11,penetration:300});
    expect(log.water[0].depth).toBe(2.25);
    expect(log.notes).toEqual(["intervals reach 7.5 m, below the stated total depth of 7 m"]);
  });

  it("reads a version 2 log, with penetration in centimetres and the file name as id",()=>{
    const log=readBoringXml(japaneseXml[2].text,japaneseXml[2].name);
    expect(log.version).toBe("2.10");
    expect(log.id).toBe("synthetic-v2");
    expect(log.datum).toBe("JGD2000");
    expect(log.z).toBe(33);
    expect(log.intervals.length).toBeGreaterThan(3);
    expect(log.spt.length).toBe(2);
    expect(log.spt.every(t=>t.penetration>=10&&t.penetration<=1000)).toBe(true);
    const refusal=log.spt.find(t=>t.penetration<300)!;
    expect(refusal.blows).toBe(50);
    expect(sptN(refusal)).toBeGreaterThan(50);
  });

  it("reads the JGD2000 datum code of version 4",()=>{
    const log=readBoringXml(japaneseXml[1].text,japaneseXml[1].name);
    expect(log.datum).toBe("JGD2000");
    expect(log.z).toBe(41);
    expect(log.water.length).toBe(2);
  });

  it("converts short SPT tests to N-values over 300 mm",()=>{
    expect(sptN({depth:1,blows:7,penetration:300})).toBe(7);
    expect(sptN({depth:1,blows:50,penetration:120})).toBe(125);
    expect(sptN({depth:1,blows:0,penetration:600})).toBe(0);
  });
});

describe("units from logged descriptions",()=>{
  const hole:Borehole={id:"H",x:0,y:0,z:10,intervals:[
    {from:0,to:1,unit:"",name:"盛土"},{from:1,to:4,unit:"",name:"細砂"},{from:4,to:8,unit:"",name:"細砂"},{from:8,to:9,unit:"",name:"謎の土"}],
    spt:[{depth:2,blows:8,penetration:300},{depth:5,blows:50,penetration:150},{depth:6,blows:50,penetration:100}]};
  it("takes the first rule that matches the description and the median N-value in the interval",()=>{
    const {boreholes,unmatched}=applyUnitRules([hole],[
      {match:"盛土",unit:"Fill"},{match:"砂",minN:50,unit:"Bedrock"},{match:"砂",unit:"Alluvium"}]);
    expect(boreholes[0].intervals.map(i=>i.unit)).toEqual(["Fill","Alluvium","Bedrock","謎の土"]);
    expect([...unmatched]).toEqual([["謎の土",1]]);
  });
  it("can restrict a rule to elevations",()=>{
    const {boreholes}=applyUnitRules([hole],[{match:"砂",maxZ:8,unit:"Low"},{match:".",unit:"Other"}]);
    // Tops at 10, 9, 6 and 2 m.
    expect(boreholes[0].intervals.map(i=>i.unit)).toEqual(["Other","Other","Low","Other"]);
  });
  it("groups Japanese soil names by their principal material",()=>{
    const names=["盛土（ローム）","有機質シルト","火山灰質粘土","固結シルト","砂礫","シルト混じり細砂","砂質シルト","礫混じり砂","泥岩"];
    const holes:Borehole[]=[{id:"H",x:0,y:0,z:0,intervals:names.map((name,k)=>({from:k,to:k+1,unit:"",name}))}];
    expect(applyUnitRules(holes,japaneseLithologyRules).boreholes[0].intervals.map(i=>i.unit)).toEqual(
      ["Fill and topsoil","Organic soil","Volcanic ash soil","Rock and cemented soil","Gravel","Sand","Clay and silt","Sand","Rock and cemented soil"]);
  });
});

describe("importing borehole logs into a project",()=>{
  const files=japaneseXml;
  it("places the logs in the national system for their location and keeps descriptions, SPT and water levels",()=>{
    const {project,warnings}=importFiles(files);
    expect(project.crsCode).toBe("EPSG:6677");
    expect(project.crs).toBe("JGD2011 / Japan Plane Rectangular CS IX");
    expect(project.boreholes.length).toBe(3);
    const first=project.boreholes.find(b=>b.id==="FICTION-4")!;
    // The invented first collar is at the defined natural origin of Japan zone IX.
    expect(first.x).toBeCloseTo(0,3);
    expect(first.y).toBeCloseTo(0,3);
    expect(first.intervals[0]).toEqual({from:0,to:1.25,unit:"Fill and topsoil",name:"埋土"});
    expect(first.spt!.length).toBe(2);
    expect(first.water![0].depth).toBe(2.25);
    expect(project.rules).toEqual(japaneseLithologyRules);
    expect(warnings.join("\n")).toMatch(/converted from latitude and longitude to JGD2011 \/ Japan Plane Rectangular CS IX \(EPSG:6677\)/);
    expect(warnings.join("\n")).toMatch(/FICTION-4: intervals reach 7\.5 m/);
    expect(warnings.join("\n")).toMatch(/JGD2000, taken as JGD2011/);
  });
  it("keeps everything through a project file",()=>{
    const {project}=importFiles(files);
    const again=importFiles([{name:"p.json",text:toProjectJson(project)}]).project;
    expect(again.crsCode).toBe("EPSG:6677");
    expect(again.rules).toEqual(project.rules);
    expect(again.boreholes).toEqual(project.boreholes);
    expect(again.units.map(u=>u.id)).toEqual(project.units.map(u=>u.id));
  });
  it("decodes UTF-8, UTF-16 and Shift_JIS files",()=>{
    const preamble=new TextEncoder().encode('<?xml version="1.0" encoding="Shift_JIS"?><soil>');
    const sjis=Uint8Array.from([...preamble,0x90,0xb7,0x93,0x79,...new TextEncoder().encode("</soil>")]);
    expect(decodeText(sjis)).toContain("<soil>盛土</soil>");
    expect(decodeText(new TextEncoder().encode("hole_id,x\nB1,5"))).toBe("hole_id,x\nB1,5");
    expect(decodeText(Uint8Array.from([0xff,0xfe,0x41,0x00,0x42,0x00]))).toBe("AB");
    // "盛土" in Shift_JIS, without any declaration (as a Japanese spreadsheet saves CSV).
    expect(decodeText(Uint8Array.from([0x90,0xb7,0x93,0x79]))).toBe("盛土");
  });
  it("converts latitude and longitude columns of a CSV table",()=>{
    const csv="hole_id,lat,lon,z,from,to,unit\nA,51.5,-0.13,10,0,5,Clay\nB,51.51,-0.12,11,0,6,Clay\nC,51.505,-0.10,12,0,4,Clay\n";
    const {project}=importFiles([{name:"london.csv",text:csv}]);
    expect(project.crsCode).toBe("EPSG:27700");
    expect(project.boreholes[0].x).toBeGreaterThan(520000);
    expect(project.boreholes[0].x).toBeLessThan(540000);
    expect(project.boreholes[0].lat).toBe(51.5);
  });
  it("recognises coordinate system names",()=>{
    expect(crsFromName("EPSG:6677")!.code).toBe("EPSG:6677");
    expect(crsFromName("British National Grid")!.code).toBe("EPSG:27700");
    expect(crsFromName("HK1980 Grid")!.code).toBe("EPSG:2326");
    expect(crsFromName("my site grid")).toBeUndefined();
  });
});
