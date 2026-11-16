import {test,expect,Page} from "@playwright/test";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {downloadJson,prepare} from "./helpers";

const attack='<img src=x onerror="globalThis.benchmarkInjected=true">';
const modelHost=(url:string)=>/https:\/\/(?:[^/]+\.)?(?:huggingface\.co|hf\.co|hf\.space|xethub\.hf\.co)\//.test(url);
const benchmarkPath="/core-ai-benchmark.html",assetPath="/core-benchmark-v026/";
async function evaluationPlan(){const raw=await readFile(new URL("../../docs/benchmarks/0.27.0-desktop-ai/evaluation-plan.json",import.meta.url));return {id:"qwen-desktop-1",sha256:createHash("sha256").update(raw).digest("hex"),plan:JSON.parse(raw.toString("utf8"))}}
type FixtureOptions={supported?:boolean;delayCase?:string;delayMs?:number;failCase?:string;tamperCase?:string;diagnosticFailure?:boolean;progressBurst?:boolean};

async function fixture(page:Page,options:FixtureOptions={}){
  await prepare(page);
  await page.addInitScript(supported=>{
    Object.defineProperty(navigator,"gpu",{configurable:true,value:supported?{
      requestAdapter:async()=>({features:new Set(),limits:{maxStorageBufferBindingSize:1_073_741_824,maxBufferSize:1_073_741_824},info:{vendor:"Playwright capability fixture",architecture:"software fixture"}})
    }:undefined});
    localStorage.setItem("benchmark-project-sentinel","accepted engineering values remain unchanged");
    const write=Storage.prototype.setItem;(globalThis as any).benchmarkRecoveryWrites=0;
    Storage.prototype.setItem=function(key:string,value:string){if(key==="geomodel3d:qwen-benchmark:last-report")(globalThis as any).benchmarkRecoveryWrites++;return write.call(this,key,value)};
  },options.supported!==false);
  // Keep the frozen inputs exact so these UI tests exercise the same manifest-integrity gate.
  // Only model execution/output and GPU capability are synthetic fixtures.
  const manifestBytes=await readFile(new URL("../../public/core-benchmark-v026/manifest.json",import.meta.url));
  const manifest=JSON.parse(manifestBytes.toString("utf8")) as {version:1;datasetId:string;cases:{id:string;image:string;sha256:string;sourceSha256:string;width:number;height:number}[]};
  const buffers=await Promise.all(manifest.cases.map(sample=>readFile(new URL(`../../public/core-benchmark-v026/${sample.image}`,import.meta.url))));
  const activity={workers:0,images:[] as string[],cases:[] as {caseId:string;sha256:string;mode:string;active:number}[],weights:[] as string[],requestMethods:[] as string[]};
  await page.route("**/core-benchmark-v026/manifest.json",route=>route.fulfill({contentType:"application/json",body:manifestBytes}));
  await page.route("**/core-benchmark-v026/images/*.png",route=>{
    const id=route.request().url().match(/case-\d{2}/)![0];activity.images.push(id);
    const i=Number(id.slice(-2))-1;
    return route.fulfill({contentType:"image/png",body:buffers[options.tamperCase===id?(i+1)%40:i]});
  });
  await page.route("**/__core_benchmark_fixture__/**",route=>{
    const u=new URL(route.request().url());activity.cases.push({caseId:u.searchParams.get("caseId")!,sha256:u.searchParams.get("sha256")!,mode:u.searchParams.get("mode")!,active:Number(u.searchParams.get("active"))});
    return route.fulfill({contentType:"application/json",body:"{}"});
  });
  await page.route(/\/(src\/coreBenchmark\.worker\.ts|assets\/coreBenchmark\.worker-[\w-]+\.js)(\?|$)/,route=>{
    activity.workers++;
    return route.fulfill({contentType:"text/javascript",body:`
import {CORE_BENCHMARK_MODEL as config,CORE_BENCHMARK_PROMPT,CORE_BENCHMARK_PROMPT_VERSION,CORE_BENCHMARK_RUNTIME_VERSION,CORE_BENCHMARK_ONNX_VERSION,coreBenchmarkTokenLimit} from '/src/coreBenchmark.ts';
let active=0,count=0;
self.onmessage=async({data})=>{
 if(data.type!=='run')return;const {id,request}=data;active++;
 try{
  const bytes=Uint8Array.from(atob(request.image.split(',')[1]),c=>c.charCodeAt(0));
  const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
  await fetch('/__core_benchmark_fixture__/request?'+new URLSearchParams({caseId:request.caseId,sha256,mode:request.mode,active:String(active)}));
  if(active!==1)throw Error('Fixture detected concurrent image generation');
  if(sha256!==request.expectedSha256)throw Error('Fixture input hash mismatch');
  const reused=count++>0,max=coreBenchmarkTokenLimit(request.mode);
  if(!reused)await fetch('https://huggingface.co/__geomodel3d_benchmark_ui_fixture/model.bin');
  if(${!!options.diagnosticFailure})self.postMessage({type:'progress',id,progress:{phase:'loading',stage:'model-load',message:'Synthetic model transfer',file:'onnx/vision_encoder.onnx_data',loaded:1048576,total:4194304}});
  else if(${!!options.progressBurst})for(let i=0;i<100;i++)self.postMessage({type:'progress',id,progress:{phase:'loading',stage:'model-load',message:'Fixture burst '+i,file:i%2?'onnx/vision_encoder.onnx_data':'onnx/decoder_model_merged_q4.onnx_data',loaded:i,total:100}});
  else self.postMessage({type:'progress',id,progress:{phase:'running',stage:'generate',message:'Synthetic inference in progress '+request.caseId,generatedTokens:1,maxNewTokens:max}});
  await new Promise(r=>setTimeout(r,request.caseId===${JSON.stringify(options.delayCase??"")}?${options.delayMs??5000}:35));
  if(request.caseId===${JSON.stringify(options.failCase??"")}){
   if(${!!options.diagnosticFailure}){self.postMessage({type:'error',id,message:'Load failed',diagnostic:{stage:'model-load',operation:'fetch',resource:'onnx/decoder_model_merged_q4.onnx_data',name:'TypeError',message:'Load failed '+${JSON.stringify(attack)}+' https://example.test/model?token=secret',unexpectedImage:request.image}});return}
   throw Error('Synthetic runtime failure retained for review');
  }
  const result={caseId:request.caseId,mode:request.mode,modelId:config.id,model:config.repo,revision:config.revision,dtypes:{...config.dtype},
   prompt:CORE_BENCHMARK_PROMPT,promptVersion:CORE_BENCHMARK_PROMPT_VERSION,enableThinking:false,generation:{doSample:false,repetitionPenalty:1.1,maxNewTokens:max},
   text:'SYNTHETIC UI TEST '+request.caseId+' '+${JSON.stringify(attack)}+' [input-sha256:'+sha256+']',generatedTokens:request.mode==='compatibility'?32:19,inputTokens:334,maxNewTokens:max,outputLimitReached:request.mode==='compatibility',
   imageSha256:sha256,imageWidth:512,imageHeight:512,imageGrid:[[1,32,32]],loadMs:reused?0:10,preprocessingMs:2,inferenceMs:35,totalMs:reused?37:47,firstTokenMs:5,tokensPerSecond:19/0.035,
   modelReused:reused,cacheState:'available',cached:false,downloadBytes:reused?0:16,device:'webgpu',runtimeVersion:CORE_BENCHMARK_RUNTIME_VERSION,onnxRuntimeVersion:CORE_BENCHMARK_ONNX_VERSION,
   adapter:{vendor:'Playwright capability fixture',architecture:'software fixture',device:'',description:'Synthetic UI test adapter',features:[],softwareAdapter:true,limits:{maxBufferSize:1073741824,maxStorageBufferBindingSize:1073741824}},
   memory:{gpuMemoryBytes:null,jsHeapUsedBytes:null,scope:'Unknown GPU allocations'},unexpectedImage:request.image};
  self.postMessage({type:'result',id,result});
 }catch(error){self.postMessage({type:'error',id,message:String(error.message??error)})}
 finally{active--}
};`});
  });
  await page.route("https://huggingface.co/__geomodel3d_benchmark_ui_fixture/**",route=>{
    activity.weights.push(route.request().url());activity.requestMethods.push(route.request().method());expect(route.request().postData()).toBeNull();
    return route.fulfill({headers:{"access-control-allow-origin":"*"},body:"synthetic-weight"});
  });
  return {manifest,buffers,activity};
}

