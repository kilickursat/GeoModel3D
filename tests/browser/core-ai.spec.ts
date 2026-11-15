import {test,expect,Page,Locator} from "@playwright/test";
import {existsSync,readFileSync} from "node:fs";
import {resolve} from "node:path";
import {downloadJson,importJson,openInput,prepare,saved} from "./helpers";

const modelHost=(url:string)=>/https:\/\/(?:[^/]+\.)?(?:huggingface\.co|hf\.co|hf\.space|xethub\.hf\.co)\//.test(url);
const attack='<img src=x onerror="globalThis.coreAiInjected=true">';
const appVersion=JSON.parse(readFileSync(resolve("package.json"),"utf8")).version as string;

async function gpuSupport(page:Page,supported:boolean){
  // The UI's capability check is deterministic. Inference itself is exercised through a real Worker whose
  // module is routed below; this fixture never claims to run a model on the test machine's GPU.
  await page.addInitScript(supported=>{
    Object.defineProperty(navigator,"gpu",{configurable:true,value:supported?{
      requestAdapter:async()=>({features:new Set(["shader-f16"]),limits:{maxStorageBufferBindingSize:1_073_741_824,maxBufferSize:2_147_483_648},info:{vendor:"Playwright capability fixture"}}),
      getPreferredCanvasFormat:()=>"bgra8unorm"
    }:undefined});
  },supported);
}

async function fixture(page:Page){
  const image=await page.evaluate(()=>{
    const canvas=document.createElement("canvas");canvas.width=800;canvas.height=400;
    const context=canvas.getContext("2d")!;context.fillStyle="#d8c9ae";context.fillRect(0,0,800,400);
    context.fillStyle="#353c3f";context.font="22px sans-serif";context.fillText("SYNTHETIC CORE · UI TEST ONLY",35,40);
    for(const y of [80,240]){
      context.fillStyle="#49483e";context.fillRect(40,y,720,80);
      for(let i=0;i<8;i++){context.fillStyle=i%2?"#a7a394":"#b9af99";context.fillRect(45+i*89,y+8,83,64)}
    }
    return canvas.toDataURL("image/png");
  });
  const piece=(id:string,end:number)=>({id,end,sound:"unknown",breakAfter:"end",unit:"rock",description:"Existing description remains unchanged"});
  return {
    name:"Local core AI validation",crs:"Local grid",base:0,margin:2,
    units:[{id:"rock",name:"Reviewed rock",color:"#a7a394",params:{E:1000},source:"Existing engineering interpretation"}],
    boreholes:[{id:"BH-01",x:0,y:0,z:10,depth:5,intervals:[{from:0,to:5,unit:"rock",name:"Existing log"}],tests:[{depth:2,property:"qu",value:1000}]},
      {id:"BH-02",x:20,y:0,z:10,depth:5,intervals:[{from:0,to:5,unit:"rock"}]}],
    evidence:{version:1,sources:[{id:"source-ai",name:"Synthetic core photo.png",pages:[{page:1,width:800,height:400,image}]}],records:[]},
    corePhotos:{version:1,runs:[{id:"run-first",boreholeId:"BH-01",sourceId:"source-ai",from:0,to:1,lossReviewed:false,status:"draft",rows:[
      {id:"row-first",box:{x0:.05,y0:.2,x1:.95,y1:.4},from:0,to:.4,direction:"ltr",registrationReviewed:false,pieces:[piece("piece-first",.4)]},
      {id:"row-second",box:{x0:.05,y0:.6,x1:.95,y1:.8},from:.6,to:1,direction:"rtl",registrationReviewed:false,pieces:[piece("piece-second",1)]}]},
      {id:"run-other",boreholeId:"BH-02",sourceId:"source-ai",from:4,to:5,lossReviewed:false,status:"draft",rows:[
        {id:"row-other",box:{x0:.05,y0:.2,x1:.95,y1:.4},from:4,to:5,direction:"ltr",registrationReviewed:false,pieces:[piece("piece-other",5)]}]}]}
  };
}

