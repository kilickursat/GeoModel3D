import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {parseXml,textOf,descendants} from "../src/xml";
import {readBoringXml,isBoringXml} from "../src/boringXml";
import {applyUnitRules,japaneseLithologyRules} from "../src/rules";
import {sptN,Borehole} from "../src/geology";
import {importFiles,toProjectJson,decodeText,crsFromName} from "../src/io";

const fixture=(id:string)=>new TextDecoder("shift_jis").decode(readFileSync(new URL(`./fixtures/kunijiban/${id}.xml`,import.meta.url)));

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
    const text=fixture("357875393");
    expect(isBoringXml(text)).toBe(true);
    const log=readBoringXml(text,"357875393.xml");
    expect(log.version).toBe("4.00");
    expect(log.id).toBe("R2-No.1");
    expect(log.datum).toBe("JGD2011");
    expect(log.lon).toBeCloseTo(139+31/60+12.1/3600,9);
    expect(log.lat).toBeCloseTo(35+22/60+24.5/3600,9);
    // The log states a total depth of 9.00 m but describes the ground to 9.37 m: the deeper value is kept, and noted.
    expect([log.z,log.depth,log.angle]).toEqual([25.1,9.37,0]);
    expect(log.intervals.slice(0,2)).toEqual([{from:0,to:0.8,name:"盛土（ローム）"},{from:0.8,to:1.6,name:"シルト質細砂"}]);
    expect(log.intervals.every((iv,k)=>k===0?iv.from===0:iv.from===log.intervals[k-1].to)).toBe(true);
    expect(log.intervals.at(-1)!.to).toBe(9.37);
    expect(log.spt[0]).toEqual({depth:1.15,blows:7,penetration:300});
    expect(log.water[0].depth).toBe(3.15);
    expect(log.notes).toEqual(["intervals reach 9.37 m, below the stated total depth of 9 m"]);
  });

  it("reads a version 2 log, with penetration in centimetres and the file name as id",()=>{
    const log=readBoringXml(fixture("148301107"),"148301107.xml");
    expect(log.version).toBe("2.10");
    expect(log.id).toBe("148301107");
    expect(log.datum).toBe("JGD2000");
    expect(log.z).toBe(65.26);
    expect(log.intervals.length).toBeGreaterThan(3);
    expect(log.spt.length).toBe(47);
    expect(log.spt.every(t=>t.penetration>=10&&t.penetration<=1000)).toBe(true);
    const refusal=log.spt.find(t=>t.penetration<300)!;
    expect(refusal.blows).toBe(50);
    expect(sptN(refusal)).toBeGreaterThan(50);
  });

  it("reads the JGD2000 datum code of version 4",()=>{
    const log=readBoringXml(fixture("509132859"),"509132859.xml");
    expect(log.datum).toBe("JGD2000");
    expect(log.z).toBe(9.17);
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
  const files=["357875393","509132859","148301107"].map(id=>({name:`${id}.xml`,text:fixture(id)}));
  it("places the logs in the national system for their location and keeps descriptions, SPT and water levels",()=>{
    const {project,warnings}=importFiles(files);
    expect(project.crsCode).toBe("EPSG:6677");
    expect(project.crs).toBe("JGD2011 / Japan Plane Rectangular CS IX");
    expect(project.boreholes.length).toBe(3);
    const r2=project.boreholes.find(b=>b.id==="R2-No.1")!;
    // GSI: (35.373472, 139.520028) → X −69463.2814, Y −28467.7100 in zone IX.
    expect(r2.x).toBeCloseTo(-28467.71,1);
    expect(r2.y).toBeCloseTo(-69463.28,1);
    expect(r2.intervals[0]).toEqual({from:0,to:0.8,unit:"Fill and topsoil",name:"盛土（ローム）"});
    expect(r2.spt!.length).toBe(9);
    expect(r2.water![0].depth).toBe(3.15);
    expect(project.rules).toEqual(japaneseLithologyRules);
    expect(warnings.join("\n")).toMatch(/converted from latitude and longitude to JGD2011 \/ Japan Plane Rectangular CS IX \(EPSG:6677\)/);
    expect(warnings.join("\n")).toMatch(/R2-No\.1: intervals reach 9\.37 m/);
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
    const sjis=readFileSync(new URL("./fixtures/kunijiban/357875393.xml",import.meta.url));
    expect(decodeText(sjis)).toContain("R2-No.1");
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

describe("KuniJiban fixtures",()=>{
  it("carry no personal data: engineers' names, registration numbers and telephone numbers are empty",()=>{
    for(const id of ["148301107","357875393","509132859"]){
      const personal=[...fixture(id).matchAll(/<([^<>\s/]*(?:_氏名|登録番号|_TEL|_FAX))>([^<]*)<\/\1>/g)].filter(m=>m[2].trim());
      expect(personal.map(m=>m[1])).toEqual([]);
    }
  });
});
