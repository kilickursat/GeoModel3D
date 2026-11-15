import {CORE_AI_CACHE,validateCoreAiRequest} from "./coreAi";
import type {CoreAiProgress,CoreAiRequest,CoreAiResult,CoreAiWorkerResponse} from "./coreAi";

export type CoreAiSupport = {supported:boolean;reason?:string};
function hostingSupport():CoreAiSupport {
  if(typeof location!=="undefined"&&location.protocol==="file:"||typeof document!=="undefined"&&document.querySelector('meta[name="geomodel3d-standalone"]'))
    return {supported:false,reason:"Local AI requires the hosted GeoModel3D web app. The standalone HTML keeps the manual core-photo workflow."};
  if(typeof isSecureContext!=="undefined"&&!isSecureContext)return {supported:false,reason:"Local AI requires a secure HTTPS connection or localhost."};
  return {supported:true};
}
export async function coreAiSupport():Promise<CoreAiSupport> {
  const hosting=hostingSupport();if(!hosting.supported)return hosting;
  const gpu=(typeof navigator!=="undefined"?navigator:undefined) as unknown as {gpu?:{requestAdapter:()=>Promise<unknown>}}|undefined;
  if(!gpu?.gpu)return {supported:false,reason:"WebGPU is unavailable in this browser. Local AI needs a browser and device with WebGPU; the manual workflow remains available."};
  try{return await gpu.gpu.requestAdapter()?{supported:true}:{supported:false,reason:"No WebGPU adapter is available on this device. Try a WebGPU-capable browser or device."}}
  catch{return {supported:false,reason:"This browser could not initialize WebGPU. Try a WebGPU-capable browser or device."}}
}

/** Deletes only this experiment's model cache. The caller first unloads its idle model. */
export async function clearCoreAiCache():Promise<boolean> {
  if(typeof caches==="undefined")throw new Error("Browser model-cache storage is unavailable.");
  return caches.delete(CORE_AI_CACHE);
}

type Pending = {id:number;resolve:(value:CoreAiResult)=>void;reject:(reason:Error)=>void;progress?:(value:CoreAiProgress)=>void;timer:ReturnType<typeof setTimeout>};
type ClientOptions = {workerFactory?:()=>Worker;timeoutMs?:number;supportCheck?:()=>Promise<CoreAiSupport>};
/** Downloads begin only in run(). Terminating this dedicated worker cancels downloads and GPU sessions. */
export class CoreAiClient {
  private worker?:Worker;
  private pending?:Pending;
  private sequence=0;
  private disposed=false;
  constructor(private readonly options:ClientOptions={}){}
  run(request:CoreAiRequest,onProgress?:(value:CoreAiProgress)=>void):Promise<CoreAiResult> {
    if(this.disposed)return Promise.reject(new Error("This local AI client has been disposed."));
    if(this.pending)return Promise.reject(new Error("A local AI request is already running."));
    try{validateCoreAiRequest(request)}catch(error){return Promise.reject(error)}
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail(new Error("Local AI timed out. The model has been unloaded; try the smaller model or another device.")),this.options.timeoutMs??20*60_000);
      this.pending={id,resolve,reject,progress:onProgress,timer};
      void this.start(id,request);
    });
  }
  private async start(id:number,request:CoreAiRequest){
    try{
      this.pending?.progress?.({phase:"checking",message:"Checking local WebGPU support…"});
      const support=await (this.options.supportCheck??coreAiSupport)();
      if(this.pending?.id!==id)return;
      if(!support.supported)throw new Error(support.reason??"Local AI is unavailable.");
      if(!this.worker){
        const worker=(this.options.workerFactory??(()=>new Worker(new URL("./coreAi.worker.ts",import.meta.url),{type:"module"})))();
        this.worker=worker;
        worker.onmessage=(event:MessageEvent<CoreAiWorkerResponse>)=>{
          const message=event.data,pending=this.pending;
          if(this.worker!==worker||!pending||message.id!==pending.id)return;
          if(message.type==="progress")pending.progress?.(message.progress);
          else if(message.type==="result"){clearTimeout(pending.timer);this.pending=undefined;pending.resolve(message.result)}
          else if(message.type==="error")this.fail(new Error(message.message));
        };
        worker.onerror=event=>{if(this.worker===worker)this.fail(new Error(event.message||"Local AI worker failed. The model has been unloaded."))};
        worker.onmessageerror=()=>{if(this.worker===worker)this.fail(new Error("Local AI returned an unreadable response."))};
      }
      this.worker.postMessage({type:"run",id,request});
    }catch(error){if(this.pending?.id===id)this.fail(error instanceof Error?error:new Error(String(error)))}
  }
  private fail(error:Error){
    const pending=this.pending;this.pending=undefined;
    this.worker?.terminate();this.worker=undefined;
    if(pending){clearTimeout(pending.timer);pending.reject(error)}
  }
  stop(){this.fail(new DOMException("Local AI cancelled and unloaded.","AbortError"))}
  dispose(){this.stop();this.disposed=true}
}
