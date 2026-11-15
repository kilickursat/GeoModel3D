/** Offline quality screening. CPU timings are NOT browser/WebGPU performance measurements. */
import {availableParallelism} from "node:os";
import {readFile,mkdir} from "node:fs/promises";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import * as nativeOrt from "onnxruntime-node";
import {AutoProcessor,AutoModelForVision2Seq,Qwen3_5ForConditionalGeneration,RawImage,Tensor,TextStreamer,env} from "@huggingface/transformers";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
export const BENCHMARK_CACHE_DIR=resolve(root,".cache/core-ai-benchmark/models");
export const BENCHMARK_MODELS=Object.freeze([
  Object.freeze({id:"smolvlm-500m",label:"SmolVLM 500M baseline",repo:"HuggingFaceTB/SmolVLM-500M-Instruct",revision:"753c1752602b5e739af7a7fa6947a635051897a3",family:"idefics3",dtype:Object.freeze({embed_tokens:"fp32",vision_encoder:"fp32",decoder_model_merged:"q4"}),weightBytes:811545504}),
  Object.freeze({id:"qwen3.5-0.8b-opt",label:"Qwen3.5 0.8B challenger",repo:"onnx-community/Qwen3.5-0.8B-ONNX-OPT",revision:"9a4c21d8f724176b0a7edaaed36303044451886e",family:"qwen3_5",dtype:Object.freeze({embed_tokens:"q4",vision_encoder:"fp32",decoder_model_merged:"q4"}),weightBytes:1049662346}),
]);
env.allowLocalModels=false;
env.allowRemoteModels=true;
env.useFSCache=true;
env.useBrowserCache=false;
env.useCustomCache=false;
env.cacheDir=BENCHMARK_CACHE_DIR;
const threads=Math.max(1,Math.min(4,availableParallelism()));
let resident;
let busy=false;

function metadata(config){return {modelId:config.id,model:config.repo,revision:config.revision,dtypes:{...config.dtype},weightBytes:config.weightBytes,license:"Apache-2.0",backend:"onnxruntime-node/cpu",transformersVersion:env.version,onnxRuntimeVersion:nativeOrt.env.versions.node,nodeVersion:process.versions.node,intraOpNumThreads:threads}}
function knownConfig(config){
  const found=BENCHMARK_MODELS.find(entry=>entry.id===(typeof config==="string"?config:config?.id));
  if(!found)throw new Error("Unknown benchmark model; select a pinned BENCHMARK_MODELS entry.");
  return found;
}
function disposeTensors(value,seen=new Set()){
  if(!value||typeof value!=="object"||seen.has(value))return;seen.add(value);
  if(value instanceof Tensor){value.dispose();return}
  for(const item of Object.values(value))disposeTensors(item,seen);
}
export async function disposeBenchmarkModel(){
  if(busy)throw new Error("Cannot dispose a benchmark model during a load or generation.");
  const previous=resident;resident=undefined;
  if(previous)await previous.model.dispose();
}

/** Loads one pinned model at a time. onProgress receives library model-file progress without images. */
export async function loadBenchmarkModel(config,{onProgress}={}){
  if(busy)throw new Error("Benchmark runtime is busy; models and images must run sequentially.");
  const selected=knownConfig(config);
  if(resident?.config.id===selected.id)return {...resident,modelReused:true,loadMs:0};
  busy=true;
  const started=performance.now();
  try{
    const previous=resident;resident=undefined;if(previous)await previous.model.dispose();
    await mkdir(BENCHMARK_CACHE_DIR,{recursive:true});
    const options={revision:selected.revision,progress_callback:onProgress};
    const processor=await AutoProcessor.from_pretrained(selected.repo,options);
    if(selected.family==="idefics3"){
      processor.image_processor.size={longest_edge:512};processor.image_processor.do_pad=true;
      processor.image_processor.pad_size={height:512,width:512};
    }else{
      // Keep identical 512-square prepared PNGs; Qwen's native 32px grid remains intact.
      processor.image_processor.min_pixels=512*512;processor.image_processor.max_pixels=512*512;
    }
    const Model=selected.family==="qwen3_5"?Qwen3_5ForConditionalGeneration:AutoModelForVision2Seq;
    const model=await Model.from_pretrained(selected.repo,{
      ...options,dtype:{...selected.dtype},device:"cpu",session_options:{intraOpNumThreads:threads,interOpNumThreads:1,executionMode:"sequential"},
    });
    resident={config:selected,model,processor,loadMs:performance.now()-started,modelReused:false,generationCount:0,metadata:metadata(selected)};
    return resident;
  }finally{busy=false}
}

