import {AutoModelForVision2Seq,AutoProcessor,RawImage,Tensor,TextStreamer,env} from "@huggingface/transformers";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmFactoryUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import {CORE_AI_CACHE,CORE_AI_DTYPE,CORE_AI_DTYPE_LABEL,CORE_AI_MAX_NEW_TOKENS,CORE_AI_ONNX_VERSION,CORE_AI_PROMPT_VERSION,CORE_AI_RUNTIME_VERSION,coreAiModel,coreAiPrompt,validateCoreAiRequest} from "./coreAi";
import type {CoreAiProgress,CoreAiRequest,CoreAiResult,CoreAiWorkerRequest,CoreAiWorkerResponse} from "./coreAi";

// Importing this module does not load weights. The worker itself is created only on explicit Run.
env.allowLocalModels=false;
env.allowRemoteModels=true;
env.useFSCache=false;
env.useBrowserCache=false;
env.cacheKey=CORE_AI_CACHE;
env.useWasmCache=false;
env.backends.onnx.wasm!.numThreads=1;
env.backends.onnx.wasm!.proxy=false;
env.backends.onnx.wasm!.wasmPaths={wasm:wasmUrl,mjs:wasmFactoryUrl};

let model:Awaited<ReturnType<typeof AutoModelForVision2Seq.from_pretrained>>|undefined;
let processor:Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>|undefined;
let loadedModelId:string|undefined;
let busy=false;
let cacheState:"available"|"unavailable"="unavailable";
let cacheInitialized=false;
const cacheHits=new Set<string>();
const fileName=(key:RequestInfo|URL)=>String(typeof key==="object"&&"url" in key?key.url:key).split("/").at(-1)!;

async function configureCache(){
  if(cacheInitialized)return;
  cacheInitialized=true;
  try{
    if(typeof caches==="undefined")return;
    const cache=await caches.open(CORE_AI_CACHE);
    cacheState="available";
    env.useCustomCache=true;
    env.customCache={
      async match(key){
        try{const response=await cache.match(key);if(response)cacheHits.add(fileName(key));return response}
        catch{cacheState="unavailable";return undefined}
      },
      async put(key,response){
        try{await cache.put(key,response)}catch{cacheState="unavailable"}
      },
    };
  }catch{cacheState="unavailable";env.useCustomCache=false}
}

function send(message:CoreAiWorkerResponse){self.postMessage(message)}
function disposeTensors(value:unknown,seen=new Set<unknown>()){
  if(!value||typeof value!=="object"||seen.has(value))return;seen.add(value);
  if(value instanceof Tensor){value.dispose();return}
  if(Array.isArray(value)){for(const item of value)disposeTensors(item,seen)}
  else for(const item of Object.values(value))disposeTensors(item,seen);
}

