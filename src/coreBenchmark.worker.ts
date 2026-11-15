import {AutoProcessor,Qwen3_5ForConditionalGeneration,RawImage,Tensor,TextStreamer,env} from "@huggingface/transformers";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmFactoryUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import {CORE_BENCHMARK_MODEL,CORE_BENCHMARK_CACHE,CORE_BENCHMARK_PROMPT,CORE_BENCHMARK_PROMPT_VERSION,CORE_BENCHMARK_ONNX_VERSION,coreBenchmarkAdapterMetadata,coreBenchmarkMemoryMetadata,coreBenchmarkTokenLimit,verifyCoreBenchmarkImage} from "./coreBenchmark";
import type {CoreBenchmarkAdapter,CoreBenchmarkProgress,CoreBenchmarkRequest,CoreBenchmarkResult,CoreBenchmarkStage,CoreBenchmarkWorkerRequest,CoreBenchmarkWorkerResponse} from "./coreBenchmark";
import {createCoreBenchmarkTransport} from "./coreBenchmarkTransport";

// This dedicated worker is created only by an explicit benchmark Run, separate from the application's VLM choices.
env.allowLocalModels=false;env.allowRemoteModels=true;env.useFSCache=false;env.useBrowserCache=false;env.useWasmCache=false;
env.cacheKey=CORE_BENCHMARK_CACHE;
// Transformers.js's tokenizer existence check omits revision. Pin even that metadata URL.
env.remotePathTemplate=`{model}/resolve/${CORE_BENCHMARK_MODEL.revision}/`;
env.backends.onnx.wasm!.numThreads=1;env.backends.onnx.wasm!.proxy=false;
env.backends.onnx.wasm!.wasmPaths={wasm:wasmUrl,mjs:wasmFactoryUrl};
let currentStage:CoreBenchmarkStage="worker-start";
const originalFetch=env.fetch;
const transport=createCoreBenchmarkTransport({fetch:(input,init)=>originalFetch(input,init),repo:CORE_BENCHMARK_MODEL.repo,revision:CORE_BENCHMARK_MODEL.revision,stage:()=>currentStage});
env.fetch=transport.fetch;

let model:Awaited<ReturnType<typeof Qwen3_5ForConditionalGeneration.from_pretrained>>|undefined;
let processor:Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>|undefined;
let adapterInfo:CoreBenchmarkAdapter|undefined,busy=false,cacheInitialized=false;
let cacheState:"available"|"unavailable"="unavailable";
const cacheHits=new Set<string>();
const fileName=(key:RequestInfo|URL)=>String(typeof key==="object"&&"url" in key?key.url:key).split("/").at(-1)!;
const send=(message:CoreBenchmarkWorkerResponse)=>self.postMessage(message);

