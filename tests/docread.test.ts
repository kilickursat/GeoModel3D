import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {TextLine,textLine,readDocument,readPage,header,ReadLog} from "../src/docread/reconstruct";
import {linesFromItems,PdfTextItem} from "../src/docread/textlines";
import {draftHoles,checkDraft,draftTables,pageRanges,DraftHole} from "../src/docread/draft";
import {projectFromTables} from "../src/tables";
import {applyUnitRules,lithologyRules} from "../src/rules";

const DIR="tests/fixtures/docread/";
interface Truth { id:string; ground:number; x:number; y:number; water?:number; final?:number; layers:Array<{from:number;to:number;description:string}> }
const json=<T>(f:string):T=>JSON.parse(readFileSync(DIR+f,"utf8"));
const norm=(s:string)=>s.toLowerCase().replace(/\s+/g," ").replace(/\s*([,.:;()])\s*/g,"$1").trim();
// Boundaries within 5 cm, boundaries the truth hasn't (beyond 15 cm), and layers with the same depths and description.
function score(log:ReadLog,truth:Truth){
  const have=log.layers.map(l=>l.to),want=truth.layers.map(l=>l.to);
  return {
    boundaries:want.filter(v=>have.some(w=>Math.abs(w-v)<=0.05)).length,
    extra:have.filter(v=>!want.some(w=>Math.abs(w-v)<=0.15)).length,
    descriptions:truth.layers.filter(t=>log.layers.some(l=>Math.abs(l.from-t.from)<0.05&&Math.abs(l.to-t.to)<0.05&&norm(l.description)===norm(t.description))).length,
    layers:truth.layers.length
  };
}
const ocrPage=(name:string)=>{
  const j=json<{width:number;height:number;lines:Array<{text:string;x0:number;y0:number;x1:number;y1:number}>}>(`ocr/${name}.lines.json`);
  return {page:1,width:j.width,height:j.height,lines:j.lines.map(l=>textLine(l.text,l.x0,l.y0,l.x1,l.y1))};
};
// PDF.js 6 uses Promise.withResolvers (Node 22 has it; CI runs Node 22).
const P=Promise as unknown as {withResolvers?:()=>unknown};
P.withResolvers??=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return {promise,resolve,reject}};
async function readPdf(file:string){
  const task=pdfjs.getDocument({data:new Uint8Array(readFileSync(DIR+file)),
    cMapUrl:"node_modules/pdfjs-dist/cmaps/",cMapPacked:true,standardFontDataUrl:"node_modules/pdfjs-dist/standard_fonts/"});
  const doc=await task.promise,pages=[];
  for(let n=1;n<=doc.numPages;n++){
    const page=await doc.getPage(n),vp=page.getViewport({scale:150/72}),text=await page.getTextContent();
    pages.push({page:n,width:vp.width,height:vp.height,lines:linesFromItems(text.items as unknown as PdfTextItem[],vp.transform)});
  }
  await task.destroy();
  return readDocument(pages);
}
// A synthetic drawn log: a depth scale of whole metres at x 40, base depths at x 900, descriptions at x 300.
const L=(text:string,x:number,y:number,w=8*text.length,h=12)=>textLine(text,x,y-h/2,x+w,y+h/2);
const yAt=(d:number)=>200+40*d;
function drawnLog(extra:TextLine[]=[]){
  return [L("Borehole No",40,40),L("BH-7",160,40),L("Ground level",400,40),L("12.30 m",400,60),
    L("DESCRIPTION",300,150),...Array.from({length:11},(_,d)=>L(String(d),40,yAt(d),10)),
    L("1.20",900,yAt(1.2)+8,40),L("4.50",900,yAt(4.5)+8,40),L("9.80",900,yAt(9.8)+8,40),
    L("FILL: sand and gravel",300,yAt(0.5)),L("CLAY: soft, grey",300,yAt(2.5)),L("SAND: dense",300,yAt(7)),...extra];
}

