import {afterEach,describe,expect,it,vi} from "vitest";
import {CORE_AI_CACHE,CORE_AI_MODELS,CORE_AI_MAX_NEW_TOKENS,coreAiPrompt,validateCoreAiRequest} from "../src/coreAi";
import type {CoreAiRequest,CoreAiResult,CoreAiWorkerResponse} from "../src/coreAi";
import {CoreAiClient,clearCoreAiCache,coreAiSupport} from "../src/coreAiClient";

const image="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const request:CoreAiRequest={modelId:"smolvlm-256m",task:"describe",image};
const result:CoreAiResult={modelId:request.modelId,model:CORE_AI_MODELS[0].repo,revision:CORE_AI_MODELS[0].revision,task:request.task,text:"A grey cylindrical sample.",loadMs:1,inferenceMs:2,totalMs:3,cacheState:"available",imageWidth:1,imageHeight:1,maxNewTokens:128,device:"webgpu",dtype:"test"};
class FakeWorker {
  onmessage:((event:MessageEvent<CoreAiWorkerResponse>)=>void)|null=null;
  onerror:((event:ErrorEvent)=>void)|null=null;
  onmessageerror:(()=>void)|null=null;
  messages:Array<{type:"run";id:number;request:CoreAiRequest}>=[];
  terminated=false;
  postMessage(message:{type:"run";id:number;request:CoreAiRequest}){this.messages.push(message)}
  terminate(){this.terminated=true}
  reply(message:CoreAiWorkerResponse){this.onmessage?.({data:message} as MessageEvent<CoreAiWorkerResponse>)}
}
function clientSetup(options:{timeoutMs?:number;supportCheck?:()=>Promise<{supported:boolean;reason?:string}>}={}){
  const workers:FakeWorker[]=[];
  const factory=vi.fn(()=>{const worker=new FakeWorker();workers.push(worker);return worker as unknown as Worker});
  const client=new CoreAiClient({workerFactory:factory,supportCheck:async()=>({supported:true}),...options});
  return {client,workers,factory};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()});

describe("bounded local AI input",()=>{
  it("pins official models and uses fixed visual-only tasks with a bounded output",()=>{
    expect(CORE_AI_MODELS).toHaveLength(2);expect(CORE_AI_MAX_NEW_TOKENS).toBe(128);
    for(const model of CORE_AI_MODELS){expect(model.repo).toMatch(/^HuggingFaceTB\/SmolVLM-/);expect(model.revision).toMatch(/^[a-f0-9]{40}$/)}
    for(const task of ["describe","observations"] as const){expect(coreAiPrompt(task)).toContain("Do not infer");expect(coreAiPrompt(task)).toContain("RQD")}
    expect(validateCoreAiRequest(request)).toEqual({width:1,height:1});
  });
  it("rejects remote images, unsupported requests, oversized payloads and misleading PNG headers",()=>{
    for(const patch of [{modelId:"other"},{task:"estimate-strength"},{image:"https://example.test/photo.png"},{image:"data:image/svg+xml;base64,PHN2Zz4="},{image:"data:image/png;base64,"+"A".repeat(2_800_000)},{image:"data:image/png;base64,AAAA"}])
      expect(()=>validateCoreAiRequest({...request,...patch} as CoreAiRequest)).toThrow();
    const bytes=Uint8Array.from(atob(image.split(",")[1]),c=>c.charCodeAt(0));
    new DataView(bytes.buffer).setUint32(16,513);
    expect(()=>validateCoreAiRequest({...request,image:"data:image/png;base64,"+btoa(String.fromCharCode(...bytes))})).toThrow(/512/);
    new DataView(bytes.buffer).setUint32(16,0);
    expect(()=>validateCoreAiRequest({...request,image:"data:image/png;base64,"+btoa(String.fromCharCode(...bytes))})).toThrow(/512/);
  });
});

