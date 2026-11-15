/** Fixed, versioned local VLM experiment. These general models are not geological classifiers. */
export const CORE_AI_MODELS = [
  {id:"smolvlm-256m",label:"SmolVLM 256M",repo:"HuggingFaceTB/SmolVLM-256M-Instruct",revision:"d039ab0d4b9311b617e8ffec1d06c8464364aeb3",downloadMiB:548},
  {id:"smolvlm-500m",label:"SmolVLM 500M",repo:"HuggingFaceTB/SmolVLM-500M-Instruct",revision:"753c1752602b5e739af7a7fa6947a635051897a3",downloadMiB:774},
] as const;
export const CORE_AI_CACHE = "geomodel3d-core-vlm";
export const CORE_AI_MAX_IMAGE_EDGE = 512;
export const CORE_AI_MAX_NEW_TOKENS = 128;
export const CORE_AI_DTYPE = {embed_tokens:"fp32",vision_encoder:"fp32",decoder_model_merged:"q4"} as const;
export const CORE_AI_DTYPE_LABEL = "embed_tokens=fp32;vision_encoder=fp32;decoder_model_merged=q4";
export const CORE_AI_RUNTIME_VERSION = "4.3.2";
export const CORE_AI_ONNX_VERSION = "1.31.1";
export const CORE_AI_PROMPT_VERSION = 1;
export type CoreAiTask = "describe" | "observations";
export type CoreAiRequest = {modelId:string;task:CoreAiTask;image:string};
export type CoreAiProgress = {phase:"checking"|"loading"|"running";message:string;loaded?:number;total?:number;elapsedMs?:number;file?:string};
export type CoreAiResult = {
  modelId:string;model:string;revision:string;task:CoreAiTask;text:string;
  /** load includes adapter/cache/session initialization and model downloads. */
  loadMs:number;preprocessingMs?:number;inferenceMs:number;totalMs:number;
  downloadBytes?:number;cacheState:"available"|"unavailable";cached?:boolean;modelReused?:boolean;
  generatedTokens?:number;tokensPerSecond?:number;imageWidth:number;imageHeight:number;
  maxNewTokens:number;device:"webgpu";dtype:string;
  runtimeVersion?:string;onnxRuntimeVersion?:string;promptVersion?:number;
  preprocessing?:string;
};
export type CoreAiWorkerRequest = {type:"run";id:number;request:CoreAiRequest};
export type CoreAiWorkerResponse =
  | {type:"progress";id:number;progress:CoreAiProgress}
  | {type:"result";id:number;result:CoreAiResult}
  | {type:"error";id:number;message:string};

export function coreAiModel(id:string){
  const model=CORE_AI_MODELS.find(model=>model.id===id);
  if(!model)throw new Error("Unknown local AI model.");
  return model;
}

export function coreAiPrompt(task:CoreAiTask):string {
  const limit="Describe only what is visible. Do not infer rock type, mineral composition, strength, soundness, RQD, fracture cause, or any numerical engineering property. If something is unclear, say so. Keep the answer brief.";
  if(task==="describe")return `Describe this photograph of drill core in plain language, focusing on visible colours, textures and arrangement. ${limit}`;
  if(task==="observations")return `List up to four visible observations in this photograph of drill core for a human reviewer to check, such as colour changes, visible gaps or surface markings. ${limit}`;
  throw new Error("Unknown local AI task.");
}

/** Only locally prepared PNGs enter the worker; never pass an arbitrary URL to an image loader. */
export function validateCoreAiRequest(request:CoreAiRequest):{width:number;height:number} {
  if(!request||typeof request!=="object")throw new Error("Invalid local AI request.");
  coreAiModel(request.modelId);coreAiPrompt(request.task);
  const prefix="data:image/png;base64,";
  if(typeof request.image!=="string"||!request.image.startsWith(prefix)||request.image.length>2_800_000)
    throw new Error("Local AI requires a PNG crop of at most 512 × 512 pixels.");
  const encoded=request.image.slice(prefix.length);
  if(!encoded.length||encoded.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw new Error("Invalid PNG crop encoding.");
  const header=atob(encoded.slice(0,44));
  const bytes=Uint8Array.from(header,c=>c.charCodeAt(0));
  if(bytes.length<33||[137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82].some((byte,i)=>bytes[i]!==byte))
    throw new Error("Invalid PNG crop header.");
  const view=new DataView(bytes.buffer),width=view.getUint32(16),height=view.getUint32(20);
  if(width<1||height<1||width>CORE_AI_MAX_IMAGE_EDGE||height>CORE_AI_MAX_IMAGE_EDGE)
    throw new Error("Local AI requires a PNG crop of at most 512 × 512 pixels.");
  return {width,height};
}