async function open(page:Page){await page.goto(benchmarkPath);await expect(page.locator("#benchmark-case option")).toHaveCount(40);await expect(page.locator("#benchmark-review-csv")).toBeEnabled()}
async function consent(page:Page){await page.locator("#benchmark-consent").check();await expect(page.locator("#benchmark-run")).toBeEnabled()}
async function report(page:Page){return downloadJson<any>(page,"#benchmark-export")}
function imageFree(value:unknown){expect(JSON.stringify(value)).not.toMatch(/data:image|base64|unexpectedImage/)}
function reportScope(value:any){
  expect(value).toMatchObject({format:"geomodel3d-core-device-benchmark",version:1,inProgress:false,
    protocol:{id:"core-webgpu-pilot-2",humanReviewStatus:"pending",qualityScores:null,qualityTokenLimit:128,compatibilityTokenLimit:32,
      timingDefinitions:{firstTokenMs:expect.stringContaining("model.generate"),workerTotalMs:expect.stringContaining("Worker monotonic"),caseElapsedMs:expect.stringContaining("image fetch"),clockTimestamps:expect.stringContaining("performance.now")}},
    dataset:{id:"core-v026",cohortCaseCount:40,boreholeIndependence:"unverified"},browser:{physicalDeviceVerified:false},memory:{gpuMemoryBytes:null}});
  for(const hash of [value.dataset.manifestSha256,value.protocol.sha256,value.protocol.rubricSha256,value.protocol.sourceManifestSha256])expect(hash).toMatch(/^[a-f0-9]{64}$/);expect(value.dataset.cases).toHaveLength(40);
  expect(value.activeEvaluationPlan).toMatchObject({id:"qwen-desktop-1",sha256:expect.stringMatching(/^[a-f0-9]{64}$/),appliesTo:"Only runs explicitly carrying this plan ID and hash.",plan:{mobile:{requiredForDesktopMilestone:false}}});
  expect(value.dataset.cases.map((x:any)=>x.caseId)).toEqual(Array.from({length:40},(_,i)=>`case-${String(i+1).padStart(2,"0")}`));
  for(const run of value.runs){expect(run.cohortCaseCount).toBe(40);expect(run.physicalDeviceVerified).toBe(false);expect(run.selectedCaseIds.length+run.unselectedCaseIds.length).toBe(40);expect(run.cases.map((x:any)=>x.caseId)).toEqual(run.selectedCaseIds)}
  imageFree(value);
}
async function preserved(page:Page){expect(await page.evaluate(()=>localStorage.getItem("benchmark-project-sentinel"))).toBe("accepted engineering values remain unchanged")}

