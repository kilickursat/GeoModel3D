import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {afterEach,describe,expect,it,vi} from "vitest";
import {CORE_BENCHMARK_MODEL,CORE_BENCHMARK_CACHE,CORE_BENCHMARK_PROMPT,CORE_BENCHMARK_PROMPT_VERSION,CORE_BENCHMARK_RUNTIME_VERSION,CORE_BENCHMARK_ONNX_VERSION,CORE_BENCHMARK_TIMEOUT_MS,coreBenchmarkTokenLimit,validateCoreBenchmarkRequest,verifyCoreBenchmarkImage,coreBenchmarkAdapterMetadata,coreBenchmarkMemoryMetadata,checkedCoreBenchmarkResult} from "../src/coreBenchmark";
import type {CoreBenchmarkRequest,CoreBenchmarkResult,CoreBenchmarkWorkerRequest,CoreBenchmarkWorkerResponse} from "../src/coreBenchmark";
import {CoreBenchmarkClient,coreBenchmarkSupport,clearCoreBenchmarkCache} from "../src/coreBenchmarkClient";
import {CORE_AI_MODELS,coreAiPrompt} from "../src/coreAi";
import {CoreBenchmarkError} from "../src/coreBenchmarkDiagnostics";

const bytes=readFileSync(new URL("../docs/benchmarks/0.25.0-core-ai/images/sample-03.png",import.meta.url));
const image="data:image/png;base64,"+Buffer.from(bytes).toString("base64"),sha256=createHash("sha256").update(bytes).digest("hex");
const request:CoreBenchmarkRequest={caseId:"case-01",image,expectedSha256:sha256,mode:"quality"};
function resultFor(value:CoreBenchmarkRequest=request):CoreBenchmarkResult{
  const max=coreBenchmarkTokenLimit(value.mode);
  return {caseId:value.caseId,mode:value.mode,modelId:CORE_BENCHMARK_MODEL.id,model:CORE_BENCHMARK_MODEL.repo,revision:CORE_BENCHMARK_MODEL.revision,dtypes:{...CORE_BENCHMARK_MODEL.dtype},
    prompt:CORE_BENCHMARK_PROMPT,promptVersion:CORE_BENCHMARK_PROMPT_VERSION,enableThinking:false,generation:{doSample:false,repetitionPenalty:1.1,maxNewTokens:max},
    text:"A grey surface with pale markings.",generatedTokens:7,inputTokens:334,maxNewTokens:max,outputLimitReached:false,
    imageSha256:value.expectedSha256,imageWidth:512,imageHeight:512,imageGrid:[[1,32,32]],
    loadMs:10,preprocessingMs:5,inferenceMs:20,totalMs:35,firstTokenMs:8,tokensPerSecond:350,modelReused:false,cacheState:"available",downloadBytes:0,
    device:"webgpu",runtimeVersion:CORE_BENCHMARK_RUNTIME_VERSION,onnxRuntimeVersion:CORE_BENCHMARK_ONNX_VERSION,
    adapter:coreBenchmarkAdapterMetadata({info:{vendor:"google",architecture:"swiftshader"},features:new Set(["subgroups"]),limits:{maxBufferSize:1073741824,maxStorageBufferBindingSize:1073741824}}),memory:coreBenchmarkMemoryMetadata({})};
}
class FakeWorker{
  onmessage:((event:MessageEvent<CoreBenchmarkWorkerResponse>)=>void)|null=null;
  onerror:((event:ErrorEvent)=>void)|null=null;
  onmessageerror:(()=>void)|null=null;
  messages:CoreBenchmarkWorkerRequest[]=[];
  terminated=false;
  postMessage(message:CoreBenchmarkWorkerRequest){this.messages.push(message)}
  terminate(){this.terminated=true}
  reply(message:CoreBenchmarkWorkerResponse){this.onmessage?.({data:message} as MessageEvent<CoreBenchmarkWorkerResponse>)}
}
function setup(options:{timeoutMs?:number;supportCheck?:()=>Promise<{supported:boolean;reason?:string}>}={}){
  const workers:FakeWorker[]=[],factory=vi.fn(()=>{const worker=new FakeWorker();workers.push(worker);return worker as unknown as Worker});
  const client=new CoreBenchmarkClient({workerFactory:factory,supportCheck:async()=>({supported:true}),...options});
  return {client,workers,factory};
}
async function ready(workers:FakeWorker[],count=1){await vi.waitFor(()=>expect(workers.length).toBe(count));await vi.waitFor(()=>expect(workers[count-1].messages.length).toBeGreaterThan(0))}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()});

