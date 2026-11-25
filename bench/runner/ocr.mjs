// OCR for the benchmark, by the app itself: the pages read.ts lists are drawn by the app's PDF code and read by the
// app's built OCR worker (PP-OCRv6 small) in headless Chromium, exactly as in the app. Each page's lines are saved as
// JSON under <run>/ocr/<report>/<doc>/p<n>.json, with the time the page took. Pages already saved are skipped, so a run
// can be stopped and resumed. Requests are answered by routing, as in the UI tests: no server is started and nothing
// is fetched from the network.
//
//   node bench/runner/ocr.mjs bench/.cache/runs/<run> [report ids]
//
// Needs the production build (npm run build) for the worker and the model files.
import {chromium} from "@playwright/test";
import {readFileSync,writeFileSync,readdirSync,existsSync,mkdirSync} from "node:fs";
import {createUiResponder} from "../../tests/browser/serve.mjs";

const [runDir,...only]=process.argv.slice(2);
const ORIGIN="https://geomodel3d.invalid";
const plan=JSON.parse(readFileSync(`${runDir}/ocr-plan.json`,"utf8"));
const jobs=[];
for(const [id,docs] of Object.entries(plan.reports)){
  if(only.length&&!only.includes(id))continue;
  for(const d of docs){
    const out=`${runDir}/ocr/${id}/${d.doc}`,pages=d.pages.filter(n=>!existsSync(`${out}/p${n}.json`));
    const rules=(d.rules??[]).filter(n=>!existsSync(`${out}/p${n}.rules.json`));
    if(pages.length||rules.length)jobs.push({id,doc:d.doc,file:d.file,out,pages,rules});
  }
}
const total=jobs.reduce((s,j)=>s+j.pages.length+j.rules.length,0);
if(!total){console.log("all pages read");process.exit(0)}
console.log(`${total} pages to read in ${jobs.length} documents`);
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
const context=await browser.newContext(),respond=await createUiResponder();
let current=null;
await context.route("**/*",async route=>{
  const url=new URL(route.request().url());
  if(!["http:","https:"].includes(url.protocol))return route.continue();
  if(url.origin!==ORIGIN)return route.abort();
  if(url.pathname==="/__doc.pdf")return route.fulfill({status:200,contentType:"application/pdf",body:current});
  const r=await respond(url.pathname,url.search);
  return route.fulfill({status:r.status,contentType:r.type,body:typeof r.body==="string"?r.body:Buffer.from(r.body)});
});
const page=await context.newPage();
await page.exposeFunction("savePage",(dir,n,json)=>{writeFileSync(`${dir}/p${n}.json`,json)});
await page.goto(ORIGIN+"/");
const worker=ORIGIN+"/assets/"+readdirSync("dist/assets").find(f=>/^ocr\.worker-.*\.js$/.test(f));
let done=0;
for(const job of jobs){
  mkdirSync(job.out,{recursive:true});
  current=readFileSync(job.file);
  const t0=Date.now();
  const backend=await page.evaluate(async ({pages,rules,worker,out})=>{
    const {openPdf}=await import("/src/docread/pdftext.ts");
    const {imageRules}=await import("/src/docread/ruling.ts");
    const d=await openPdf("doc.pdf",new Uint8Array(await (await fetch("/__doc.pdf")).arrayBuffer()));
    window.__ocr??=await (async()=>{
      const w=new Worker(worker,{type:"module"}),waiting=new Map();let next=1;
      const on=await new Promise((res,rej)=>{
        w.onmessage=e=>{const m=e.data;
          if(m.type==="ready")res(m.backend);
          else if(m.type==="lines"){waiting.get(m.id)?.res(m.lines);waiting.delete(m.id)}
          else if(m.type==="error"){if(m.id!==undefined&&waiting.has(m.id)){waiting.get(m.id).rej(new Error(m.message));waiting.delete(m.id)}else rej(new Error(m.message))}};
        w.onerror=e=>rej(new Error(e.message||"worker stopped"));
        w.postMessage({type:"load",base:new URL("ocr/pp-ocrv6-small/",document.baseURI).href});
      });
      const read=img=>new Promise((res,rej)=>{const id=next++;waiting.set(id,{res,rej});w.postMessage({type:"read",id,width:img.width,height:img.height,data:img.data.buffer},[img.data.buffer])});
      return {on,read};
    })();
    // The ruled lines of a page's image, as the app finds them (before the image goes to the worker).
    for(const n of rules){
      const img=await d.image(n);
      await window.savePage(out,`${n}.rules`,JSON.stringify({page:n,width:img.width,height:img.height,rules:imageRules(img)}));
    }
    for(const n of pages){
      const t0=performance.now(),img=await d.image(n),width=img.width,height=img.height,lines=await window.__ocr.read(img);
      await window.savePage(out,n,JSON.stringify({page:n,width,height,ms:Math.round(performance.now()-t0),backend:window.__ocr.on,lines}));
    }
    await d.close();
    return window.__ocr.on;
  },{pages:job.pages,rules:job.rules,worker,out:job.out});
  done+=job.pages.length+job.rules.length;
  console.log(`${job.id} doc ${job.doc}: ${job.pages.length} pages in ${Math.round((Date.now()-t0)/1000)} s (${backend}); ${done}/${total}`);
}
await browser.close();
process.exit(0);