/** Input must be a prepared local 512-square PNG, preserving the exact crop used by both models. */
export async function generateBenchmark(handle,imagePath,prompt,{maxNewTokens=128,onProgress}={}){
  if(busy)throw new Error("Benchmark runtime is busy; run image requests sequentially.");
  if(!resident||handle.model!==resident.model)throw new Error("This benchmark model was unloaded; load it again.");
  if(typeof imagePath!=="string"||/^[a-z]+:\/\//i.test(imagePath))throw new Error("Benchmark image must be a local PNG path.");
  if(typeof prompt!=="string"||!prompt.trim()||prompt.length>4096)throw new Error("A bounded benchmark prompt is required.");
  if(!Number.isInteger(maxNewTokens)||maxNewTokens<1||maxNewTokens>128)throw new Error("Benchmark output cap must be between 1 and 128 tokens.");
  busy=true;
  const started=performance.now();let inputs,output;
  try{
    const data=await readFile(resolve(imagePath));
    if(data.length>2_100_000||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error("Benchmark image must be a bounded local PNG.");
    const image=await RawImage.fromBlob(new Blob([data],{type:"image/png"}));
    if(image.width!==512||image.height!==512)throw new Error("Prepare an aspect-preserving 512 × 512 PNG before running either model.");
    const conversation=[{role:"user",content:[{type:"image"},{type:"text",text:prompt}]}];
    // The pinned Qwen template explicitly branches on enable_thinking and emits a closed empty think block when false.
    const chatOptions={add_generation_prompt:true,...(handle.config.family==="qwen3_5"?{enable_thinking:false}:{})};
    const text=handle.processor.apply_chat_template(conversation,chatOptions);
    if(handle.config.family==="qwen3_5"&&!text.endsWith("<think>\n\n</think>\n\n"))throw new Error("Qwen non-thinking template invariant failed.");
    inputs=await handle.processor(text,[image],{do_image_splitting:false});
    const inputTokens=inputs.input_ids.dims.at(-1),preprocessingMs=performance.now()-started;
    let generated=0;
    const streamer=new TextStreamer(handle.processor.tokenizer,{skip_prompt:true,callback_function:()=>{},token_callback_function:tokens=>{generated+=tokens.length;onProgress?.({generatedTokens:generated,maxNewTokens,elapsedMs:performance.now()-started})}});
    const sessionRunIndex=++resident.generationCount;
    const inferenceStart=performance.now();
    output=await handle.model.generate({...inputs,do_sample:false,max_new_tokens:maxNewTokens,repetition_penalty:1.1,return_dict_in_generate:false,streamer});
    const inferenceMs=performance.now()-inferenceStart;
    if(!(output instanceof Tensor))throw new Error("Unexpected benchmark generation output.");
    const tokens=output.tolist()[0].slice(inputTokens).map(Number);
    const answer=handle.processor.tokenizer.decode(tokens,{skip_special_tokens:true}).trim();
    return {...metadata(handle.config),text:answer,loadMs:sessionRunIndex===1?handle.loadMs:0,sessionLoadMs:resident.loadMs,sessionRunIndex,preprocessingMs,inferenceMs,totalMs:performance.now()-started,
      modelReused:handle.modelReused||sessionRunIndex>1,generatedTokens:tokens.length,tokensPerSecond:tokens.length/(inferenceMs/1000),inputTokens,maxNewTokens,
      imageWidth:image.width,imageHeight:image.height,imageSha256:createHash("sha256").update(data).digest("hex"),
      prompt,chatTemplate:{addGenerationPrompt:true,...(handle.config.family==="qwen3_5"?{enableThinking:false}:{})},
      generation:{doSample:false,repetitionPenalty:1.1,maxNewTokens},
      preprocessing:"Identical prepared 512 × 512 PNG; native model processor normalization and image-token grid.",
      ...(inputs.image_grid_thw?{imageGrid:inputs.image_grid_thw.tolist().map(row=>row.map(Number))}:{}),
      timingScope:"CPU quality-screening run; generation includes vision encoding and prompt prefill. Not browser or phone performance."};
  }finally{disposeTensors(inputs);disposeTensors(output);busy=false}
}
