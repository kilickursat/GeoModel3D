import {readFileSync,writeFileSync,existsSync,mkdirSync,readdirSync,realpathSync} from "node:fs";
import {createHash} from "node:crypto";
import {basename,resolve,sep} from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {extractPageText,scanReason} from "../../src/docread/pdfpage";
import {agreement} from "../../src/docread/textlines";
import {readDocument,textLine} from "../../src/docread/reconstruct";
import {joinRules,scaleRules} from "../../src/docread/ruling";
import {draftHoles,checkDraft,DraftHole} from "../../src/docread/draft";

const CONFIRMED=0.6;
const pct=(v:number)=>`${Math.round(100*v)} %`;
// The caller supplies a fresh temporary run directory and the input files. No report catalogue or downloads.
const [mode,runDir,caseId,...inputFiles]=process.argv.slice(2);
if(!["plan","read"].includes(mode)||!runDir||!caseId||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(caseId)||!inputFiles.length){
  console.error("usage: plan|read TEMP_DIR CASE_ID PDF [PDF ...]");process.exit(2);
}
mkdirSync(runDir,{recursive:true});
const scratch=realpathSync(runDir),checkout=realpathSync(".");
if(scratch===checkout||scratch.startsWith(checkout+sep))throw new Error("Choose a temporary run directory outside this checkout.");
if(mode==="plan"&&readdirSync(scratch).length)throw new Error("Use an empty temporary directory for each benchmark run.");
const documents=inputFiles.map(input=>({name:basename(input),file:resolve(input)}));
const planFile=resolve(runDir,"ocr-plan.json");
const planned=mode==="read"?JSON.parse(readFileSync(planFile,"utf8")).reports[caseId]:undefined;
if(mode==="read"&&planned?.length!==documents.length)throw new Error("The selected case or document count differs from the plan.");

// The pages of one document as the app judges them before any OCR.
async function judge(file:string){
  const data=new Uint8Array(readFileSync(file));
  const t0=performance.now();
  const task=pdfjs.getDocument({data,cMapUrl:"node_modules/pdfjs-dist/cmaps/",cMapPacked:true,
    standardFontDataUrl:"node_modules/pdfjs-dist/standard_fonts/",verbosity:0}),doc=await task.promise;
  const pages:any[]=[],scan:number[]=[],doubt:number[]=[],why=new Map<number,string>();
  for(let n=1;n<=doc.numPages;n++){
    const t=await extractPageText(await doc.getPage(n),pdfjs.OPS),reason=scanReason(t);
    if(reason){scan.push(n);why.set(n,reason)}
    else{pages.push(t);if(t.layer==="doubtful")doubt.push(n)}
  }
  // As index.ts: a log page whose text gives no depth scale is read by OCR too, unless its text is prose.
  const prose=(n:number)=>(pages.find(p=>p.page===n)?.lines??[]).filter((l:any)=>l.text.trim().split(/\s+/).length>=8).length>=5;
  for(const u of readDocument(pages).unread)if(u.log&&u.error==="no depth scale found"&&!scan.includes(u.page)&&!doubt.includes(u.page)&&!prose(u.page)){
    scan.push(u.page);why.set(u.page,"a log page whose text gives no depth scale");
  }
  scan.sort((a,b)=>a-b);
  // As index.ts: a log page read from its text with no layers (boundaries drawn only) is read again with the lines
  // found on its image.
  const drawn=[...new Set(readDocument(pages).unread.filter(u=>u.log&&u.error==="no layers found"&&!scan.includes(u.page)&&!doubt.includes(u.page)).map(u=>u.page))];
  const count=doc.numPages;
  await task.destroy();
  return {count,pages,scan,doubt,drawn,why,judgeMs:performance.now()-t0};
}

const cacheDir=(id:string,doc:number)=>`${runDir}/ocr/${id}/${doc}`;
// The app's lines of a page read by OCR, as ocr.mjs saved them.
const cached=(id:string,doc:number,n:number)=>{const f=`${cacheDir(id,doc)}/p${n}.json`;return existsSync(f)?JSON.parse(readFileSync(f,"utf8")):undefined};
// The ruled lines found on a page's image (ocr.mjs, with the app's own imageRules).
const cachedRules=(id:string,doc:number,n:number)=>{const f=`${cacheDir(id,doc)}/p${n}.rules.json`;return existsSync(f)?JSON.parse(readFileSync(f,"utf8")):undefined};