async function openPhotos(page:Page){
  await page.locator('[data-step="logs"]').click();await page.locator(".ws-core-photos").click();
  await expect(page.locator(".core-dialog")).toBeVisible();return page.locator(".core-dialog");
}
async function openAi(page:Page){
  await page.locator(".core-ai-open").click();const dialog=page.locator(".core-ai-dialog");await expect(dialog).toBeVisible();return dialog;
}
async function closeAi(page:Page){await page.locator(".core-ai-close").click();await expect(page.locator(".core-ai-dialog")).toHaveCount(0)}
async function closePhotos(page:Page){await page.locator(".core-close").click();await expect(page.locator(".core-dialog")).toHaveCount(0)}
async function load(page:Page,supported=true){
  await prepare(page);await gpuSupport(page,supported);await page.goto("/?backend=webgl#input");await openInput(page);
  const project=await fixture(page);await importJson(page,project,"core-ai-project.json");await saved(page);return project;
}

async function workerFixture(page:Page,delayMs=25){
  const activity={workers:0,models:[] as string[],methods:[] as string[]};
  // Route the Worker module, not the UI or CoreAiClient. Messages still cross a real Worker boundary, and
  // cancellation terminates that Worker. No Transformers code or real model weights run in these tests.
  await page.route("**/src/coreAi.worker.ts*",route=>{
    activity.workers++;
    return route.fulfill({status:200,contentType:"text/javascript",body:`
import {CORE_AI_MODELS,CORE_AI_DTYPE_LABEL,CORE_AI_RUNTIME_VERSION,CORE_AI_ONNX_VERSION,CORE_AI_PROMPT_VERSION} from '/src/coreAi.ts';
self.onmessage=async({data})=>{
  if(data.type!=='run')return;
  const {id,request}=data,model=CORE_AI_MODELS.find(m=>m.id===request.modelId);
  try{
    if(!model)throw new Error('Unknown fixture model');
    self.postMessage({type:'progress',id,progress:{phase:'loading',message:'Fetching a synthetic test weight',loaded:0,total:16}});
    await fetch('https://huggingface.co/__geomodel3d_ui_fixture/'+encodeURIComponent(model.id)+'/model.bin');
    const bitmap=await createImageBitmap(await (await fetch(request.image)).blob());
    const result={modelId:model.id,model:model.repo,revision:model.revision,task:request.task,
      text:'Synthetic '+model.id+' '+request.task+': '+${JSON.stringify(attack)},
      loadMs:model.id.includes('256')?8:12,inferenceMs:model.id.includes('256')?15:28,totalMs:model.id.includes('256')?23:40,
      downloadBytes:16,cacheState:'available',cached:false,generatedTokens:model.id.includes('256')?16:128,tokensPerSecond:20,
      imageWidth:bitmap.width,imageHeight:bitmap.height,maxNewTokens:128,device:'webgpu',dtype:CORE_AI_DTYPE_LABEL,
      runtimeVersion:CORE_AI_RUNTIME_VERSION,onnxRuntimeVersion:CORE_AI_ONNX_VERSION,promptVersion:CORE_AI_PROMPT_VERSION,
      image:request.image};
    bitmap.close();
    // A wrong request id must never populate a result card or an exported benchmark.
    self.postMessage({type:'result',id:id+100000,result:{...result,text:'STALE_RESULT_SHOULD_NOT_APPEAR'}});
    self.postMessage({type:'progress',id,progress:{phase:'running',message:'Synthetic inference in progress',elapsedMs:0}});
    await new Promise(resolve=>setTimeout(resolve,${delayMs}));
    self.postMessage({type:'result',id,result});
  }catch(error){self.postMessage({type:'error',id,message:String(error.message??error)})}
};`});
  });
  await page.route("https://huggingface.co/__geomodel3d_ui_fixture/**",route=>{
    const request=route.request();activity.models.push(decodeURIComponent(new URL(request.url()).pathname.split("/")[2]));activity.methods.push(request.method());
    expect(request.postData()).toBeNull();
    return route.fulfill({status:200,headers:{"access-control-allow-origin":"*"},contentType:"application/octet-stream",body:"synthetic-weight"});
  });
  return activity;
}
async function ready(dialog:Locator){await expect(dialog.locator(".core-ai-crop")).toBeVisible();await expect(dialog.locator(".core-ai-run")).toBeEnabled()}
async function benchmark(page:Page){return downloadJson<any>(page,".core-ai-export")}
function expectImageFree(report:unknown){expect(JSON.stringify(report)).not.toMatch(/data:image|base64|STALE_RESULT_SHOULD_NOT_APPEAR/)}

