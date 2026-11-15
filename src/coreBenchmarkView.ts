// Dedicated evaluation page. It has no project/workspace imports or path into accepted geology.
import pkg from "../package.json";
import {CORE_BENCHMARK_MODEL,CORE_BENCHMARK_PROMPT,CORE_BENCHMARK_PROMPT_VERSION,CORE_BENCHMARK_TIMEOUT_MS,coreBenchmarkTokenLimit,checkedCoreBenchmarkResult,coreBenchmarkAdapterMetadata} from "./coreBenchmark";
import type {CoreBenchmarkAdapter,CoreBenchmarkMode,CoreBenchmarkResult,CoreBenchmarkProgress,CoreBenchmarkFailure,CoreBenchmarkStage} from "./coreBenchmark";
import {CoreBenchmarkClient,coreBenchmarkSupport,clearCoreBenchmarkCache} from "./coreBenchmarkClient";
import {CoreBenchmarkError,CORE_BENCHMARK_STAGE_LABELS,checkedCoreBenchmarkProgress,checkedCoreBenchmarkFailure,coreBenchmarkFailure} from "./coreBenchmarkDiagnostics";
import humanReviewTemplate from "../docs/benchmarks/0.26.0-core-ai/human-review-template.csv?raw";
import protocolSource from "../docs/benchmarks/0.26.0-core-ai/protocol.json?raw";
import rubricSource from "../docs/benchmarks/0.26.0-core-ai/rubric.md?raw";
import sourceManifest from "../docs/benchmarks/0.26.0-core-ai/dataset-manifest.json?raw";
import evaluationPlanSource from "../docs/benchmarks/0.27.0-desktop-ai/evaluation-plan.json?raw";
import {checkedCoreBenchmarkEvaluation,summarizeCoreBenchmarkRun} from "./coreBenchmarkSummary";
import type {CoreBenchmarkEvaluation} from "./coreBenchmarkSummary";
import "./coreBenchmark.css";

interface Case {id:string;image:string;sha256:string;sourceSha256:string;width:512;height:512}
interface Manifest {version:1;datasetId:"core-v026";cases:Case[]}
type CaseStatus="not-started"|"running"|"completed"|"failed"|"timed-out"|"cancelled"|"interrupted";
interface Entry {caseId:string;imageSha256:string;sourceSha256:string;status:CaseStatus;elapsedMs?:number;startedAt?:string;finishedAt?:string;recoveredAt?:string;error?:string;result?:CoreBenchmarkResult;
  lastProgress?:{progress:CoreBenchmarkProgress;observedAt:string;caseElapsedMs:number};errorDiagnostic?:CoreBenchmarkFailure}
interface Run {id:string;appVersion?:string;evaluation?:CoreBenchmarkEvaluation;startedAt:string;finishedAt?:string;recoveredAt?:string;mode:CoreBenchmarkMode;maxNewTokens:number;status:"running"|"completed"|"failed"|"cancelled"|"interrupted";
  selfReportedDeviceLabel:string;physicalDeviceVerified:false;cohortCaseCount:40;selectedCaseIds:string[];unselectedCaseIds:string[];cases:Entry[];stopReason?:string;
  mainThreadJsHeapBeforeBytes:number|null;mainThreadJsHeapAfterBytes?:number|null;pageVisibleAtStart:boolean;preflightAdapter?:CoreBenchmarkAdapter;browserContext?:ReturnType<typeof browserContext>}
interface Active {token:number;run:Run;abort:AbortController;client:CoreBenchmarkClient;current?:Entry;currentStarted?:number;caseTimer?:ReturnType<typeof setTimeout>;
  checkpointTimer?:ReturnType<typeof setTimeout>;checkpointAt?:number;checkpointStage?:string;checkpointFiles?:Set<string>}
