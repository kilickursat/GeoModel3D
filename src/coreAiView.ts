// A deliberately separate trial: generated text never changes a reviewed core log or its RQD.
import pkg from "../package.json";
import {CORE_AI_MODELS,CORE_AI_PROMPT_VERSION,coreAiPrompt} from "./coreAi";
import type {CoreAiTask,CoreAiResult,CoreAiProgress} from "./coreAi";
import {CoreAiClient,coreAiSupport,clearCoreAiCache} from "./coreAiClient";
import type {CoreRow} from "./corePhoto";
import {coreAiCropPlan,selectCoreAiRegion} from "./coreAiCrop";
import type {CoreAiCropPlan,CoreAiRegion} from "./coreAiCrop";
import "./coreAi.css";

const esc=(value:string)=>value.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const fmt=(value:number,d=3)=>value.toLocaleString("en-US",{maximumFractionDigits:d});
const seconds=(ms:number)=>`${fmt(ms/1000,2)} s`;
const tasks:Record<CoreAiTask,string>={describe:"Describe visible material",observations:"List visible features and image limitations"};
let activeClose:(()=>void)|undefined,sequence=0;

export interface CoreAiViewInput {
  image:string;sourceId:string;sourceName:string;sourceSha256?:string;runId:string;boreholeId:string;
  row:CoreRow;pieceId?:string;
}
interface Crop extends CoreAiCropPlan {image:string;sha256?:string;preparationMs:number}
interface Review {useful:"unreviewed"|"yes"|"no";hallucinations:"unreviewed"|"yes"|"no";notes:string}
interface TrialResult {id:string;result:CoreAiResult;review:Review;completedAt:string}
interface Trial {
  id:string;kind:"single"|"comparison";task:CoreAiTask;prompt:string;promptVersion:number;modelIds:string[];startedAt:string;finishedAt?:string;
  status:"running"|"completed"|"cancelled"|"failed";results:TrialResult[];error?:string;
}

async function prepareCrop(input:CoreAiViewInput,region:CoreAiRegion):Promise<Crop>{
  const started=performance.now();
  if(!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(input.image))throw new Error("The saved source must be a local PNG photograph.");
  const source=new Image();
  await new Promise<void>((resolve,reject)=>{source.onload=()=>resolve();source.onerror=()=>reject(new Error("The saved photograph could not be opened."));source.src=input.image});
  const plan=coreAiCropPlan(region,source.naturalWidth,source.naturalHeight),{pixels,preprocessing}=plan;
  const {scaledWidth,scaledHeight}=preprocessing,{left,top}=preprocessing.padding;
  const canvas=document.createElement("canvas");canvas.width=plan.width;canvas.height=plan.height;
  const context=canvas.getContext("2d");if(!context)throw new Error("This browser cannot prepare the selected photograph.");
  // The encoder expects a square. Pad visibly here so a long row is never silently stretched into a square.
  context.fillStyle=preprocessing.background;context.fillRect(0,0,plan.width,plan.height);
  context.imageSmoothingEnabled=true;context.imageSmoothingQuality="low";
  context.drawImage(source,pixels.x,pixels.y,pixels.width,pixels.height,left,top,scaledWidth,scaledHeight);
  const image=canvas.toDataURL("image/png"),bytes=Uint8Array.from(atob(image.split(",")[1]),c=>c.charCodeAt(0));
  const sha256=globalThis.crypto?.subtle?Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(n=>n.toString(16).padStart(2,"0")).join(""):undefined;
  return {...plan,image,sha256,preparationMs:performance.now()-started};
}

