/** Fixed Qwen device experiment. It never changes the application's model selector or reviewed logs. */
import {CORE_AI_PROMPT_VERSION,coreAiPrompt} from "./coreAi";
import type {CoreBenchmarkProgress,CoreBenchmarkFailure} from "./coreBenchmarkDiagnostics";
export type {CoreBenchmarkProgress,CoreBenchmarkFailure,CoreBenchmarkStage} from "./coreBenchmarkDiagnostics";

export const CORE_BENCHMARK_MODEL={id:"qwen3.5-0.8b-opt",label:"Qwen3.5 0.8B",repo:"onnx-community/Qwen3.5-0.8B-ONNX-OPT",revision:"9a4c21d8f724176b0a7edaaed36303044451886e",downloadMiB:1001,weightBytes:1049662346,
  dtype:{embed_tokens:"q4",vision_encoder:"fp32",decoder_model_merged:"q4"}} as const;
export const CORE_BENCHMARK_CACHE="geomodel3d-qwen-benchmark";
export const CORE_BENCHMARK_PROMPT=coreAiPrompt("describe");
export const CORE_BENCHMARK_PROMPT_VERSION=CORE_AI_PROMPT_VERSION;
export const CORE_BENCHMARK_RUNTIME_VERSION="4.3.2";
export const CORE_BENCHMARK_ONNX_VERSION="1.31.1";
export const CORE_BENCHMARK_TIMEOUT_MS=30*60_000;
export type CoreBenchmarkMode="quality"|"compatibility";
export type CoreBenchmarkRequest={caseId:string;image:string;expectedSha256:string;mode:CoreBenchmarkMode};
export type CoreBenchmarkAdapter={vendor:string;architecture:string;device:string;description:string;features:string[];softwareAdapter:boolean|null;
  limits:{maxBufferSize:number|null;maxStorageBufferBindingSize:number|null}};
export type CoreBenchmarkMemory={gpuMemoryBytes:null;jsHeapUsedBytes:number|null;scope:string};
export type CoreBenchmarkResult={
  caseId:string;mode:CoreBenchmarkMode;modelId:string;model:string;revision:string;dtypes:typeof CORE_BENCHMARK_MODEL.dtype;
  prompt:string;promptVersion:number;enableThinking:false;generation:{doSample:false;repetitionPenalty:1.1;maxNewTokens:number};
  text:string;generatedTokens:number;inputTokens:number;maxNewTokens:number;outputLimitReached:boolean;
  imageSha256:string;imageWidth:512;imageHeight:512;imageGrid:number[][];
  loadMs:number;preprocessingMs:number;inferenceMs:number;totalMs:number;firstTokenMs:number|null;tokensPerSecond:number;
  modelReused:boolean;cacheState:"available"|"unavailable";cached?:boolean;downloadBytes:number;
  device:"webgpu";runtimeVersion:string;onnxRuntimeVersion:string;adapter:CoreBenchmarkAdapter;memory:CoreBenchmarkMemory;
};
export type CoreBenchmarkWorkerRequest={type:"run";id:number;request:CoreBenchmarkRequest};
export type CoreBenchmarkWorkerResponse={type:"progress";id:number;progress:CoreBenchmarkProgress}|{type:"result";id:number;result:CoreBenchmarkResult}|{type:"error";id:number;message:string;diagnostic?:CoreBenchmarkFailure};

export function coreBenchmarkTokenLimit(mode:CoreBenchmarkMode){
  if(mode==="quality")return 128;
  if(mode==="compatibility")return 32;
  throw new Error("Choose a quality or compatibility benchmark.");
}

