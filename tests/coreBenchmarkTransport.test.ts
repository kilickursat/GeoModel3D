import {describe,expect,it,vi} from "vitest";
import {CORE_BENCHMARK_MODEL} from "../src/coreBenchmark";
import {CoreBenchmarkError} from "../src/coreBenchmarkDiagnostics";
import type {CoreBenchmarkStage} from "../src/coreBenchmarkDiagnostics";
import {benchmarkModelResource,createCoreBenchmarkTransport} from "../src/coreBenchmarkTransport";

const base=`https://huggingface.co/${CORE_BENCHMARK_MODEL.repo}/resolve/${CORE_BENCHMARK_MODEL.revision}/`;
const options={repo:CORE_BENCHMARK_MODEL.repo,revision:CORE_BENCHMARK_MODEL.revision,stage:()=>"processor-load" as CoreBenchmarkStage};

describe("bounded benchmark transport diagnostics",()=>{
  it("identifies only pinned model resources and never retains queries, credentials or unrelated URLs",()=>{
    expect(benchmarkModelResource(base+"onnx/decoder_model_merged_q4.onnx_data?Signature=secret#fragment",options.repo,options.revision)).toBe("onnx/decoder_model_merged_q4.onnx_data");
    for(const url of [base.replace(options.revision,"main")+"config.json","https://unrelated.test/private.png",base+"../secret",base+"bad%3Fsecret.json","data:image/png;base64,AAAA"])
      expect(benchmarkModelResource(url,options.repo,options.revision)).toBeUndefined();
  });
  it("preserves the request and captures the original stage/resource on a native fetch rejection",async()=>{
    let stage:CoreBenchmarkStage="processor-load";
    const url=base+"preprocessor_config.json?Signature=secret",native=vi.fn(async()=>{stage="model-load";throw new TypeError(`Load failed ${url}`)});
    const transport=createCoreBenchmarkTransport({...options,stage:()=>stage,fetch:native});
    const init={headers:{Range:"bytes=0-0"},cache:"no-store" as RequestCache};
    let caught:unknown;try{await transport.fetch(url,init)}catch(error){caught=error}
    expect(native).toHaveBeenCalledExactlyOnceWith(url,init);expect(caught).toBeInstanceOf(CoreBenchmarkError);
    expect(transport.failure(caught)).toEqual({stage:"processor-load",name:"TypeError",message:"Load failed [URL omitted]",operation:"fetch",resource:"preprocessor_config.json"});
    expect(JSON.stringify(transport.failure(caught))).not.toContain("secret");
  });
  it("preserves native Response fields and lazy stream semantics without cloning or rebuffering",async()=>{
    let pulls=0;const nativeBody=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array([1,2,3]));controller.close()}},{highWaterMark:0});
    const response=new Response(nativeBody,{status:206,statusText:"Partial Content",headers:{"content-length":"3","content-range":"bytes 0-2/90","x-test":"retained"}});
    Object.defineProperty(response,"url",{value:"https://signed.example.test/file?Signature=private"});
    Object.defineProperty(response,"redirected",{value:true});
    const clone=vi.spyOn(response,"clone"),native=vi.fn(async()=>response);
    const transport=createCoreBenchmarkTransport({...options,fetch:native}),observed=await transport.fetch(base+"tokenizer.json");
    expect(observed).toBeInstanceOf(Response);expect(observed.status).toBe(206);expect(observed.statusText).toBe("Partial Content");expect(observed.headers).toBe(response.headers);expect(observed.url).toBe(response.url);expect(observed.redirected).toBe(true);
    expect(observed.body).toBe(observed.body);expect(observed.body!.locked).toBe(false);expect(observed.bodyUsed).toBe(false);expect(pulls).toBe(0);expect(clone).not.toHaveBeenCalled();
    const reader=observed.body!.getReader();expect(observed.body!.locked).toBe(true);expect(await reader.read()).toEqual({done:false,value:new Uint8Array([1,2,3])});expect(await reader.read()).toEqual({done:true,value:undefined});
    reader.releaseLock();expect(observed.bodyUsed).toBe(true);expect(pulls).toBe(1);expect(native).toHaveBeenCalledTimes(1);
  });
  it("retains native consuming-method and explicit clone behavior",async()=>{
    const native=vi.fn(async()=>new Response('{"ok":true}',{headers:{"content-type":"application/json"}}));
    const transport=createCoreBenchmarkTransport({...options,fetch:native}),response=await transport.fetch(base+"config.json"),clone=response.clone();
    expect(clone).toBeInstanceOf(Response);expect(await clone.json()).toEqual({ok:true});expect(response.bodyUsed).toBe(false);expect(await response.text()).toBe('{"ok":true}');expect(response.bodyUsed).toBe(true);expect(native).toHaveBeenCalledTimes(1);
  });
  it("attaches exact byte progress to a body-stream failure without changing its resource or phase",async()=>{
    let reads=0,stage:CoreBenchmarkStage="model-load";
    const response=new Response(new ReadableStream<Uint8Array>({pull(controller){if(reads++===0)controller.enqueue(new Uint8Array([1,2,3,4]));else controller.error(new TypeError("Load failed"))}},{highWaterMark:0}),{headers:{"content-length":"9"}});
    const transport=createCoreBenchmarkTransport({...options,stage:()=>stage,fetch:async()=>response});
    const observed=await transport.fetch(base+"onnx/vision_encoder.onnx_data"),reader=observed.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1,2,3,4]));stage="generate";
    await expect(reader.read()).rejects.toMatchObject({diagnostic:{stage:"model-load",name:"TypeError",message:"Load failed",operation:"read-response",resource:"onnx/vision_encoder.onnx_data",loadedBytes:4,totalBytes:9}});
    reader.releaseLock();
  });
  it("reports native body-consumption failure without inventing a byte count",async()=>{
    const response=new Response(new ReadableStream<Uint8Array>({start(controller){controller.error(new TypeError("Load failed"))}}));
    const transport=createCoreBenchmarkTransport({...options,fetch:async()=>response});
    let caught:unknown;try{await (await transport.fetch(base+"config.json")).arrayBuffer()}catch(error){caught=error}
    expect(caught).toBeInstanceOf(CoreBenchmarkError);expect(transport.failure(caught)).toMatchObject({operation:"read-response",resource:"config.json"});expect(transport.failure(caught)).not.toHaveProperty("loadedBytes");
  });
  it("identifies a cached body-read failure without issuing any network request",async()=>{
    const native=vi.fn(),transport=createCoreBenchmarkTransport({...options,fetch:native});
    const response=new Response(new ReadableStream<Uint8Array>({start(controller){controller.error(new TypeError("Cached body unavailable"))}}),{headers:{"content-length":"10"}});
    const cached=transport.observeCached(response,base+"onnx/embed_tokens_q4.onnx_data");
    await expect(cached.body!.getReader().read()).rejects.toMatchObject({diagnostic:{stage:"processor-load",operation:"cache-read",resource:"onnx/embed_tokens_q4.onnx_data",loadedBytes:0,totalBytes:10}});
    expect(native).not.toHaveBeenCalled();
  });
  it("leaves optional HTTP failures intact and adds context only when the library reports that resource as fatal",async()=>{
    const native=vi.fn(async()=>new Response("missing",{status:404,headers:{"content-type":"text/plain"}}));
    const transport=createCoreBenchmarkTransport({...options,fetch:native}),url=base+"optional.json",response=await transport.fetch(url);
    expect(response.status).toBe(404);expect(await response.text()).toBe("missing");
    expect(transport.failure(new Error("GPU lost"))).toEqual({stage:"processor-load",name:"Error",message:"GPU lost"});
    expect(transport.failure(new Error(`Could not locate file: ${url}`))).toMatchObject({operation:"http",resource:"optional.json",httpStatus:404,message:"Could not locate file: [URL omitted]"});
    transport.reset();expect(transport.failure(new Error(`Could not locate file: ${url}`))).not.toHaveProperty("httpStatus");
  });
});
