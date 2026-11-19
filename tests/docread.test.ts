import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {TextLine,textLine,readDocument,readPage,header,ReadLog,sameId} from "../src/docread/reconstruct";
import {linesFromItems,PdfTextItem,judgeText,wordShare,agreement} from "../src/docread/textlines";
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
  it("reads a column of boundaries that prints each boundary's elevation above its depth",()=>{
    // Elevations far outside the log's depths are no misread depths: the column still gives the boundaries, and the
    // pairs give the ground level.
    const lines=[...drawnLog().filter(e=>!/Ground level|12\.30/.test(e.text)),
      ...[1.2,4.5,9.8].map(d=>L((48.25-d).toFixed(2),900,yAt(d)-8,48))];
    const [log]=readPage(lines,1000,800);
    expect(log.layers.map(l=>l.to)).toEqual([1.2,4.5,9.8]);
    expect([log.ground,log.groundFlag]).toEqual([48.25,"from the elevations and depths at the boundaries"]);
  });
  it("ends a log over two sheets on a last sheet too short for a depth scale",()=>{
    // The last sheet holds only the end of the log: the rest of its description and the depth of the end of the hole.
    const end=[L("Borehole No",40,40),L("BH-7",160,40),L("DESCRIPTION",300,150),L("Continued",300,190),
      L("SAND: dense, grey,",300,210),L("wet (Continued)",300,226),L("END OF BOREHOLE",300,250),L("10.40",900,250,40)];
    const r=readDocument([{page:1,width:1000,height:800,lines:drawnLog()},{page:2,width:1000,height:800,lines:end}]);
    expect(r.logs).toHaveLength(1);
    const [log]=r.logs;
    expect([log.pages,log.final]).toEqual([[1,2],10.4]);
    expect(log.layers.at(-1)).toMatchObject({from:9.8,to:10.4,description:"SAND: dense, grey, wet",flagged:true});
    expect(log.layers.at(-1)!.why).toMatch(/page 2, which ends the log with no depth scale/);
    expect(r.unread).toEqual([]);
  });
});

