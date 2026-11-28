// Borehole logs read from documents on this device, loaded only when one is dropped or picked (and the user has agreed):
// PDF.js indexes each page's native text, then reads the selected pages in detail. The reading model (OCR) reads pages without
// text (scans), pages whose text is unusable (fonts without a map to characters give text that is not text), log pages
// whose text gives no depth scale (a typed header over a scanned log), and images. A page whose text is doubtful is read
// by both, and its own text kept where OCR confirms it. The selected pages then go through reconstruction
// together (reconstruct.ts), so a log can run on over pages, and the review opens on the logs. What is being read shows
// as it goes; Cancel stops it, the reading model too. In the review, any page read from its text can be read again by
// OCR on request: the document's logs are then read again.
import {openPdf,openImage,pageText,PageText,Doc} from "./pdftext";
import {scanReason} from "./pdfpage";
import {readDocument} from "./reconstruct";
import {selectReportPages} from "./pageSelection";
import {readCollarSchedules,matchCollarSchedules} from "./collarSchedule";
import {draftHoles,DraftHole} from "./draft";
import {createReview,ReviewHost,Unread,OcrRead} from "./review";
import {createOcr,readPageImage,Ocr} from "./ocrclient";
import {agreement} from "./textlines";
import {imageRules,joinRules,scaleRules} from "./ruling";
import {newEvidenceId,EvidenceSource} from "../evidence";

export const isImage=(f:File)=>/\.(png|jpe?g|webp)$/i.test(f.name)||/^image\/(png|jpeg|webp)$/.test(f.type);
const mb=(n:number)=>(n/1e6).toFixed(n<1e7?1:0);
const pct=(v:number)=>`${Math.round(100*v)} %`;
// Where OCR confirms at least this share of a doubtful page's words, the page keeps its own text (and its exact boxes).
const CONFIRMED=0.6;

// What the reader keeps of each document for reading pages again: the pages as read, which were read by OCR and why.
interface DocState { d:Doc; file:string; pages:PageText[]; selected:Set<number>; read:Set<number>; why:Map<number,string> }