// All model output and capability in this file is a fixture. Tests verify the real page/client/Worker
// boundary and source bytes; these records must never be used as model-quality or device-speed evidence.
test("core benchmark unsupported devices keep review and cache controls available without eager inference",async({page})=>{
  const {activity}=await fixture(page,{supported:false});await open(page);
  await expect(page.locator("#benchmark-support")).toContainText(/unavailable|not available|not supported/i);
  await expect(page.locator("#benchmark-target-note")).toContainText("Desktop/laptop Chrome");await expect(page.locator("#benchmark-target-note")).toContainText("iPhone and other mobile AI checks are optional");
  await page.locator("#benchmark-consent").check();await expect(page.locator("#benchmark-run")).toBeDisabled();
  expect(activity).toEqual({workers:0,images:[],cases:[],weights:[],requestMethods:[]});
  const pending=page.waitForEvent("download");await page.locator("#benchmark-review-csv").click();const download=await pending,path=await download.path();
  expect(path).not.toBeNull();const csv=await readFile(path!,"utf8");expect(csv).toContain("case-01");expect(csv).toContain("case-40");expect(csv).not.toContain("SYNTHETIC UI TEST");
  expect(csv.trim().split(/\r?\n/)).toHaveLength(41);expect(csv).toContain('"reference_reviewer_id","reference_reviewer_role","reference_qualification_basis"');expect(csv).toContain('"model_outputs_seen_before_reference"');
  await preserved(page);
});

test("core benchmark rejects a structurally valid manifest outside the frozen plan before loading images or models",async({page})=>{
  const {manifest,activity}=await fixture(page);const changed=structuredClone(manifest);changed.cases[0].sourceSha256="a".repeat(64);
  await page.route("**/core-benchmark-v026/manifest.json",route=>route.fulfill({contentType:"application/json",body:JSON.stringify(changed)}));
  await page.goto(benchmarkPath);await expect(page.locator("#benchmark-dataset-status")).toContainText(/frozen|hash|match/i);
  await expect(page.locator("#benchmark-status")).toContainText("could not be verified");
  await page.locator("#benchmark-consent").check();await expect(page.locator("#benchmark-run")).toBeDisabled();
  await expect(page.locator("#benchmark-review-images")).toBeDisabled();await expect(page.locator("#benchmark-review-csv")).toBeDisabled();
  expect(activity).toEqual({workers:0,images:[],cases:[],weights:[],requestMethods:[]});await preserved(page);
});

test("core benchmark source review verifies images before model disclosure and keeps review blank",async({page})=>{
  const {manifest,activity}=await fixture(page);await open(page);
  await page.locator("#benchmark-review-images").click();
  const preview=page.locator("#benchmark-reference-preview");await expect(preview.locator("img")).toBeVisible();
  await expect(page.locator("#benchmark-reference-note")).toContainText("before viewing model answers");
  await page.locator("#benchmark-reference-case").selectOption("case-11");await expect(preview).toContainText("case-11 · verified");
  expect(activity.images).toEqual(["case-01","case-11"]);expect(activity.workers).toBe(0);expect(activity.cases).toEqual([]);expect(activity.weights).toEqual([]);
  const downloadPromise=page.waitForEvent("download");await page.locator("#benchmark-review-csv").click();const file=await (await downloadPromise).path();
  const csv=await readFile(file!,"utf8");expect(csv).toContain(manifest.cases[10].sha256);expect(csv).toContain("/core-benchmark-v026/images/case-11.png");
  expect(csv).not.toContain("SYNTHETIC UI TEST");expect(csv).not.toContain("Playwright capability fixture");
  await page.locator("#benchmark-reference-close").click();await expect(page.locator("#benchmark-review-images")).toBeFocused();
  await page.locator("#benchmark-case").selectOption("case-11");await consent(page);await page.locator("#benchmark-run").click();
  await expect(page.locator("#benchmark-stop")).toBeDisabled({timeout:15_000});
  expect(activity.cases.map(x=>[x.caseId,x.sha256,x.mode])).toEqual([["case-11",manifest.cases[10].sha256,"quality"]]);
  await page.locator("#benchmark-review-images").click();await expect(page.locator("#benchmark-reference-note")).toContainText("already been displayed");
  await preserved(page);
});

