import {readFileSync} from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {beforeAll,expect,it} from "vitest";
import {extractPageText} from "../src/docread/pdfpage";
import {readDocument,type PageLines} from "../src/docread/reconstruct";

let head:PageLines,tail:PageLines;
beforeAll(async()=>{
  const task=pdfjs.getDocument({data:new Uint8Array(readFileSync("tests/fixtures/tochigi/11901049606.pdf")),
    cMapUrl:"node_modules/pdfjs-dist/cmaps/",cMapPacked:true,standardFontDataUrl:"node_modules/pdfjs-dist/standard_fonts/"});
  try{
    const pdf=await task.promise;
    head=await extractPageText(await pdf.getPage(1),pdfjs.OPS);
    tail=await extractPageText(await pdf.getPage(2),pdfjs.OPS);
  }finally{await task.destroy()}
});

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
