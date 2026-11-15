import {CORE_BENCHMARK_CACHE,CORE_BENCHMARK_TIMEOUT_MS,checkedCoreBenchmarkResult,coreBenchmarkAdapterMetadata,validateCoreBenchmarkRequest,verifyCoreBenchmarkImage} from "./coreBenchmark";
import type {CoreBenchmarkAdapter,CoreBenchmarkProgress,CoreBenchmarkRequest,CoreBenchmarkResult,CoreBenchmarkWorkerResponse} from "./coreBenchmark";
import {CoreBenchmarkError,checkedCoreBenchmarkProgress,checkedCoreBenchmarkFailure,coreBenchmarkFailure} from "./coreBenchmarkDiagnostics";
import type {CoreBenchmarkStage} from "./coreBenchmarkDiagnostics";

export type CoreBenchmarkSupport={supported:boolean;reason?:string;adapter?:CoreBenchmarkAdapter};
export async function coreBenchmarkSupport():Promise<CoreBenchmarkSupport>{
  if(typeof location!=="undefined"&&location.protocol==="file:"||typeof document!=="undefined"&&document.querySelector('meta[name="geomodel3d-standalone"]'))
    return {supported:false,reason:"The device benchmark requires its hosted HTTPS page. Manual core-photo logging remains available offline."};
  if(typeof isSecureContext!=="undefined"&&!isSecureContext)return {supported:false,reason:"Open the device benchmark over HTTPS or localhost."};
  if(!globalThis.crypto?.subtle)return {supported:false,reason:"Secure image hashing is unavailable in this browser."};
  const gpu=(typeof navigator!=="undefined"?navigator:undefined) as unknown as {gpu?:{requestAdapter:()=>Promise<unknown>}}|undefined;
  if(!gpu?.gpu)return {supported:false,reason:"WebGPU is unavailable in this browser. No model was downloaded."};
  try{const adapter=await gpu.gpu.requestAdapter();return adapter?{supported:true,adapter:coreBenchmarkAdapterMetadata(adapter)}:{supported:false,reason:"No WebGPU adapter is available on this device. No model was downloaded."}}
  catch{return {supported:false,reason:"This browser could not initialize WebGPU. No model was downloaded."}}
}
/** Delete only this experiment's cache; the UI unloads its model before calling this. */
export async function clearCoreBenchmarkCache(){
  if(typeof caches==="undefined")throw new Error("Browser model-cache storage is unavailable.");
  return caches.delete(CORE_BENCHMARK_CACHE);
}