describe("local AI worker lifecycle",()=>{
  it("creates no worker until explicit run, forwards progress, and retains one worker for sequential requests",async()=>{
    const {client,workers,factory}=clientSetup(),progress=vi.fn();expect(factory).not.toHaveBeenCalled();
    const first=client.run(request,progress);await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);expect(workers[0].messages[0].request).toEqual(request);
    const id=workers[0].messages[0].id;
    workers[0].reply({type:"progress",id,progress:{phase:"running",message:"Running"}});
    expect(progress).toHaveBeenLastCalledWith({phase:"running",message:"Running"});
    workers[0].reply({type:"result",id,result});await expect(first).resolves.toEqual(result);
    const second=client.run({...request,modelId:"smolvlm-500m"});await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);expect(workers[0].messages).toHaveLength(2);
    workers[0].reply({type:"result",id:workers[0].messages[1].id,result});await second;client.dispose();expect(workers[0].terminated).toBe(true);
  });
  it("rejects invalid input, unavailable hardware and overlapping requests before starting extra workers",async()=>{
    const invalid=clientSetup();await expect(invalid.client.run({...request,image:"https://example.test"})).rejects.toThrow();expect(invalid.factory).not.toHaveBeenCalled();invalid.client.dispose();
    const unsupported=clientSetup({supportCheck:async()=>({supported:false,reason:"No adapter"})});await expect(unsupported.client.run(request)).rejects.toThrow("No adapter");expect(unsupported.factory).not.toHaveBeenCalled();unsupported.client.dispose();
    const {client,workers,factory}=clientSetup(),pending=client.run(request);await Promise.resolve();
    await expect(client.run(request)).rejects.toThrow(/already running/);expect(factory).toHaveBeenCalledTimes(1);
    const rejected=expect(pending).rejects.toMatchObject({name:"AbortError"});client.stop();await rejected;expect(workers[0].terminated).toBe(true);client.dispose();
  });
  it("terminates cancelled work and ignores both old request IDs and responses from terminated workers",async()=>{
    const {client,workers}=clientSetup(),first=client.run(request);await Promise.resolve();
    const rejected=expect(first).rejects.toMatchObject({name:"AbortError"});client.stop();await rejected;
    const second=client.run(request);await Promise.resolve();let complete=false;void second.then(()=>{complete=true});
    workers[0].reply({type:"result",id:workers[1].messages[0].id,result});
    workers[1].reply({type:"result",id:workers[0].messages[0].id,result});await Promise.resolve();expect(complete).toBe(false);
    workers[1].reply({type:"result",id:workers[1].messages[0].id,result});await second;expect(complete).toBe(true);client.dispose();
  });
  it("does not create a worker when cancellation happens during the adapter check",async()=>{
    let finish!:(value:{supported:boolean})=>void;
    const {client,factory}=clientSetup({supportCheck:()=>new Promise(resolve=>{finish=resolve})});
    const pending=client.run(request),rejected=expect(pending).rejects.toMatchObject({name:"AbortError"});client.stop();finish({supported:true});await rejected;await Promise.resolve();expect(factory).not.toHaveBeenCalled();client.dispose();
  });
  it("terminates on timeout, errors and disposal, allowing retry only before disposal",async()=>{
    vi.useFakeTimers();const {client,workers}=clientSetup({timeoutMs:100});
    const timeout=client.run(request),timedOut=expect(timeout).rejects.toThrow(/timed out/);await Promise.resolve();await vi.advanceTimersByTimeAsync(101);await timedOut;expect(workers[0].terminated).toBe(true);
    const failed=client.run(request),failure=expect(failed).rejects.toThrow("GPU allocation failed");await Promise.resolve();workers[1].reply({type:"error",id:workers[1].messages[0].id,message:"GPU allocation failed"});await failure;expect(workers[1].terminated).toBe(true);
    client.dispose();await expect(client.run(request)).rejects.toThrow(/disposed/);expect(vi.getTimerCount()).toBe(0);
  });
});

describe("capability and cache boundaries",()=>{
  it("reports missing GPU and adapter failures without any network request",async()=>{
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);vi.stubGlobal("navigator",{});expect((await coreAiSupport()).supported).toBe(false);
    vi.stubGlobal("navigator",{gpu:{requestAdapter:async()=>null}});expect((await coreAiSupport()).reason).toContain("adapter");
    vi.stubGlobal("navigator",{gpu:{requestAdapter:async()=>{throw new Error("disabled")}}});expect((await coreAiSupport()).supported).toBe(false);
    vi.stubGlobal("navigator",{gpu:{requestAdapter:async()=>({})}});expect(await coreAiSupport()).toEqual({supported:true});expect(fetch).not.toHaveBeenCalled();
  });
  it("disables AI in standalone HTML even when the browser exposes WebGPU",async()=>{
    const adapter=vi.fn(async()=>({}));vi.stubGlobal("navigator",{gpu:{requestAdapter:adapter}});
    vi.stubGlobal("location",{protocol:"file:"});expect((await coreAiSupport()).reason).toContain("hosted");
    vi.stubGlobal("location",{protocol:"https:"});vi.stubGlobal("document",{querySelector:()=>({})});expect((await coreAiSupport()).reason).toContain("standalone");expect(adapter).not.toHaveBeenCalled();
  });
  it("clears only the dedicated AI model cache, with truthful capability errors",async()=>{
    const remove=vi.fn(async()=>true);vi.stubGlobal("caches",{delete:remove});expect(await clearCoreAiCache()).toBe(true);expect(remove).toHaveBeenCalledExactlyOnceWith(CORE_AI_CACHE);
    vi.stubGlobal("caches",undefined);await expect(clearCoreAiCache()).rejects.toThrow(/unavailable/);
  });
});
