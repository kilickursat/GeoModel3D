import {readFileSync} from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {beforeAll,expect,it} from "vitest";
import {extractPageText} from "../src/docread/pdfpage";
import {readDocument,type PageLines} from "../src/docread/reconstruct";

let head:PageLines,tail:PageLines;
async function original(name:string){
  const task=pdfjs.getDocument({data:new Uint8Array(readFileSync("tests/fixtures/tochigi/"+name)),
    cMapUrl:"node_modules/pdfjs-dist/cmaps/",cMapPacked:true,standardFontDataUrl:"node_modules/pdfjs-dist/standard_fonts/"});
  try{
    const pdf=await task.promise;
    const pages:PageLines[]=[];
    for(let n=1;n<=pdf.numPages;n++)pages.push(await extractPageText(await pdf.getPage(n),pdfjs.OPS));
    return pages;
  }finally{await task.destroy()}
}
beforeAll(async()=>{[head,tail]=await original("11901049606.pdf")});

const replaceText=(page:PageLines,before:string,after:string):PageLines=>({...page,
  lines:page.lines.map(line=>line.text===before?{...line,text:after}:line)});
const firstSheetBases=[1.50,2.15,2.80,10.60,12.25,12.40];
it("recovers each original continuation contact, soil name and source box",()=>{
  const {logs,unread}=readDocument([head,tail]);
  expect(unread).toEqual([]);
  expect(logs).toHaveLength(1);
  const [log]=logs;
  expect(log.pages).toEqual([1,2]);
  expect(log.layers.map(l=>l.to)).toEqual([...firstSheetBases,17.00,17.60,18.20]);
  expect(log.layers.slice(-3).map(l=>[l.from,l.soilName])).toEqual([
    [12.40,"粘土混じり砂礫(GS-C)"],[17.00,"礫混じり細砂(FS-G)"],[17.60,"粘土混じり砂礫(GS-C)"]]);
  for(const layer of log.layers.slice(-3)){
    expect(layer.src[0].text).toBe(layer.to.toFixed(2));
    for(const source of layer.src){
      expect(source.page).toBe(2);
      expect(tail.lines.some(e=>e.text===source.text&&e.x0===source.x0&&e.y0===source.y0)).toBe(true);
    }
  }
});

it("honours the selected pages even when the header states the final depth",()=>{
  const first=readDocument([head]),second=readDocument([tail]);
  expect(first.logs[0].pages).toEqual([1]);
  expect(first.logs[0].layers.map(l=>l.to)).toEqual(firstSheetBases);
  expect(second.logs).toEqual([]);
  expect(second.unread).toMatchObject([{page:2,log:true}]);
});

it.each([
  ["different printed filename",(p:PageLines)=>replaceText(p,"11901049606.pdf (16 - 19 m)","other.pdf (16 - 19 m)")],
  ["different sheet count",(p:PageLines)=>replaceText(p,"2/2 ページ","2/3 ページ")],
  ["non-adjacent selected page",(p:PageLines)=>({...p,page:3})],
  ["shifted depth window",(p:PageLines)=>replaceText(p,"11901049606.pdf (16 - 19 m)","11901049606.pdf (15 - 19 m)")],
  ["mismatched page geometry",(p:PageLines)=>({...p,width:p.width+5})],
  ["inconsistent bed thickness",(p:PageLines)=>replaceText(p,"4.60","4.90")],
  ["a one-centimetre elevation discrepancy",(p:PageLines)=>replaceText(p,"38.53","38.54")],
  ["missing final printed bed",(p:PageLines)=>({...p,lines:p.lines.filter(l=>l.text!=="37.93")})],
  ["orphan SPT numbers",(p:PageLines)=>({...p,lines:p.lines.filter(l=>l.cx>300||!/^\d+\.\d+$/.test(l.text))})],
  ["missing material",(p:PageLines)=>({...p,lines:p.lines.filter(l=>l.cx<220||l.cx>280)})]
] as const)("leaves a continuation with %s for review",(_reason,change)=>{
  const next=change(tail),{logs,unread}=readDocument([head,next]);
  expect(logs[0].layers.map(l=>l.to)).toEqual(firstSheetBases);
  expect(unread).toMatchObject([{page:next.page,log:true}]);
});


it("requires an independently confirmed contact before borrowing the heading geometry",()=>{
  const wrongAnchor=replaceText(head,"43.73","43.74"),{logs,unread}=readDocument([wrongAnchor,tail]);
  expect(logs[0].layers.map(l=>l.to)).toEqual(firstSheetBases);
  expect(unread).toMatchObject([{page:2,log:true}]);
});

it("preserves the longer rulers on all three sheets of B-3(P-6)",async()=>{
  const pages=await original("11905045102.pdf");
  const {logs,unread}=readDocument(pages);
  expect(unread).toEqual([]);
  expect(logs).toHaveLength(1);
  expect(logs[0].pages).toEqual([1,2,3]);
  expect(logs[0].layers.map(l=>l.to)).toEqual([3.95,5.35,5.90,6.70,8.90,10.95,12.00,
    16.90,18.10,22.00,22.35,33.00,34.15,35.10,35.50,40.80,41.70,42.80,49.80,50.29]);
  const other=replaceText(pages[1],"11905045102.pdf (16 - 40 m)","unrelated.pdf (16 - 40 m)");
  expect(readDocument([pages[0],other,pages[2]]).logs[0].pages).toEqual([1]);
});

it("points to disagreeing first-sheet depths and source boxes on B-4(A-2)",async()=>{
  const {logs}=readDocument(await original("11905045103.pdf"));
  const first=logs[0].layers[0];
  expect(first.flagged).toBe(true);
  expect(first.why).toContain("printed layer bases missing from this reading: 5.9 m");
  expect(first.why).toContain("read bases without a matching printed row: 7.3, 9.3 m");
  expect(first.src.some(e=>e.page===1&&e.text==="5.90")).toBe(true);
  expect(logs[0].layers.at(-1)?.to).toBe(17.42);
});
