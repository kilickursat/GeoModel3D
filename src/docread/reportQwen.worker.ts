import {AutoProcessor,LogitsProcessor,LogitsProcessorList,Qwen3_5ForCausalLM,Tensor,env} from "@huggingface/transformers";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmFactoryUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import cpuWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import cpuWasmFactoryUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import {CORE_BENCHMARK_CACHE,CORE_BENCHMARK_MODEL} from "../coreBenchmark";
import {benchmarkDiagnosticText} from "../coreBenchmarkDiagnostics";
import {benchmarkModelResource} from "../coreBenchmarkTransport";
import type {ReportPageRole,ReportQwenRequest,ReportQwenResponse} from "./reportQwen";

const config=CORE_BENCHMARK_MODEL;
// Reuse the same immutable revision and browser weight cache as the Qwen image benchmark.
env.allowLocalModels=false;env.allowRemoteModels=true;env.useFSCache=false;
env.useBrowserCache=true;env.cacheKey=CORE_BENCHMARK_CACHE;env.useWasmCache=false;
env.remotePathTemplate=`{model}/resolve/${config.revision}/`;
env.backends.onnx.wasm!.numThreads=1;env.backends.onnx.wasm!.proxy=false;
const fetchModel=env.fetch;
env.fetch=(url,options)=>{
  if(!benchmarkModelResource(url,config.repo,config.revision)||!["GET","HEAD"].includes(options?.method??"GET")||options?.body!=null)
    throw new Error("Only downloads from the pinned Qwen model revision are supported.");
  return fetchModel(url,{...options,credentials:"omit",referrerPolicy:"no-referrer"});
};

const send=(response:ReportQwenResponse)=>self.postMessage(response);
const evidenceQuestions={
  log:"Does this excerpt contain a borehole lithology log or describe soil or rock layers by measured depth? A graphic log counts.",
  schedule:"Does this record give latitude and longitude or easting and northing for an existing borehole? Proposed boreholes do not count."
} as const;
// Answer each independent evidence question with a single token. A page may supply both kinds of evidence.
class PageClassTokens extends LogitsProcessor{
  constructor(private ids:readonly number[]){super()}
  _call(_input:bigint[][],logits:Tensor):Tensor{
    const scores=logits.data as Float32Array;
    const allowed=this.ids.map(i=>scores[i]);
    if(!allowed.some(Number.isFinite))throw new Error("Qwen produced no finite page-class scores.");
    scores.fill(-Infinity);
    this.ids.forEach((id,k)=>{if(Number.isFinite(allowed[k]))scores[id]=allowed[k]});
    return logits;
  }
}

async function classify(pages:ReportQwenRequest):Promise<ReportPageRole[]>{
  const gpu=(navigator as unknown as {gpu?:{requestAdapter():Promise<{info?:{isFallbackAdapter?:boolean;architecture?:string};isFallbackAdapter?:boolean}|null>}}).gpu;
  const adapter=await gpu?.requestAdapter().catch(()=>null);
  const useGpu=!!adapter&&!adapter.isFallbackAdapter&&!adapter.info?.isFallbackAdapter&&adapter.info?.architecture!=="swiftshader";
  if(useGpu)env.backends.onnx.webgpu!.adapter=adapter as NonNullable<typeof env.backends.onnx.webgpu>["adapter"];
  // ONNX Runtime's CPU distribution contains the quantized token-embedding kernel.
  env.backends.onnx.wasm!.wasmPaths=useGpu?{wasm:wasmUrl,mjs:wasmFactoryUrl}:{wasm:cpuWasmUrl,mjs:cpuWasmFactoryUrl};
  const backend=useGpu?"WebGPU":"WebAssembly CPU";
  send({progress:`Loading ${config.label} locally for ${backend}…`});
  const onFile=(event:{status:string;file?:string})=>{
    if(event.status==="initiate"&&event.file)send({progress:`Loading ${event.file} for ${backend}…`});
  };
  const options={revision:config.revision,progress_callback:onFile};
  const processor=await AutoProcessor.from_pretrained(config.repo,options);
  const tokenIds=["Yes","No"].map(label=>{
    const ids=processor.tokenizer!.encode(label,{add_special_tokens:false});
    if(ids.length!==1)throw new Error("The pinned tokenizer does not support the expected page classes.");
    return ids[0];
  });
  const processors=new LogitsProcessorList();processors.push(new PageClassTokens(tokenIds));
  // The text-only class from the same release loads the embedding and decoder sessions, omitting the vision encoder.
  const model=await Qwen3_5ForCausalLM.from_pretrained(config.repo,{...options,dtype:{...config.dtype},device:useGpu?"webgpu":"wasm"});
  const roles:ReportPageRole[]=[];
  try{
    for(const questions of pages){
      send({progress:`Qwen · ${backend} · classifying text excerpt ${roles.length+1} of ${pages.length}…`});
      const answers={log:false,schedule:false};
      const chatOptions={add_generation_prompt:true,enable_thinking:false};
      for(const {question,excerpt} of questions){
        const prompt=processor.apply_chat_template([
          {role:"system",content:"Read the supplied report excerpt and answer the question with Yes or No."},
          {role:"user",content:evidenceQuestions[question]+"\n\n"+excerpt}
        ],chatOptions);
        if(typeof prompt!=="string")throw new Error("The Qwen processor could not prepare the page excerpt.");
        const inputs=await processor(prompt);
        let result:unknown;
        try{
          result=await model.generate({...inputs,do_sample:false,max_new_tokens:1,logits_processor:processors,return_dict_in_generate:false});
          if(!(result instanceof Tensor))throw new Error("Qwen returned no page classification.");
          const token=Number(result.data.at(-1));
          if(!tokenIds.includes(token))throw new Error("Qwen returned an unknown page class.");
          answers[question]=token===tokenIds[0];
        }finally{
          for(const input of Object.values(inputs))if(input instanceof Tensor)input.dispose();
          if(result instanceof Tensor)result.dispose();
        }
      }
      const {log,schedule}=answers;
      const role=log?(schedule?"both":"log"):(schedule?"schedule":"other");
      send({index:roles.length,role});
      roles.push(role);
    }
    return roles;
  }finally{await model.dispose()}
}

self.onmessage=async({data}:MessageEvent<ReportQwenRequest>)=>{
  try{send({roles:await classify(data)})}
  catch(error){send({error:`Local Qwen page suggestions could not finish. ${benchmarkDiagnosticText(error instanceof Error?error.message:String(error),280)}`})}
};
