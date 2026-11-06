// The reading model for scanned pages, in a worker of its own: PP-OCRv6 small's detection and recognition models run by
// ONNX Runtime Web, on the graphics processor through WebGPU where the browser has it, else on the processor
// (WebAssembly, one thread: the site cannot enable more). The model files come from the app's own site, are checked
// against the sizes and SHA-256 sums the build wrote (scripts/fetch-ocr-models.mjs), and are kept in the browser's
// cache storage, from which Help can remove them. A page goes in as RGBA pixels and comes back as lines of text with
// their boxes, in its pixels.
//
// Messages in: {type:"load", base} (the folder of the model files), {type:"read", id, width, height, data}.
// Messages out: {type:"progress", loaded, total} while downloading, {type:"ready", backend, gpu}, {type:"boxes", id, done,
// total} while reading, {type:"lines", id, lines}, {type:"backend", backend, reason} when WebGPU fails and the
// processor takes over, {type:"error", id?, message}.
import * as ort from "onnxruntime-web/webgpu";
// The build of ONNX Runtime this bundle runs: WebGPU (its native backend) and the processor in one WebAssembly file.
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import {Img,DetSettings,Reading,OcrLine,detInput,dbBoxes,crop,recInput,ctcDecode,ctcClasses,readBox} from "./ocr";
import {MODEL_CACHE} from "../modelcache";

interface Manifest { model:string; files:Record<string,{size:number;sha256:string}>; runtime?:{file:string;size:number;sha256:string} }
interface Settings { det:DetSettings; rec:{characters:string[]} }
type Backend="webgpu"|"wasm";

const post=(m:unknown)=>(self as unknown as Worker).postMessage(m);
const hex=(b:ArrayBuffer)=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
const digest=async(b:ArrayBuffer|Uint8Array)=>hex(await crypto.subtle.digest("SHA-256",b as BufferSource));

// A file of the model: from the cache where a whole copy is kept, else downloaded, checked and kept.
async function fetchFile(url:string,size:number,sha:string,tick:(n:number)=>void):Promise<Uint8Array>{
  let cache:Cache|undefined;
  try{cache=await caches.open(MODEL_CACHE)}catch{/* no cache storage: downloaded each time */}
  const hit=await cache?.match(url);
  if(hit){
    const b=new Uint8Array(await hit.arrayBuffer());
    if(b.length===size&&await digest(b)===sha){tick(size);return b}
    await cache?.delete(url);
  }
  const res=await fetch(url);
  if(!res.ok||!res.body)throw new Error(`${url.split("/").pop()} could not be downloaded (HTTP ${res.status})`);
  const reader=res.body.getReader(),parts:Uint8Array[]=[];
  let n=0;
  for(;;){const {done,value}=await reader.read();if(done)break;parts.push(value);n+=value.length;tick(value.length)}
  const b=new Uint8Array(n);
  let o=0;for(const p of parts){b.set(p,o);o+=p.length}
  if(n!==size||await digest(b)!==sha)throw new Error(`${url.split("/").pop()} did not download whole: try again`);
  try{await cache?.put(url,new Response(b))}catch{/* storage full: kept for this page only */}
  return b;
}

let settings:Settings,classes:string[],det:ort.InferenceSession,rec:ort.InferenceSession,backend:Backend="wasm",files:Record<string,Uint8Array>={};
const create=(bytes:Uint8Array,ep:Backend)=>ort.InferenceSession.create(bytes,{executionProviders:[ep],logSeverityLevel:3});
async function sessions(ep:Backend){
  const d=await create(files.det,ep),r=await create(files.rec,ep).catch(e=>{void d.release();throw e});
  await det?.release().catch(()=>undefined);await rec?.release().catch(()=>undefined);
  det=d;rec=r;backend=ep;
}