test("core benchmark quality batch binds exact image hashes, runs sequentially and preserves literal output",async({page},testInfo)=>{
  const {manifest,activity}=await fixture(page);await open(page);await expect(page.locator("#benchmark-run")).toBeDisabled();
  expect(activity.images).toEqual([]);expect(activity.workers).toBe(0);expect(activity.weights).toEqual([]);
  await page.locator("#benchmark-count").selectOption("5");await page.locator("#benchmark-device").fill("Synthetic test device; not a physical phone");await consent(page);
  await page.locator("#benchmark-run").click();await expect(page.locator("#benchmark-stop")).toBeDisabled({timeout:15_000});
  expect(activity.cases.map(x=>x.caseId)).toEqual(manifest.cases.slice(0,5).map(x=>x.id));expect(activity.images).toEqual(manifest.cases.slice(0,5).map(x=>x.id));
  expect(activity.cases.map(x=>x.sha256)).toEqual(manifest.cases.slice(0,5).map(x=>x.sha256));expect(activity.cases.every(x=>x.mode==="quality"&&x.active===1)).toBe(true);
  expect(activity.workers).toBe(1);expect(activity.requestMethods).toEqual(["GET"]);
  await expect(page.locator("#benchmark-results")).toContainText(attack);await expect(page.locator("#benchmark-results img")).toHaveCount(0);expect(await page.evaluate(()=>Boolean((globalThis as any).benchmarkInjected))).toBe(false);
  const exported=await report(page);reportScope(exported);expect(exported.partial).toBe(true);expect(exported.runs).toHaveLength(1);
  const run=exported.runs[0];expect(run).toMatchObject({status:"completed",mode:"quality",maxNewTokens:128,selfReportedDeviceLabel:"Synthetic test device; not a physical phone"});
  expect(run.appVersion).toBe(exported.appVersion);
  const plan=await evaluationPlan();expect(exported.activeEvaluationPlan).toMatchObject(plan);
  expect(run.evaluation).toEqual({planId:plan.id,planSha256:plan.sha256,target:"desktop"});
  expect(run.technicalSummary).toMatchObject({classification:"software-adapter",physicalDeviceVerified:false,counts:{selected:5,unselected:35,attempted:5,completed:5,capped:0},
    timings:{withheldReason:null,cold:{count:1,firstToken:{count:1,medianMs:5,p95Ms:null},load:{count:1,medianMs:10,p95Ms:null}},warm:{count:4,firstToken:{count:4,medianMs:5,p95Ms:null},endToEnd:{count:4,p95Ms:null}}}});
  await expect(page.locator(".bench-technical-summary")).toContainText(/p95/i);
  expect(run.selectedCaseIds).toEqual(manifest.cases.slice(0,5).map(x=>x.id));expect(run.unselectedCaseIds).toHaveLength(35);
  expect(run.cases.map((x:any)=>x.status)).toEqual(Array(5).fill("completed"));
  for(const [i,entry] of run.cases.entries()){
    expect(entry).toMatchObject({caseId:manifest.cases[i].id,imageSha256:manifest.cases[i].sha256,sourceSha256:manifest.cases[i].sourceSha256});
    expect(entry.result).toMatchObject({imageSha256:manifest.cases[i].sha256,device:"webgpu",mode:"quality",maxNewTokens:128,generatedTokens:19,outputLimitReached:false,modelReused:i>0,
      adapter:{softwareAdapter:true},memory:{gpuMemoryBytes:null,jsHeapUsedBytes:null}});
    expect(entry.result.text).toContain(`[input-sha256:${manifest.cases[i].sha256}]`);expect(entry.elapsedMs).toBeGreaterThanOrEqual(0);
  }
  await preserved(page);await page.screenshot({path:testInfo.outputPath("core-benchmark-desktop.png"),fullPage:true});
});

test("core benchmark compatibility mode stays distinct and retains earlier quality runs",async({page})=>{
  const {activity}=await fixture(page);await open(page);await consent(page);await page.locator("#benchmark-run").click();
  await expect(page.locator("#benchmark-stop")).toBeDisabled({timeout:15_000});
  await page.locator("#benchmark-mode").selectOption("compatibility");await page.locator("#benchmark-case").selectOption("case-11");await page.locator("#benchmark-run").click();
  await expect(page.locator("#benchmark-stop")).toBeDisabled({timeout:15_000});
  const exported=await report(page);reportScope(exported);expect(exported.partial).toBe(true);expect(exported.runs).toHaveLength(2);expect(activity.cases.map(x=>[x.caseId,x.mode])).toEqual([["case-01","quality"],["case-11","compatibility"]]);
  expect(exported.runs.map((x:any)=>[x.mode,x.maxNewTokens])).toEqual([["quality",128],["compatibility",32]]);
  expect(exported.runs[1].cases[0].result).toMatchObject({mode:"compatibility",generatedTokens:32,maxNewTokens:32,outputLimitReached:true});
  expect(exported.runs[0].technicalSummary).toMatchObject({mode:"quality",counts:{completed:1,capped:0},timings:{cold:{count:1},warm:{count:0}}});
  expect(exported.runs[1].technicalSummary).toMatchObject({mode:"compatibility",counts:{completed:1,capped:1},timings:{cold:{count:1},warm:{count:0}}});
  await expect(page.locator(".bench-run").first().locator(".bench-run-summary")).toContainText("Unscored execution check");
  await preserved(page);
});

test("core benchmark cancelled image fetch starts no worker and cannot leak into a restarted run",async({page})=>{
  const {activity,buffers}=await fixture(page);let release:()=>void=()=>{};const blocked=new Promise<void>(resolve=>{release=resolve});let intercepted=0;
  await page.route("**/core-benchmark-v026/images/case-01.png",async route=>{intercepted++;if(intercepted===1)await blocked;await route.fulfill({contentType:"image/png",body:buffers[0]}).catch(()=>{})});
  await open(page);await page.locator("#benchmark-count").selectOption("5");await consent(page);await page.locator("#benchmark-run").click();await expect.poll(()=>intercepted).toBe(1);
  await page.locator("#benchmark-stop").click();await expect(page.locator("#benchmark-stop")).toBeDisabled();expect(activity.workers).toBe(0);
  release();const cancelled=await report(page);reportScope(cancelled);expect(cancelled.runs).toHaveLength(1);
  expect(cancelled.runs[0].status).toBe("cancelled");expect(cancelled.runs[0].cases.map((x:any)=>x.status)).toEqual(["cancelled","not-started","not-started","not-started","not-started"]);
  await page.locator("#benchmark-count").selectOption("1");await page.locator("#benchmark-case").selectOption("case-03");await page.locator("#benchmark-run").click();
  await expect(page.locator("#benchmark-stop")).toBeDisabled({timeout:15_000});expect(activity.cases.map(x=>x.caseId)).toEqual(["case-03"]);expect((await report(page)).runs).toHaveLength(2);await preserved(page);
});