test("core AI opens without downloading a model and explains unavailable WebGPU",async({page})=>{
  const requests:string[]=[];page.on("request",request=>{if(modelHost(request.url())||request.url().includes("coreAi.worker"))requests.push(request.url())});
  await load(page,false);await openPhotos(page);const dialog=await openAi(page);
  await expect(dialog.locator(".core-ai-support")).toContainText(/unavailable|not available|not supported|does not support|requires/i);
  await expect(dialog.locator(".core-ai-run")).toBeDisabled();await expect(dialog.locator(".core-ai-compare")).toBeDisabled();
  expect(requests).toEqual([]);await expect(dialog.locator(".core-ai-crop")).toBeVisible();
  await closeAi(page);await expect(page.locator(".core-ai-open")).toBeFocused();
  await expect(page.locator(".core-registration")).toBeEnabled();await closePhotos(page);
});

test("core AI explicitly compares 256M and 500M with literal text and image-free provenance",async({page},testInfo)=>{
  const requestsBeforeStart:string[]=[];page.on("request",request=>{if(modelHost(request.url())||request.url().includes("coreAi.worker"))requestsBeforeStart.push(request.url())});
  await load(page);const before=await downloadJson(page,".ws-json"),activity=await workerFixture(page);
  await openPhotos(page);const dialog=await openAi(page);await ready(dialog);
  const frame=await dialog.locator(".core-ai-crop").evaluate(async(image:HTMLImageElement)=>{
    const canvas=document.createElement("canvas");canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    const context=canvas.getContext("2d")!;context.drawImage(image,0,0);
    const bytes=Uint8Array.from(atob(image.src.split(",")[1]),c=>c.charCodeAt(0));
    return {width:canvas.width,height:canvas.height,corner:[...context.getImageData(0,0,1,1).data],center:[...context.getImageData(256,256,1,1).data],
      sha256:[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(v=>v.toString(16).padStart(2,"0")).join("")};
  });
  expect(frame).toMatchObject({width:512,height:512,corner:[128,128,128,255]});expect(frame.center).not.toEqual(frame.corner);
  await dialog.locator(".core-ai-model").selectOption("smolvlm-500m");await dialog.locator(".core-ai-task").selectOption("observations");
  expect(activity).toEqual({workers:0,models:[],methods:[]});expect(requestsBeforeStart).toEqual([]);await dialog.locator(".core-ai-task").selectOption("describe");
  await dialog.locator(".core-ai-compare").click();await expect(dialog.locator(".core-ai-result")).toHaveCount(2);await expect(dialog.locator(".core-ai-export")).toBeEnabled();
  expect(activity.models).toEqual(["smolvlm-256m","smolvlm-500m"]);expect(activity.methods).toEqual(["GET","GET"]);expect(activity.workers).toBeGreaterThan(0);
  for(const id of ["smolvlm-256m","smolvlm-500m"]){
    const card=dialog.locator(`[data-model-id="${id}"]`);await expect(card.locator(".core-ai-output")).toHaveText(`Synthetic ${id} describe: ${attack}`);
    await expect(card.locator(".core-ai-result-interval")).toContainText("BH-01 · 0–0.4 m");
    if(id==="smolvlm-500m")await expect(card.locator(".core-ai-truncated")).toHaveText("Output reached the 128-token limit and may be incomplete.");
    else await expect(card.locator(".core-ai-truncated")).toHaveCount(0);
  }
  await expect(dialog.locator(".core-ai-truncated")).toHaveCount(1);
  await expect(dialog.locator('.core-ai-output img')).toHaveCount(0);expect(await page.evaluate(()=>Boolean((globalThis as any).coreAiInjected))).toBe(false);
  const first=dialog.locator(".core-ai-result").first();await first.locator(".core-ai-useful").selectOption("yes");await first.locator(".core-ai-hallucinations").selectOption("yes");
  await first.locator(".core-ai-review-notes").fill("Synthetic test output; the HTML-like text must remain literal.");
  const report=await benchmark(page);expect(report).toMatchObject({format:"geomodel3d-core-ai-benchmark",version:1,appVersion,
    interval:{sourceId:"source-ai",runId:"run-first",boreholeId:"BH-01",rowId:"row-first",from:0,to:.4,direction:"ltr",registrationReviewed:false}});
  expect(report.crop).toMatchObject({normalizedBox:{x0:.05,y0:.2,x1:.95,y1:.4},sourceWidth:800,sourceHeight:400,pixels:{x:40,y:80,width:720,height:80},analysisWidth:512,analysisHeight:512,
    preprocessing:{method:"aspect-preserving-gray-letterbox",scaledWidth:512,scaledHeight:57,padding:{left:0,top:227,right:0,bottom:228},background:"#808080"}});
  const scaled=report.crop.preprocessing;expect(scaled.scaledWidth+scaled.padding.left+scaled.padding.right).toBe(512);expect(scaled.scaledHeight+scaled.padding.top+scaled.padding.bottom).toBe(512);
  expect(Math.abs(scaled.scaledHeight-scaled.scaledWidth*report.crop.pixels.height/report.crop.pixels.width)).toBeLessThanOrEqual(.5);
  expect(report.crop.sha256).toBe(frame.sha256);expect(report.trials).toHaveLength(1);expect(report.trials[0].promptVersion).toBe(1);expect(report.trials[0].prompt).toContain("Do not infer");
  expect(report.trials[0]).toMatchObject({kind:"comparison",task:"describe",modelIds:["smolvlm-256m","smolvlm-500m"],status:"completed"});
  expect(report.trials[0].results.map((entry:any)=>entry.result.generatedTokens)).toEqual([16,128]);
  for(const [index,entry] of report.trials[0].results.entries()){
    const model=index===0?"smolvlm-256m":"smolvlm-500m";expect(entry.result).toMatchObject({modelId:model,task:"describe",imageWidth:512,imageHeight:512,maxNewTokens:128,device:"webgpu",promptVersion:1});
    expect(entry.result.model).toMatch(index===0?/256M/:/500M/);expect(entry.result.revision).toMatch(/^[a-f0-9]{40}$/);expect(entry.result.dtype).toContain("q4");
    expect(entry.result.runtimeVersion).toMatch(/^\d+\.\d+\.\d+/);expect(entry.result.onnxRuntimeVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(entry.result.totalMs).toBe(entry.result.loadMs+entry.result.inferenceMs);
  }
  expect(report.trials[0].results[0].review).toMatchObject({useful:"yes",hallucinations:"yes",notes:"Synthetic test output; the HTML-like text must remain literal."});expectImageFree(report);
  await dialog.locator(".core-ai-results").scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("core-ai-comparison-desktop.png"),fullPage:true});
  // Selecting a new task leaves earlier trials correctly labelled; a new run records its own task.
  await dialog.locator(".core-ai-task").selectOption("observations");await dialog.locator(".core-ai-run").click();
  await expect(dialog.locator(".core-ai-result")).toHaveCount(3);await expect(dialog.locator(".core-ai-export")).toBeEnabled();
  const next=await benchmark(page);expect(next.trials.map((trial:any)=>trial.task)).toEqual(["describe","observations"]);
  expect(next.trials[0].results.map((entry:any)=>entry.result.task)).toEqual(["describe","describe"]);expect(next.trials[1].results[0].result.task).toBe("observations");expectImageFree(next);
  await closeAi(page);await closePhotos(page);expect(await downloadJson(page,".ws-json")).toEqual(before);
});