describe("reading a drawn log",()=>{
  it("finds the depth scale, the boundaries, the descriptions and the header",()=>{
    const [log]=readPage(drawnLog(),1000,800);
    expect(log.error).toBeUndefined();
    expect(log.layers.map(l=>[l.from,l.to,l.description])).toEqual([[0,1.2,"FILL: sand and gravel"],[1.2,4.5,"CLAY: soft, grey"],[4.5,9.8,"SAND: dense"]]);
    expect([log.id,log.ground]).toEqual(["BH-7",12.3]);
    // Each layer keeps the lines it was read from: its base depth and its description.
    expect(log.layers[1].src.map(e=>e.text)).toEqual(["4.50","CLAY: soft, grey"]);
  });
  it("reads a scale whose ticks were read as minus signs",()=>{
    const lines=drawnLog().map(e=>/^\d+$/.test(e.text)&&+e.text%2?{...e,text:"-"+e.text}:e);
    expect(readPage(lines,1000,800)[0].layers.map(l=>l.to)).toEqual([1.2,4.5,9.8]);
  });
  it("puts back a decimal point OCR dropped, and flags the depth",()=>{
    const lines=drawnLog().map(e=>e.text==="4.50"?{...e,text:"450"}:e);
    const [log]=readPage(lines,1000,800);
    expect(log.layers.map(l=>l.to)).toEqual([1.2,4.5,9.8]);
    expect(log.flagged).toEqual([4.5]);
    expect(log.layers[1].flagged).toBe(true);
    expect(log.layers[1].why).toBe("read as “450”; the decimal point put back");
  });
  it("keeps the line each header value was read from, and the page of every line",()=>{
    const {logs}=readDocument([{page:3,width:1000,height:800,lines:drawnLog()}]);
    expect([logs[0].src?.id?.text,logs[0].src?.ground?.text,logs[0].src?.id?.page]).toEqual(["BH-7","12.30 m",3]);
    expect(logs[0].layers.flatMap(l=>l.src).every(e=>e.page===3)).toBe(true);
  });
  it("stacks thin layers given by thickness, and deals the titles to the layers in order",()=>{
    const lines=[...drawnLog().filter(e=>!/FILL/.test(e.text)),L("50mm ASPHALT",300,yAt(0.2)),L("250mm AGGREGATE",300,yAt(0.6))]
      .map(e=>e.text==="1.20"?{...e,text:"0.30",cy:yAt(0.3)+8,y0:yAt(0.3)+2,y1:yAt(0.3)+14}:e);
    const [log]=readPage(lines,1000,800);
    expect(log.layers.map(l=>[l.from,l.to,l.description])).toEqual([[0,0.05,"50mm ASPHALT"],[0.05,0.3,"250mm AGGREGATE"],[0.3,4.5,"CLAY: soft, grey"],[4.5,9.8,"SAND: dense"]]);
    expect(log.flagged).toEqual([0.05]);
  });
  it("takes a depth of 0 written at the top of the log for its top, not for a boundary",()=>{
    const [log]=readPage([...drawnLog(),L("0.00",900,yAt(0)+8,40)],1000,800);
    expect(log.layers.map(l=>[l.from,l.to])).toEqual([[0,1.2],[1.2,4.5],[4.5,9.8]]);
  });
  it("links each layer to its own lines where two layers have the same description",()=>{
    const lines=drawnLog().map(e=>/^(CLAY|SAND):/.test(e.text)?{...e,text:"SAND: dense"}:e);
    const [log]=readPage(lines,1000,800);
    expect(log.layers.slice(1).map(l=>[l.description,l.src.filter(e=>/SAND/.test(e.text)).map(e=>Math.round(e.cy))])).toEqual([["SAND: dense",[300]],["SAND: dense",[480]]]);
  });
  it("keeps a line a boundary runs through with the layer above, unless it starts the layer below",()=>{
    // Descriptions with titles: the boundary at 4.50 m runs through "brown, moist", the end of the clay, and the boundary
    // at 9.80 m through the title of the layer below it (by their centres, each would be on the wrong side).
    const lines=[...drawnLog().filter(e=>!/^(FILL|CLAY|SAND):/.test(e.text)),L("Made ground, sandy",300,yAt(0.5)),L("CLAY: soft,",300,yAt(2.5)),
      L("brown, moist",300,yAt(4.5)+3),L("SAND: dense",300,yAt(6)),L("GRAVEL: coarse",300,yAt(9.8)-2),L("10.20",900,yAt(10.2)+8,40),L("10",40,yAt(10),10)];
    const [log]=readPage(lines,1000,800);
    expect(log.layers.map(l=>l.description)).toEqual(["Made ground, sandy","CLAY: soft, brown, moist","SAND: dense","GRAVEL: coarse"]);
  });
  it("gives no log where there is no depth scale",()=>{
    const [log]=readPage([L("This report describes the site investigation.",40,40),L("Borehole BH3 was drilled to 7.5 m.",40,60)],1000,800);
    expect(log.layers).toEqual([]);
    expect(log.error).toBe("no depth scale found");
  });
});