/** Only bounded, prepared local image bytes can enter this worker; filenames and source labels do not. */
export function validateCoreBenchmarkRequest(request:CoreBenchmarkRequest):Uint8Array<ArrayBuffer>{
  if(!request||typeof request!=="object"||!/^case-(?:0[1-9]|[1-3][0-9]|40)$/.test(request.caseId))throw new Error("Choose a case from the fixed forty-image benchmark.");
  coreBenchmarkTokenLimit(request.mode);
  if(typeof request.expectedSha256!=="string"||!/^[a-f0-9]{64}$/.test(request.expectedSha256))throw new Error("The benchmark image needs its frozen SHA-256 hash.");
  const prefix="data:image/png;base64,";
  if(typeof request.image!=="string"||!request.image.startsWith(prefix)||request.image.length>2_800_000)throw new Error("Benchmark input must be a local 512 × 512 PNG.");
  const encoded=request.image.slice(prefix.length);
  if(!encoded.length||encoded.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw new Error("Invalid benchmark PNG encoding.");
  const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
  if(bytes.length<33||[137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82].some((byte,i)=>bytes[i]!==byte))throw new Error("Invalid benchmark PNG header.");
  const view=new DataView(bytes.buffer);
  if(view.getUint32(16)!==512||view.getUint32(20)!==512)throw new Error("Benchmark input must be exactly 512 × 512 pixels.");
  return bytes;
}
export async function verifyCoreBenchmarkImage(request:CoreBenchmarkRequest){
  const bytes=validateCoreBenchmarkRequest(request);
  if(!globalThis.crypto?.subtle)throw new Error("Secure image hashing is unavailable. Open the benchmark over HTTPS or localhost.");
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(b=>b.toString(16).padStart(2,"0")).join("");
  if(hash!==request.expectedSha256)throw new Error("The benchmark image does not match its frozen SHA-256 hash. No model was downloaded.");
  return {bytes,sha256:hash};
}

/** Adapter metadata is a capability observation; absent or masked identification remains unknown. */
export function coreBenchmarkAdapterMetadata(adapter:unknown):CoreBenchmarkAdapter{
  const value=adapter as {features?:Iterable<unknown>;info?:Record<string,unknown>;limits?:Record<string,unknown>};
  const text=(key:string)=>typeof value?.info?.[key]==="string"?String(value.info[key]).slice(0,256):"";
  const vendor=text("vendor"),architecture=text("architecture"),device=text("device"),description=text("description");
  const identity=[vendor,architecture,device,description].join(" ").toLowerCase();
  const softwareAdapter=/swiftshader|llvmpipe|software|lavapipe|microsoft basic render/.test(identity)?true:/apple|nvidia|intel|\bamd\b|qualcomm|adreno|mali/.test(identity)?false:null;
  const limit=(key:string)=>typeof value?.limits?.[key]==="number"&&Number.isFinite(value.limits[key])&&Number(value.limits[key])>=0?Number(value.limits[key]):null;
  return {vendor,architecture,device,description,features:value?.features?Array.from(value.features).filter((v):v is string=>typeof v==="string").slice(0,128).sort():[],softwareAdapter,
    limits:{maxBufferSize:limit("maxBufferSize"),maxStorageBufferBindingSize:limit("maxStorageBufferBindingSize")}};
}
export function coreBenchmarkMemoryMetadata(performanceValue:unknown=performance):CoreBenchmarkMemory{
  const used=(performanceValue as {memory?:{usedJSHeapSize?:unknown}})?.memory?.usedJSHeapSize;
  return {gpuMemoryBytes:null,jsHeapUsedBytes:typeof used==="number"&&Number.isFinite(used)&&used>=0?used:null,
    scope:"Total GPU memory is unavailable through WebGPU. Optional worker JS heap bytes exclude GPU allocations and are not total model memory."};
}

/** Verify response binding and whitelist exported fields so a worker cannot add image bytes to a report. */
export function checkedCoreBenchmarkResult(value:CoreBenchmarkResult,request:CoreBenchmarkRequest):CoreBenchmarkResult{
  const max=coreBenchmarkTokenLimit(request.mode),config=CORE_BENCHMARK_MODEL;
  if(!value||value.caseId!==request.caseId||value.mode!==request.mode||value.modelId!==config.id||value.model!==config.repo||value.revision!==config.revision
    ||value.imageSha256!==request.expectedSha256||value.imageWidth!==512||value.imageHeight!==512||value.device!=="webgpu"
    ||value.runtimeVersion!==CORE_BENCHMARK_RUNTIME_VERSION||value.onnxRuntimeVersion!==CORE_BENCHMARK_ONNX_VERSION
    ||value.prompt!==CORE_BENCHMARK_PROMPT||value.promptVersion!==CORE_BENCHMARK_PROMPT_VERSION||value.enableThinking!==false
    ||value.maxNewTokens!==max||value.generation?.maxNewTokens!==max||value.generation?.doSample!==false||value.generation?.repetitionPenalty!==1.1
    ||Object.entries(config.dtype).some(([key,dtype])=>value.dtypes?.[key as keyof typeof config.dtype]!==dtype))throw new Error("Benchmark response does not match the selected image, model or protocol.");
  if(typeof value.text!=="string"||!value.text.trim()||value.text.length>16384||!Number.isSafeInteger(value.generatedTokens)||value.generatedTokens<1||value.generatedTokens>max
    ||!Number.isSafeInteger(value.inputTokens)||value.inputTokens<1||value.outputLimitReached!==(value.generatedTokens>=max))throw new Error("Benchmark returned an invalid or empty output.");
  for(const key of ["loadMs","preprocessingMs","inferenceMs","totalMs","tokensPerSecond","downloadBytes"] as const)
    if(!Number.isFinite(value[key])||value[key]<0)throw new Error("Benchmark returned invalid timing metadata.");
  if(value.firstTokenMs!==null&&(!Number.isFinite(value.firstTokenMs)||value.firstTokenMs<0||value.firstTokenMs>value.inferenceMs+1))throw new Error("Benchmark returned invalid first-token timing.");
  if(typeof value.modelReused!=="boolean"||!["available","unavailable"].includes(value.cacheState)||value.cached!==undefined&&typeof value.cached!=="boolean")throw new Error("Benchmark returned invalid cache metadata.");
  if(!value.adapter||!Array.isArray(value.adapter.features)||value.adapter.features.length>128||value.adapter.features.some(f=>typeof f!=="string")
    ||![true,false,null].includes(value.adapter.softwareAdapter)||!value.adapter.limits||!value.memory||value.memory.gpuMemoryBytes!==null)throw new Error("Benchmark returned invalid device metadata.");
  for(const key of ["vendor","architecture","device","description"] as const)if(typeof value.adapter[key]!=="string"||value.adapter[key].length>256)throw new Error("Benchmark returned invalid adapter metadata.");
  for(const n of [value.adapter.limits.maxBufferSize,value.adapter.limits.maxStorageBufferBindingSize,value.memory.jsHeapUsedBytes])if(n!==null&&(!Number.isFinite(n)||n<0))throw new Error("Benchmark returned invalid memory metadata.");
  if(!Array.isArray(value.imageGrid)||value.imageGrid.length!==1||value.imageGrid[0].length!==3||value.imageGrid[0].some(n=>!Number.isSafeInteger(n)||n<1))throw new Error("Benchmark returned invalid image-grid metadata.");
  return {caseId:value.caseId,mode:value.mode,modelId:value.modelId,model:value.model,revision:value.revision,dtypes:{...config.dtype},
    prompt:value.prompt,promptVersion:value.promptVersion,enableThinking:false,generation:{doSample:false,repetitionPenalty:1.1,maxNewTokens:max},
    text:value.text,generatedTokens:value.generatedTokens,inputTokens:value.inputTokens,maxNewTokens:max,outputLimitReached:value.outputLimitReached,
    imageSha256:value.imageSha256,imageWidth:512,imageHeight:512,imageGrid:value.imageGrid.map(row=>[...row]),
    loadMs:value.loadMs,preprocessingMs:value.preprocessingMs,inferenceMs:value.inferenceMs,totalMs:value.totalMs,firstTokenMs:value.firstTokenMs,tokensPerSecond:value.tokensPerSecond,
    modelReused:value.modelReused,cacheState:value.cacheState,...(value.cached===undefined?{}:{cached:value.cached}),downloadBytes:value.downloadBytes,
    device:"webgpu",runtimeVersion:value.runtimeVersion,onnxRuntimeVersion:value.onnxRuntimeVersion,
    adapter:{vendor:value.adapter.vendor,architecture:value.adapter.architecture,device:value.adapter.device,description:value.adapter.description,
      features:[...value.adapter.features],softwareAdapter:value.adapter.softwareAdapter,limits:{maxBufferSize:value.adapter.limits.maxBufferSize,maxStorageBufferBindingSize:value.adapter.limits.maxStorageBufferBindingSize}},
    memory:{gpuMemoryBytes:null,jsHeapUsedBytes:value.memory.jsHeapUsedBytes,scope:coreBenchmarkMemoryMetadata().scope}};
}