describe("isolated Qwen benchmark protocol",()=>{
  it("keeps the fixed model outside app choices and separates complete quality runs from capped compatibility probes",()=>{
    expect(CORE_AI_MODELS.some(model=>String(model.id)===CORE_BENCHMARK_MODEL.id)).toBe(false);
    expect(CORE_BENCHMARK_MODEL.revision).toBe("9a4c21d8f724176b0a7edaaed36303044451886e");
    expect(CORE_BENCHMARK_MODEL.dtype).toEqual({embed_tokens:"q4",vision_encoder:"fp32",decoder_model_merged:"q4"});
    expect(CORE_BENCHMARK_PROMPT).toBe(coreAiPrompt("describe"));
    expect(coreBenchmarkTokenLimit("quality")).toBe(128);expect(coreBenchmarkTokenLimit("compatibility")).toBe(32);
    expect(()=>coreBenchmarkTokenLimit("quick-quality" as never)).toThrow();
  });
  it("rejects remote/unbounded images, unexpected cases and non-square PNG headers before any model transfer",()=>{
    for(const patch of [{image:"https://example.test/photo.png"},{image:"data:image/png;base64,"+"A".repeat(2_800_000)},{expectedSha256:"bad"},{caseId:"case-41"},{caseId:"sample-01"},{mode:"freeform"}])
      expect(()=>validateCoreBenchmarkRequest({...request,...patch} as CoreBenchmarkRequest)).toThrow();
    const changed=Buffer.from(bytes);changed.writeUInt32BE(511,16);
    expect(()=>validateCoreBenchmarkRequest({...request,image:"data:image/png;base64,"+changed.toString("base64")})).toThrow(/exactly 512/);
    expect(validateCoreBenchmarkRequest({...request,caseId:"case-40"})).toEqual(new Uint8Array(bytes));
  });
  it("verifies full image bytes, rejecting a changed PNG even when its dimensions remain correct",async()=>{
    expect((await verifyCoreBenchmarkImage(request)).sha256).toBe(sha256);
    const changed=Buffer.from(bytes);changed[changed.length-1]^=1;
    await expect(verifyCoreBenchmarkImage({...request,image:"data:image/png;base64,"+changed.toString("base64")})).rejects.toThrow(/frozen SHA-256/);
    await expect(verifyCoreBenchmarkImage({...request,expectedSha256:"0".repeat(64)})).rejects.toThrow(/frozen SHA-256/);
  });
  it("binds a result to the exact case, bytes, runtime and mode while stripping unexpected image fields",()=>{
    const clean=checkedCoreBenchmarkResult({...resultFor(),image,sourceBytes:image} as CoreBenchmarkResult,request);
    expect(clean).toEqual(resultFor());expect(clean).not.toHaveProperty("image");expect(clean).not.toHaveProperty("sourceBytes");
    for(const patch of [{caseId:"case-02"},{imageSha256:"0".repeat(64)},{revision:"main"},{mode:"compatibility"},{maxNewTokens:32},{generatedTokens:129},{outputLimitReached:true},{firstTokenMs:100},{runtimeVersion:"other"}])
      expect(()=>checkedCoreBenchmarkResult({...resultFor(),...patch} as CoreBenchmarkResult,request)).toThrow();
    const capped={...resultFor(),generatedTokens:128,outputLimitReached:true};expect(checkedCoreBenchmarkResult(capped,request).outputLimitReached).toBe(true);
  });
  it("records software adapters and unknown identifiers honestly, without inventing total GPU memory",()=>{
    expect(coreBenchmarkAdapterMetadata({info:{architecture:"swiftshader"}}).softwareAdapter).toBe(true);
    expect(coreBenchmarkAdapterMetadata({info:{description:"llvmpipe"}}).softwareAdapter).toBe(true);
    expect(coreBenchmarkAdapterMetadata({info:{vendor:"Apple"}}).softwareAdapter).toBe(false);
    expect(coreBenchmarkAdapterMetadata({})).toMatchObject({softwareAdapter:null,limits:{maxBufferSize:null,maxStorageBufferBindingSize:null}});
    expect(coreBenchmarkMemoryMetadata({})).toMatchObject({gpuMemoryBytes:null,jsHeapUsedBytes:null});
    expect(coreBenchmarkMemoryMetadata({memory:{usedJSHeapSize:123}})).toMatchObject({gpuMemoryBytes:null,jsHeapUsedBytes:123});
    expect(coreBenchmarkMemoryMetadata({memory:{usedJSHeapSize:NaN}}).jsHeapUsedBytes).toBeNull();
    expect(()=>checkedCoreBenchmarkResult({...resultFor(),memory:{gpuMemoryBytes:100,jsHeapUsedBytes:123,scope:"total"}} as never,request)).toThrow(/device metadata/);
  });
});