const protocolId="core-webgpu-pilot-2",base=new URL("./core-benchmark-v026/",location.href),runs:Run[]=[],urls=new Set<string>();
let manifest:Manifest|undefined,manifestSha256:string|undefined,supported=false,clearing=false,active:Active|undefined,sequence=0;
let preflightAdapter:CoreBenchmarkAdapter|undefined;
let protocolSha256:string|undefined,rubricSha256:string|undefined,sourceManifestSha256:string|undefined;
const evaluationPlan=JSON.parse(evaluationPlanSource) as {id:string;baseProtocol:{sha256:string;rubricSha256:string;sourceManifestSha256:string;publicManifestSha256:string}};
let evaluationPlanSha256:string|undefined;
const recoveryKey="geomodel3d:qwen-benchmark:last-report";
let recoveryNote="";
let referenceAbort:AbortController|undefined,referenceUrl:string|undefined,referenceSequence=0;
const createdAt=new Date().toISOString();
const app=document.querySelector<HTMLElement>("#benchmark-app")!;
app.innerHTML=`<main class="bench-shell"><nav class="bench-nav" aria-label="Benchmark navigation"><a class="bench-brand" href="./">GeoModel3D <span class="bench-version"></span></a><a href="./">Back to the ground model</a></nav>
<header class="bench-hero"><p class="bench-eyebrow">Experimental evaluation</p><h1>Test Qwen on your device</h1><p class="bench-lead">Evaluate Qwen locally on desktop Chrome, then export the evidence.</p><p>The model describes visible features. Human review is still pending, and no result changes your ground model, logs or engineering properties.</p></header>
<div class="bench-grid"><section class="bench-card" aria-labelledby="benchmark-run-heading"><h2 id="benchmark-run-heading">Run a device check</h2><p class="bench-support" id="benchmark-support" role="status">Checking this browser’s WebGPU support…</p>
<p class="bench-hint" id="benchmark-target-note">Desktop/laptop Chrome with a hardware GPU is the primary target; Edge is another candidate. iPhone and other mobile AI checks are optional. Start with a one-case compatibility check, then run all forty quality cases if execution succeeds.</p>
<div class="bench-fields"><label class="wide">Evaluation target<select id="benchmark-target"><option value="desktop">Desktop/laptop Chrome or Edge (primary)</option><option value="exploratory">Other devices (exploratory)</option></select><span class="bench-hint">This records your chosen target; it does not verify the physical device.</span></label><label>Purpose<select id="benchmark-mode"><option value="quality">Description evaluation · 128 tokens</option><option value="compatibility">Compatibility check · 32 tokens</option></select></label><label>Cases<select id="benchmark-count"><option value="1">One case</option><option value="5">First five cases</option><option value="40">All forty cases</option></select></label><label class="wide" id="benchmark-case-label">Selected case<select id="benchmark-case" disabled><option>Loading case IDs…</option></select></label><label class="wide">Machine / OS / GPU / browser (optional)<input id="benchmark-device" maxlength="120" placeholder="For example, laptop · Windows · RTX 4060 · Chrome 142" autocomplete="off"><span class="bench-hint">Your label is recorded as self-reported, separately from browser information.</span></label></div>
<p class="bench-hint" id="benchmark-mode-note">The full study contains 40 cases. A smaller run is a partial evaluation; human assessment is required.</p>
<label class="bench-consent"><input id="benchmark-consent" type="checkbox"><span>I understand that starting may download about <strong>1.0 GiB</strong> of model weights, plus runtime and selected image files. Processing stays on this device.</span></label>
<div class="bench-actions"><button id="benchmark-run" class="primary" type="button" disabled>Download model &amp; run</button><button id="benchmark-stop" type="button" disabled>Stop &amp; unload</button></div>
<p id="benchmark-status" class="bench-status" role="status" aria-live="polite">No model or case image has been downloaded.</p><progress id="benchmark-progress" class="bench-progress" hidden aria-label="Current case progress"></progress>
<p class="bench-memory-note">Keep this page visible during a run. Switching apps or hiding the page stops the batch and preserves an interrupted result. Results are saved locally when browser storage permits. Export JSON for a durable copy.</p></section>
<aside class="bench-card bench-review" aria-labelledby="benchmark-review-heading"><h2 id="benchmark-review-heading">Keep the evidence</h2><ol><li>Complete the blank reference sheet with a geologist <strong>before viewing model answers</strong>.</li><li>Run the selected cases. A compatibility check tests execution only and is never counted as a quality score.</li><li>Export results, including failed, stopped and unstarted cases. Review descriptions against the photographs before judging usefulness.</li></ol>
<div class="bench-actions"><button id="benchmark-review-images" type="button" disabled>Review source images</button><button id="benchmark-review-csv" type="button" disabled>Download blank review sheet</button><button id="benchmark-export" type="button" disabled>Export results JSON</button><button id="benchmark-clear-cache" type="button">Clear benchmark downloads</button></div><p id="benchmark-recovery-status" role="status"></p><button id="benchmark-forget-report" type="button" disabled>Forget saved benchmark results</button><p id="benchmark-dataset-status">Loading the frozen case manifest…</p><p>These public patches do not establish borehole independence or engineering-property accuracy. GPU memory cannot be measured by this page; any available JavaScript heap value is reported separately.</p></aside></div>
<section id="benchmark-reference-panel" class="bench-card bench-reference" aria-labelledby="benchmark-reference-heading" hidden><div class="bench-reference-heading"><h2 id="benchmark-reference-heading">Image-only reference review</h2><button id="benchmark-reference-close" type="button">Close source review</button></div><p id="benchmark-reference-note">Describe the visible colour, texture, markings, edges and uncertainty in the blank review sheet. Save and freeze that reference before viewing model answers. No model runs from this panel.</p><div class="bench-reference-controls"><label>Source case<select id="benchmark-reference-case" aria-label="Source case"></select></label><button id="benchmark-reference-next" type="button">Next source image</button></div><div id="benchmark-reference-preview" aria-live="polite"></div></section>
<section class="bench-results" aria-labelledby="benchmark-results-heading"><h2 id="benchmark-results-heading">Run history</h2><div id="benchmark-results"><p class="bench-empty">No runs yet. Starting another run keeps earlier results in this page.</p></div></section>
<footer class="bench-footer"><div class="bench-links"><a href="https://github.com/kilickursat/GeoModel3D/tree/main/docs/benchmarks/0.27.0-desktop-ai" target="_blank" rel="noreferrer">Desktop evaluation plan and instructions</a><a href="https://github.com/kilickursat/GeoModel3D/tree/main/docs/benchmarks/0.26.0-core-ai" target="_blank" rel="noreferrer">Study protocol and source credits</a><a href="https://github.com/kilickursat/GeoModel3D/blob/main/docs/benchmarks/0.26.0-core-ai/NOTICE.md" target="_blank" rel="noreferrer">Image licence</a></div><p>Qwen3.5 0.8B · pinned Hugging Face model · local WebGPU. Model weights are separate from this page. Cached files may be evicted by your browser.</p></footer></main>`;
const $=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
$("benchmark-app").querySelector(".bench-version")!.textContent=`${pkg.version}`;
const runButton=$<HTMLButtonElement>("benchmark-run"),stopButton=$<HTMLButtonElement>("benchmark-stop"),exportButton=$<HTMLButtonElement>("benchmark-export");
const csvButton=$<HTMLButtonElement>("benchmark-review-csv"),clearButton=$<HTMLButtonElement>("benchmark-clear-cache"),consent=$<HTMLInputElement>("benchmark-consent");
const referenceButton=$<HTMLButtonElement>("benchmark-review-images"),referenceSelect=$<HTMLSelectElement>("benchmark-reference-case"),referenceNext=$<HTMLButtonElement>("benchmark-reference-next");
const targetSelect=$<HTMLSelectElement>("benchmark-target");
const modeSelect=$<HTMLSelectElement>("benchmark-mode"),countSelect=$<HTMLSelectElement>("benchmark-count"),caseSelect=$<HTMLSelectElement>("benchmark-case"),deviceLabel=$<HTMLInputElement>("benchmark-device");
const status=$("benchmark-status"),progress=$<HTMLProgressElement>("benchmark-progress"),results=$("benchmark-results");
function now(){return new Date().toISOString()}
function heapBytes(){const value=(performance as Performance&{memory?:{usedJSHeapSize?:number}}).memory?.usedJSHeapSize;return typeof value==="number"&&Number.isFinite(value)&&value>=0?value:null}
function browserContext():{observedAt:string;userAgent:string;language:string;hardwareConcurrency:number|null;deviceMemoryGiB:number|null;viewport:{width:number;height:number;pixelRatio:number};physicalDeviceVerified:false}{return {observedAt:now(),userAgent:navigator.userAgent,language:navigator.language,hardwareConcurrency:navigator.hardwareConcurrency??null,deviceMemoryGiB:(navigator as Navigator&{deviceMemory?:number}).deviceMemory??null,viewport:{width:innerWidth,height:innerHeight,pixelRatio:devicePixelRatio},physicalDeviceVerified:false}}
function checkpoint(){
  if(!manifest||!protocolSha256||!runs.length)return;
  try{
    const text=JSON.stringify({version:1,protocolSha256,manifestSha256,runs});
    if(text.length>2_000_000)throw new Error("Report exceeds local recovery storage size.");
    localStorage.setItem(recoveryKey,text);
    $("benchmark-recovery-status").textContent=recoveryNote+"Results saved in this browser. Export JSON to keep a separate copy.";
  }catch{$("benchmark-recovery-status").textContent="Local recovery storage is unavailable or full. Export JSON before closing this page."}
}
function restore(){
  try{
    const text=localStorage.getItem(recoveryKey);if(!text)return;
    if(text.length>2_000_000)throw new Error("Oversized recovery data.");
    const stored=JSON.parse(text);
    if(stored.version!==1||stored.protocolSha256!==protocolSha256||stored.manifestSha256!==manifestSha256||!Array.isArray(stored.runs)||stored.runs.length>100)throw new Error("Saved study differs from this study.");
    const stamp=(v:unknown)=>{if(typeof v!=="string"||v.length>32||!Number.isFinite(Date.parse(v)))throw new Error("Invalid saved timestamp.");return v};
    const number=(v:unknown)=>{if(v!==null&&(typeof v!=="number"||!Number.isFinite(v)||v<0))throw new Error("Invalid saved measurement.");return v as number|null};
    const brief=(v:unknown,max:number)=>{if(typeof v!=="string"||v.length>max)throw new Error("Invalid saved text.");return v};
    const restored:Run[]=stored.runs.map((value:Run,index:number)=>{
      if(!value||!["quality","compatibility"].includes(value.mode)||value.maxNewTokens!==coreBenchmarkTokenLimit(value.mode)||!Array.isArray(value.selectedCaseIds)||![1,5,40].includes(value.selectedCaseIds.length)||new Set(value.selectedCaseIds).size!==value.selectedCaseIds.length||!Array.isArray(value.cases)||value.cases.length!==value.selectedCaseIds.length||!["running","completed","failed","cancelled","interrupted"].includes(value.status))throw new Error("Invalid saved run.");
      const selected=value.selectedCaseIds.map(id=>{if(!manifest!.cases.some(c=>c.id===id))throw new Error("Invalid saved case.");return id});
      const cases:Entry[]=value.cases.map((entry,i)=>{
        const source=manifest!.cases.find(c=>c.id===selected[i])!;
        if(entry.caseId!==source.id||entry.imageSha256!==source.sha256||entry.sourceSha256!==source.sourceSha256||!["not-started","running","completed","failed","timed-out","cancelled","interrupted"].includes(entry.status))throw new Error("Saved input does not match this study.");
        const result=entry.result?checkedCoreBenchmarkResult(entry.result,{caseId:source.id,expectedSha256:source.sha256,mode:value.mode,image:""}):undefined;
        if((entry.status==="completed")!==!!result)throw new Error("Incomplete saved result.");
        const interrupted=entry.status==="running";
        const lastProgress=entry.lastProgress?{progress:checkedCoreBenchmarkProgress(entry.lastProgress.progress),observedAt:stamp(entry.lastProgress.observedAt),caseElapsedMs:number(entry.lastProgress.caseElapsedMs)}:undefined;
        if(lastProgress&&lastProgress.caseElapsedMs===null)throw new Error("Invalid saved progress observation.");
        return {caseId:source.id,imageSha256:source.sha256,sourceSha256:source.sourceSha256,status:interrupted?"interrupted":entry.status,
          ...(entry.startedAt?{startedAt:stamp(entry.startedAt)}:{}),...(interrupted?{recoveredAt:now(),error:"Run interrupted before this page reopened; the cause and stopping time were not observed. No automatic retry."}:entry.finishedAt?{finishedAt:stamp(entry.finishedAt)}:{}),
          ...(!interrupted&&entry.recoveredAt?{recoveredAt:stamp(entry.recoveredAt)}:{}),...(!interrupted&&entry.error?{error:brief(entry.error,16384)}:{}),...(!interrupted&&entry.elapsedMs!==undefined?{elapsedMs:number(entry.elapsedMs)!}:{}),
          ...(lastProgress?{lastProgress:{...lastProgress,caseElapsedMs:lastProgress.caseElapsedMs!}}:{}),...(entry.errorDiagnostic?{errorDiagnostic:checkedCoreBenchmarkFailure(entry.errorDiagnostic)}:{}),...(result?{result}:{})};
      });
      if(value.status==="completed"&&cases.some(c=>c.status!=="completed"))throw new Error("Saved completion count is inconsistent.");
      let originalBrowser:Run["browserContext"];
      if(value.browserContext){const b=value.browserContext;originalBrowser={observedAt:stamp(b.observedAt),userAgent:brief(b.userAgent,2048),language:brief(b.language,64),hardwareConcurrency:number(b.hardwareConcurrency),deviceMemoryGiB:number(b.deviceMemoryGiB),viewport:{width:number(b.viewport.width)!,height:number(b.viewport.height)!,pixelRatio:number(b.viewport.pixelRatio)!},physicalDeviceVerified:false}}
      if(value.appVersion!==undefined&&(typeof value.appVersion!=="string"||!/^\d+\.\d+\.\d+$/.test(value.appVersion)||value.appVersion.length>32))throw new Error("Invalid saved application version.");
      const evaluation=checkedCoreBenchmarkEvaluation(value.evaluation);
      if(value.evaluation!==undefined&&!evaluation)throw new Error("Invalid saved evaluation identity.");
      return {id:`run-${index+1}`,...(evaluation?{evaluation}:{}),...(value.appVersion!==undefined?{appVersion:value.appVersion}:{}),startedAt:stamp(value.startedAt),...(value.status==="running"?{recoveredAt:now()}:value.finishedAt?{finishedAt:stamp(value.finishedAt)}:{}),
        ...(value.status!=="running"&&value.recoveredAt?{recoveredAt:stamp(value.recoveredAt)}:{}),mode:value.mode,maxNewTokens:value.maxNewTokens,status:value.status==="running"?"interrupted":value.status,
        selfReportedDeviceLabel:brief(value.selfReportedDeviceLabel,120),physicalDeviceVerified:false,cohortCaseCount:40,selectedCaseIds:selected,unselectedCaseIds:manifest!.cases.filter(c=>!selected.includes(c.id)).map(c=>c.id),cases,
        mainThreadJsHeapBeforeBytes:number(value.mainThreadJsHeapBeforeBytes),...(value.mainThreadJsHeapAfterBytes!==undefined?{mainThreadJsHeapAfterBytes:number(value.mainThreadJsHeapAfterBytes)}:{}),pageVisibleAtStart:value.pageVisibleAtStart===true,
        ...(value.preflightAdapter?{preflightAdapter:coreBenchmarkAdapterMetadata({info:value.preflightAdapter,features:value.preflightAdapter.features,limits:value.preflightAdapter.limits})}:{}),...(originalBrowser?{browserContext:originalBrowser}:{}),...(value.status==="running"?{stopReason:"Recovered interrupted run; no automatic retry."}:value.stopReason?{stopReason:brief(value.stopReason,16384)}:{})};
    });
    runs.push(...restored);recoveryNote=`Recovered ${restored.length} saved run${restored.length===1?"":"s"}; no automatic restart. `;say(`Recovered ${restored.length} saved run${restored.length===1?"":"s"}. No model was started; export or begin a new run explicitly.`);
  }catch{$("benchmark-recovery-status").textContent="Saved results could not be restored for this study. No model was started and the saved record was left unchanged."}
}
function say(message:string,error=false){status.textContent=message;status.dataset.error=String(error)}
function controls(){
  runButton.disabled=!!active||clearing||!supported||!manifest||!protocolSha256||!evaluationPlanSha256||!consent.checked;
  $("benchmark-forget-report").toggleAttribute("disabled",!!active||!runs.length);
  stopButton.disabled=!active;clearButton.disabled=!!active||clearing;exportButton.disabled=!runs.length;csvButton.disabled=!manifest;
  referenceButton.disabled=referenceSelect.disabled=referenceNext.disabled=!!active||!manifest;
  if(manifest&&referenceSelect.value===manifest.cases.at(-1)?.id)referenceNext.disabled=true;
  for(const el of [targetSelect,modeSelect,countSelect,caseSelect,deviceLabel,consent])el.disabled=!!active||clearing;
  if(!manifest)caseSelect.disabled=true;
  $("benchmark-case-label").hidden=countSelect.value!=="1";
  $("benchmark-mode-note").textContent=modeSelect.value==="compatibility"?"Compatibility mode stops at 32 tokens. Its output is unscored and does not establish description quality.":"The full study contains 40 cases. A smaller run is a partial evaluation; human assessment is required.";
}
async function sha256(bytes:Uint8Array<ArrayBuffer>){if(!crypto?.subtle)throw new Error("Secure image hashing is unavailable. Use HTTPS or localhost.");return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(b=>b.toString(16).padStart(2,"0")).join("")}
async function fetchBytes(url:URL,maxBytes:number,signal?:AbortSignal,onProgress?:(value:CoreBenchmarkProgress)=>void){
  if(url.origin!==location.origin)throw new Error("Benchmark inputs must come from this site.");
  const resource=url.pathname.startsWith(base.pathname)?url.pathname.slice(base.pathname.length):undefined;
  let response:Response;
  try{response=await fetch(url,{signal,credentials:"omit",redirect:"error",referrerPolicy:"no-referrer"})}
  catch(error){throw new CoreBenchmarkError(coreBenchmarkFailure(error,"image-fetch",{operation:"fetch",...(resource?{resource}:{})}))}
  if(!response.ok)throw new CoreBenchmarkError(coreBenchmarkFailure(new Error(`Could not load the benchmark input (HTTP ${response.status}).`),"image-fetch",{operation:"http",httpStatus:response.status,...(resource?{resource}:{})}));
  const size=Number(response.headers.get("Content-Length"));
  if(Number.isFinite(size)&&size>maxBytes){await response.body?.cancel();throw new Error("Benchmark input exceeds its size limit.")}
  const reader=response.body?.getReader();if(!reader)throw new Error("This browser cannot read benchmark inputs.");
  const chunks:Uint8Array[]=[];let total=0;
  try{while(true){const next=await reader.read();if(next.done)break;total+=next.value.length;if(total>maxBytes)throw new Error("Benchmark input exceeds its size limit.");chunks.push(next.value);
    onProgress?.({phase:"loading",stage:"image-fetch",message:"Loading the frozen image from this site…",...(resource?{file:resource}:{}),loaded:total,...(Number.isFinite(size)&&size>0?{total:size}:{})})}}
  catch(error){await reader.cancel().catch(()=>{});throw new CoreBenchmarkError(coreBenchmarkFailure(error,"image-fetch",{operation:"read-response",...(resource?{resource}:{}),loadedBytes:total,...(Number.isFinite(size)&&size>0?{totalBytes:size}:{})}))}finally{reader.releaseLock()}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}return bytes;
}
function parseManifest(bytes:Uint8Array):Manifest{
  const value=JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
  if(value.version!==1||value.datasetId!=="core-v026"||!Array.isArray(value.cases)||value.cases.length!==40)throw new Error("The study manifest does not contain the fixed forty cases.");
  const cases=value.cases.map((item,i)=>{
    const id=`case-${String(i+1).padStart(2,"0")}`;
    if(item.id!==id||item.image!==`images/${id}.png`||!/^([a-f0-9]{64})$/.test(item.sha256)||!/^([a-f0-9]{64})$/.test(item.sourceSha256)||item.width!==512||item.height!==512)
      throw new Error("The study manifest has an invalid case, image path or source hash.");
    return {id,image:item.image,sha256:item.sha256,sourceSha256:item.sourceSha256,width:512 as const,height:512 as const};
  });return {version:1,datasetId:"core-v026",cases};
}
function inputDataUrl(bytes:Uint8Array){let binary="";for(let at=0;at<bytes.length;at+=32768)binary+=String.fromCharCode(...bytes.subarray(at,at+32768));return `data:image/png;base64,${btoa(binary)}`}
function closeReference(restoreFocus=false){referenceSequence++;referenceAbort?.abort();referenceAbort=undefined;if(referenceUrl){URL.revokeObjectURL(referenceUrl);referenceUrl=undefined}$("benchmark-reference-preview").replaceChildren();$("benchmark-reference-panel").hidden=true;if(restoreFocus)referenceButton.focus()}
async function showReference(){
  if(active||!manifest)return;const sample=manifest.cases.find(c=>c.id===referenceSelect.value);if(!sample)return;
  referenceAbort?.abort();const abort=new AbortController();referenceAbort=abort;const token=++referenceSequence;
  if(referenceUrl){URL.revokeObjectURL(referenceUrl);referenceUrl=undefined}
  $("benchmark-reference-panel").hidden=false;const preview=$("benchmark-reference-preview");preview.textContent=`Loading and verifying ${sample.id}…`;
  $("benchmark-reference-note").textContent=runs.some(r=>r.cases.some(c=>c.result))?"Model answers have already been displayed in this page. Record that exposure honestly in the review sheet; this is not a reference prepared before seeing outputs. No model runs from this panel.":"Describe the visible colour, texture, markings, edges and uncertainty in the blank review sheet. Save and freeze that reference before viewing model answers. No model runs from this panel.";
  controls();
  try{const bytes=await fetchBytes(new URL(sample.image,base),2_100_000,abort.signal);if(referenceSequence!==token)return;
    if(await sha256(bytes)!==sample.sha256)throw new Error("The source image does not match its frozen hash.");if(referenceSequence!==token)return;
    referenceUrl=URL.createObjectURL(new Blob([bytes],{type:"image/png"}));const image=document.createElement("img");image.src=referenceUrl;image.alt=`Frozen source image ${sample.id}; no model interpretation`;image.width=image.height=512;
    const caption=document.createElement("p");caption.textContent=`${sample.id} · verified 512 × 512 input. The patch is enlarged from the source; enlargement adds no observed detail.`;preview.replaceChildren(image,caption);
  }catch(error){if(referenceSequence===token)preview.textContent=error instanceof Error?error.message:String(error)}
}
function technicalSummary(run:Run){
  const value=summarizeCoreBenchmarkRun(run,{id:evaluationPlan.id,sha256:evaluationPlanSha256!});
  const panel=document.createElement("section");panel.className="bench-technical-summary";
  const heading=document.createElement("h4");heading.textContent="Technical summary";panel.append(heading);
  const note=(text:string)=>{const p=document.createElement("p");p.textContent=text;panel.append(p)};
  note(run.evaluation?`Evaluation: ${run.evaluation.planId} · ${run.evaluation.target} target. Plan hash is retained in the JSON export.`:"Legacy run: no evaluation plan assigned. Its original device context is retained.");
  note(value.classificationReason);
  const c=value.counts;
  note(`${c.attempted} attempted · ${c.failed} failed · ${c.timedOut} timed out · ${c.interrupted} interrupted · ${c.cancelled} cancelled · ${c.notStarted} not started · ${c.unselected} unselected · ${c.capped} capped outputs.`);
  const grid=document.createElement("div");grid.className="bench-timing-grid";
  const seconds=(ms:number|null)=>ms===null?"—":`${(ms/1000).toFixed(3)} s`;
  for(const kind of ["cold","warm"] as const){
    const group=value.timings[kind],section=document.createElement("div"),title=document.createElement("h5");
    title.textContent=`${kind==="cold"?"Cold model session":"Warm model session"} · ${group.count} completed`;section.append(title);
    for(const [key,label] of [["firstToken","First token"],["endToEnd","End to end"],["load","Model loading"]] as const){
      const metric=group[key],p=document.createElement("p");p.textContent=`${label}: ${metric.count} measured · median ${seconds(metric.medianMs)} · p95 ${seconds(metric.p95Ms)}`;section.append(p);
    }
    grid.append(section);
  }
  panel.append(grid);
  note(value.timings.withheldReason??"Timings describe this run only. Each p95 needs at least 30 valid samples; — means unavailable. Warm means the model session was reused. First-token timing excludes loading and preprocessing.");
  note("Technical measurements do not establish description quality. Human grading, source independence, physical-device verification and total GPU/process memory remain unassessed.");
  return panel;
}
function render(){
  checkpoint();
  if(!runs.length){results.textContent="No runs yet.";return}results.replaceChildren();
  for(let index=runs.length-1;index>=0;index--){const run=runs[index],card=document.createElement("article");card.className="bench-run";card.dataset.runId=run.id;
    const title=document.createElement("h3");title.textContent=`Run ${index+1} · ${run.mode==="quality"?"Description evaluation":"Compatibility check"}`;card.append(title);
    const summary=document.createElement("p");summary.className="bench-run-summary";
    const done=run.cases.filter(c=>c.status==="completed").length;
    summary.textContent=`${done}/${run.cases.length} selected cases completed · ${run.status} · full study: 40 cases${run.appVersion?` · app ${run.appVersion}`:""}. ${run.mode==="compatibility"?"Unscored execution check.":"Human quality review pending."}`;card.append(summary);
    card.append(technicalSummary(run));
    for(const entry of run.cases){const element=document.createElement("section");element.className="bench-case";element.dataset.caseId=entry.caseId;
      const head=document.createElement("div");head.className="bench-case-head";const h=document.createElement("h4");h.textContent=entry.caseId;const badge=document.createElement("span");badge.className="bench-case-status";badge.dataset.status=entry.status;badge.textContent=entry.status.replaceAll("-"," ");head.append(h,badge);element.append(head);
      if(entry.result){const answer=document.createElement("div");answer.className="bench-answer";answer.textContent=entry.result.text;element.append(answer);
        const meta=document.createElement("p");meta.className="bench-case-meta";meta.textContent=`${entry.result.generatedTokens}/${entry.result.maxNewTokens} tokens · ${(entry.result.inferenceMs/1000).toFixed(1)} s generation${entry.result.outputLimitReached?" · output limit reached; answer may be incomplete":""}. Unreviewed model output.`;element.append(meta)}
      if(entry.error){const error=document.createElement("p");error.textContent=entry.error;element.append(error)}
      if(entry.errorDiagnostic){const diagnostic=entry.errorDiagnostic,note=document.createElement("p");note.className="bench-case-diagnostic";
        note.textContent=`Failure while ${CORE_BENCHMARK_STAGE_LABELS[diagnostic.stage]} (${diagnostic.name})${diagnostic.operation?` · ${diagnostic.operation}`:""}${diagnostic.resource?` · failed resource: ${diagnostic.resource}`:""}${diagnostic.httpStatus?` · HTTP ${diagnostic.httpStatus}`:""}. Export results JSON to retain these details.`;element.append(note)}
      if(entry.lastProgress&&entry.status!=="completed"){const observation=entry.lastProgress,value=observation.progress,note=document.createElement("p");note.className="bench-case-progress-note";
        const transfer=value.loaded!==undefined?` · ${(value.loaded/1048576).toFixed(1)}${value.total?` / ${(value.total/1048576).toFixed(1)}`:""} MiB observed`:"";
        note.textContent=`Last observed: ${value.stage?CORE_BENCHMARK_STAGE_LABELS[value.stage]:value.message}${value.file?` · observed file: ${value.file}`:""}${transfer}${value.generatedTokens!==undefined?` · ${value.generatedTokens} tokens`:""} · ${(observation.caseElapsedMs/1000).toFixed(1)} s into this case. This checkpoint is not a completion time or a diagnosis of the interruption.`;element.append(note)}
      card.append(element)}results.append(card)}
}
function flushProgressCheckpoint(state:Active){
  clearTimeout(state.checkpointTimer);state.checkpointTimer=undefined;
  if(active!==state||state.current?.status!=="running")return;
  state.checkpointAt=performance.now();const value=state.current.lastProgress?.progress;state.checkpointStage=value?.stage??value?.phase;checkpoint();
}
function progressMessage(state:Active,entry:Entry,value:CoreBenchmarkProgress){
  if(active!==state||state.current!==entry||entry.status!=="running")return;
  value=checkedCoreBenchmarkProgress(value);entry.lastProgress={progress:value,observedAt:now(),caseElapsedMs:performance.now()-(state.currentStarted??performance.now())};
  const stage=value.stage??value.phase,elapsed=performance.now()-(state.checkpointAt??-Infinity);
  const firstFile=!!value.file&&!state.checkpointFiles?.has(value.file)&&(state.checkpointFiles?.size??0)<32;
  if(firstFile){state.checkpointFiles??=new Set();state.checkpointFiles.add(value.file!)}
  if(stage!==state.checkpointStage||firstFile||elapsed>=1000)flushProgressCheckpoint(state);
  else if(state.checkpointTimer===undefined)state.checkpointTimer=setTimeout(()=>flushProgressCheckpoint(state),Math.max(0,1000-elapsed));
  say(`${entry.caseId} · ${value.message}`);progress.hidden=false;
  if(value.phase==="loading"&&value.total&&value.loaded!==undefined){progress.max=value.total;progress.value=Math.min(value.loaded,value.total)}
  else if(value.generatedTokens!==undefined&&value.maxNewTokens){progress.max=value.maxNewTokens;progress.value=value.generatedTokens}
  else progress.removeAttribute("value");
}
function stop(reason:string,kind:"cancelled"|"interrupted"|"timed-out"){
  const state=active;if(!state)return;
  active=undefined;sequence++;clearTimeout(state.caseTimer);clearTimeout(state.checkpointTimer);state.abort.abort();state.client.dispose();
  state.run.status=kind==="timed-out"?"failed":kind;state.run.finishedAt=now();state.run.stopReason=reason;state.run.mainThreadJsHeapAfterBytes=heapBytes();
  if(state.current?.status==="running"){state.current.status=kind;state.current.finishedAt=now();state.current.elapsedMs=performance.now()-(state.currentStarted??performance.now());state.current.error=reason}
  progress.hidden=true;say(`${reason} Completed and unstarted cases are preserved. Export this page’s results before closing.`);render();controls();
}
async function start(){
  if(active||clearing||!manifest||!protocolSha256||!evaluationPlanSha256||!supported||!consent.checked)return;
  if(targetSelect.value!=="desktop"&&targetSelect.value!=="exploratory")return;
  const mode=modeSelect.value as CoreBenchmarkMode,count=Number(countSelect.value);
  const selected=count===1?manifest.cases.filter(c=>c.id===caseSelect.value):manifest.cases.slice(0,count);
  if(![1,5,40].includes(count)||selected.length!==count){say("Choose a valid set of frozen cases.",true);return}
  if(document.visibilityState!=="visible"){say("Keep this page visible before starting a run.",true);return}
  closeReference();
  const run:Run={id:`run-${runs.length+1}`,appVersion:pkg.version,evaluation:{planId:evaluationPlan.id,planSha256:evaluationPlanSha256,target:targetSelect.value},startedAt:now(),mode,maxNewTokens:coreBenchmarkTokenLimit(mode),status:"running",selfReportedDeviceLabel:deviceLabel.value.trim().slice(0,120),physicalDeviceVerified:false,
    cohortCaseCount:40,selectedCaseIds:selected.map(c=>c.id),unselectedCaseIds:manifest.cases.filter(c=>!selected.some(s=>s.id===c.id)).map(c=>c.id),
    cases:selected.map(c=>({caseId:c.id,imageSha256:c.sha256,sourceSha256:c.sourceSha256,status:"not-started"})),mainThreadJsHeapBeforeBytes:heapBytes(),pageVisibleAtStart:true,browserContext:browserContext(),...(preflightAdapter?{preflightAdapter:structuredClone(preflightAdapter)}:{})};
  const state:Active={token:++sequence,run,abort:new AbortController(),client:new CoreBenchmarkClient()};active=state;runs.push(run);render();controls();
  try{
    for(let i=0;i<selected.length;i++){
      if(active!==state)return;const sample=selected[i],entry=run.cases[i];state.current=entry;state.currentStarted=performance.now();state.checkpointStage=undefined;state.checkpointFiles=new Set();entry.status="running";entry.startedAt=now();state.caseTimer=setTimeout(()=>stop("This case timed out after its thirty-minute budget; remaining cases were not started.","timed-out"),CORE_BENCHMARK_TIMEOUT_MS);render();
      let stage:CoreBenchmarkStage="image-fetch";progressMessage(state,entry,{phase:"loading",stage,message:"Loading the frozen image from this site…",file:sample.image});
      try{
        const bytes=await fetchBytes(new URL(sample.image,base),2_100_000,state.abort.signal,value=>progressMessage(state,entry,value));if(active!==state)return;
        stage="image-verify";progressMessage(state,entry,{phase:"checking",stage,message:"Checking the frozen image hash…",file:sample.image});
        if(await sha256(bytes)!==sample.sha256)throw new Error("Image integrity check failed. No model was started for this case.");if(active!==state)return;
        stage="worker-start";progressMessage(state,entry,{phase:"checking",stage,message:"Starting the model worker…"});
        const result=await state.client.run({caseId:sample.id,image:inputDataUrl(bytes),expectedSha256:sample.sha256,mode},value=>progressMessage(state,entry,value));if(active!==state)return;
        entry.result=result;entry.status="completed";entry.finishedAt=now();entry.elapsedMs=performance.now()-state.currentStarted;clearTimeout(state.caseTimer);clearTimeout(state.checkpointTimer);state.checkpointTimer=undefined;render();
      }catch(error){if(active!==state)return;entry.errorDiagnostic=coreBenchmarkFailure(error,stage,stage==="image-fetch"||stage==="image-verify"?{resource:sample.image}:{});entry.error=entry.errorDiagnostic.message;entry.status=/timed out/i.test(entry.error)?"timed-out":"failed";entry.finishedAt=now();entry.elapsedMs=performance.now()-state.currentStarted;clearTimeout(state.caseTimer);run.status="failed";run.stopReason="Stopped at the first failed case; later selected cases were not started.";say(`${sample.id} failed while ${CORE_BENCHMARK_STAGE_LABELS[entry.errorDiagnostic.stage]}. ${entry.error} Export results JSON for diagnosis. Later cases remain unstarted.`,true);break}
    }
    if(active!==state)return;if(run.status==="running"){run.status="completed";say(`${run.cases.length} selected case${run.cases.length===1?"":"s"} completed. ${mode==="compatibility"?"Compatibility output is unscored.":"Human quality review is still pending."} Export your results.`)}
    run.finishedAt=now();run.mainThreadJsHeapAfterBytes=heapBytes();
  }finally{clearTimeout(state.caseTimer);clearTimeout(state.checkpointTimer);state.client.dispose();if(active===state){active=undefined;progress.hidden=true;render();controls()}}
}
function download(name:string,type:string,contents:string){const url=URL.createObjectURL(new Blob([contents],{type}));urls.add(url);const link=document.createElement("a");link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url)},60_000)}
function exportReport(){
  if(!manifest||!runs.length)return;
  const report={format:"geomodel3d-core-device-benchmark",version:1,appVersion:pkg.version,createdAt,exportedAt:now(),inProgress:!!active,partial:runs.some(run=>run.selectedCaseIds.length!==40||run.cases.some(c=>c.status!=="completed")),
    protocol:{id:protocolId,sha256:protocolSha256,rubricSha256,sourceManifestSha256,timingDefinitions:JSON.parse(protocolSource).execution.timingDefinitions,promptVersion:CORE_BENCHMARK_PROMPT_VERSION,prompt:CORE_BENCHMARK_PROMPT,model:CORE_BENCHMARK_MODEL,qualityTokenLimit:128,compatibilityTokenLimit:32,doSample:false,repetitionPenalty:1.1,humanReviewStatus:"pending",qualityScores:null},
    dataset:{id:manifest.datasetId,manifestSha256,cohortCaseCount:40,boreholeIndependence:"unverified",cases:manifest.cases.map(c=>({caseId:c.id,imageSha256:c.sha256,sourceSha256:c.sourceSha256,width:c.width,height:c.height}))},
    activeEvaluationPlan:{id:evaluationPlan.id,sha256:evaluationPlanSha256,plan:JSON.parse(evaluationPlanSource),appliesTo:"Only runs explicitly carrying this plan ID and hash."},
    browser:browserContext(),
    memory:{gpuMemoryBytes:null,note:"Main-thread and worker JavaScript heap observations, when available, exclude GPU allocations. They do not measure total model or device memory."},
    methodology:"Each selected case runs once in recorded order with the pinned model, frozen input hash and fixed prompt. Stop, failure or page hiding preserves completed/current/unstarted records. Runs are not retried automatically. Compatibility output is excluded from quality evaluation. Human references and scores must be supplied independently; no quality or engineering accuracy is inferred from execution.",runs:runs.map(run=>({...structuredClone(run),technicalSummary:summarizeCoreBenchmarkRun(run,{id:evaluationPlan.id,sha256:evaluationPlanSha256!})}))};
  download(`geomodel3d-qwen-device-${new Date().toISOString().replaceAll(":","-")}.json`,"application/json",JSON.stringify(report,null,2)+"\n");
}
function reviewCsv(){
  if(!manifest)return;const cell=(value:string)=>'"'+value.replaceAll('"','""')+'"';
  // The checked-in blank template contains no quoted commas. Keep every review field
  // and unassessed state intact; only substitute this verified site's image links/hash.
  const lines=humanReviewTemplate.trimEnd().split(/\r?\n/),headers=lines[0].split(",");
  const idAt=headers.indexOf("case_id"),imageAt=headers.indexOf("image_path"),hashAt=headers.indexOf("image_sha256");
  if(idAt<0||imageAt<0||hashAt<0||lines.length!==41)throw new Error("The human review template does not match the forty-case protocol.");
  const rows=manifest.cases.map((c,i)=>{const row=lines[i+1].split(",");if(row.length!==headers.length||row[idAt]!==c.id)throw new Error("The human review template case order changed.");row[imageAt]=new URL(c.image,base).href;row[hashAt]=c.sha256;return row.map(cell).join(",")});
  download("geomodel3d-core-v026-blank-reference-review.csv","text/csv;charset=utf-8",[headers.map(cell).join(","),...rows].join("\r\n")+"\r\n");
}
runButton.addEventListener("click",()=>{void start().catch(error=>say(error instanceof Error?error.message:String(error),true))});
stopButton.addEventListener("click",()=>stop("Stopped by the user.","cancelled"));exportButton.addEventListener("click",exportReport);csvButton.addEventListener("click",reviewCsv);
referenceButton.addEventListener("click",()=>{void showReference();$("benchmark-reference-heading").scrollIntoView({block:"start"})});
referenceSelect.addEventListener("change",()=>{void showReference()});referenceNext.addEventListener("click",()=>{if(referenceSelect.selectedIndex<referenceSelect.options.length-1){referenceSelect.selectedIndex++;void showReference()}});
$("benchmark-reference-close").addEventListener("click",()=>closeReference(true));
for(const input of [consent,modeSelect,countSelect])input.addEventListener("change",controls);
clearButton.addEventListener("click",()=>{if(active||clearing)return;clearing=true;controls();void clearCoreBenchmarkCache().then(removed=>say(removed?"Cached benchmark model downloads removed. Other GeoModel3D data are unchanged.":"No benchmark model cache was present.")).catch(error=>say(error instanceof Error?error.message:String(error),true)).finally(()=>{clearing=false;controls()})});
$("benchmark-forget-report").addEventListener("click",()=>{if(active)return;try{localStorage.removeItem(recoveryKey);recoveryNote="";runs.length=0;render();controls();$("benchmark-recovery-status").textContent="Saved benchmark results removed. Model cache and ground-model data are unchanged."}catch{$("benchmark-recovery-status").textContent="Browser storage could not remove the saved benchmark report."}});
document.addEventListener("visibilitychange",()=>{if(document.visibilityState!=="visible")stop("Page hidden; the batch was interrupted and the model unloaded.","interrupted")});
window.addEventListener("pagehide",()=>{stop("Page left; the batch was interrupted and the model unloaded.","interrupted");closeReference()});
window.addEventListener("beforeunload",event=>{if(active){stop("Page closed or reloaded; the batch was interrupted.","interrupted");event.preventDefault();event.returnValue=""}});
void coreBenchmarkSupport().then(value=>{
  supported=value.supported;preflightAdapter=(value as typeof value&{adapter?:CoreBenchmarkAdapter}).adapter;
  const support=$("benchmark-support");support.dataset.state=!supported?"unavailable":preflightAdapter?.softwareAdapter?"software":"available";
  support.textContent=!supported?(value.reason??"WebGPU is unavailable. You can still prepare a human reference sheet."):preflightAdapter?.softwareAdapter?"A software WebGPU adapter is active. Runs may take a long time and do not measure desktop hardware GPU speed.":"WebGPU is available. No model downloads until you start. Adapter identity may be hidden by the browser.";
  controls();
}).catch(error=>{supported=false;$("benchmark-support").textContent=error instanceof Error?error.message:String(error);$("benchmark-support").dataset.state="unavailable";controls()});
void fetchBytes(new URL("manifest.json",base),128_000).then(async bytes=>{
  const parsed=parseManifest(bytes),encoder=new TextEncoder();const [hash,ph,rh,sh,eh]=await Promise.all([sha256(bytes),sha256(encoder.encode(protocolSource)),sha256(encoder.encode(rubricSource)),sha256(encoder.encode(sourceManifest)),sha256(encoder.encode(evaluationPlanSource))]);
  const expected=evaluationPlan.baseProtocol;
  if(hash!==expected.publicManifestSha256||ph!==expected.sha256||rh!==expected.rubricSha256||sh!==expected.sourceManifestSha256)throw new Error("Benchmark files do not match the frozen desktop evaluation plan. Reload the page before starting a new run.");
  evaluationPlanSha256=eh;manifest=parsed;manifestSha256=hash;protocolSha256=ph;rubricSha256=rh;sourceManifestSha256=sh;caseSelect.replaceChildren(...parsed.cases.map(c=>new Option(c.id,c.id)));
  referenceSelect.replaceChildren(...parsed.cases.map(c=>new Option(c.id,c.id)));
  $("benchmark-dataset-status").textContent="40 frozen public images are available. Case images load only when you review a source or start a run.";restore();render();controls();
}).catch(error=>{$("benchmark-dataset-status").textContent=`Case manifest unavailable: ${error instanceof Error?error.message:String(error)}`;say("The frozen image set could not be verified. No model or case image was downloaded.",true);controls()});
controls();
