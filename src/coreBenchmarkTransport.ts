import {CoreBenchmarkError,benchmarkResourceName,coreBenchmarkFailure} from "./coreBenchmarkDiagnostics";
import type {CoreBenchmarkFailure,CoreBenchmarkStage} from "./coreBenchmarkDiagnostics";

type Fetcher=(input:string|URL,init?:RequestInit)=>Promise<Response>;
type Options={fetch:Fetcher;repo:string;revision:string;stage:()=>CoreBenchmarkStage};

/** The original pinned request identifies the file; signed redirect URLs are never retained. */
export function benchmarkModelResource(input:string|URL,repo:string,revision:string):string|undefined{
  try{
    const url=new URL(String(input)),prefix=`/${repo}/resolve/${revision}/`;
    if(url.protocol!=="https:"||!["huggingface.co","hf.co"].includes(url.hostname)||!url.pathname.startsWith(prefix))return;
    return benchmarkResourceName(url.pathname.slice(prefix.length));
  }catch{return undefined}
}

/** Observes actual consumption; it never starts another request, clones a body or buffers model bytes. */
function observedResponse(response:Response,stage:CoreBenchmarkStage,resource?:string,operation:"read-response"|"cache-read"="read-response"):Response{
  const size=Number(response.headers.get("content-length"));
  const totalBytes=response.headers.has("content-length")&&Number.isFinite(size)&&size>=0?size:undefined;
  let loadedBytes=0,body:ReadableStream<Uint8Array>|null|undefined;
  const fail=(error:unknown,counted=true)=>new CoreBenchmarkError(coreBenchmarkFailure(error,stage,{operation,...(resource?{resource}:{}),...(counted?{loadedBytes}:{}),...(totalBytes===undefined?{}:{totalBytes})}));
  const track=(stream:ReadableStream<Uint8Array>)=>new Proxy(stream,{
    get(target,key){
      if(key==="getReader")return (...args:unknown[])=>{
        const reader=Reflect.apply(target.getReader,target,args);
        return new Proxy(reader,{
          get(actual,member){
            if(member==="read")return async(...values:unknown[])=>{
              try{const part=await Reflect.apply(actual.read,actual,values) as ReadableStreamReadResult<Uint8Array>;if(!part.done&&part.value?.byteLength)loadedBytes+=part.value.byteLength;return part}
              catch(error){throw fail(error)}
            };
            const value=Reflect.get(actual,member,actual);return typeof value==="function"?value.bind(actual):value;
          },
        });
      };
      const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
    },
  });
  return new Proxy(response,{
    get(target,key){
      if(key==="body"){if(body===undefined)body=target.body?track(target.body):null;return body}
      if(key==="clone")return ()=>observedResponse(target.clone(),stage,resource,operation);
      const value=Reflect.get(target,key,target);
      if(typeof value!=="function")return value;
      if(["arrayBuffer","blob","bytes","formData","json","text"].includes(String(key)))return async(...args:unknown[])=>{
        try{return await Reflect.apply(value,target,args)}catch(error){throw fail(error,false)}
      };
      return value.bind(target);
    },
  });
}

export function createCoreBenchmarkTransport(options:Options){
  // An optional-file 404 remains optional. Attach HTTP metadata only when a later
  // fatal library error actually names that failed pinned request.
  const failedHttp=new Map<string,{resource:string;status:number;stage:CoreBenchmarkStage}>();
  const fetch:Fetcher=async(input,init)=>{
    const stage=options.stage(),resource=benchmarkModelResource(input,options.repo,options.revision);
    let response:Response;
    try{response=await options.fetch(input,init)}
    catch(error){throw new CoreBenchmarkError(coreBenchmarkFailure(error,stage,{operation:"fetch",...(resource?{resource}:{})}))}
    if(resource){
      const url=new URL(String(input));url.search="";url.hash="";
      if(response.status>=400)failedHttp.set(url.href,{resource,status:response.status,stage});else failedHttp.delete(url.href);
      if(failedHttp.size>32)failedHttp.delete(failedHttp.keys().next().value!);
    }
    return observedResponse(response,stage,resource);
  };
  function failure(error:unknown):CoreBenchmarkFailure{
    if(!(error instanceof CoreBenchmarkError)&&error instanceof Error){
      for(const [url,context] of failedHttp)if(error.message.includes(url))return coreBenchmarkFailure(error,context.stage,{operation:"http",resource:context.resource,httpStatus:context.status});
    }
    return coreBenchmarkFailure(error,options.stage());
  }
  const observeCached=(response:Response,key:string|URL)=>observedResponse(response,options.stage(),benchmarkModelResource(key,options.repo,options.revision),"cache-read");
  return {fetch,failure,observeCached,reset:()=>failedHttp.clear()};
}