describe("benchmark worker lifecycle and provenance",()=>{
  it("creates no eager worker and reuses one session only for sequential, correctly bound cases",async()=>{
    const {client,workers,factory}=setup(),progress=vi.fn();expect(factory).not.toHaveBeenCalled();
    const first=client.run(request,progress);await ready(workers);expect(workers[0].messages[0].request).toEqual(request);
    const id=workers[0].messages[0].id;workers[0].reply({type:"progress",id,progress:{phase:"running",message:"Generating",generatedTokens:1,maxNewTokens:128}});
    expect(progress).toHaveBeenLastCalledWith({phase:"running",message:"Generating",generatedTokens:1,maxNewTokens:128});
    workers[0].reply({type:"result",id,result:resultFor()});await expect(first).resolves.toEqual(resultFor());
    const next={...request,caseId:"case-02",mode:"compatibility" as const},second=client.run(next);await vi.waitFor(()=>expect(workers[0].messages).toHaveLength(2));
    expect(factory).toHaveBeenCalledTimes(1);workers[0].reply({type:"result",id:workers[0].messages[1].id,result:{...resultFor(next),modelReused:true}});await second;client.dispose();expect(workers[0].terminated).toBe(true);
  });
  it("checks the complete SHA before adapter checks or worker creation and freezes caller-owned request values",async()=>{
    const supportCheck=vi.fn(async()=>({supported:true})),bad=setup({supportCheck});
    await expect(bad.client.run({...request,expectedSha256:"0".repeat(64)})).rejects.toThrow(/SHA-256/);expect(supportCheck).not.toHaveBeenCalled();expect(bad.factory).not.toHaveBeenCalled();bad.client.dispose();
    const {client,workers}=setup(),mutable={...request},pending=client.run(mutable);mutable.caseId="case-02";mutable.image="https://example.test";
    await ready(workers);expect(workers[0].messages[0].request).toEqual(request);workers[0].reply({type:"result",id:workers[0].messages[0].id,result:resultFor()});await pending;client.dispose();
  });
  it("rejects unsupported hardware and concurrent cases without starting another worker",async()=>{
    const unavailable=setup({supportCheck:async()=>({supported:false,reason:"No adapter"})});await expect(unavailable.client.run(request)).rejects.toThrow("No adapter");expect(unavailable.factory).not.toHaveBeenCalled();unavailable.client.dispose();
    const {client,workers,factory}=setup(),pending=client.run(request);await ready(workers);
    await expect(client.run({...request,caseId:"case-02"})).rejects.toThrow(/already running/);expect(factory).toHaveBeenCalledTimes(1);
    const rejected=expect(pending).rejects.toMatchObject({name:"AbortError"});client.stop();await rejected;expect(workers[0].terminated).toBe(true);client.dispose();
  });
  it("terminates a cancelled session and ignores stale results from old IDs and old workers",async()=>{
    const {client,workers}=setup(),first=client.run(request);await ready(workers);const firstId=workers[0].messages[0].id;
    const rejected=expect(first).rejects.toMatchObject({name:"AbortError"});client.stop();await rejected;
    const second=client.run(request);await ready(workers,2);let complete=false;void second.then(()=>{complete=true});
    const secondId=workers[1].messages[0].id;workers[0].reply({type:"result",id:secondId,result:resultFor()});workers[1].reply({type:"result",id:firstId,result:resultFor()});await Promise.resolve();expect(complete).toBe(false);
    workers[1].reply({type:"result",id:secondId,result:resultFor()});await second;expect(complete).toBe(true);client.dispose();
  });
  it("does not create a worker if cancelled while checking device support",async()=>{
    let finish!:(value:{supported:boolean})=>void;const supportCheck=vi.fn(()=>new Promise<{supported:boolean}>(resolve=>{finish=resolve}));
    const {client,factory}=setup({supportCheck}),pending=client.run(request);await vi.waitFor(()=>expect(supportCheck).toHaveBeenCalled());
    const rejected=expect(pending).rejects.toMatchObject({name:"AbortError"});client.stop();finish({supported:true});await rejected;await Promise.resolve();expect(factory).not.toHaveBeenCalled();client.dispose();
  });
  it("unloads the worker on a mismatched response instead of retaining invalid evidence",async()=>{
    const {client,workers}=setup(),pending=client.run(request),rejected=expect(pending).rejects.toThrow(/does not match/);await ready(workers);
    workers[0].reply({type:"result",id:workers[0].messages[0].id,result:{...resultFor(),imageSha256:"0".repeat(64)}});await rejected;expect(workers[0].terminated).toBe(true);client.dispose();
  });
  it("enforces a bounded per-case timeout, unloads, and permits a fresh session after worker failure",async()=>{
    for(const timeoutMs of [0,NaN,Infinity,CORE_BENCHMARK_TIMEOUT_MS+1])expect(()=>setup({timeoutMs})).toThrow(/thirty minutes/);
    const {client,workers}=setup({timeoutMs:1000});const timed=client.run(request),rejected=expect(timed).rejects.toThrow(/timed out/);await ready(workers);await rejected;expect(workers[0].terminated).toBe(true);
    const failed=client.run(request),failure=expect(failed).rejects.toThrow("GPU lost");await ready(workers,2);workers[1].reply({type:"error",id:workers[1].messages[0].id,message:"GPU lost"});await failure;expect(workers[1].terminated).toBe(true);
    client.dispose();await expect(client.run(request)).rejects.toThrow(/disposed/);
  });
  it("records worker bootstrap separately and preserves sanitized structured transport failures",async()=>{
    const {client,workers}=setup(),progress=vi.fn(),first=client.run(request,progress);
    const startup=expect(first).rejects.toMatchObject({diagnostic:{stage:"worker-start",operation:"worker",message:"Load failed [URL omitted]"}});
    await ready(workers);expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({stage:"worker-start"}));
    workers[0].onerror?.({message:"Load failed https://signed.example.test/runtime?token=secret"} as ErrorEvent);await startup;expect(workers[0].terminated).toBe(true);
    const second=client.run(request),failure=expect(second).rejects.toMatchObject({diagnostic:{stage:"processor-load",operation:"fetch",resource:"preprocessor_config.json",name:"TypeError",message:"Load failed"}});await ready(workers,2);
    workers[1].reply({type:"error",id:workers[1].messages[0].id,message:"Load failed",diagnostic:{stage:"processor-load",operation:"fetch",resource:"preprocessor_config.json",name:"TypeError",message:"Load failed"}});await failure;client.dispose();
  });
  it("validates progress before callbacks and ignores diagnostic errors from a stale worker",async()=>{
    const {client,workers}=setup(),progress=vi.fn(),first=client.run(request,progress),invalid=expect(first).rejects.toBeInstanceOf(CoreBenchmarkError);await ready(workers);
    const id=workers[0].messages[0].id;workers[0].reply({type:"progress",id,progress:{phase:"loading",stage:"model-load",message:"Loading https://signed.example/file?token=secret",file:"https://signed.example/file?token=secret",loaded:4,total:8}});
    expect(progress).toHaveBeenLastCalledWith({phase:"loading",stage:"model-load",message:"Loading [URL omitted]",loaded:4,total:8});
    workers[0].reply({type:"progress",id,progress:{phase:"loading",message:"Bad progress",loaded:NaN}});await invalid;expect(workers[0].terminated).toBe(true);
    const second=client.run(request),resolved=expect(second).resolves.toEqual(resultFor());await ready(workers,2);const nextId=workers[1].messages[0].id;
    workers[0].reply({type:"error",id:nextId,message:"stale",diagnostic:{stage:"processor-load",name:"TypeError",message:"stale",operation:"fetch"}});
    workers[1].reply({type:"result",id:nextId,result:resultFor()});await resolved;client.dispose();
  });
});

