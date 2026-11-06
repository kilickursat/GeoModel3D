// The reading model's worker (ocr.worker.ts) from the page's side: started when a scanned page is to be read, it
// downloads or opens the model, then reads pages one at a time. close() stops it at once, in the middle of a page too.
import type {OcrLine} from "./ocr";

export type OcrProgress =
  | {stage:"download";loaded:number;total:number}
  | {stage:"page";done:number;total:number}
  | {stage:"backend";backend:"webgpu"|"wasm";reason?:string};
// `ready` gives where the model runs, and the maker of the GPU where the browser says it.
export interface Ocr { ready:Promise<{backend:"webgpu"|"wasm";gpu:string}>; read(img:ImageData):Promise<OcrLine[]>; close():void }

export function createOcr(onProgress:(p:OcrProgress)=>void):Ocr{
  const worker=new Worker(new URL("./ocr.worker.ts",import.meta.url),{type:"module"});
  const waiting=new Map<number,{resolve(lines:OcrLine[]):void;reject(err:Error):void}>();
  let next=1,started=false,closed=false;
  let resolveReady:(b:{backend:"webgpu"|"wasm";gpu:string})=>void=()=>{},rejectReady:(e:Error)=>void=()=>{};
  const ready=new Promise<{backend:"webgpu"|"wasm";gpu:string}>((res,rej)=>{resolveReady=res;rejectReady=rej});
  ready.catch(()=>undefined);
  const fail=(err:Error)=>{rejectReady(err);for(const w of waiting.values())w.reject(err);waiting.clear()};
  worker.onmessage=(e:MessageEvent)=>{
    const m=e.data;
    if(m.type==="progress")onProgress({stage:"download",loaded:m.loaded,total:m.total});
    else if(m.type==="ready"){started=true;resolveReady({backend:m.backend,gpu:m.gpu??""})}
    else if(m.type==="boxes")onProgress({stage:"page",done:m.done,total:m.total});
    else if(m.type==="backend")onProgress({stage:"backend",backend:m.backend,reason:m.reason});
    else if(m.type==="lines"){waiting.get(m.id)?.resolve(m.lines);waiting.delete(m.id)}
    else if(m.type==="error"){
      const err=new Error(m.message);
      if(m.id!==undefined&&waiting.has(m.id)){waiting.get(m.id)!.reject(err);waiting.delete(m.id)}
      else if(!started)fail(err);
    }
  };
  worker.onerror=e=>{e.preventDefault();fail(new Error(e.message||"the reading model stopped"))};
  worker.postMessage({type:"load",base:new URL("ocr/pp-ocrv6-small/",document.baseURI).href});
  return {
    ready,
    read(img){
      if(closed)return Promise.reject(new Error("stopped"));
      const id=next++;
      return new Promise((resolve,reject)=>{
        waiting.set(id,{resolve,reject});
        worker.postMessage({type:"read",id,width:img.width,height:img.height,data:img.data.buffer},[img.data.buffer]);
      });
    },
    close(){if(closed)return;closed=true;worker.terminate();fail(new Error("stopped"))}
  };
}