describe("header values",()=>{
  it("reads positions given by easting and northing, also with the labels swapped (UTM)",()=>{
    const line=L("E: 512345, N: 5401234 (UTM 33U)",40,40,300),h=header([L("Project: Main Street",40,20,200),line]);
    expect(h).toMatchObject({x:512345,y:5401234});
    expect([h.src?.x,h.src?.y]).toEqual([line,line]);
    expect(header([L("N 412345.67 E 5701234.56",40,40,300)])).toMatchObject({x:412345.67,y:5701234.56,xyFlag:"N and E read the other way round (UTM)"});
  });
  it("reads latitude and longitude, a dash being no minus sign",()=>{
    expect(header([L("Latitude (N) - 48.2082",40,40,200),L("Longitude(E) - 16.3738",40,60,200)])).toMatchObject({lat:48.2082,lon:16.3738});
  });
  it("reads a Japanese water level below ground, and a table of readings",()=>{
    expect(header([L("孔内水位",40,40,60),L("GL-9.80m",40,60,60)]).water).toBe(9.8);
    const table=[L("Date",40,40,40),L("Water Depth (m)",120,40,120),L("Mar 3, 2024",40,60,80),L("2.4",170,60,30),L("Mar 9, 2024",40,80,80),L("2.6",170,80,30)];
    expect(header(table).water).toBe(2.4);
  });
});

describe("unit rules for real logs",()=>{
  const unit=(name:string)=>applyUnitRules([{id:"b",x:0,y:0,z:0,intervals:[{from:0,to:1,unit:"",name}]}],lithologyRules).boreholes[0].intervals[0].unit;
  it("counts topsoil written in two words and road layers as made ground",()=>{
    for(const n of ["TOP SOIL (100 mm)","200mm AGGREGATE","GRANULAR BASE (250mm): gravelly sand","GRANULAR SUBBASE: sand with gravel"])expect(unit(n)).toBe("Made ground");
  });
  it("takes a rock name only where it comes before the soil",()=>{
    expect(unit("SAND, some silt, trace gravel, trace rock fragments")).toBe("Sand");
    expect(unit("Highly weathered, fractured rock.")).toBe("Rock");
    expect(unit("MUDSTONE, weathered to clay")).toBe("Mudstone and siltstone");
    expect(unit("Firm grey CLAY with sandstone fragments")).toBe("Clay");
  });
});

