// Borehole logs read from PDFs on this device, loaded only when a PDF is dropped or picked (and the user has agreed):
// each PDF is opened with PDF.js, the text of each page is read into logs (reconstruct.ts), and the review opens on
// them. The page being read shows as it goes, and Cancel stops it. Scanned pages are listed as not read.
import {openPdf,pageText,PageText} from "./pdftext";
import {readDocument} from "./reconstruct";
import {draftHoles,DraftHole} from "./draft";
import {createReview,ReviewHost,Unread} from "./review";

export async function readPdfs(files:File[],host:ReviewHost){
  const review=createReview(host);
  document.body.appendChild(review.element);
  const holes:DraftHole[]=[],unread:Unread[]=[],problems:string[]=[];
  for(const f of files){
    if(review.closed)return;
    review.progress(`Opening ${f.name}…`);
    let d;
    try{d=await openPdf(f.name,new Uint8Array(await f.arrayBuffer()))}
    catch(err){problems.push(`${f.name}: not read, as ${(err as Error).message}.`);continue}
    if(review.closed){void d.close();return}
    const doc=review.addDoc(d),pages:PageText[]=[];
    for(let n=1;n<=d.pages;n++){
      if(review.closed)return;
      review.progress(`Reading ${f.name}: page ${n} of ${d.pages}`);
      try{
        const t=await pageText(d,n);
        review.size(doc,n,t.width,t.height);
        if(t.scanned)unread.push({doc,page:n,scanned:true,error:"a scanned image"});else pages.push(t);
      }catch(err){unread.push({doc,page:n,error:`it could not be read (${(err as Error).message})`})}
    }
    const read=readDocument(pages);
    holes.push(...draftHoles(doc,f.name,read.logs));
    for(const u of read.unread)unread.push({doc,page:u.page,id:u.id,error:u.error,log:u.log});
  }
  if(!review.closed)review.show(holes,unread.sort((a,b)=>a.doc-b.doc||a.page-b.page),problems);
}
