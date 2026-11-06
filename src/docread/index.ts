// Borehole logs read from documents on this device, loaded only when one is dropped or picked (and the user has agreed):
// each PDF is opened with PDF.js and the text of each page read; pages without text (scans), log pages whose text gives
// no depth scale (a typed header over a scanned log) and images are read by the reading model (OCR) instead. All pages
// of a document then go through the reconstruction together (reconstruct.ts), so a log can run on over pages, and the
// review opens on the logs. What is being read shows as it goes; Cancel stops it, the reading model too.
import {openPdf,openImage,pageText,PageText,Doc} from "./pdftext";
import {readDocument,textLine} from "./reconstruct";
import {draftHoles,DraftHole} from "./draft";
import {createReview,ReviewHost,Unread} from "./review";
import {createOcr,Ocr} from "./ocrclient";

export const isImage=(f:File)=>/\.(png|jpe?g|webp)$/i.test(f.name)||/^image\/(png|jpeg|webp)$/.test(f.type);
const mb=(n:number)=>(n/1e6).toFixed(n<1e7?1:0);

export async function readPdfs(files:File[],host:ReviewHost){
  const review=createReview(host);
  document.body.appendChild(review.element);
  const holes:DraftHole[]=[],unread:Unread[]=[],problems:string[]=[];
  const reader:{ocr:Ocr|null;backend:string;status:string}={ocr:null,backend:"",status:""};
  review.onClose(()=>reader.ocr?.close());
  // The reading model starts with the first page that needs it, downloading the model the first time.
  const startOcr=async()=>{
    if(!reader.ocr){
      reader.ocr=createOcr(p=>{
        if(p.stage==="download")review.progress(`Downloading the reading model: ${mb(p.loaded)} of ${mb(p.total)} MB`);
        else if(p.stage==="page")review.progress(`${reader.status}: ${p.done} of ${p.total} lines`);
        else reader.backend=p.backend;
      });
      review.progress("Starting the reading model…");
    }
    reader.backend=await reader.ocr.ready;
    return reader.ocr;
  };
  for(const f of files){
    if(review.closed)return;
    review.progress(`Opening ${f.name}…`);
    let d:Doc,pdf:Awaited<ReturnType<typeof openPdf>>|undefined,image:Awaited<ReturnType<typeof openImage>>|undefined;
    try{if(isImage(f))d=image=await openImage(f.name,f);else d=pdf=await openPdf(f.name,new Uint8Array(await f.arrayBuffer()))}
    catch(err){problems.push(`${f.name}: not read, as ${(err as Error).message}.`);continue}
    if(review.closed){void d.close();return}
    const doc=review.addDoc(d),pages:PageText[]=[],scan:number[]=[];
    if(image){review.size(doc,1,image.width,image.height);scan.push(1)}
    else if(pdf)for(let n=1;n<=pdf.pages;n++){
      if(review.closed)return;
      review.progress(`Reading ${f.name}: page ${n} of ${pdf.pages}`);
      try{
        const t=await pageText(pdf,n);
        review.size(doc,n,t.width,t.height);
        if(t.scanned)scan.push(n);else pages.push(t);
      }catch(err){unread.push({doc,page:n,error:`it could not be read (${(err as Error).message})`})}
    }
    // A log page whose text gives no depth scale may carry the log as an image: it is read by OCR too.
    for(const u of readDocument(pages).unread)if(u.log&&u.error==="no depth scale found"&&!scan.includes(u.page))scan.push(u.page);
    scan.sort((a,b)=>a-b);
    const read=new Set<number>();
    if(scan.length){
      let why="",ocr:Ocr|undefined;
      try{ocr=await startOcr()}catch(err){why=`the reading model could not start (${(err as Error).message})`}
      for(const n of scan){
        if(review.closed)return;
        if(!ocr){if(!pages.some(p=>p.page===n))unread.push({doc,page:n,scanned:true,error:why});continue}
        reader.status=`Reading ${f.name}${d.pages>1?`: page ${n} of ${d.pages}`:""} by OCR${reader.backend==="webgpu"?" (WebGPU)":""}`;
        review.progress(reader.status+"…");
        try{
          const img=await d.image(n),lines=await ocr.read(img);
          // The boxes on the review's page are in the pixels the page was read in.
          review.size(doc,n,img.width,img.height);
          const at=pages.findIndex(p=>p.page===n);
          if(at>=0)pages.splice(at,1);
          pages.push({page:n,width:img.width,height:img.height,scanned:true,lines:lines.map(l=>textLine(l.text,l.x0,l.y0,l.x1,l.y1))});
          read.add(n);
        }catch(err){
          if(review.closed)return;
          if(!pages.some(p=>p.page===n))unread.push({doc,page:n,scanned:true,error:`the reading model failed (${(err as Error).message})`});
        }
      }
    }
    pages.sort((a,b)=>a.page-b.page);
    const result=readDocument(pages);
    holes.push(...draftHoles(doc,f.name,result.logs,read));
    for(const u of result.unread)unread.push({doc,page:u.page,id:u.id,error:u.error,log:u.log});
  }
  reader.ocr?.close();
  if(!review.closed)review.show(holes,unread.sort((a,b)=>a.doc-b.doc||a.page-b.page),problems);
}