describe("the review's draft, its checks and the Input data tables",()=>{
  const drafts=()=>draftHoles(0,"site-report.pdf",readDocument([{page:2,width:1000,height:800,lines:drawnLog()}]).logs);
  const hole=(id:string,layers:Array<[string,string]>,extra:Partial<DraftHole["values"]>={}):DraftHole=>({use:true,doc:0,file:"a.pdf",pages:[1],kind:"scale",ocr:false,
    values:{id,x:"100",y:"200",lat:"",lon:"",ground:"10",final:"",water:"",...extra},flags:{},src:{},
    layers:layers.map(([from,to])=>({from,to,unit:"Clay",description:"Clay",autoUnit:false,src:[]}))});
  it("drafts each log with its values, and units by the lithology rules",()=>{
    const [h]=drafts();
    expect(h.values).toMatchObject({id:"BH-7",ground:"12.3",x:"",final:""});
    expect(h.layers.map(l=>[l.from,l.to,l.unit])).toEqual([["0","1.2","Made ground"],["1.2","4.5","Clay"],["4.5","9.8","Sand"]]);
    expect(h.flags).toEqual({});
    expect(h.src.id?.text).toBe("BH-7");
  });
  it("names a log whose ID was not read after its page, and flags it",()=>{
    const [h]=draftHoles(0,"a.pdf",readDocument([{page:5,width:1000,height:800,lines:drawnLog().filter(e=>!/^B/.test(e.text))}]).logs);
    expect([h.values.id,h.flags.id]).toEqual(["Page 5","no borehole ID read: type its name"]);
  });
  it("checks depths, names, positions and levels, and never fixes them",()=>{
    const holes=[hole("BH-1",[["0","1.5"],["1.8","3"],["2.5","4"]],{final:"3.5",water:"7"}),hole("BH-1",[["0","x"]],{x:"",y:"",ground:""})];
    const texts=checkDraft(holes).map(c=>`${c.hole} ${c.level}: ${c.text}`);
    expect(texts).toEqual([
      "0 error: Another borehole is also named BH-1: rename one.",
      "0 warn: A gap from 1.5 to 1.8 m: no layer is there.",
      "0 warn: Layers overlap from 2.5 to 3 m.",
      "0 warn: The final depth (3.5 m) is above the base of the log (4 m).",
      "0 warn: The water depth (7 m) is below the bottom of the hole.",
      "1 error: Another borehole is also named BH-1: rename one.",
      "1 warn: No position: type an easting and northing, or a latitude and longitude, or this borehole is not placed with the others.",
      "1 warn: No ground level: type it, or this borehole is not placed.",
      "1 error: Layer 1: its depths are not both numbers.",
      "1 error: No layer has depths that can be used: correct them, or leave this borehole out."
    ]);
    // A borehole left out is not checked, and one borehole on its own needs no position.
    holes[1].use=false;
    expect(checkDraft(holes).filter(c=>/position|named/.test(c.text))).toEqual([]);
    expect(holes[0].layers.map(l=>l.from)).toEqual(["0","1.8","2.5"]);
  });
  it("turns the boreholes in use into Input data tables that build",()=>{
    const holes=[...drafts(),hole("BH-8",[["0","2,5"],["2,5","6"]],{water:"1,2"})];
    holes[0].values.x="100";holes[0].values.y="250";
    const t=draftTables(holes,["site-report.pdf"]);
    expect(t.project).toMatchObject({name:"site-report",source:"site-report.pdf"});
    expect(t.project.description).toBe("Borehole logs read from site-report.pdf (pages 1–2) and checked in the review.");
    expect(t.rows.boreholes).toEqual([["BH-7","100","250","","","12.3",""],["BH-8","100","200","","","10",""]]);
    expect(t.rows.logs.slice(-2)).toEqual([["BH-8","0","2.5","Clay","Clay"],["BH-8","2.5","6","Clay","Clay"]]);
    expect(t.rows.water).toEqual([["BH-8","1.2",""]]);
    expect(t.rows.units.map(r=>r[0])).toEqual(["Made ground","Clay","Sand"]);
    const built=projectFromTables(t);
    expect(built.project.boreholes.map(b=>[b.id,b.intervals.length])).toEqual([["BH-7",3],["BH-8",2]]);
  });
  it("writes pages as ranges",()=>expect(pageRanges([9,4,5,6,12,11])).toBe("4–6, 9, 11–12"));
});

