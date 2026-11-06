// The documents read in the browser. PDFs are opened with PDF.js: the text of each page with its boxes (textlines.ts),
// whether a page is a scanned image, the page drawn for the review, and the page as an image for the reading model.
// Images (a photographed or scanned log) are pages of their own. PDF.js's worker, CMaps (CJK text), standard fonts,
// image decoders and ICC profile are served with the app (vite.config.ts), so opening a PDF fetches nothing from
// anywhere else. Scripts in a PDF never run: PDF.js 6 has no eval path, and its scripting is not used.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {linesFromItems,textChars,PdfTextItem} from "./textlines";
import type {TextLine} from "./reconstruct";

pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
// Pages are read at 150 dpi, as page images are for the reading model, so both reach the reconstruction at one scale.
export const READ_SCALE=150/72;
// A page with fewer characters than this in its text layer is taken for a scanned image.
const MIN_CHARS=30;
// The largest canvas drawn: about 16 million pixels, which every browser (Safari on iPhone included) draws.
const MAX_PIXELS=16e6;
// Images are read with their long side at most this long: an A4 page at about 200 dpi.
const MAX_IMAGE=2400;
// Pages are read by the reading model at 150 dpi up to this many pixels (an A3 page is 4.4 million), at a lower
// resolution beyond: the detection of a large drawing at 150 dpi would not fit the memory of WebAssembly.
const MAX_READ_PIXELS=6e6;

// A page drawn into a canvas for a width in CSS pixels; cancel() stops a drawing in progress (the page shown changed).
export interface Drawing { done:Promise<void>; cancel():void }
export interface Doc {
  kind:"pdf"|"image"; name:string; pages:number;
  render(n:number,canvas:HTMLCanvasElement,cssWidth:number):Drawing;
  // The page as an image, in the pixels its text is read in.
  image(n:number):Promise<ImageData>;
  close():Promise<void>|void;
}
const ratio=()=>Math.min(window.devicePixelRatio||1,3);

export async function openPdf(name:string,data:Uint8Array):Promise<Doc&{doc:pdfjs.PDFDocumentProxy}>{
  const base=new URL(`pdfjs-${pdfjs.version}/`,document.baseURI).href;
  const task=pdfjs.getDocument({data,cMapUrl:base+"cmaps/",cMapPacked:true,standardFontDataUrl:base+"standard_fonts/",
    wasmUrl:base+"wasm/",iccUrl:base+"iccs/",enableXfa:false,verbosity:pdfjs.VerbosityLevel.ERRORS});
  let doc:pdfjs.PDFDocumentProxy;
  try{doc=await task.promise}
  catch(err){
    void task.destroy();
    throw new Error(err instanceof pdfjs.PasswordException?"it is protected by a password":
      err instanceof pdfjs.InvalidPDFException?"it is not a PDF that can be opened (damaged, or another kind of file)":(err as Error).message);
  }
  return {kind:"pdf",name,pages:doc.numPages,doc,close:()=>task.destroy(),
    render(n,canvas,cssWidth){
      let job:pdfjs.RenderTask|undefined,cancelled=false;
      const done=(async()=>{
        const page=await doc.getPage(n);
        if(cancelled)return;
        const one=page.getViewport({scale:1});
        const view=page.getViewport({scale:Math.min(cssWidth*ratio()/one.width,Math.sqrt(MAX_PIXELS/(one.width*one.height)))});
        canvas.width=Math.floor(view.width);canvas.height=Math.floor(view.height);
        job=page.render({canvas,viewport:view});
        try{await job.promise}catch(err){if(!(err instanceof pdfjs.RenderingCancelledException))throw err}
      })();
      return {done,cancel(){cancelled=true;job?.cancel()}};
    },
    async image(n){
      const page=await doc.getPage(n),one=page.getViewport({scale:1});
      const view=page.getViewport({scale:Math.min(READ_SCALE,Math.sqrt(MAX_READ_PIXELS/(one.width*one.height)))});
      const canvas=document.createElement("canvas");
      canvas.width=Math.round(view.width);canvas.height=Math.round(view.height);
      await page.render({canvas,viewport:view,background:"#ffffff"}).promise;
      page.cleanup();
      return canvas.getContext("2d",{willReadFrequently:true})!.getImageData(0,0,canvas.width,canvas.height);
    }
  };
}

export interface PageText { page:number; width:number; height:number; lines:TextLine[]; scanned:boolean }
export async function pageText(d:Doc&{doc:pdfjs.PDFDocumentProxy},n:number):Promise<PageText>{
  const page=await d.doc.getPage(n),view=page.getViewport({scale:READ_SCALE});
  // Marked-content items have no text; linesFromItems passes over them.
  const items=(await page.getTextContent()).items as unknown as PdfTextItem[];
  const text={page:n,width:view.width,height:view.height,lines:linesFromItems(items,view.transform),scanned:textChars(items)<MIN_CHARS};
  page.cleanup();
  return text;
}

// An image as a document of one page, read at its own size or with its long side at MAX_IMAGE px.
export async function openImage(name:string,file:Blob):Promise<Doc&{width:number;height:number}>{
  let bitmap:ImageBitmap;
  try{bitmap=await createImageBitmap(file)}catch{throw new Error("this browser cannot open the image")}
  const k=Math.min(1,MAX_IMAGE/Math.max(bitmap.width,bitmap.height)),width=Math.round(bitmap.width*k),height=Math.round(bitmap.height*k);
  const draw=(canvas:HTMLCanvasElement,w:number,h:number)=>{
    canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext("2d",{willReadFrequently:true})!;
    ctx.fillStyle="#ffffff";ctx.fillRect(0,0,w,h);ctx.drawImage(bitmap,0,0,w,h);
    return ctx;
  };
  return {kind:"image",name,pages:1,width,height,close:()=>bitmap.close(),
    render(_n,canvas,cssWidth){
      const s=Math.min(cssWidth*ratio()/width,Math.sqrt(MAX_PIXELS/(width*height)));
      draw(canvas,Math.max(1,Math.floor(width*s)),Math.max(1,Math.floor(height*s)));
      return {done:Promise.resolve(),cancel(){}};
    },
    async image(){return draw(document.createElement("canvas"),width,height).getImageData(0,0,width,height)}
  };
}