type Pending={id:number;request:CoreBenchmarkRequest;resolve:(result:CoreBenchmarkResult)=>void;reject:(reason:Error)=>void;progress?:(progress:CoreBenchmarkProgress)=>void;stage:CoreBenchmarkStage;timer:ReturnType<typeof setTimeout>};
type Options={workerFactory?:()=>Worker;supportCheck?:()=>Promise<CoreBenchmarkSupport>;timeoutMs?:number};
/** One worker/model session, created only by Run. Stop terminates all pending downloads and GPU computation. */
export class CoreBenchmarkClient{
  private worker?:Worker;
  private pending?:Pending;
  private sequence=0;
  private disposed=false;
  constructor(private readonly options:Options={}){
    if(options.timeoutMs!==undefined&&(!Number.isFinite(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>CORE_BENCHMARK_TIMEOUT_MS))throw new Error("Benchmark timeout must be positive and no more than thirty minutes per case.");
  }
  run(value:CoreBenchmarkRequest,onProgress?:(progress:CoreBenchmarkProgress)=>void):Promise<CoreBenchmarkResult>{
    if(this.disposed)return Promise.reject(new Error("This benchmark client has been disposed."));
    if(this.pending)return Promise.reject(new Error("A benchmark case is already running."));
    let request:CoreBenchmarkRequest;
    try{validateCoreBenchmarkRequest(value);request={caseId:value.caseId,image:value.image,expectedSha256:value.expectedSha256,mode:value.mode}}
    catch(error){return Promise.reject(error)}
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail(new Error("This benchmark case timed out after its device budget. The model has been unloaded; the failed case must remain in the report.")),this.options.timeoutMs??CORE_BENCHMARK_TIMEOUT_MS);
      this.pending={id,request,resolve,reject,progress:onProgress,stage:"image-verify",timer};
      void this.start(id,request);
    });
  }
  private async start(id:number,request:CoreBenchmarkRequest){
    try{
      this.pending?.progress?.({phase:"checking",stage:"image-verify",message:"Verifying the frozen image and this device's WebGPU support…"});
      await verifyCoreBenchmarkImage(request);
      if(this.pending?.id!==id)return;
      this.pending.stage="client-webgpu";
      this.pending.progress?.({phase:"checking",stage:"client-webgpu",message:"Checking browser WebGPU before starting the worker…"});
      const support=await (this.options.supportCheck??coreBenchmarkSupport)();
      if(this.pending?.id!==id)return;
      if(!support.supported)throw new Error(support.reason??"WebGPU is unavailable.");
      this.pending.stage="worker-start";
      this.pending.progress?.({phase:"checking",stage:"worker-start",message:this.worker?"Sending the verified image to the model worker…":"Starting the model worker…"});
      if(!this.worker){
        const worker=(this.options.workerFactory??(()=>new Worker(new URL("./coreBenchmark.worker.ts",import.meta.url),{type:"module"})))();
        this.worker=worker;
        worker.onmessage=(event:MessageEvent<CoreBenchmarkWorkerResponse>)=>{
          const message=event.data,pending=this.pending;
          if(this.worker!==worker||!pending||!message||message.id!==pending.id)return;
          if(message.type==="progress"){
            try{const progress=checkedCoreBenchmarkProgress(message.progress);if(progress.stage)pending.stage=progress.stage;pending.progress?.(progress)}
            catch(error){this.fail(new CoreBenchmarkError(coreBenchmarkFailure(error,pending.stage,{operation:"worker"})))}
          }else if(message.type==="result"){
            try{const result=checkedCoreBenchmarkResult(message.result,pending.request);clearTimeout(pending.timer);this.pending=undefined;pending.resolve(result)}
            catch(error){this.fail(error instanceof Error?error:new Error(String(error)))}
          }else if(message.type==="error"){
            try{this.fail(new CoreBenchmarkError(message.diagnostic?checkedCoreBenchmarkFailure(message.diagnostic):coreBenchmarkFailure(new Error(typeof message.message==="string"?message.message:"The benchmark worker failed."),pending.stage,{operation:"worker"})))}
            catch(error){this.fail(new CoreBenchmarkError(coreBenchmarkFailure(error,pending.stage,{operation:"worker"})))}
          }
        };
        worker.onerror=event=>{if(this.worker===worker&&this.pending)this.fail(new CoreBenchmarkError(coreBenchmarkFailure(new Error(event.message||"The benchmark worker failed. Its model has been unloaded."),this.pending.stage,{operation:"worker"})))};
        worker.onmessageerror=()=>{if(this.worker===worker&&this.pending)this.fail(new CoreBenchmarkError(coreBenchmarkFailure(new Error("The benchmark worker returned an unreadable response."),this.pending.stage,{operation:"worker"})))};
      }
      this.worker.postMessage({type:"run",id,request});
    }catch(error){if(this.pending?.id===id)this.fail(new CoreBenchmarkError(coreBenchmarkFailure(error,this.pending.stage)))}
  }
  private fail(error:Error){
    const pending=this.pending;this.pending=undefined;this.worker?.terminate();this.worker=undefined;
    if(pending){clearTimeout(pending.timer);pending.reject(error)}
  }
  stop(){this.fail(new DOMException("Benchmark cancelled and model unloaded.","AbortError"))}
  dispose(){this.stop();this.disposed=true}
}