describe("digital PDFs read with PDF.js",()=>{
  it("reads a strip log exactly",async()=>{
    const {logs}=await readPdf("bro-470162-strip.pdf"),truth=json<Truth>("bro-470162-strip.truth.json");
    expect(logs).toHaveLength(1);
    expect(score(logs[0],truth)).toEqual({boundaries:11,extra:0,descriptions:11,layers:11});
    expect([logs[0].id,logs[0].ground,logs[0].water,logs[0].x,logs[0].y]).toEqual([truth.id,truth.ground,truth.water,+truth.x.toFixed(2),+truth.y.toFixed(2)]);
  });
  it("reads a Japanese log (柱状図) with its header",async()=>{
    const {logs}=await readPdf("kj-148301107.pdf"),truth=json<Truth>("kj-148301107.truth.json");
    expect(logs).toHaveLength(1);
    expect(score(logs[0],truth)).toEqual({boundaries:15,extra:0,descriptions:15,layers:15});
    expect([logs[0].id,logs[0].ground,logs[0].water,logs[0].final]).toEqual([truth.id,truth.ground,truth.water,48.29]);
  });
  it("reads two logs set out as tables on one page, with vertical depths",async()=>{
    const {logs}=await readPdf("bro-tables.pdf"),truths=json<Truth[]>("bro-tables.truth.json");
    expect(logs.map(l=>l.id)).toEqual(truths.map(t=>t.id));
    logs.forEach((log,k)=>{
      expect(log.kind).toBe("table");
      expect(score(log,truths[k])).toEqual({boundaries:truths[k].layers.length,extra:0,descriptions:truths[k].layers.length,layers:truths[k].layers.length});
      // The water level is the cell after "Water level", not the Y coordinate in the cell before it.
      expect([log.ground,log.final,log.x,log.y,log.water]).toEqual([truths[k].ground,truths[k].final,+truths[k].x.toFixed(2),+truths[k].y.toFixed(2),truths[k].water]);
    });
  });
});

describe("page images read by OCR (recorded PP-OCRv6 small output)",()=>{
  // The results the reader reached on these pages; a change that reads fewer is a regression.
  // On the clean Japanese page two depth labels 0.35 m apart (13.85, 14.20) print over each other and OCR misreads them.
  const cases:Array<[string,string,number,number]>=[
    ["bro-470162-150dpi","bro-470162",11,11],["bro-470162-scan","bro-470162",11,11],
    ["kj-148301107-150dpi","kj-148301107",13,12],["kj-148301107-scan","kj-148301107",14,12]
  ];
  for(const [page,truthFile,boundaries,descriptions] of cases)it(page,()=>{
    const {logs}=readDocument([ocrPage(page)]),s=score(logs[0],json<Truth>(`ocr/${truthFile}.truth.json`));
    expect(s.boundaries).toBeGreaterThanOrEqual(boundaries);
    expect(s.descriptions).toBeGreaterThanOrEqual(descriptions);
    expect(s.extra).toBe(0);
  });
  it("six scan-like logs of one site",()=>{
    let b=0,d=0,n=0;
    for(const id of ["BHR000000470122","BHR000000470187","BHR000000470168","BHR000000364999","BHR000000470165","BHR000000470162"]){
      const {logs}=readDocument([ocrPage(`${id}-scan`)]),s=score(logs[0],json<Truth>(`ocr/${id}.truth.json`));
      b+=s.boundaries;d+=s.descriptions;n+=s.layers;
    }
    expect(n).toBe(72);
    expect(b).toBeGreaterThanOrEqual(66);
    expect(d).toBeGreaterThanOrEqual(61);
  });
});