test("core benchmark times out a stalled image fetch before creating a model worker",async({page})=>{
  const {activity,buffers}=await fixture(page);await page.clock.install();
  let release:()=>void=()=>{},intercepted=0;const blocked=new Promise<void>(resolve=>{release=resolve});
  await page.route("**/core-benchmark-v026/images/case-01.png",async route=>{intercepted++;await blocked;await route.fulfill({contentType:"image/png",body:buffers[0]}).catch(()=>{})});
  try{
    await open(page);await page.locator("#benchmark-count").selectOption("5");await consent(page);await page.locator("#benchmark-run").click();await expect.poll(()=>intercepted).toBe(1);
    await page.clock.fastForward(30*60_000+1000);await expect(page.locator("#benchmark-stop")).toBeDisabled();await expect(page.locator("#benchmark-status")).toContainText("timed out");
    expect(activity.workers).toBe(0);expect(activity.cases).toEqual([]);expect(activity.weights).toEqual([]);
    const timedOut=await report(page);reportScope(timedOut);expect(timedOut.runs[0].status).toBe("failed");
    expect(timedOut.runs[0].cases.map((x:any)=>x.status)).toEqual(["timed-out","not-started","not-started","not-started","not-started"]);
    expect(timedOut.runs[0].cases[0].elapsedMs).toBeGreaterThanOrEqual(30*60_000);await preserved(page);
  }finally{release()}
});