describe("logs that describe their samples",()=>{
  // Depths at the start of each sample's description, a scale of whole metres at x 40, and no boundary depths.
  const at=(d:number)=>yAt(d)+8;
  const sheet=(head:string[],labels:number[],rows:Array<[number,string]>,extra:TextLine[]=[])=>[
    ...head.map((t,k)=>L(t,40,40+20*k)),L("SAMPLE DESCRIPTION",300,150),...labels.map(d=>L(String(d),40,yAt(d),10)),
    ...rows.map(([y,t])=>L(t,300,y,7*t.length)),...extra];
  const HEAD=["BORING NO.: BH-9","FINAL DEPTH: 6.45 m.","GWT: 2.10 m.","ELEVATION: 12.50 m.","SHEET NO. 1 of 1"];
  it("takes a layer from each new description, flags where the change lies between samples, and reads the header",()=>{
    const lines=sheet(HEAD,[1,2,3,4,5,6,7,8,9,10],[
      [at(1),"(1.0-1.45 m) Brown clayey SAND, fine-"],[at(1)+16,"grained, loose. (Rec: 38/45 cm.)"],
      [at(2),"(2.0-2.45 m) - same materials -"],[at(2)+16,"(Rec: 41/45 cm.)"],
      [at(3),"(3.0-3.45 m) Gray CLAY, soft, high plasticity."],
      [at(4),"(4.0-4.45 m) - same materials -, but with shell fragments."],[at(4)+16,"Approx. change of stratum at 4.60 m."],
      [at(5),"x (5.0-5.45 m) Yellowish brown sandy GRAVEL, dense."],[at(6),"(6.0-6.45 m) - same materials -"],
      [at(7),"Note:"],[at(7)+16,"* = field description"],[at(7.5),"End of Borehole @ 6.45 m."]],
      // A laboratory result that fits its place on the scale by chance is no boundary.
      [L("Gs =",900,yAt(2.7)-14,32),L("2.68",900,yAt(2.7),32)]);
    const [log]=readPage(lines,1000,800);
    expect(log.layers.map(l=>[l.from,l.to,l.description])).toEqual([
      [1,3,"Brown clayey SAND, fine-grained, loose."],[3,4.6,"Gray CLAY, soft, high plasticity; but with shell fragments."],[4.6,6.45,"Yellowish brown sandy GRAVEL, dense."]]);
    expect(log.flagged).toEqual([3,4.6]);
    expect(log.layers[0].why).toBe("the change lies between the samples ending at 2.45 m and starting at 3 m; placed where the new description starts");
    expect(log.layers[1].why).toBe("the log notes “Approx. change of stratum at 4.60 m.”; the samples end at 4.45 m and start again at 5 m");
    expect(log.layers[2].flagged).toBeUndefined();
    expect([log.id,log.final,log.water,log.ground]).toEqual(["BH-9",6.45,2.1,12.5]);
    const [hole]=draftHoles(0,"log.pdf",readDocument([{page:1,width:1000,height:800,lines}]).logs);
    expect(hole.samples).toBe(true);
  });
  it("skips runs that brought up nothing and joins runs described in the same words",()=>{
    const lines=sheet(["BORING NO.: BH-2","FINAL DEPTH: 6.00 m."],[1,2,3,4,5,6,7,8,9,10],[
      [at(1),"(1.0-2.0 m) Reddish brown gravelly SAND, dense."],[at(2),"(2.0-2.0 m) No penetration, test refused."],
      [at(2)+16,"(2.0-3.0 m) No Recovery"],[at(3),"(3.0-4.0 m) Dark gray weathered BASALT, moderately strong."],
      [at(4),"(4.0-5.0 m) Dark gray weathered BASALT, moderately strong."],[at(5),"(5.0-6.0 m) - same materials -"]]);
    const [log]=readPage(lines,1000,800);
    expect(log.layers.map(l=>[l.from,l.to,l.description,!!l.flagged])).toEqual([
      [1,3,"Reddish brown gravelly SAND, dense.",true],[3,6,"Dark gray weathered BASALT, moderately strong.",false]]);
  });
  it("joins the sheets of one log, the last read below a note under the log and with its header unreadable",()=>{
    const first=sheet(["BORING NO.: BH-9","SHEET NO. 1 of 2","GWT: 2.10 m."],[1,2,3,4,5,6,7,8,9,10],[
      [at(1),"(1.0-1.45 m) Brown clayey SAND, loose."],[at(2),"(2.0-2.45 m) - same materials -"],[at(3),"(3.0-3.45 m) Gray CLAY, soft."]]);
    // The last sheet runs from 4 m, its first label (5) below the last sample, with a note under the log close below
    // it; its ID and sheet number are not read, its elevation and final depth are.
    const y2=(d:number)=>200+40*(d-4);
    const last=[L("ELEVATION: 12.50 m.",40,40),L("FINAL DEPTH: 4.45 m.",40,60),L("SAMPLE DESCRIPTION",300,150),
      ...[5,6,7,8,9,10,11,12,13].map(d=>L(String(d),40,y2(d),10)),L("(4.0-4.45 m) - same materials -",300,y2(4)+8,217),
      L("Note:",300,y2(4.6),35),L("* = field description",300,y2(5.2),140),L("End of Borehole @ 4.45 m.",300,y2(5.8),175)];
    const r=readDocument([{page:1,width:1000,height:800,lines:first},{page:2,width:1000,height:800,lines:last}]);
    expect(r.unread).toEqual([]);
    expect(r.logs).toHaveLength(1);
    const [log]=r.logs;
    expect([log.id,log.pages,log.samples,log.water,log.ground,log.final]).toEqual(["BH-9",[1,2],true,2.1,12.5,4.45]);
    expect(log.layers.map(l=>[l.from,l.to,l.description])).toEqual([[1,3,"Brown clayey SAND, loose."],[3,4.45,"Gray CLAY, soft."]]);
  });
});

