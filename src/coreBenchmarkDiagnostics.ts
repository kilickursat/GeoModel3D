/** Bounded, image-free observations. They identify a failure site, not its underlying cause. */
export const CORE_BENCHMARK_STAGES=["image-fetch","image-verify","client-webgpu","worker-start","worker-verify","worker-webgpu","cache-open","processor-load","model-load","preprocess","generate"] as const;
export type CoreBenchmarkStage=typeof CORE_BENCHMARK_STAGES[number];
export type CoreBenchmarkProgress={phase:"checking"|"loading"|"running";message:string;stage?:CoreBenchmarkStage;elapsedMs?:number;inferenceElapsedMs?:number;firstTokenMs?:number|null;generatedTokens?:number;maxNewTokens?:number;loaded?:number;total?:number;file?:string};
export type CoreBenchmarkFailure={stage:CoreBenchmarkStage;name:string;message:string;operation?:"fetch"|"read-response"|"http"|"cache-read"|"cache-write"|"worker";resource?:string;httpStatus?:number;loadedBytes?:number;totalBytes?:number};
const stages=new Set<string>(CORE_BENCHMARK_STAGES);
const operations=new Set(["fetch","read-response","http","cache-read","cache-write","worker"]);
const numeric=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)&&value>=0;

/** Do not retain credentials, signed URLs, image payloads or arbitrary stacks in diagnostics. */
export function benchmarkDiagnosticText(value:unknown,max=2048):string{
  if(typeof value!=="string")return "Unknown error";
  return value.replace(/data:[^\s"'<>]+/gi,"[data omitted]").replace(/https?:\/\/[^\s"'<>]+/gi,"[URL omitted]").replace(/blob:[^\s"'<>]+/gi,"[blob omitted]").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,"").slice(0,max);
}
export function benchmarkResourceName(value:unknown):string|undefined{
  if(typeof value!=="string"||value.length>256||!value||!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)||value.split("/").some(part=>part==="."||part===".."))return;
  return value;
}
export function checkedCoreBenchmarkProgress(value:unknown):CoreBenchmarkProgress{
  if(!value||typeof value!=="object")throw new Error("Invalid benchmark progress.");
  const v=value as Record<string,unknown>;
  if(!["checking","loading","running"].includes(String(v.phase))||typeof v.message!=="string"||v.message.length>4096)throw new Error("Invalid benchmark progress.");
  const result:CoreBenchmarkProgress={phase:v.phase as CoreBenchmarkProgress["phase"],message:benchmarkDiagnosticText(v.message)};
  if(v.stage!==undefined){if(!stages.has(String(v.stage)))throw new Error("Invalid benchmark stage.");result.stage=v.stage as CoreBenchmarkStage}
  if(v.file!==undefined){const file=benchmarkResourceName(v.file);if(file)result.file=file}
  for(const key of ["elapsedMs","inferenceElapsedMs","generatedTokens","maxNewTokens","loaded","total"] as const){
    if(v[key]!==undefined){if(!numeric(v[key]))throw new Error("Invalid benchmark progress measurement.");result[key]=v[key] as number}
  }
  if(v.firstTokenMs!==undefined){if(v.firstTokenMs!==null&&!numeric(v.firstTokenMs))throw new Error("Invalid first-token observation.");result.firstTokenMs=v.firstTokenMs as number|null}
  return result;
}
export function checkedCoreBenchmarkFailure(value:unknown):CoreBenchmarkFailure{
  if(!value||typeof value!=="object")throw new Error("Invalid benchmark failure.");
  const v=value as Record<string,unknown>;
  if(!stages.has(String(v.stage))||typeof v.name!=="string"||v.name.length>128||typeof v.message!=="string"||v.message.length>4096)throw new Error("Invalid benchmark failure.");
  const result:CoreBenchmarkFailure={stage:v.stage as CoreBenchmarkStage,name:benchmarkDiagnosticText(v.name,128),message:benchmarkDiagnosticText(v.message)};
  if(v.operation!==undefined){if(!operations.has(String(v.operation)))throw new Error("Invalid benchmark failure operation.");result.operation=v.operation as CoreBenchmarkFailure["operation"]}
  if(v.resource!==undefined){const resource=benchmarkResourceName(v.resource);if(resource)result.resource=resource}
  if(v.httpStatus!==undefined){if(!Number.isInteger(v.httpStatus)||Number(v.httpStatus)<100||Number(v.httpStatus)>599)throw new Error("Invalid HTTP status.");result.httpStatus=v.httpStatus as number}
  for(const key of ["loadedBytes","totalBytes"] as const)if(v[key]!==undefined){if(!numeric(v[key]))throw new Error("Invalid transfer measurement.");result[key]=v[key] as number}
  return result;
}
export function coreBenchmarkFailure(error:unknown,stage:CoreBenchmarkStage,extra:Partial<Omit<CoreBenchmarkFailure,"stage"|"name"|"message">>={}):CoreBenchmarkFailure{
  if(error instanceof CoreBenchmarkError)return checkedCoreBenchmarkFailure(error.diagnostic);
  const e=error as {name?:unknown;message?:unknown}|null;
  return checkedCoreBenchmarkFailure({stage,name:benchmarkDiagnosticText(typeof e?.name==="string"?e.name:"Error",128),message:benchmarkDiagnosticText(typeof e?.message==="string"?e.message:String(error)),...extra});
}
export class CoreBenchmarkError extends Error{
  readonly diagnostic:CoreBenchmarkFailure;
  constructor(diagnostic:CoreBenchmarkFailure){const checked=checkedCoreBenchmarkFailure(diagnostic);super(checked.message);this.name=checked.name;this.diagnostic=checked}
}
export const CORE_BENCHMARK_STAGE_LABELS:Record<CoreBenchmarkStage,string>={"image-fetch":"loading the source image","image-verify":"checking the image hash","client-webgpu":"checking browser WebGPU","worker-start":"starting the model worker","worker-verify":"decoding the image in the worker","worker-webgpu":"checking worker WebGPU","cache-open":"opening the model cache","processor-load":"loading the tokenizer and image processor","model-load":"loading model files and GPU sessions","preprocess":"preparing model inputs","generate":"generating a description"};