test("core benchmark visibility interruption preserves completed cases and records remaining coverage",async({page})=>{
  const {activity}=await fixture(page,{delayCase:"case-02",delayMs:5000});await open(page);await page.locator("#benchmark-count").selectOption("5");await consent(page);await page.locator("#benchmark-run").click();
  await expect.poll(()=>activity.cases.map(x=>x.caseId)).toEqual(["case-01","case-02"]);
  await page.evaluate(()=>{Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"});document.dispatchEvent(new Event("visibilitychange"))});
  await expect(page.locator("#benchmark-stop")).toBeDisabled();const interrupted=await report(page);reportScope(interrupted);expect(interrupted.runs).toHaveLength(1);
  expect(interrupted.runs[0].status).toBe("interrupted");expect(interrupted.runs[0].cases.map((x:any)=>x.status)).toEqual(["completed","interrupted","not-started","not-started","not-started"]);
  expect(interrupted.runs[0].unselectedCaseIds).toHaveLength(35);
  await page.evaluate(()=>{Object.defineProperty(document,"visibilityState",{configurable:true,value:"visible"});document.dispatchEvent(new Event("visibilitychange"))});
  await preserved(page);
});

test("core benchmark reload recovers interrupted results without restarting inference",async({page})=>{
  const {activity}=await fixture(page,{delayCase:"case-02",delayMs:20_000});await open(page);
  await page.locator("#benchmark-count").selectOption("5");await page.locator("#benchmark-device").fill("Synthetic persistence device");await consent(page);await page.locator("#benchmark-run").click();
  await expect.poll(()=>activity.cases.map(x=>x.caseId)).toEqual(["case-01","case-02"]);
  await expect.poll(()=>page.evaluate(()=>!!localStorage.getItem("geomodel3d:qwen-benchmark:last-report"))).toBe(true);
  const originalBrowser=await page.evaluate(()=>JSON.parse(localStorage.getItem("geomodel3d:qwen-benchmark:last-report")!).runs[0].browserContext);
  const before={workers:activity.workers,images:activity.images.length,cases:activity.cases.length,weights:activity.weights.length};
  page.once("dialog",dialog=>dialog.accept());await page.reload();await expect(page.locator("#benchmark-case option")).toHaveCount(40);
  await expect(page.locator("#benchmark-status")).toContainText(/Recovered .*saved run/);await expect(page.locator("#benchmark-export")).toBeEnabled();
  await expect(page.locator("#benchmark-stop")).toBeDisabled();await expect(page.locator("#benchmark-consent")).not.toBeChecked();
  const restored=await report(page);reportScope(restored);expect(restored.runs).toHaveLength(1);
  expect(restored.runs[0]).toMatchObject({status:"interrupted",selfReportedDeviceLabel:"Synthetic persistence device"});
  expect(restored.runs[0].browserContext).toEqual(originalBrowser);
  const plan=await evaluationPlan();expect(restored.runs[0].evaluation).toEqual({planId:plan.id,planSha256:plan.sha256,target:"desktop"});
  expect(restored.runs[0].cases.map((x:any)=>x.status)).toEqual(["completed","interrupted","not-started","not-started","not-started"]);
  expect(restored.runs[0].cases[0].result.text).toContain("SYNTHETIC UI TEST case-01");expect(restored.runs[0].cases[1].result).toBeUndefined();
  expect({workers:activity.workers,images:activity.images.length,cases:activity.cases.length,weights:activity.weights.length}).toEqual(before);
  await page.locator("#benchmark-case").selectOption("case-11");await consent(page);await page.locator("#benchmark-run").click();await expect(page.locator("#benchmark-stop")).toBeDisabled({timeout:15_000});
  const next=await report(page);expect(next.runs).toHaveLength(2);expect(next.runs[0].status).toBe("interrupted");expect(next.runs[1]).toMatchObject({status:"completed",selectedCaseIds:["case-11"]});
  await preserved(page);
});

test("core benchmark reports the failed resource separately from its last observed download",async({page})=>{
  const {activity}=await fixture(page,{failCase:"case-01",diagnosticFailure:true});await open(page);await consent(page);await page.locator("#benchmark-run").click();
  await expect(page.locator("#benchmark-stop")).toBeDisabled();await expect(page.locator("#benchmark-status")).toContainText("Load failed");
  const exported=await report(page);reportScope(exported);const entry=exported.runs[0].cases[0];
  expect(entry.status).toBe("failed");expect(entry.error).toContain("Load failed");expect(entry.error).toContain(attack);expect(entry.error).not.toContain("token=secret");
  expect(entry.errorDiagnostic).toMatchObject({stage:"model-load",name:"TypeError",operation:"fetch",resource:"onnx/decoder_model_merged_q4.onnx_data"});
  expect(entry.errorDiagnostic).not.toHaveProperty("unexpectedImage");
  expect(entry.lastProgress).toMatchObject({observedAt:expect.any(String),caseElapsedMs:expect.any(Number),progress:{stage:"model-load",file:"onnx/vision_encoder.onnx_data",loaded:1048576,total:4194304}});
  await expect(page.locator(".bench-case-diagnostic")).toContainText("failed resource: onnx/decoder_model_merged_q4.onnx_data");
  await expect(page.locator(".bench-case-progress-note")).toContainText("observed file: onnx/vision_encoder.onnx_data");
  await expect(page.locator("#benchmark-results img")).toHaveCount(0);expect(await page.evaluate(()=>Boolean((globalThis as any).benchmarkInjected))).toBe(false);
  expect(activity.cases).toHaveLength(1);await preserved(page);
});

test("core benchmark throttles progress checkpoints and recovers an abrupt interruption without invented timing",async({page})=>{
  const {activity}=await fixture(page,{progressBurst:true,delayCase:"case-01",delayMs:60_000});
  const frozenTime=new Date("2026-11-15T12:00:00Z");await page.clock.install({time:frozenTime});await page.clock.pauseAt(frozenTime);
  await open(page);await consent(page);await page.locator("#benchmark-run").click();await expect(page.locator("#benchmark-status")).toContainText("Fixture burst 99");
  const before=await page.evaluate(()=>({writes:(globalThis as any).benchmarkRecoveryWrites,saved:JSON.parse(localStorage.getItem("geomodel3d:qwen-benchmark:last-report")!)}));
  expect(before.writes).toBeLessThan(20);expect(before.saved.runs[0].cases[0].lastProgress.progress.loaded).toBe(1);
  await page.clock.runFor(1001);
  const after=await page.evaluate(()=>({writes:(globalThis as any).benchmarkRecoveryWrites,saved:JSON.parse(localStorage.getItem("geomodel3d:qwen-benchmark:last-report")!)}));
  expect(after.writes-before.writes).toBe(1);expect(after.saved.runs[0].cases[0].lastProgress.progress.loaded).toBe(99);
  const exported=await report(page);expect(exported.inProgress).toBe(true);expect(exported.runs[0].status).toBe("running");
  const lastProgress=structuredClone(exported.runs[0].cases[0].lastProgress);
  const stored={version:1,protocolSha256:exported.protocol.sha256,manifestSha256:exported.dataset.manifestSha256,runs:exported.runs};
  stored.runs[0].appVersion="0.26.0";
  stored.runs[0].cases[0].lastProgress.unexpectedImage="data:image/png;base64,unexpected";
  stored.runs[0].cases[0].lastProgress.progress.unexpectedImage="data:image/png;base64,unexpected";
  await page.locator("#benchmark-stop").click();
  const unchanged={workers:activity.workers,images:activity.images.length,cases:activity.cases.length,weights:activity.weights.length};
  // Inject the last downloaded running snapshot before bootstrap: no unload handler wrote a terminal result in this saved record.
  await page.addInitScript(value=>localStorage.setItem("geomodel3d:qwen-benchmark:last-report",JSON.stringify(value)),stored);
  await page.reload();await expect(page.locator("#benchmark-case option")).toHaveCount(40);await expect(page.locator("#benchmark-status")).toContainText("Recovered");
  const recovered=await report(page);reportScope(recovered);const run=recovered.runs[0],entry=run.cases[0];
  expect(run).toMatchObject({status:"interrupted",appVersion:"0.26.0",recoveredAt:expect.any(String)});expect(run.finishedAt).toBeUndefined();
  expect(entry).toMatchObject({status:"interrupted",recoveredAt:expect.any(String),lastProgress});expect(entry.finishedAt).toBeUndefined();expect(entry.elapsedMs).toBeUndefined();expect(entry.result).toBeUndefined();
  expect(entry.error).toContain("cause and stopping time were not observed");
  await expect(page.locator(".bench-case-progress-note")).toContainText("not a completion time");
  expect({workers:activity.workers,images:activity.images.length,cases:activity.cases.length,weights:activity.weights.length}).toEqual(unchanged);await expect(page.locator("#benchmark-consent")).not.toBeChecked();await preserved(page);
});

test("core benchmark restores legacy reports without relabelling unknown or older app versions",async({page})=>{
  const {activity}=await fixture(page);await open(page);await consent(page);await page.locator("#benchmark-run").click();await expect(page.locator("#benchmark-stop")).toBeDisabled();
  const exported=await report(page),originalBrowser=exported.runs[0].browserContext,originalFinishedAt=exported.runs[0].finishedAt;
  const first=structuredClone(exported.runs[0]);delete first.appVersion;delete first.evaluation;delete first.cases[0].lastProgress;delete first.cases[0].errorDiagnostic;
  const second=structuredClone(first);second.id="run-2";second.appVersion="0.26.0";second.status="failed";second.cases[0].status="failed";second.cases[0].error="Load failed";delete second.cases[0].result;
  const saved={version:1,protocolSha256:exported.protocol.sha256,manifestSha256:exported.dataset.manifestSha256,runs:[first,second]};
  await page.addInitScript(value=>localStorage.setItem("geomodel3d:qwen-benchmark:last-report",JSON.stringify(value)),saved);
  const workers=activity.workers;await page.reload();await expect(page.locator("#benchmark-case option")).toHaveCount(40);const recovered=await report(page);reportScope(recovered);
  expect(recovered.runs[0].evaluation).toBeUndefined();expect(recovered.runs[0].technicalSummary.classification).toBe("legacy-unassigned");expect(recovered.runs[0].appVersion).toBeUndefined();expect(recovered.runs[0].cases[0].lastProgress).toBeUndefined();expect(recovered.runs[0].finishedAt).toBe(originalFinishedAt);expect(recovered.runs[0].browserContext).toEqual(originalBrowser);
  expect(recovered.runs[1]).toMatchObject({appVersion:"0.26.0",status:"failed",cases:[{status:"failed",error:"Load failed"}]});expect(recovered.runs[1].cases[0].errorDiagnostic).toBeUndefined();expect(activity.workers).toBe(workers);await preserved(page);
});

test("core benchmark preserves legacy phone and unknown-plan history beside new desktop runs",async({page})=>{
  const {activity}=await fixture(page);await open(page);await expect(page.locator("#benchmark-target")).toHaveValue("desktop");
  await consent(page);await page.locator("#benchmark-run").click();await expect(page.locator("#benchmark-stop")).toBeDisabled();
  const exported=await report(page),plan=await evaluationPlan();
  const legacy=structuredClone(exported.runs[0]);legacy.appVersion="0.26.0";delete legacy.evaluation;
  legacy.selfReportedDeviceLabel="Historical phone fixture";legacy.browserContext.userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/27.2 Mobile/15E148 Safari/604.1";
  // Recovery recalculates a summary; saved summaries are not trusted evidence.
  legacy.technicalSummary={classification:"desktop-candidate",passed:true};
  const other=structuredClone(legacy);other.id="run-2";other.evaluation={planId:"earlier-desktop-plan",planSha256:"a".repeat(64),target:"exploratory",unexpectedImage:"data:image/png;base64,unexpected"};
  const saved={version:1,protocolSha256:exported.protocol.sha256,manifestSha256:exported.dataset.manifestSha256,runs:[legacy,other]};
  await page.evaluate(value=>localStorage.setItem("geomodel3d:qwen-benchmark:last-report",JSON.stringify(value)),saved);
  const before={workers:activity.workers,images:activity.images.length,cases:activity.cases.length,weights:activity.weights.length};
  await page.reload();await expect(page.locator("#benchmark-case option")).toHaveCount(40);await expect(page.locator("#benchmark-recovery-status")).toContainText("Recovered 2 saved runs");
  const recovered=await report(page);reportScope(recovered);expect(recovered.runs).toHaveLength(2);
  expect(recovered.runs[0].evaluation).toBeUndefined();expect(recovered.runs[0].browserContext).toEqual(legacy.browserContext);
  expect(recovered.runs[0].technicalSummary).toMatchObject({classification:"legacy-unassigned",physicalDeviceVerified:false});expect(recovered.runs[0].technicalSummary).not.toHaveProperty("passed");
  expect(recovered.runs[1].evaluation).toEqual({planId:"earlier-desktop-plan",planSha256:"a".repeat(64),target:"exploratory"});
  expect(recovered.runs[1].technicalSummary.classification).toBe("different-plan");
  expect({workers:activity.workers,images:activity.images.length,cases:activity.cases.length,weights:activity.weights.length}).toEqual(before);
  await page.locator("#benchmark-device").fill("New desktop fixture");await page.locator("#benchmark-case").selectOption("case-03");await consent(page);await page.locator("#benchmark-run").click();await expect(page.locator("#benchmark-stop")).toBeDisabled();
  const mixed=await report(page);reportScope(mixed);expect(mixed.runs).toHaveLength(3);expect(mixed.activeEvaluationPlan).toMatchObject(plan);
  expect(mixed.runs[0].evaluation).toBeUndefined();expect(mixed.runs[0].browserContext).toEqual(legacy.browserContext);
  expect(mixed.runs[1].evaluation).toEqual(recovered.runs[1].evaluation);expect(mixed.runs[2].evaluation).toEqual({planId:plan.id,planSha256:plan.sha256,target:"desktop"});
  expect(mixed.runs[2].technicalSummary).toMatchObject({classification:"software-adapter",counts:{selected:1,completed:1},timings:{cold:{count:1},warm:{count:0}}});
  expect(activity.cases.map(x=>x.caseId)).toEqual(["case-01","case-03"]);
  await page.reload();await expect(page.locator("#benchmark-case option")).toHaveCount(40);const again=await report(page);
  expect(again.runs.map((run:any)=>run.evaluation)).toEqual(mixed.runs.map((run:any)=>run.evaluation));expect(again.runs[0].browserContext).toEqual(legacy.browserContext);await preserved(page);
});

test("core benchmark rejects a modified input before loading a model",async({page})=>{
  const {activity}=await fixture(page,{tamperCase:"case-01"});await open(page);await consent(page);await page.locator("#benchmark-run").click();
  await expect(page.locator("#benchmark-status")).toContainText(/integrity|hash|SHA-256/i);await expect(page.locator("#benchmark-stop")).toBeDisabled();
  expect(activity.workers).toBe(0);expect(activity.weights).toEqual([]);const failed=await report(page);reportScope(failed);expect(failed.runs).toHaveLength(1);
  expect(failed.runs[0]).toMatchObject({status:"failed",cases:[{caseId:"case-01",status:"failed",errorDiagnostic:{stage:"image-verify",resource:"images/case-01.png"}}]});await preserved(page);
});

test("core benchmark clears only its own cache and records runtime failures",async({page})=>{
  const {activity}=await fixture(page,{failCase:"case-02"});await open(page);
  await page.evaluate(async()=>{for(const name of ["geomodel3d-qwen-benchmark","geomodel3d-core-vlm","unrelated-test-cache"]){const c=await caches.open(name);await c.put(new Request(location.origin+"/cache-fixture"),new Response("synthetic cached bytes"))}});
  await page.locator("#benchmark-clear-cache").click();await expect(page.locator("#benchmark-status")).toContainText(/cache/i);
  const names=await page.evaluate(()=>caches.keys());expect(names).not.toContain("geomodel3d-qwen-benchmark");expect(names).toContain("geomodel3d-core-vlm");expect(names).toContain("unrelated-test-cache");
  await page.locator("#benchmark-count").selectOption("5");await consent(page);await page.locator("#benchmark-run").click();
  await expect(page.locator("#benchmark-status")).toContainText("Synthetic runtime failure");await expect(page.locator("#benchmark-stop")).toBeDisabled();
  expect(activity.cases.map(x=>x.caseId)).toEqual(["case-01","case-02"]);const failed=await report(page);reportScope(failed);expect(failed.runs).toHaveLength(1);
  expect(failed.runs[0].status).toBe("failed");expect(failed.runs[0].cases.map((x:any)=>x.status)).toEqual(["completed","failed","not-started","not-started","not-started"]);await preserved(page);
});

test("core benchmark completes all forty cases without inventing human review or hardware qualification",async({page})=>{
  const {manifest,activity}=await fixture(page);await open(page);await page.locator("#benchmark-count").selectOption("40");await consent(page);await page.locator("#benchmark-run").click();
  await expect(page.locator("#benchmark-status")).toContainText("40 selected cases completed",{timeout:25_000});
  const exported=await report(page);reportScope(exported);expect(exported.partial).toBe(false);const run=exported.runs[0];
  expect(run.status).toBe("completed");expect(run.cases).toHaveLength(40);expect(run.unselectedCaseIds).toEqual([]);
  expect(run.technicalSummary).toMatchObject({classification:"software-adapter",physicalDeviceVerified:false,counts:{selected:40,unselected:0,attempted:40,completed:40,capped:0},
    timings:{withheldReason:null,cold:{count:1,firstToken:{count:1,p95Ms:null}},warm:{count:39,firstToken:{count:39,medianMs:5,p95Ms:5},endToEnd:{count:39,p95Ms:expect.any(Number)}}}});
  const warmElapsed=run.cases.slice(1).map((entry:any)=>entry.elapsedMs).sort((a:number,b:number)=>a-b);
  expect(run.technicalSummary.timings.warm.endToEnd.p95Ms).toBe(warmElapsed[Math.ceil(.95*warmElapsed.length)-1]);
  expect(run.technicalSummary).not.toHaveProperty("passed");expect(run.technicalSummary).not.toHaveProperty("qualityScore");
  expect(run.cases.every((x:any)=>x.status==="completed"&&x.result.adapter.softwareAdapter===true)).toBe(true);
  expect(activity.cases.map(x=>x.caseId)).toEqual(manifest.cases.map(x=>x.id));expect(activity.cases.every(x=>x.active===1)).toBe(true);
  await expect(page.locator("#benchmark-status")).toContainText("Human quality review is still pending");await preserved(page);
});

test("mobile core benchmark keeps controls and results usable without claiming physical device validation",async({page},testInfo)=>{
  await fixture(page);await open(page);await page.locator("#benchmark-target").selectOption("exploratory");await page.locator("#benchmark-device").fill("iPhone 17 layout emulation only");await consent(page);await page.locator("#benchmark-device").focus();await page.keyboard.press("Tab");await expect(page.locator("#benchmark-consent")).toBeFocused();await page.keyboard.press("Tab");await expect(page.locator("#benchmark-run")).toBeFocused();await page.keyboard.press("Enter");
  await expect(page.locator("#benchmark-stop")).toBeDisabled({timeout:15_000});await expect(page.locator("#benchmark-export")).toBeEnabled();
  const exported=await report(page);reportScope(exported);expect(exported.runs).toHaveLength(1);expect(exported.runs[0].selfReportedDeviceLabel).toBe("iPhone 17 layout emulation only");
  expect(exported.runs[0].evaluation.target).toBe("exploratory");expect(exported.runs[0].technicalSummary.classification).toBe("exploratory");
  const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));expect(size.scroll).toBeLessThanOrEqual(size.width+1);
  await page.locator("#benchmark-results").scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("core-benchmark-mobile.png"),fullPage:true});await preserved(page);
});