describe("text from a PDF's own text layer",()=>{
  // Page pixels at twice the PDF's points, y down.
  const view=[2,0,0,-2,0,1600];
  const run=(str:string,x:number,y:number,width:number):PdfTextItem=>({str,transform:[9,0,0,9,x,y],width,height:9});
  const texts=(items:PdfTextItem[])=>linesFromItems(items,view).map(l=>l.text);
  it("reads text printed twice over itself once",()=>{
    expect(texts([run("BOREHOLE NO.: BH-12",330,740,90),run("BOREHOLE NO.: BH-12",329.34,740,90)])).toEqual(["BOREHOLE NO.: BH-12"]);
  });
  it("starts a line where a column of a table starts, however close the text before it",()=>{
    const lines=texts([
      run("(6.0-6.45 m) Gray clayey SILT, low plasticity, firm,",110,700,174),run("S-6",290,700,18),run("Firm",313.5,700,17),
      run("with some fine sand.",110,680,70),run("S-7",290,680,18),run("(Rec: 38/45 cm.)",110,660,60),run("S-8",290,660,18),
      run("(8.0-8.45 m) - same materials -",110,640,110),run("S-9",290,640,18),
      // Text set word by word, its words as far apart as the columns above, but where no line starts.
      run("Samples",110,600,32),run("were",148,600,18),run("taken",172,600,24),run("daily",202,600,22)]);
    expect(lines).toContain("(6.0-6.45 m) Gray clayey SILT, low plasticity, firm,");
    expect(lines).toContain("S-6 Firm");
    expect(lines).toContain("Samples were taken daily");
  });
});

describe("pages whose own text is unusable",()=>{
  // A font with no map to characters gives its codes for letters: text that looks like text but is not.
  const real=["Brown clayey SAND, medium dense","Grey silty CLAY, firm, wet"],garbled=["#$%& '()* +,-./","<=>? @#$% &'()","*+,- ./:;"];
  it("reads a page's text as good, garbled or doubtful by how much of it reads as words",()=>{
    expect(judgeText(real,60,30)).toMatchObject({layer:"good",share:1});
    expect(judgeText(garbled,40,30)).toMatchObject({layer:"garbled",share:0});
    expect(judgeText([...real.slice(0,1).map(t=>t.split(" ").slice(0,4).join(" ")),...garbled.slice(0,2)],60,30).layer).toBe("doubtful");
    expect(judgeText(["ボーリング柱状図 孔口標高 12.30 m 土質区分 砂質シルト 粘土 記事 地下水位"],40,30).layer).toBe("good");
    // Too little text to judge keeps its text; almost none is a scan.
    expect(judgeText(["#$% &'("],8,5).layer).toBe("good");
    expect(judgeText(["APPENDIX A"],9,30).layer).toBe("none");
    // Bullets, dashes and leader dots are no words either way.
    expect(wordShare(["• Clay ……… 12 — Sand"]).share).toBe(1);
  });
  it("keeps a doubtful page's own text where OCR reads the same words",()=>{
    expect(agreement(["Brown clayey SAND, medium dense"],["brown clayey sand medium dense"])).toBe(1);
    expect(agreement(["Brown clayey SAND, medium dense"],["#$% &'() *+,"])).toBe(0);
  });
});