export async function readPdfs(files:File[],host:ReviewHost){
  const review=createReview(host);
  document.body.appendChild(review.element);
  const holes:DraftHole[]=[],unread:Unread[]=[],problems:string[]=[],states:DocState[]=[];
  const reader:{ocr:Ocr|null;backend:string;status:string}={ocr:null,backend:"",status:""};
  const stopOcr=()=>{reader.ocr?.close();reader.ocr=null};
  review.onClose(stopOcr);
  // The reading model starts with the first page that needs it, downloading the model the first time.
  const startOcr=async()=>{
    if(!reader.ocr){
      reader.ocr=createOcr(p=>{
        if(p.stage==="download")review.progress(`Downloading the reading model: ${mb(p.loaded)} of ${mb(p.total)} MB`);
        else if(p.stage==="page")review.progress(`${reader.status}: ${p.done} of ${p.total} lines`);
        else reader.backend="";   // WebGPU failed: the processor reads on
      });
      review.progress("Starting the reading model…");
    }
    try{
      const on=await reader.ocr.ready;
      // Where the model reads, for the progress line: "WebGPU, nvidia"; nothing on the processor.
      reader.backend=on.backend==="webgpu"?`WebGPU${on.gpu?`, ${on.gpu}`:""}`:"";
    }catch(err){stopOcr();throw err}
    return reader.ocr;
  };
  // A page read by OCR, as a page of lines in the pixels it was read in.
  const ocrPage=async(doc:number,s:DocState,n:number):Promise<PageText>=>{
    const ocr=await startOcr();
    reader.status=`Reading ${s.file}${s.d.pages>1?`: page ${n} of ${s.d.pages}`:""} by OCR${reader.backend?` (${reader.backend})`:""}`;
    review.progress(reader.status+"…");
    const page=await readPageImage(ocr,await s.d.image(n));
    // The boxes on the review's page are in the pixels the page was read in. The ruled lines are found on the same image.
    review.size(doc,n,page.width,page.height);
    return {page:n,scanned:true,...page};
  };
  const put=(s:DocState,t:PageText)=>{const at=s.pages.findIndex(p=>p.page===t.page);if(at>=0)s.pages.splice(at,1);s.pages.push(t)};
  // The logs of a document as read so far, for the review.
  const result=(doc:number,s:DocState)=>{
    s.pages.sort((a,b)=>a.page-b.page);
    const r=readDocument(s.pages);
    const rows=readCollarSchedules(s.pages),schedulePages=new Set(rows.map(row=>row.page));
    return {holes:draftHoles(doc,s.file,r.logs,s.read,s.why,matchCollarSchedules(r.logs,rows)),
      unread:r.unread.filter(u=>u.log||!schedulePages.has(u.page)).map(u=>({doc,page:u.page,id:u.id,error:u.error,log:u.log,text:!s.read.has(u.page)&&s.d.kind==="pdf"})) as Unread[],
      ocr:[...s.why].filter(([n])=>s.read.has(n)).map(([page,why])=>({doc,page,why})) as OcrRead[]};
  };
  for(const f of files){
    if(review.closed)return;
    review.progress(`Opening ${f.name}…`);
    let d:Doc,pdf:Awaited<ReturnType<typeof openPdf>>|undefined,image:Awaited<ReturnType<typeof openImage>>|undefined;
    let source:EvidenceSource;
    try{
      const bytes=await f.arrayBuffer();
      let sha256:string|undefined;
      // PDF.js may transfer and detach its input buffer, so fingerprint the original bytes before opening it.
      if(globalThis.crypto?.subtle)try{sha256=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(n=>n.toString(16).padStart(2,"0")).join("")}catch{/* Metadata and source excerpts still remain available. */}
      source={id:newEvidenceId(),name:f.name,size:f.size,...(sha256?{sha256}:{}),pages:[]};
      if(isImage(f))d=image=await openImage(f.name,f);else d=pdf=await openPdf(f.name,new Uint8Array(bytes));
    }
    catch(err){problems.push(`${f.name}: not read, as ${(err as Error).message}.`);continue}
    if(review.closed){void d.close();return}
    const doc=review.addDoc(d,source);
    const selected=pdf?await selectReportPages(pdf,review):new Set([1]);
    if(!selected||review.closed)return;
    review.selectedPages(doc,selected);
    const s:DocState={d,file:f.name,pages:[],selected,read:new Set(),why:new Map()};
    states[doc]=s;
    // The pages to read by OCR, and those whose text OCR should confirm.
    const scan:number[]=[],doubt:number[]=[];
    if(image){review.size(doc,1,image.width,image.height);scan.push(1);s.why.set(1,"an image")}
    else if(pdf)for(let n=1;n<=pdf.pages;n++){
      if(review.closed)return;
      if(!selected.has(n))continue;
      review.progress(`Reading ${f.name}: page ${n} of ${pdf.pages}`);
      try{
        const t=await pageText(pdf,n);
        review.size(doc,n,t.width,t.height);
        const reason=scanReason(t);
        if(reason){scan.push(n);s.why.set(n,reason)}
        else{s.pages.push(t);if(t.layer==="doubtful")doubt.push(n)}
      }catch(err){unread.push({doc,page:n,error:`it could not be read (${(err as Error).message})`})}
    }
    // A log page whose text gives no depth scale may carry the log as an image (a typed header over a scanned log): it is
    // read by OCR too, unless its text is prose (five lines or more of eight words or more), as a page of a report is.
    const prose=(n:number)=>(s.pages.find(p=>p.page===n)?.lines??[]).filter(l=>l.text.trim().split(/\s+/).length>=8).length>=5;
    const schedulePages=new Set(readCollarSchedules(s.pages).map(row=>row.page));
    for(const u of readDocument(s.pages).unread)if(u.log&&u.error==="no depth scale found"&&!schedulePages.has(u.page)&&!scan.includes(u.page)&&!doubt.includes(u.page)&&!prose(u.page)){
      scan.push(u.page);s.why.set(u.page,"a log page whose text gives no depth scale");
    }
    scan.sort((a,b)=>a-b);
    let failed="";
    for(const n of [...scan,...doubt]){
      if(review.closed)return;
      const text=s.pages.find(p=>p.page===n);
      if(failed){if(!text)unread.push({doc,page:n,scanned:true,error:failed});continue}
      try{
        const read=await ocrPage(doc,s,n);
        if(doubt.includes(n)&&text){
          // Doubtful text: kept where OCR reads the same words, replaced where it does not.
          const agree=agreement(text.lines.map(l=>l.text),read.lines.map(l=>l.text));
          if(agree>=CONFIRMED){review.size(doc,n,text.width,text.height);continue}
          s.why.set(n,`PDF text that OCR did not confirm (${pct(agree)} of its words read the same)`);
        }
        put(s,read);s.read.add(n);
      }catch(err){
        if(review.closed)return;
        const started=reader.ocr!==null;
        if(!started)failed=`the reading model could not start (${(err as Error).message})`;
        if(!text)unread.push({doc,page:n,scanned:true,error:started?`the reading model failed (${(err as Error).message})`:failed});
        else if(doubt.includes(n))review.size(doc,n,text.width,text.height);
      }
    }
    // A log whose boundaries are drawn only, as lines across its descriptions (a scanned log with a text layer, depths
    // every 2 ft), reads no layers from its text: its lines are found on the page's image, and the document read again.
    const drawn=readDocument(s.pages).unread.filter(u=>u.log&&u.error==="no layers found"&&!s.read.has(u.page)).map(u=>u.page);
    for(const n of [...new Set(drawn)]){
      if(review.closed)return;
      review.progress(`Reading the lines drawn on ${f.name}${s.d.pages>1?`, page ${n}`:""}…`);
      try{
        const img=await s.d.image(n),t=s.pages.find(p=>p.page===n);
        if(t)t.rules=joinRules([...(t.rules??[]),...scaleRules(imageRules(img),t.width/img.width)]);
      }catch{/* the page keeps its text alone */}
    }
    const r=result(doc,s);
    holes.push(...r.holes);
    unread.push(...r.unread);
    review.ocrRead(r.ocr);
  }
  stopOcr();
  if(review.closed)return;
  // A page read from its text, read again by OCR on request: the document's logs are read again.
  review.onReread(async(doc,page)=>{
    const s=states[doc];
    if(!s)throw new Error("this document is no longer open");
    if(!s.selected.has(page))throw new Error("This page was excluded from extraction.");
    try{
      put(s,await ocrPage(doc,s,page));
      s.read.add(page);s.why.set(page,"read by OCR on request");
      return result(doc,s);
    }finally{stopOcr()}
  });
  review.show(holes,unread.sort((a,b)=>a.doc-b.doc||a.page-b.page),problems);
}