test("core AI cancellation, stale worker messages and closing preserve the selected interval",async({page})=>{
  test.setTimeout(60_000);await load(page);const activity=await workerFixture(page,1200);await openPhotos(page);let dialog=await openAi(page);await ready(dialog);
  await dialog.locator(".core-ai-run").click();await expect(dialog.locator(".core-ai-status")).toContainText("Synthetic inference in progress");
  await expect(dialog.locator(".core-ai-model")).toBeDisabled();await expect(dialog.locator(".core-ai-task")).toBeDisabled();await expect(dialog.locator(".core-ai-export")).toBeDisabled();
  await dialog.locator(".core-ai-cancel").click();await expect(dialog.locator(".core-ai-status")).toContainText("Cancelled");await expect(dialog.locator(".core-ai-result")).toHaveCount(0);
  const cancelled=await benchmark(page);expect(cancelled.trials[0]).toMatchObject({status:"cancelled",results:[]});
  await dialog.locator(".core-ai-model").selectOption("smolvlm-500m");await dialog.locator(".core-ai-task").selectOption("observations");await dialog.locator(".core-ai-run").click();
  await expect(dialog.locator(".core-ai-result")).toHaveCount(1);await expect(dialog.locator(".core-ai-export")).toBeEnabled();
  const restarted=await benchmark(page);expect(restarted.trials.map((trial:any)=>trial.status)).toEqual(["cancelled","completed"]);
  expect(restarted.trials[1].results[0].result).toMatchObject({modelId:"smolvlm-500m",task:"observations"});expectImageFree(restarted);
  await dialog.locator(".core-ai-run").click();await expect(dialog.locator(".core-ai-status")).toContainText("Synthetic inference in progress");await closeAi(page);
  await page.locator(".core-run").selectOption("run-other");dialog=await openAi(page);await ready(dialog);
  await expect(dialog.locator(".core-ai-interval")).toHaveText("BH-02 · 4–5 m");await expect(dialog.locator(".core-ai-result")).toHaveCount(0);
  await dialog.locator(".core-ai-run").click();await expect(dialog.locator(".core-ai-result")).toHaveCount(1);await expect(dialog.locator(".core-ai-export")).toBeEnabled();
  const other=await benchmark(page);expect(other.interval).toMatchObject({runId:"run-other",boreholeId:"BH-02",rowId:"row-other",from:4,to:5});
  expect(other.trials).toHaveLength(1);expect(other.trials[0].results[0].result).toMatchObject({modelId:"smolvlm-256m",task:"describe"});expectImageFree(other);
  expect(activity.workers).toBeGreaterThanOrEqual(3);await closeAi(page);await closePhotos(page);
});