describe("benchmark device and cache checks",()=>{
  it("exposes a preflight adapter without downloads and handles unavailable/failed adapters",async()=>{
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);vi.stubGlobal("navigator",{});expect((await coreBenchmarkSupport()).supported).toBe(false);
    vi.stubGlobal("navigator",{gpu:{requestAdapter:async()=>null}});expect((await coreBenchmarkSupport()).reason).toContain("adapter");
    vi.stubGlobal("navigator",{gpu:{requestAdapter:async()=>{throw new Error("GPU lost")}}});expect((await coreBenchmarkSupport()).supported).toBe(false);
    vi.stubGlobal("navigator",{gpu:{requestAdapter:async()=>({info:{architecture:"swiftshader"}})}});expect(await coreBenchmarkSupport()).toMatchObject({supported:true,adapter:{softwareAdapter:true}});expect(fetch).not.toHaveBeenCalled();
  });
  it("gates standalone and insecure contexts before probing the adapter",async()=>{
    const adapter=vi.fn(async()=>({}));vi.stubGlobal("navigator",{gpu:{requestAdapter:adapter}});vi.stubGlobal("location",{protocol:"file:"});expect((await coreBenchmarkSupport()).reason).toContain("hosted");
    vi.stubGlobal("location",{protocol:"https:"});vi.stubGlobal("isSecureContext",false);expect((await coreBenchmarkSupport()).reason).toContain("HTTPS");expect(adapter).not.toHaveBeenCalled();
  });
  it("clears only its own model cache and reports unavailable browser storage",async()=>{
    const remove=vi.fn(async()=>true);vi.stubGlobal("caches",{delete:remove});await expect(clearCoreBenchmarkCache()).resolves.toBe(true);expect(remove).toHaveBeenCalledExactlyOnceWith(CORE_BENCHMARK_CACHE);
    vi.stubGlobal("caches",undefined);await expect(clearCoreBenchmarkCache()).rejects.toThrow(/unavailable/);
  });
});