async function load(base:string){
  const manifest:Manifest=await (await fetch(base+"manifest.json",{cache:"no-cache"})).json();
  const want:Array<[string,string,{size:number;sha256:string}]>=[["det",base+"det.onnx",manifest.files["det.onnx"]],
    ["rec",base+"rec.onnx",manifest.files["rec.onnx"]],["ocr",base+"ocr.json",manifest.files["ocr.json"]]];
  if(manifest.runtime)want.push(["wasm",wasmUrl,manifest.runtime]);
  const total=want.reduce((s,[,,f])=>s+f.size,0);
  let loaded=0,last=0;
  const tick=(n:number)=>{loaded+=n;const now=Date.now();if(now-last>150||loaded>=total){last=now;post({type:"progress",loaded,total})}};
  const got=await Promise.all(want.map(([,url,f])=>fetchFile(url,f.size,f.sha256,tick)));
  want.forEach(([name],k)=>{files[name]=got[k]});
  settings=JSON.parse(new TextDecoder().decode(files.ocr));
  classes=ctcClasses(settings.rec.characters);
  ort.env.logLevel="error";
  ort.env.wasm.numThreads=1;
  ort.env.wasm.wasmBinary=files.wasm??new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  // WebGPU where an adapter is offered: the high-performance one, so that a computer with a graphics card beside the
  // processor's own graphics reads on the card (the browser decides which it gives). The adapter is handed to ONNX
  // Runtime, so the model runs on the very GPU asked for. The processor otherwise, or where WebGPU cannot build the model.
  type Adapter={info?:{vendor?:string}};
  const gpu=(navigator as Navigator&{gpu?:{requestAdapter(o?:{powerPreference?:string}):Promise<Adapter|null>}}).gpu;
  const adapter=gpu?await gpu.requestAdapter({powerPreference:"high-performance"}).catch(()=>null):null;
  if(adapter){
    ort.env.webgpu.adapter=adapter;
    ort.env.webgpu.powerPreference="high-performance";
    vendor=adapter.info?.vendor??"";
    try{await sessions("webgpu");return}catch{/* falls back below */}
  }
  await sessions("wasm");
}
// The maker of the GPU read on ("nvidia", "intel", "amd", "apple"…), where the browser says it.
let vendor="";

async function recognise(img:Img):Promise<Reading>{
  const x=recInput(img);
  const out=await rec.run({[rec.inputNames[0]]:new ort.Tensor("float32",x.data,[1,3,48,x.width])});
  const o=out[rec.outputNames[0]],[,T,C]=o.dims;
  const r=ctcDecode(o.data as Float32Array,T,C,classes);
  o.dispose();
  return r;
}
async function read(img:Img,id:number):Promise<OcrLine[]>{
  const x=detInput(img,settings.det);
  const out=await det.run({[det.inputNames[0]]:new ort.Tensor("float32",x.data,[1,3,x.height,x.width])});
  const prob=out[det.outputNames[0]],boxes=dbBoxes(prob.data as Float32Array,x.width,x.height,img.width,img.height,settings.det);
  prob.dispose();
  const lines:OcrLine[]=[],r1=(v:number)=>Math.round(v*10)/10;
  for(let k=0;k<boxes.length;k++){
    const c=crop(img,boxes[k]);
    if(c){const r=await readBox(c,recognise);if(r.text)lines.push({text:r.text,conf:Math.round(r.conf*1000)/1000,x0:r1(boxes[k].x0),y0:r1(boxes[k].y0),x1:r1(boxes[k].x1),y1:r1(boxes[k].y1)})}
    if(k%8===7||k===boxes.length-1)post({type:"boxes",id,done:k+1,total:boxes.length});
  }
  return lines.sort((p,q)=>p.y0-q.y0||p.x0-q.x0);
}

// One message at a time, in the order they came.
let queue:Promise<unknown>=Promise.resolve();
self.onmessage=(e:MessageEvent)=>{
  const m=e.data as {type:"load";base:string}|{type:"read";id:number;width:number;height:number;data:ArrayBuffer};
  queue=queue.then(async()=>{
    try{
      if(m.type==="load"){await load(m.base);post({type:"ready",backend,gpu:backend==="webgpu"?vendor:""});return}
      const img={data:new Uint8ClampedArray(m.data),width:m.width,height:m.height};
      let lines:OcrLine[];
      try{lines=await read(img,m.id)}
      catch(err){
        // A graphics processor that fails while reading (memory, a lost device) hands over to the processor.
        if(backend!=="webgpu")throw err;
        await sessions("wasm");
        post({type:"backend",backend,reason:(err as Error).message});
        lines=await read(img,m.id);
      }
      post({type:"lines",id:m.id,lines});
    }catch(err){post({type:"error",id:m.type==="read"?m.id:undefined,message:(err as Error).message||String(err)})}
  });
};