test("mobile core AI comparison fits iPhone Chromium emulation and keeps review controls usable",async({page},testInfo)=>{
  await load(page);await workerFixture(page);await openPhotos(page);const dialog=await openAi(page);await ready(dialog);
  await dialog.locator(".core-ai-compare").click();await expect(dialog.locator(".core-ai-result")).toHaveCount(2);await expect(dialog.locator(".core-ai-export")).toBeEnabled();
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);expect(await dialog.locator(".core-ai-content").evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  const card=dialog.locator(".core-ai-result").last();await card.locator(".core-ai-useful").selectOption("no");await card.locator(".core-ai-hallucinations").selectOption("yes");
  await card.locator(".core-ai-review-notes").fill("Reviewed on a narrow screen.");await card.locator(".core-ai-output").scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath("core-ai-comparison-iphone.png"),fullPage:true});
  for(let i=0;i<24;i++){await page.keyboard.press("Tab");expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true)}
  const report=await benchmark(page);expect(report.trials[0].results[1].review).toEqual({useful:"no",hallucinations:"yes",notes:"Reviewed on a narrow screen."});expectImageFree(report);
  await closeAi(page);await expect(page.locator(".core-ai-open")).toBeFocused();await closePhotos(page);
});

test("standalone core AI explains its limit while manual core review remains available offline",async({page,context},testInfo)=>{
  await prepare(page);await gpuSupport(page,true);await page.goto("/?backend=webgl#input");const project=await fixture(page),file=resolve("dist/geomodel3d-offline.html");
  expect(existsSync(file),"Build the standalone HTML before browser validation").toBe(true);const html=readFileSync(file,"utf8"),modelRequests:string[]=[],errors:string[]=[];
  await page.route("**/*",route=>route.request().isNavigationRequest()?route.fulfill({status:200,contentType:"text/html",body:html}):route.abort());await context.setOffline(true);
  page.on("request",request=>{if(modelHost(request.url())||request.url().includes("coreAi.worker"))modelRequests.push(request.url())});page.on("pageerror",error=>errors.push(error.message));
  await page.goto("http://127.0.0.1:4173/standalone-core-ai.html?backend=webgl#input");await openInput(page);await importJson(page,project);await saved(page);
  await openPhotos(page);const dialog=await openAi(page);await expect(dialog.locator(".core-ai-crop")).toBeVisible();
  await expect(dialog.locator(".core-ai-support")).toContainText(/unavailable in the standalone HTML/i);await expect(dialog.locator(".core-ai-run")).toBeDisabled();await expect(dialog.locator(".core-ai-compare")).toBeDisabled();
  expect(modelRequests).toEqual([]);expect(errors).toEqual([]);await page.screenshot({path:testInfo.outputPath("core-ai-standalone-limit.png"),fullPage:true});
  await closeAi(page);await page.locator(".core-registration").check();await expect(page.locator(".core-registration")).toBeChecked();await page.locator(".core-save").click();await closePhotos(page);
  const exported:any=await downloadJson(page);expect(exported.draft.tables.corePhotos.runs[0].rows[0].registrationReviewed).toBe(true);expect(modelRequests).toEqual([]);
});