async function configureCache(){
  if(cacheInitialized)return;cacheInitialized=true;
  try{
    if(typeof caches==="undefined")return;
    const cache=await caches.open(CORE_BENCHMARK_CACHE);cacheState="available";env.useCustomCache=true;
    env.customCache={
      async match(key){try{const response=await cache.match(key);if(response){cacheHits.add(fileName(key));return transport.observeCached(response,key)}return undefined}catch{cacheState="unavailable";return undefined}},
      async put(key,response){try{await cache.put(key,response)}catch{cacheState="unavailable"}},
    };
  }catch{cacheState="unavailable";env.useCustomCache=false}
}
function disposeTensors(value:unknown,seen=new Set<unknown>()){
  if(!value||typeof value!=="object"||seen.has(value))return;seen.add(value);
  if(value instanceof Tensor){value.dispose();return}
  for(const item of Object.values(value))disposeTensors(item,seen);
}
async function run(id:number,request:CoreBenchmarkRequest):Promise<CoreBenchmarkResult>{
  const started=performance.now(),maxNewTokens=coreBenchmarkTokenLimit(request.mode),config=CORE_BENCHMARK_MODEL;
  transport.reset();
  const progress=(value:CoreBenchmarkProgress)=>send({type:"progress",id,progress:{...value,stage:currentStage,elapsedMs:performance.now()-started}});
  const stage=(value:CoreBenchmarkStage,phase:CoreBenchmarkProgress["phase"],message:string)=>{currentStage=value;progress({phase,message})};
  stage("worker-verify","checking","Verifying and decoding the exact benchmark image inside the worker…");
  const {bytes,sha256}=await verifyCoreBenchmarkImage(request);
  // Decode local bytes before any model download, so malformed image data cannot trigger a large transfer.
  const image=await RawImage.fromBlob(new Blob([bytes],{type:"image/png"}));
  if(image.width!==512||image.height!==512)throw new Error("Decoded benchmark dimensions differ from the frozen 512-square input.");
  const verifiedAt=performance.now(),reused=!!model&&!!processor&&!!adapterInfo;
  cacheHits.clear();const loaded=new Map<string,number>(),observedFiles=new Map<string,boolean>();
  if(!reused){
    stage("worker-webgpu","checking","Checking WebGPU inside the benchmark worker…");
    const gpu=(navigator as unknown as {gpu?:{requestAdapter:()=>Promise<unknown>}}).gpu;
    if(!gpu)throw new Error("WebGPU is unavailable inside this browser's worker. No model was downloaded.");
    const adapter=await gpu.requestAdapter();if(!adapter)throw new Error("No worker WebGPU adapter is available. No model was downloaded.");
    env.backends.onnx.webgpu!.adapter=adapter as NonNullable<typeof env.backends.onnx.webgpu>["adapter"];
    adapterInfo=coreBenchmarkAdapterMetadata(adapter);
    stage("cache-open","checking","Opening this benchmark's model cache…");await configureCache();
    const onLoad=(event:unknown)=>{
      const item=event as {status?:string;file?:string;loaded?:number;total?:number};if(!item.file)return;
      const name=fileName(item.file),fromCache=cacheHits.has(name);
      if(item.status==="download")observedFiles.set(name,(observedFiles.get(name)??true)&&fromCache);
      if(typeof item.loaded==="number"&&Number.isFinite(item.loaded)&&!fromCache)loaded.set(name,Math.max(loaded.get(name)??0,item.loaded));
      progress({phase:"loading",message:`${fromCache?"Reading cached":"Loading"} ${item.file}…`,file:item.file,
        ...(typeof item.loaded==="number"?{loaded:item.loaded}:{}),...(typeof item.total==="number"&&item.total>0?{total:item.total}:{})});
    };
    stage("processor-load","loading","Loading the pinned tokenizer and image processor…");
    processor=await AutoProcessor.from_pretrained(config.repo,{revision:config.revision,progress_callback:onLoad});
    if(!processor.image_processor)throw new Error("The pinned Qwen processor has no image processor.");
    processor.image_processor.min_pixels=512*512;processor.image_processor.max_pixels=512*512;
    stage("model-load","loading",`Loading ${config.label} files and GPU sessions: about ${config.downloadMiB} MiB of weights.`);
    model=await Qwen3_5ForConditionalGeneration.from_pretrained(config.repo,{revision:config.revision,dtype:{...config.dtype},device:"webgpu",progress_callback:onLoad});
  }
  const loadMs=performance.now()-verifiedAt,preparationStart=performance.now();
  let inputs:Record<string,unknown>|undefined,output:unknown,heartbeat:ReturnType<typeof setInterval>|undefined;
  try{
    stage("preprocess","checking","Preparing the verified image and fixed prompt for Qwen…");
    // The pinned Qwen template accepts enable_thinking; Transformers.js's shared option type omits this model-specific key.
    const chatOptions={add_generation_prompt:true,enable_thinking:false};
    const text=processor!.apply_chat_template([{role:"user",content:[{type:"image"},{type:"text",text:CORE_BENCHMARK_PROMPT}]}],chatOptions);
    if(typeof text!=="string"||!text.endsWith("<think>\n\n</think>\n\n"))throw new Error("Qwen's pinned non-thinking template changed; refusing to mix protocols.");
    inputs=await processor!(text,[image],{do_image_splitting:false});
    const inputTokens=(inputs!.input_ids as Tensor).dims.at(-1)!;
    const preprocessingMs=(verifiedAt-started)+(performance.now()-preparationStart),inferenceStart=performance.now();
    let generated=0,firstTokenMs:number|null=null,lastProgress=0;
    const running=()=>{lastProgress=performance.now();progress({phase:"running",message:`${generated?`${generated} / ${maxNewTokens} tokens`:"Preparing the first token"} · ${Math.round((lastProgress-inferenceStart)/1000)}s. Stop unloads this model.`,generatedTokens:generated,maxNewTokens,firstTokenMs,inferenceElapsedMs:lastProgress-inferenceStart})};
    currentStage="generate";running();heartbeat=setInterval(running,5000);
    const streamer=new TextStreamer(processor!.tokenizer!,{skip_prompt:true,callback_function:()=>{},token_callback_function:tokens=>{
      if(tokens.length&&firstTokenMs===null)firstTokenMs=performance.now()-inferenceStart;
      generated+=tokens.length;if(performance.now()-lastProgress>=500)running();
    }});
    output=await model!.generate({...inputs,do_sample:false,max_new_tokens:maxNewTokens,repetition_penalty:1.1,return_dict_in_generate:false,streamer});
    const inferenceMs=performance.now()-inferenceStart;
    if(!(output instanceof Tensor))throw new Error("Qwen returned an unexpected output.");
    const tokens=(output.tolist()[0] as Array<number|bigint>).slice(inputTokens).map(Number);
    const answer=processor!.tokenizer!.decode(tokens,{skip_special_tokens:true}).trim();
    if(!answer)throw new Error("Qwen returned no description. Keep this failed case in the benchmark report.");
    const grid=inputs!.image_grid_thw as Tensor;
    return {caseId:request.caseId,mode:request.mode,modelId:config.id,model:config.repo,revision:config.revision,dtypes:{...config.dtype},
      prompt:CORE_BENCHMARK_PROMPT,promptVersion:CORE_BENCHMARK_PROMPT_VERSION,enableThinking:false,generation:{doSample:false,repetitionPenalty:1.1,maxNewTokens},
      text:answer,generatedTokens:tokens.length,inputTokens,maxNewTokens,outputLimitReached:tokens.length>=maxNewTokens,
      imageSha256:sha256,imageWidth:512,imageHeight:512,imageGrid:(grid.tolist() as Array<Array<number|bigint>>).map(row=>row.map(Number)),
      loadMs,preprocessingMs,inferenceMs,totalMs:performance.now()-started,firstTokenMs,tokensPerSecond:inferenceMs>0?tokens.length/(inferenceMs/1000):0,
      modelReused:reused,cacheState,...(!reused&&observedFiles.size?{cached:[...observedFiles.values()].every(Boolean)}:{}),downloadBytes:[...loaded.values()].reduce((sum,n)=>sum+n,0),
      device:"webgpu",runtimeVersion:env.version,onnxRuntimeVersion:CORE_BENCHMARK_ONNX_VERSION,adapter:adapterInfo!,memory:coreBenchmarkMemoryMetadata()};
  }finally{if(heartbeat)clearInterval(heartbeat);disposeTensors(inputs);disposeTensors(output)}
}
self.onmessage=(event:MessageEvent<CoreBenchmarkWorkerRequest>)=>{
  const message=event.data;if(!message||message.type!=="run"||!Number.isInteger(message.id))return;
  if(busy){send({type:"error",id:message.id,message:"A benchmark case is already running."});return}
  busy=true;
  void run(message.id,message.request).then(result=>send({type:"result",id:message.id,result})).catch(error=>{
    // The client terminates this worker on error; no partial session is reused after a failed case.
    const diagnostic=transport.failure(error);send({type:"error",id:message.id,message:diagnostic.message,diagnostic});
  }).finally(()=>{busy=false});
};