// The reader's units, named by the benchmark's principal materials.
const PRINCIPAL:Record<string,string>={"Made ground":"made_ground","Fill and topsoil":"made_ground","Peat":"peat_organic","Organic soil":"peat_organic",
  "Mudstone and siltstone":"rock","Sandstone":"rock","Limestone and chalk":"rock","Rock":"rock","Rock and cemented soil":"rock",
  "Volcanic ash soil":"volcanic_ash","Gravel":"gravel","Sand":"sand","Silt":"silt","Clay":"clay","Clay and silt":"clay_or_silt"};
const num=(s:string|undefined)=>{if(s===undefined)return null;const t=s.trim().replace(/^−/,"-").replace(",",".");return t!==""&&/^-?\d+(?:\.\d*)?$|^-?\.\d+$/.test(t)?Number(t):null};

function holeOut(h:DraftHole){
  const v=h.values,x=num(v.x),y=num(v.y),lat=num(v.lat),lon=num(v.lon);
  return {id:v.id,id_read:!h.flags.id,doc:h.doc,pages:h.pages,kind:h.kind,ocr:h.ocr,
    position:x!==null&&y!==null?{x,y}:lat!==null&&lon!==null?{lat,lon}:null,
    ground_elevation:num(v.ground),final_depth:num(v.final),water_depth:num(v.water),
    layers:h.layers.map(l=>({top:num(l.from),base:num(l.to),description:l.description,unit:l.unit,principal:PRINCIPAL[l.unit]??"other",...(l.flag?{flag:l.flag}:{})})),
    // Penetration in cm; n as a log prints it: the blows, scaled to 30 cm where the test went further or less far.
    spt:(h.spt??[]).map(t=>{const depth=num(t.depth),blows=num(t.blows),mm=num(t.penetration),pen=mm===null?null:mm/10;
      return {depth,blows,n:blows===null?null:pen===null||Math.abs(pen-30)<0.5?blows:Math.round(blows*30/pen),
        ...(pen!==null?{penetration_cm:pen}:{}),refusal:pen===null?(blows??0)>=50:pen<29.5}}).filter(t=>t.depth!==null&&t.blows!==null),
    rqd:(h.core?.runs??[]).filter(r=>r.rqd!==undefined).map(r=>({top:r.from??null,base:r.to??null,rqd:r.rqd,tcr:r.tcr??null,scr:r.scr??null})),
    core_pages:h.core?.pages??[]};
}

// What the app would do with the boreholes read: as the review's checks say (draft.ts), a model places only boreholes
// with a position; one borehole on its own is placed at the origin as a single column.
function readiness(holes:any[]){
  const placed=holes.filter(h=>h.position).length;
  if(!holes.length)return {decision:"abstain",reasons:["no_logs"],positioned_boreholes:0};
  if(holes.length===1)return {decision:"column_only",reasons:["single_borehole"],positioned_boreholes:placed};
  if(placed>=2)return {decision:"spatial_model",reasons:[],positioned_boreholes:placed};
  return {decision:"abstain",reasons:[placed?"too_few_positions":"no_positions"],positioned_boreholes:placed};
}

