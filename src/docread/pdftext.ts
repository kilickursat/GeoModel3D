// PDF.js for the documents read in the browser: the text of each page with its boxes (textlines.ts), whether a page is
// a scanned image, and the page drawn for the review. Its worker, CMaps (CJK text), standard fonts, image decoders and
// ICC profile are served with the app (vite.config.ts), so reading a PDF fetches nothing from anywhere else. Scripts
// in a PDF never run: PDF.js 6 has no eval path, and its scripting is not used.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {linesFromItems,textChars,PdfTextItem} from "./textlines";
import type {TextLine} from "./reconstruct";

pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
// Pages are read at 150 dpi, as page images are for OCR, so both reach the reconstruction at one scale.
export const READ_SCALE=150/72;
// A page with fewer characters than this in its text layer is taken for a scanned image.
const MIN_CHARS=30;
// The largest canvas drawn: about 16 million pixels, which every browser (Safari on iPhone included) draws.
const MAX_PIXELS=16e6;

export interface PdfDoc { name:string; pages:number; doc:pdfjs.PDFDocumentProxy; close():Promise<void> }
export async function openPdf(name:string,data:Uint8Array):Promise<PdfDoc>{
  const base=new URL(`pdfjs-${pdfjs.version}/`,document.baseURI).href;
  const task=pdfjs.getDocument({data,cMapUrl:base+"cmaps/",cMapPacked:true,standardFontDataUrl:base+"standard_fonts/",
    wasmUrl:base+"wasm/",iccUrl:base+"iccs/",enableXfa:false,verbosity:pdfjs.VerbosityLevel.ERRORS});
  try{
    const doc=await task.promise;
    return {name,pages:doc.numPages,doc,close:()=>task.destroy()};
  }catch(err){
    void task.destroy();
    throw new Error(err instanceof pdfjs.PasswordException?"it is protected by a password":
      err instanceof pdfjs.InvalidPDFException?"it is not a PDF that can be opened (damaged, or another kind of file)":(err as Error).message);
  }
}

export interface PageText { page:number; width:number; height:number; lines:TextLine[]; scanned:boolean }
export async function pageText(d:PdfDoc,n:number):Promise<PageText>{
  const page=await d.doc.getPage(n),view=page.getViewport({scale:READ_SCALE});
  // Marked-content items have no text; linesFromItems passes over them.
  const items=(await page.getTextContent()).items as unknown as PdfTextItem[];
  const text={page:n,width:view.width,height:view.height,lines:linesFromItems(items,view.transform),scanned:textChars(items)<MIN_CHARS};
  page.cleanup();
  return text;
}

// Draws page n into the canvas for a width in CSS pixels, sharp on the screen's pixels where the canvas may be that
// large. cancel() stops a drawing in progress (the page shown changed).
export function renderPage(d:PdfDoc,n:number,canvas:HTMLCanvasElement,cssWidth:number){
  let task:pdfjs.RenderTask|undefined,cancelled=false;
  const done=(async()=>{
    const page=await d.doc.getPage(n);
    if(cancelled)return;
    const one=page.getViewport({scale:1}),ratio=Math.min(window.devicePixelRatio||1,3);
    const scale=Math.min(cssWidth*ratio/one.width,Math.sqrt(MAX_PIXELS/(one.width*one.height)));
    const view=page.getViewport({scale});
    canvas.width=Math.floor(view.width);canvas.height=Math.floor(view.height);
    task=page.render({canvas,viewport:view});
    try{await task.promise}catch(err){if(!(err instanceof pdfjs.RenderingCancelledException))throw err}
  })();
  return {done,cancel(){cancelled=true;task?.cancel()}};
}