export function showCoreAi(value:CoreAiViewInput):()=>void{
  activeClose?.();
  // Freeze both the image and its registration. Results cannot migrate to another hole or depth interval.
  const input=structuredClone(value),region=selectCoreAiRegion(input.row,input.pieceId),trials:Trial[]=[],urls=new Set<string>();
  const selectionLabel=region.kind==="piece"?`Piece ${input.row.pieces.findIndex(p=>p.id===region.pieceId)+1}`:"Whole row";
  const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
  const overflow=document.body.style.overflow,heading=`core-ai-heading-${++sequence}`;
  let closed=false,crop:Crop|undefined,supported=false,supportReason="Checking this browser…",client:CoreAiClient|undefined;
  let active:Trial|undefined,token=0,prepared=false,clearing=false;
  const standalone=location.protocol==="file:"||!!document.querySelector('meta[name="geomodel3d-standalone"]');
  const dialog=document.createElement("dialog");dialog.className="core-ai-dialog";dialog.setAttribute("aria-labelledby",heading);
  const modelSize=(model:typeof CORE_AI_MODELS[number])=>model.downloadMiB?`about ${fmt(model.downloadMiB,0)} MiB` :"several hundred MiB";
  dialog.innerHTML=`<header class="core-ai-header"><div><span class="core-ai-badge">Local AI prototype</span><h2 id="${heading}">${region.kind==="piece"?"Describe this piece":"Describe this interval"}</h2><p>Compare small image models against the photograph. Suggestions remain separate from the reviewed log.</p></div><button type="button" class="core-ai-close" aria-label="Close local AI trial">Close</button></header>
<div class="core-ai-content"><section class="core-ai-input" aria-label="Selected photo interval"><h3 class="core-ai-interval">${esc(input.boreholeId)} · ${fmt(region.from)}–${fmt(region.to)} m</h3><p class="core-ai-region-label">${esc(selectionLabel)} · registered row ${fmt(input.row.from)}–${fmt(input.row.to)} m</p><p>${esc(input.sourceName)} · ${input.row.direction==="rtl"?"right to left":"left to right"}${input.row.registrationReviewed?" · registration reviewed":" · depth registration not yet reviewed"}</p><div class="core-ai-crop-box"><span class="core-ai-preparing">Preparing the selected ${region.kind}…</span></div><p class="core-ai-crop-info"></p><p class="core-ai-frozen">This crop and depth registration are fixed for this session. The models receive the image, without your assigned geological units or test results.</p></section>
<section class="core-ai-controls" aria-label="Local model trial"><h3>Run on this device</h3><p class="core-ai-download-note">Starting a trial downloads model files from Hugging Face: ${CORE_AI_MODELS.map(m=>`${esc(m.label)} ${modelSize(m)}`).join("; ")}, plus runtime and tokenizer files. Your photograph is processed in this browser. Downloads may be reused from browser storage, but storage can be evicted. GPU memory use is additional.</p><p class="core-ai-support" role="status"></p><div class="core-ai-fields"><label>Model<select class="core-ai-model">${CORE_AI_MODELS.map(m=>`<option value="${esc(m.id)}">${esc(m.label)} · ${modelSize(m)}</option>`).join("")}</select></label><label>Task<select class="core-ai-task">${Object.entries(tasks).map(([id,label])=>`<option value="${id}">${esc(label)}</option>`).join("")}</select></label></div><div class="core-ai-actions"><button type="button" class="core-ai-run" disabled>Download &amp; run</button><button type="button" class="core-ai-compare" disabled>Download &amp; compare both</button><button type="button" class="core-ai-cancel" disabled>Cancel</button><button type="button" class="core-ai-unload" disabled>Unload model</button><button type="button" class="core-ai-clear-cache">Clear model downloads</button></div><p class="core-ai-status" role="status" aria-live="polite">No model has been downloaded or started.</p><progress class="core-ai-progress" hidden></progress><p class="core-ai-limits">These general image models can miss fractures or invent details. Their text is unreviewed and supplies no RQD, strength or design parameters. Review usefulness against the source image.</p></section>
<section class="core-ai-results" aria-label="Unreviewed model suggestions"><h3>Unreviewed suggestions</h3><p class="core-ai-empty">Results will appear here. Running a model does not change photo annotations, logs or laboratory data.</p></section></div>
<footer class="core-ai-footer"><p>Results are temporary. Export the benchmark before closing. Timings compare this device and session, not geological accuracy.</p><button type="button" class="core-ai-export" disabled>Export benchmark JSON</button></footer>`;
  const $=<T extends HTMLElement>(selector:string)=>dialog.querySelector<T>(selector)!;
  const runButton=$<HTMLButtonElement>(".core-ai-run"),compareButton=$<HTMLButtonElement>(".core-ai-compare"),cancelButton=$<HTMLButtonElement>(".core-ai-cancel");
  const unloadButton=$<HTMLButtonElement>(".core-ai-unload"),exportButton=$<HTMLButtonElement>(".core-ai-export"),modelSelect=$<HTMLSelectElement>(".core-ai-model"),taskSelect=$<HTMLSelectElement>(".core-ai-task");
  const clearCacheButton=$<HTMLButtonElement>(".core-ai-clear-cache");
  const status=$(".core-ai-status"),support=$(".core-ai-support"),progress=$<HTMLProgressElement>(".core-ai-progress"),results=$(".core-ai-results");

  function controls(){
    runButton.disabled=compareButton.disabled=!!active||clearing||!supported||!crop;
    modelSelect.disabled=taskSelect.disabled=!!active;
    cancelButton.disabled=!active;unloadButton.disabled=!!active||clearing||!client;clearCacheButton.disabled=!!active||clearing;
    exportButton.disabled=!!active||!trials.length;
    support.textContent=supportReason;support.classList.toggle("core-ai-unavailable",prepared&&!supported);
  }
  function say(message:string,isError=false){status.textContent=message;status.classList.toggle("core-ai-error",isError)}
  function progressUpdate(value:CoreAiProgress,trial:Trial,requestToken:number){
    if(closed||active!==trial||requestToken!==token)return;
    say(`${trial.kind==="comparison"?`Model ${trial.results.length+1} of ${trial.modelIds.length}: `:""}${value.message}`);
    progress.hidden=false;
    if(value.total&&value.total>0&&value.loaded!==undefined){progress.max=value.total;progress.value=Math.min(value.loaded,value.total)}
    else progress.removeAttribute("value");
  }
  function reviewSelect(css:string,value:string){return `<select class="${css}"><option value="unreviewed"${value==="unreviewed"?" selected":""}>Not reviewed</option><option value="yes"${value==="yes"?" selected":""}>Yes</option><option value="no"${value==="no"?" selected":""}>No</option></select>`}
  function renderResults(){
    results.innerHTML=`<h3>Unreviewed suggestions</h3>${trials.map((trial,index)=>{
      const state=trial.status==="completed"?"Completed":trial.status==="cancelled"?"Cancelled":trial.status==="failed"?"Stopped with an error":"Running";
      const incomplete=trial.kind==="comparison"&&trial.status!=="completed"?" · incomplete comparison":"";
      return `<section class="core-ai-trial" data-trial-id="${esc(trial.id)}"><h4>${trial.kind==="comparison"?"Comparison":"Trial"} ${index+1} · ${esc(tasks[trial.task])}</h4><p class="core-ai-trial-state">${state} · ${trial.results.length}/${trial.modelIds.length} results${incomplete}</p>${trial.error?`<p class="core-ai-error">${esc(trial.error)}</p>`:""}<div class="core-ai-result-grid">${trial.results.map(entry=>{
        const result=entry.result,model=CORE_AI_MODELS.find(m=>m.id===result.modelId);
        return `<article class="core-ai-result" data-result-id="${esc(entry.id)}" data-model-id="${esc(result.modelId)}"><h5>${esc(model?.label??result.modelId)} <span>Unreviewed</span></h5><p class="core-ai-result-interval">${esc(input.boreholeId)} · ${fmt(region.from)}–${fmt(region.to)} m · ${esc(selectionLabel.toLowerCase())} in row ${esc(input.row.id)} · ${crop?.width} × ${crop?.height} px crop</p><div class="core-ai-output">${esc(result.text)}</div>${result.generatedTokens!==undefined&&result.generatedTokens>=result.maxNewTokens?`<p class="core-ai-limits core-ai-truncated">Output reached the ${result.maxNewTokens}-token limit and may be incomplete.</p>`:""}<dl class="core-ai-timings"><div><dt>Load / download</dt><dd>${seconds(result.loadMs)}</dd></div><div><dt>Inference</dt><dd>${seconds(result.inferenceMs)}</dd></div><div><dt>Total</dt><dd>${seconds(result.totalMs)}</dd></div></dl><details class="core-ai-model-details"><summary>Model and timing details</summary><p>${esc(result.model)}<br>Revision: <code>${esc(result.revision)}</code></p><p>Device: ${esc(result.device)} · ${esc(result.dtype)} · input ${result.imageWidth} × ${result.imageHeight} pixels. ${result.modelReused?"Model already resident in memory. ":""}Browser cache ${esc(result.cacheState)}${result.cached===undefined?"":`; ${result.cached?"cached files reused":"full cache reuse not confirmed"}`}. ${result.downloadBytes===undefined?"Download byte count not reported.":`${fmt(result.downloadBytes/1048576,1)} MiB downloaded.`}</p><p>Load time includes initialization and any download. This is one pass per model, with 256M first when comparing. Order and a warm cache affect timings; this is not a rigorous performance ranking.</p></details><fieldset class="core-ai-human-review"${active?" disabled":""}><legend>Your assessment against the photograph</legend><div class="core-ai-fields"><label>Useful description?${reviewSelect("core-ai-useful",entry.review.useful)}</label><label>Invented or unsupported details?${reviewSelect("core-ai-hallucinations",entry.review.hallucinations)}</label></div><label>Review notes<textarea class="core-ai-review-notes" rows="2" maxlength="4096">${esc(entry.review.notes)}</textarea></label></fieldset></article>`;
      }).join("")}</div></section>`;
    }).join("")}`;
  }
  async function start(compare:boolean){
    if(active||clearing||!supported||!crop||closed)return;
    const task=taskSelect.value as CoreAiTask,modelIds=compare?CORE_AI_MODELS.map(m=>m.id):[modelSelect.value];
    const trial:Trial={id:`trial-${trials.length+1}`,kind:compare?"comparison":"single",task,prompt:coreAiPrompt(task),promptVersion:CORE_AI_PROMPT_VERSION,modelIds,startedAt:new Date().toISOString(),status:"running",results:[]};
    const requestToken=++token;active=trial;trials.push(trial);controls();renderResults();say("Starting the local model…");
    try{
      client??=new CoreAiClient();
      for(const modelId of modelIds){
        if(closed||requestToken!==token)break;
        const result=await client.run({modelId,task,image:crop.image},value=>progressUpdate(value,trial,requestToken));
        if(closed||requestToken!==token)return;
        trial.results.push({id:`${trial.id}-${trial.results.length+1}`,result,completedAt:new Date().toISOString(),review:{useful:"unreviewed",hallucinations:"unreviewed",notes:""}});renderResults();
      }
      if(closed||requestToken!==token)return;
      trial.status="completed";say(compare?"Both models completed on the same crop and task. Review their suggestions before drawing conclusions.":"Suggestion ready for review. The geological log is unchanged.");
    }catch(e){
      if(closed||requestToken!==token)return;
      trial.status="failed";trial.error=(e as Error).message;say(trial.error,true);
    }finally{
      if(!closed&&requestToken===token){trial.finishedAt=new Date().toISOString();active=undefined;progress.hidden=true;controls();renderResults()}
    }
  }
  function stop(){
    if(!active)return;
    ++token;active.status="cancelled";active.finishedAt=new Date().toISOString();active=undefined;
    client?.stop();client?.dispose();client=undefined;progress.hidden=true;controls();renderResults();say("Cancelled. Completed suggestions are kept; this comparison may be incomplete.");
  }
  function close(){
    if(closed)return;
    stop();closed=true;++token;client?.dispose();client=undefined;
    for(const url of urls)URL.revokeObjectURL(url);urls.clear();
    if(dialog.open)dialog.close();dialog.remove();document.body.style.overflow=overflow;
    if(activeClose===close)activeClose=undefined;if(opener?.isConnected)opener.focus({preventScroll:true});
  }
  async function clearCache(){
    if(active||clearing||closed)return;
    clearing=true;client?.dispose();client=undefined;controls();say("Removing downloaded AI model files from browser storage…");
    try{
      const removed=await clearCoreAiCache();
      if(!closed)say(removed?"AI model downloads cleared. Your photographs and workspaces are unchanged.":"No AI model cache was removed. It may already be empty, or browser storage may be unavailable.");
    }catch(e){if(!closed)say(`Model downloads could not be cleared: ${(e as Error).message}`,true)}
    finally{clearing=false;if(!closed)controls()}
  }
  function exportReport(){
    if(!crop||!trials.length||active)return;
    const report={format:"geomodel3d-core-ai-benchmark",version:2,appVersion:pkg.version,exportedAt:new Date().toISOString(),browserUserAgent:navigator.userAgent,
      scope:"Local prototype; unreviewed text suggestions. No geological log, RQD or measured property was changed.",
      interval:{sourceId:input.sourceId,sourceName:input.sourceName,...(input.sourceSha256?{sourceSha256:input.sourceSha256}:{}),runId:input.runId,boreholeId:input.boreholeId,rowId:input.row.id,...(region.pieceId?{pieceId:region.pieceId}:{}),from:region.from,to:region.to,rowFrom:input.row.from,rowTo:input.row.to,direction:input.row.direction,registrationReviewed:input.row.registrationReviewed},
      selectedRegion:region,
      crop:{normalizedBox:region.box,sourceWidth:crop.sourceWidth,sourceHeight:crop.sourceHeight,pixels:crop.pixels,analysisWidth:crop.width,analysisHeight:crop.height,sha256:crop.sha256,preprocessing:crop.preprocessing,preparationMs:crop.preparationMs},
      methodology:"Models run sequentially, 256M then 500M for comparisons, with one pass each on the identical aspect-preserved photo crop centered on a neutral-gray square PNG and fixed task. Gray padding is not observed material. Small crops are interpolated to fill the long frame edge; enlargement does not add observed detail. Integer source pixel bounds cover the registered selection. Load time includes initialization and downloads; cache and model order affect timings. Human assessments are subjective, not scientific confidence scores. Photographs are not embedded.",
      trials:trials.map(trial=>({...trial,results:trial.results.map(entry=>{
        // Whitelist report fields: a worker response can never smuggle the source image into the download.
        const r=entry.result;
        return {...entry,result:{modelId:r.modelId,model:r.model,revision:r.revision,task:r.task,text:r.text,loadMs:r.loadMs,inferenceMs:r.inferenceMs,totalMs:r.totalMs,
          downloadBytes:r.downloadBytes,cacheState:r.cacheState,cached:r.cached,generatedTokens:r.generatedTokens,tokensPerSecond:r.tokensPerSecond,
          imageWidth:r.imageWidth,imageHeight:r.imageHeight,maxNewTokens:r.maxNewTokens,device:r.device,dtype:r.dtype,modelReused:r.modelReused,runtimeVersion:r.runtimeVersion,onnxRuntimeVersion:r.onnxRuntimeVersion,preprocessingMs:r.preprocessingMs,preprocessing:r.preprocessing,promptVersion:r.promptVersion}};
      })}))};
    const blob=new Blob([JSON.stringify(report,null,2)+"\n"],{type:"application/json"}),url=URL.createObjectURL(blob);urls.add(url);
    const a=document.createElement("a");a.href=url;a.download="geomodel3d-core-ai-benchmark.json";a.click();
    setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url)},1000);say("Benchmark exported with timings, model revisions and your review. No photograph is embedded.");
  }
  dialog.addEventListener("click",event=>{
    const target=(event.target as Element).closest<HTMLButtonElement>("button");if(!target)return;
    if(target.classList.contains("core-ai-close"))close();
    else if(target.classList.contains("core-ai-run"))void start(false);
    else if(target.classList.contains("core-ai-compare"))void start(true);
    else if(target.classList.contains("core-ai-cancel"))stop();
    else if(target.classList.contains("core-ai-unload")){client?.dispose();client=undefined;controls();say("Model unloaded from memory. Browser-cached downloads may remain.")}
    else if(target.classList.contains("core-ai-clear-cache"))void clearCache();
    else if(target.classList.contains("core-ai-export"))exportReport();
  });
  function editReview(event:Event){
    const target=event.target as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement,id=target.closest<HTMLElement>("[data-result-id]")?.dataset.resultId;
    const entry=trials.flatMap(t=>t.results).find(r=>r.id===id);if(!entry)return;
    if(target.classList.contains("core-ai-useful"))entry.review.useful=target.value as Review["useful"];
    else if(target.classList.contains("core-ai-hallucinations"))entry.review.hallucinations=target.value as Review["hallucinations"];
    else if(target.classList.contains("core-ai-review-notes"))entry.review.notes=target.value;
  }
  dialog.addEventListener("input",editReview);dialog.addEventListener("change",editReview);
  dialog.addEventListener("cancel",event=>{event.preventDefault();close()});
  dialog.addEventListener("keydown",event=>{
    if(event.key!=="Tab")return;
    const elements=[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary')].filter(e=>e.getClientRects().length>0),first=elements[0],last=elements.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
  });
  document.body.appendChild(dialog);document.body.style.overflow="hidden";activeClose=close;dialog.showModal();$(".core-ai-close").focus({preventScroll:true});
  void Promise.all([prepareCrop(input,region),standalone?Promise.resolve({supported:false,reason:"Local AI trials are unavailable in the standalone HTML. Open the hosted GeoModel3D app in a browser with WebGPU. Manual photo registration and reviewed logging continue to work offline."}):coreAiSupport()]).then(([preparedCrop,capability])=>{
    if(closed)return;
    crop=preparedCrop;supported=capability.supported;prepared=true;supportReason=capability.reason??(supported?"WebGPU is available. No model downloads until you start.":"WebGPU is unavailable. Try a current browser with WebGPU and hardware acceleration enabled.");
    $(".core-ai-crop-box").innerHTML=`<img class="core-ai-crop" src="${crop.image}" alt="Selected core ${region.kind} for ${esc(input.boreholeId)}, ${fmt(region.from)} to ${fmt(region.to)} metres">`;
    $(".core-ai-crop-info").textContent=`Model input: ${crop.width} × ${crop.height} pixels. Photo content: ${crop.preprocessing.scaledWidth} × ${crop.preprocessing.scaledHeight} pixels, from a ${crop.pixels.width} × ${crop.pixels.height} pixel crop with its shape preserved.${crop.preprocessing.upscaled?` Enlarged ${fmt(crop.preprocessing.scale,2)}×; interpolation adds no observed detail.`:""} Gray padding is not part of the photograph. Both models receive this exact image.`;
    controls();
  }).catch(e=>{if(closed)return;prepared=true;supported=false;supportReason=(e as Error).message;$(".core-ai-preparing")?.remove();say(supportReason,true);controls()});
  return close;
}