async function run(id:number,request:CoreAiRequest):Promise<CoreAiResult>{
  const start=performance.now(),dimensions=validateCoreAiRequest(request),config=coreAiModel(request.modelId);
  const progress=(value:CoreAiProgress)=>send({type:"progress",id,progress:{...value,elapsedMs:performance.now()-start}});
  progress({phase:"checking",message:"Checking the worker's WebGPU adapter…"});
  // Recheck inside the worker: window WebGPU support alone does not guarantee worker support.
  const gpu=(navigator as unknown as {gpu?:{requestAdapter:()=>Promise<unknown>}}).gpu;
  if(!gpu)throw new Error("WebGPU is unavailable inside this browser's worker. No model was downloaded.");
  const adapter=await gpu.requestAdapter();
  if(!adapter)throw new Error("No WebGPU adapter is available in the local AI worker. No model was downloaded.");
  env.backends.onnx.webgpu!.adapter=adapter as NonNullable<typeof env.backends.onnx.webgpu>["adapter"];
  await configureCache();cacheHits.clear();
  const loaded=new Map<string,number>(),observedFiles=new Map<string,boolean>();
  const onLoad=(event:unknown)=>{
    const item=event as {status?:string;file?:string;loaded?:number;total?:number};
    if(!item.file)return;
    const name=fileName(item.file);
    if(item.status==="download")observedFiles.set(name,(observedFiles.get(name)??true)&&cacheHits.has(name));
    if(typeof item.loaded==="number"&&Number.isFinite(item.loaded)&&!cacheHits.has(name))loaded.set(name,Math.max(loaded.get(name)??0,item.loaded));
    const fromCache=cacheHits.has(name);
    progress({phase:"loading",message:`${fromCache?"Reading cached":"Loading"} ${item.file}…`,file:item.file,
      ...(typeof item.loaded==="number"?{loaded:item.loaded}:{}),...(typeof item.total==="number"&&item.total>0?{total:item.total}:{})});
  };
  const reused=loadedModelId===config.id&&!!model&&!!processor;
  if(!reused){
    // Never retain two model sessions for a comparison, including after an unsuccessful load.
    const previous=model;model=undefined;processor=undefined;loadedModelId=undefined;
    if(previous)await previous.dispose();
    progress({phase:"loading",message:`Loading ${config.label}. First use downloads about ${config.downloadMiB} MiB of weights, plus tokenizer and runtime assets…`});
    processor=await AutoProcessor.from_pretrained(config.repo,{revision:config.revision,progress_callback:onLoad});
    // Idefics3 defaults to a 2048px pre-resize and image splitting. Both models here use one 512px tile.
    if(processor.image_processor){
      processor.image_processor.size={longest_edge:512};
      // Preserve narrow core-row proportions instead of stretching the row to a square.
      processor.image_processor.do_pad=true;
      processor.image_processor.pad_size={height:512,width:512};
    }
    model=await AutoModelForVision2Seq.from_pretrained(config.repo,{
      revision:config.revision,device:"webgpu",dtype:{...CORE_AI_DTYPE},progress_callback:onLoad,
    });
    loadedModelId=config.id;
  }
  const loadMs=performance.now()-start,prepareStart=performance.now();
  let inputs:Record<string,unknown>|undefined,output:unknown;
  try{
    // Decode only the validated local PNG. The photograph is never passed to a network fetch.
    const encoded=request.image.slice("data:image/png;base64,".length),binary=atob(encoded);
    const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
    const image=await RawImage.fromBlob(new Blob([bytes],{type:"image/png"}));
    if(image.width!==dimensions.width||image.height!==dimensions.height)throw new Error("The PNG dimensions changed during decoding.");
    const messages=[{role:"user",content:[{type:"image"},{type:"text",text:coreAiPrompt(request.task)}]}];
    const text=processor!.apply_chat_template(messages,{add_generation_prompt:true});
    inputs=await processor!(text,[image],{do_image_splitting:false});
    const promptLength=(inputs!.input_ids as Tensor).dims.at(-1)!;
    const preprocessingMs=performance.now()-prepareStart;
    progress({phase:"running",message:`Running ${config.label} locally. This can take several minutes; Cancel unloads the model.`});
    const inferenceStart=performance.now();
    let generated=0,lastProgress=0;
    const runningProgress=()=>{
      lastProgress=performance.now();
      const elapsed=Math.round((lastProgress-inferenceStart)/1000);
      progress({phase:"running",message:`${config.label}: ${generated?`generated ${generated} / ${CORE_AI_MAX_NEW_TOKENS} tokens`:"preparing the first token"} · ${elapsed}s. Cancel unloads the model.`});
    };
    const streamer=new TextStreamer(processor!.tokenizer!,{
      skip_prompt:true,callback_function:()=>{},
      token_callback_function:tokens=>{generated+=tokens.length;if(performance.now()-lastProgress>=500)runningProgress()},
    });
    const heartbeat=setInterval(runningProgress,5000);
    try{
      output=await model!.generate({...inputs,do_sample:false,max_new_tokens:CORE_AI_MAX_NEW_TOKENS,repetition_penalty:1.1,return_dict_in_generate:false,streamer});
    }finally{clearInterval(heartbeat)}
    const inferenceMs=performance.now()-inferenceStart;
    if(!(output instanceof Tensor))throw new Error("The local model returned an unexpected output.");
    const tokens=(output.tolist()[0] as Array<number|bigint>).slice(promptLength).map(Number);
    const answer=processor!.tokenizer!.decode(tokens,{skip_special_tokens:true}).trim();
    if(!answer)throw new Error("The local model returned no description. Try another crop or the other model.");
    const downloadBytes=[...loaded.values()].reduce((sum,bytes)=>sum+bytes,0);
    return {modelId:config.id,model:config.repo,revision:config.revision,task:request.task,text:answer,
      loadMs,preprocessingMs,inferenceMs,totalMs:performance.now()-start,downloadBytes,cacheState,
      ...(!reused&&observedFiles.size?{cached:[...observedFiles.values()].every(Boolean)}:{}),modelReused:reused,
      generatedTokens:tokens.length,...(inferenceMs>0?{tokensPerSecond:tokens.length/(inferenceMs/1000)}:{}),
      imageWidth:dimensions.width,imageHeight:dimensions.height,maxNewTokens:CORE_AI_MAX_NEW_TOKENS,device:"webgpu",dtype:CORE_AI_DTYPE_LABEL,
      runtimeVersion:CORE_AI_RUNTIME_VERSION,onnxRuntimeVersion:CORE_AI_ONNX_VERSION,promptVersion:CORE_AI_PROMPT_VERSION,
      preprocessing:"Aspect-preserving resize and neutral-gray padding to one 512 × 512 encoder tile; no image splitting."};
  }finally{disposeTensors(inputs);disposeTensors(output)}
}

self.onmessage=(event:MessageEvent<CoreAiWorkerRequest>)=>{
  const message=event.data;if(message?.type!=="run"||!Number.isInteger(message.id))return;
  if(busy){send({type:"error",id:message.id,message:"A local AI request is already running."});return}
  busy=true;
  void run(message.id,message.request).then(result=>send({type:"result",id:message.id,result})).catch(error=>{
    send({type:"error",id:message.id,message:`Local AI could not complete: ${error instanceof Error?error.message:String(error)}`});
  }).finally(()=>{busy=false});
};