describe("the sheets of a log and its rock core log",()=>{
  // A drawn log sheet: title with the ID, scale from `top` metres at x 40 (40 px a metre from y 200), boundary depths
  // at x 900, descriptions at x 300.
  const at=(top:number,d:number)=>200+40*(d-top);
  const sheet=(title:string,top:number,bounds:number[],texts:Array<[number,string]>,extra:TextLine[]=[])=>[
    L(title,600,40,8*title.length),L("DESCRIPTION",300,150),...Array.from({length:11},(_,k)=>L(String(top+k),40,at(top,top+k),10)),
    ...bounds.map(b=>L(b.toFixed(2),900,at(top,b)+8,40)),...texts.map(([d,t])=>L(t,300,at(top,d))),...extra];
  it("reads the ID after BOREHOLE LOG or ROCK CORE LOG, and compares IDs as one borehole's",()=>{
    expect(header([L("BOREHOLE LOG 214",600,40,140)]).id).toBe("214");
    expect(header([L("ROCK CORE LOG BH-7",600,40,150)]).id).toBe("BH-7");
    expect(header([L("BOREHOLE LOG",600,40,110),L("Client : Public Works",600,60,160)]).id).toBeUndefined();
    expect(new Set([sameId("Log 31"),sameId("LOG31"),sameId("31")]).size).toBe(1);
    expect(new Set([sameId("BH-01"),sameId("BH1"),sameId("1"),sameId("Borehole No. 1")]).size).toBe(1);
    expect(sameId("TP-1")).not.toBe(sameId("BH-1"));
  });
  it("joins sheets by their ID as one borehole's and in depth order, and keeps a log that starts again apart",()=>{
    const first=sheet("BOREHOLE LOG 7",0,[1.2],[[0.5,"FILL: sand and gravel"],[1.5,"CLAY: soft, grey"],[9.8,"(continued)"]]);
    const second=sheet("Borehole Log BH-07",10,[12.4,16.8],[[10.2,"CLAY: soft, grey (continued)"],[13,"SAND: dense"]],[L("END OF BOREHOLE",300,at(10,16.8)+18)]);
    const again=sheet("BOREHOLE LOG 7",0,[2.0],[[1,"PEAT: black, spongy"]]);
    const r=readDocument([{page:1,width:1000,height:800,lines:first},{page:2,width:1000,height:800,lines:second},{page:3,width:1000,height:800,lines:again}]);
    expect(r.logs.map(l=>[l.id,l.pages])).toEqual([["7",[1,2]],["7",[3]]]);
    const [log]=r.logs;
    // The second sheet's repeat of the layer it continues adds nothing, and "(continued)" is no description.
    expect(log.layers.map(l=>[l.from,l.to,l.description])).toEqual([[0,1.2,"FILL: sand and gravel"],[1.2,12.4,"CLAY: soft, grey"],[12.4,16.8,"SAND: dense"]]);
    // The depth written where the log ends is its final depth; an elevation there is not.
    expect([log.final,log.src?.final?.text]).toEqual([16.8,"16.80"]);
  });
  it("reads a final depth only where the log states it",()=>{
    expect(readPage(drawnLog(),1000,800)[0].final).toBeUndefined();
    expect(readPage([...drawnLog(),L("END OF BOREHOLE",300,yAt(9.8)+18)],1000,800)[0].final).toBe(9.8);
  });
  it("reads a log too short for a depth scale from the elevations printed over its depths",()=>{
    // 140 px a metre from the ground surface at y 200: each boundary's elevation printed just above its depth.
    const y=(d:number)=>200+140*d;
    const lines=[L("BOREHOLE LOG 9",600,40,120),L("DESCRIPTION",300,150),L("52.0",110,y(0),32),L("GROUND SURFACE",160,y(0),120),
      L("160mm TOPSOIL",300,y(0.05),104),L("51.8",110,y(0.2)-14,32),L("0.2",118,y(0.2),24),L("FILL, clayey sand, grey, damp",300,y(0.3)),
      L("51.4",110,y(0.6)-14,32),L("0.6",118,y(0.6),24),L("END OF BOREHOLE",300,y(0.6)+16)];
    const [log]=readPage(lines,1000,800);
    expect(log.layers.map(l=>[l.from,l.to,l.description])).toEqual([[0,0.2,"160mm TOPSOIL"],[0.2,0.6,"FILL, clayey sand, grey, damp"]]);
    // The ground level is the elevation on the ground surface's line, not the thickness under it.
    expect([log.final,log.ground]).toEqual([0.6,52]);
  });
  it("keeps the runs of a rock core log as records beside the log of its borehole, never as its layers",()=>{
    const log=sheet("BOREHOLE LOG 5",0,[1.2,4.5,9.8],[[0.5,"FILL: sand and gravel"],[2.5,"CLAY: stiff, brown"],[5,"GRANITE (see rock core log)"]],
      [L("(refer to Rock",300,yAt(6)),L("Core Log 5) below 4.5 m",300,yAt(6.3))]);
    // The core log: scale from 4 m at 60 px a metre, runs in the "Run" column between the depths of their ends.
    const c=(d:number)=>200+60*(d-4);
    const core=[L("ROCK CORE LOG 5",600,40,120),L("stratigraphy",150,150,96),L("Run",470,150,24),...[4,5,6,7,8,9,10].map(d=>L(String(d),40,c(d),10)),
      ...[4.5,6,7.5,9].map(d=>L(d.toFixed(1),470,c(d),24)),
      ...[["R1",5.25],["R2",6.75],["R3",8.25]].map(([r,d])=>L(r as string,470,c(d as number),16)),
      L("TCR = 98%",520,c(5.25)-12,72),L("SCR = 90%",520,c(5.25),72),L("RQD = 61%",520,c(5.25)+12,72),L("RQD = 85%",520,c(6.75)+12,72),
      L("5.2/ 46.8m: 40mm broken zone",980,c(5.2),220),L("GRANITE, grey, fresh, strong",150,c(4.7),220),L("Run 1:",150,c(5.6),48),L("100% granite",210,c(5.6),96)];
    const r=readDocument([{page:1,width:1000,height:800,lines:log},{page:2,width:1100,height:800,lines:core}]);
    expect(r.logs).toHaveLength(1);
    const [l]=r.logs;
    expect([l.id,l.pages,l.layers.map(x=>x.to)]).toEqual(["5",[1],[1.2,4.5,9.8]]);
    expect(l.core?.pages).toEqual([2]);
    expect(l.core?.runs.map(x=>[x.run,x.from,x.to,x.tcr,x.scr,x.rqd])).toEqual([["R1",4.5,6,98,90,61],["R2",6,7.5,undefined,undefined,85],["R3",7.5,9,undefined,undefined,undefined]]);
    expect(l.core?.runs[0].notes).toEqual(["Run 1: 100% granite","5.2/ 46.8m: 40mm broken zone"]);
    expect(l.core?.text).toBe("GRANITE, grey, fresh, strong");
    // A sentence on the log that names the core log does not make the log one; a core log with no log of its ID is
    // read as a log itself.
    expect(readPage(log,1000,800)[0].core).toBeUndefined();
    expect(readDocument([{page:2,width:1100,height:800,lines:core}]).logs[0].core).toBeUndefined();
    // The review keeps the runs with the borehole, and the Input data tables leave them out.
    const [hole]=draftHoles(0,"report.pdf",r.logs);
    expect(hole.core?.runs).toHaveLength(3);
    expect(draftTables([hole],["report.pdf"]).rows.logs).toHaveLength(3);
  });
  it("reads small capitals OCR gives for capitals in a layer's title",()=>{
    const lines=drawnLog().map(e=>e.text==="CLAY: soft, grey"?{...e,text:"cLAY: soft, grey"}:e);
    expect(readPage(lines,1000,800)[0].layers[1].description).toBe("CLAY: soft, grey");
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
  it("reads water standing at ground level as a depth of 0, flagged, but not a heading beside a water heading",()=>{
    expect(header([L("GWT: Ground level",40,40)])).toMatchObject({water:0,waterFlag:"read as “at ground level”: a depth of 0 m"});
    expect(header([L("Water level",40,40),L("Ground level",200,40)]).water).toBeUndefined();
  });
  it("reads a header's elevation with its colon as the ground level",()=>{
    expect(header([L("BORING NO.: BH-3",40,40),L("ELEVATION: 14.20 m.",40,60)])).toMatchObject({id:"BH-3",ground:14.2});
  });
});

describe("unit rules for real logs",()=>{
  const unit=(name:string)=>applyUnitRules([{id:"b",x:0,y:0,z:0,intervals:[{from:0,to:1,unit:"",name}]}],lithologyRules).boreholes[0].intervals[0].unit;
  it("counts topsoil written in two words and road layers as made ground",()=>{
    for(const n of ["TOP SOIL (100 mm)","200mm AGGREGATE","GRANULAR BASE (250mm): gravelly sand","GRANULAR SUBBASE: sand with gravel"])expect(unit(n)).toBe("Made ground");
  });
  it("names igneous and metamorphic rocks as rock, and takes rock names as whole words",()=>{
    for(const n of ["Dark green DUNITE, fresh, very strong","welded TUFF, highly weathered","SERPENTINITE, sheared","Grey GNEISS, fresh"])expect(unit(n)).toBe("Rock");
    expect(unit("GREYWACKE, fresh")).toBe("Sandstone");
    expect(unit("grey SHALES with thin limestone beds")).toBe("Mudstone and siltstone");
    expect(unit("chalky CLAY")).toBe("Clay");
    expect(unit("rockfill, sandy gravel")).toBe("Gravel");
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
  it("groups the boundaries placed between samples into one check per log, each keeping its own gap and reason",()=>{
    const h=hole("BH-1",[["1","2"],["2","3"],["3","4"],["4","6"],["6","7"]]);
    const gaps:Array<[number,number]>=[[1.45,2],[2.45,3],[3.45,4],[4.45,6]];
    h.layers.slice(0,4).forEach((l,k)=>{l.flag=`the change lies between the samples ending at ${gaps[k][0]} m and starting at ${gaps[k][1]} m; placed where the new description starts`;l.gap=gaps[k]});
    expect(checkDraft([h]).filter(c=>c.level==="warn").map(c=>[c.layer,c.text])).toEqual([
      [0,"3 layer boundaries lie between samples, in untested gaps of 0.55 m: each is placed at the top of the sample with the new description, or where the log notes the change, and is marked on its layer."],
      [3,"6 m: the change lies between the samples ending at 4.45 m and starting at 6 m; placed where the new description starts; a wider gap than this log's usual 0.55 m."]]);
    // Every boundary still carries its own reason and gap.
    expect(h.layers.slice(0,4).every(l=>l.flag&&l.gap)).toBe(true);
  });
  it("says once that no borehole has a position, where none has",()=>{
    const a=hole("BH-1",[["0","2"]],{x:"",y:""}),b=hole("BH-2",[["0","3"]],{x:"",y:""});
    expect(checkDraft([a,b]).filter(c=>/position/.test(c.text))).toEqual([{hole:0,field:"x",level:"warn",
      text:"No borehole has a position: none of the 2 boreholes in use gives an easting and northing, or a latitude and longitude, so the model cannot place them. Type them here, or under Input data."}]);
    b.values.x="5";b.values.y="7";
    expect(checkDraft([a,b]).filter(c=>/position/.test(c.text)).map(c=>c.hole)).toEqual([0]);
  });
  it("says why a borehole was read by OCR",()=>{
    const logs=readDocument([{page:1,width:1000,height:800,lines:drawnLog()}]).logs;
    const [h]=draftHoles(0,"x.pdf",logs,new Set([1]),new Map([[1,"unusable PDF text (2 % of it reads as words)"]]));
    expect(h.ocrWhy).toBe("unusable PDF text (2 % of it reads as words)");
    expect(checkDraft([h]).map(c=>c.text)).toContain("Read by OCR (unusable PDF text (2 % of it reads as words)): compare every value and description with the page.");
  });
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