const sha=(f:string)=>createHash("sha256").update(readFileSync(f)).digest("hex");
mkdirSync(`${runDir}/predictions`,{recursive:true});
const plan:Array<{doc:number;file:string;sha256:string;pages:number[];rules:number[]}>=[];
const docs:any[]=[],holes:any[]=[],timing={judge_ms:0,read_ms:0,ocr_ms:0,ocr_pages:0,ocr_backend:new Set<string>()};
let missing=0;
for(const [k,f] of documents.entries()){
  const file=f.file,sha256=sha(file);
  if(mode==="read"&&(file!==planned[k].file||sha256!==planned[k].sha256))throw new Error("A source file changed after planning. Start a fresh run.");
  const j=await judge(file);
  timing.judge_ms+=j.judgeMs;
  const ocrPages=[...j.scan,...j.doubt];
  if(mode==="plan"){plan.push({doc:k,file,sha256,pages:ocrPages,rules:[...ocrPages,...j.drawn]});continue}
  const t0=performance.now(),pages=j.pages,read=new Set<number>(),why=j.why,lost:number[]=[],kept:number[]=[];
  for(const n of ocrPages){
    const c=cached(caseId,k,n);
    if(!c){lost.push(n);continue}
    timing.ocr_ms+=c.ms;timing.ocr_pages++;timing.ocr_backend.add(c.backend);
    const r=cachedRules(caseId,k,n);
    if(!r)lost.push(n);
    const ocr={page:n,width:c.width,height:c.height,lines:c.lines.map((l:any)=>({...textLine(l.text,l.x0,l.y0,l.x1,l.y1),page:n})),...(r?{rules:r.rules}:{})};
    const text=pages.find((p:any)=>p.page===n);
    if(j.doubt.includes(n)&&text){
      const a=agreement(text.lines.map((l:any)=>l.text),ocr.lines.map((l:any)=>l.text));
      if(a>=CONFIRMED){kept.push(n);continue}
      why.set(n,`PDF text that OCR did not confirm (${pct(a)} of its words read the same)`);
    }
    const at=pages.findIndex((p:any)=>p.page===n);if(at>=0)pages.splice(at,1);
    pages.push(ocr);read.add(n);
  }
  for(const n of j.drawn){
    const t=pages.find((p:any)=>p.page===n),r=cachedRules(caseId,k,n);
    if(!r){lost.push(n);continue}
    if(t)t.rules=joinRules([...(t.rules??[]),...scaleRules(r.rules,t.width/r.width)]);
  }
  missing+=lost.length;
  pages.sort((a:any,b:any)=>a.page-b.page);
  for(const p of pages)for(const l of p.lines)l.page=p.page;
  const r=readDocument(pages),drafts=draftHoles(k,f.name,r.logs,read,why),checks=checkDraft(drafts);
  timing.read_ms+=performance.now()-t0;
  const out=drafts.map(holeOut);
  holes.push(...out);
  docs.push({doc:k,file:f.name,sha256,pages:j.count,
    routes:{ocr:[...read].sort((a,b)=>a-b),ocr_why:Object.fromEntries([...read].map(n=>[n,why.get(n)])),doubtful_kept:kept,ocr_missing:lost},
    log_pages:[...new Set(out.flatMap(h=>h.pages))].sort((a,b)=>a-b),
    core_pages:[...new Set(out.flatMap(h=>h.core_pages))].sort((a,b)=>a-b),
    unread_log_pages:r.unread.filter(u=>u.log).map(u=>({page:u.page,id:u.id??null,error:u.error})),
    checks:checks.map(c=>({hole:c.hole,level:c.level,text:c.text}))});
}
if(mode==="read"){
  const pred={schema:"geomodel3d-bench-prediction/1.0.0",report_id:caseId,
    reader:{name:"GeoModel3D",version:process.env.READER_VERSION??"",commit:process.env.READER_COMMIT??"",ocr:"PP-OCRv6 small (app worker, headless Chromium)"},
    complete:missing===0,documents:docs,boreholes:holes,readiness:readiness(holes),
    timing:{judge_ms:Math.round(timing.judge_ms),read_ms:Math.round(timing.read_ms),ocr_ms:Math.round(timing.ocr_ms),ocr_pages:timing.ocr_pages,ocr_backend:[...timing.ocr_backend]}};
  writeFileSync(`${runDir}/predictions/${caseId}.json`,JSON.stringify(pred,null,1)+"\n");
  console.log(`${caseId}: ${holes.length} boreholes, OCR ${timing.ocr_pages} pages${missing?`, ${missing} pages not yet read by OCR`:""}`);
}
if(mode==="plan"){
  writeFileSync(`${runDir}/ocr-plan.json`,JSON.stringify({reports:{[caseId]:plan}},null,1)+"\n");
  console.log(`${caseId}: ${plan.reduce((sum,doc)=>sum+doc.pages.length,0)} pages to read by OCR`);
}
process.exit(0);
