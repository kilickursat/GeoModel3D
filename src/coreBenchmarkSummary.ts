/** Execution observations for one run; these summaries do not grade descriptions or verify hardware. */
import type {CoreBenchmarkAdapter,CoreBenchmarkResult} from "./coreBenchmark";

export interface CoreBenchmarkEvaluation {planId:string;planSha256:string;target:"desktop"|"exploratory"}

/** Preserve bounded unknown plan identities instead of silently assigning today's plan to old evidence. */
export function checkedCoreBenchmarkEvaluation(value:unknown):CoreBenchmarkEvaluation|undefined{
  if(!value||typeof value!=="object")return undefined;
  const candidate=value as Record<string,unknown>;
  if(typeof candidate.planId!=="string"||!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(candidate.planId)
    ||typeof candidate.planSha256!=="string"||!/^[a-f0-9]{64}$/.test(candidate.planSha256)
    ||candidate.target!=="desktop"&&candidate.target!=="exploratory")return undefined;
  return {planId:candidate.planId,planSha256:candidate.planSha256,target:candidate.target};
}

export interface CoreBenchmarkSummaryRun {
  mode:string;cohortCaseCount:number;selectedCaseIds:string[];
  cases:{status:string;elapsedMs?:number;result?:CoreBenchmarkResult}[];
  evaluation?:CoreBenchmarkEvaluation;browserContext?:{userAgent:string};preflightAdapter?:CoreBenchmarkAdapter;
}
export interface CoreBenchmarkMetricSummary {count:number;medianMs:number|null;p95Ms:number|null}
export interface CoreBenchmarkTimingSummary {
  count:number;firstToken:CoreBenchmarkMetricSummary;endToEnd:CoreBenchmarkMetricSummary;load:CoreBenchmarkMetricSummary;
}
export type CoreBenchmarkAdapterEvidence="none"|"hardware-looking"|"software"|"unknown"|"mixed"|"non-webgpu";
export type CoreBenchmarkRunClassification="legacy-unassigned"|"exploratory"|"different-plan"|"non-desktop-browser"
  |"no-completed-inference"|"non-webgpu-execution"|"mixed-execution-modes"|"software-adapter"|"unknown-adapter"|"mixed-adapters"|"desktop-candidate";
export interface CoreBenchmarkRunSummary {
  mode:string;
  counts:{selected:number;unselected:number;attempted:number;completed:number;completedWithResult:number;failed:number;timedOut:number;interrupted:number;cancelled:number;notStarted:number;capped:number};
  classification:CoreBenchmarkRunClassification;classificationReason:string;
  adapterEvidence:CoreBenchmarkAdapterEvidence;workerAdapterCount:number;physicalDeviceVerified:false;
  timings:{withheldReason:string|null;cold:CoreBenchmarkTimingSummary;warm:CoreBenchmarkTimingSummary};
}

function validMs(value:unknown):value is number{return typeof value==="number"&&Number.isFinite(value)&&value>=0}
function metric(values:unknown[],withheld:boolean):CoreBenchmarkMetricSummary{
  const samples=values.filter(validMs).sort((a,b)=>a-b),n=samples.length;
  return {count:n,medianMs:n&&!withheld?(samples[Math.floor((n-1)/2)]+samples[Math.floor(n/2)])/2:null,
    p95Ms:n>=30&&!withheld?samples[Math.ceil(.95*n)-1]:null};
}
function adapterIdentity(adapter:CoreBenchmarkAdapter|undefined):string{
  // Features and limits are capability observations; vendor/device identity defines aggregation groups.
  return JSON.stringify(adapter?[adapter.vendor,adapter.architecture,adapter.device,adapter.description,adapter.softwareAdapter]:null);
}
function desktopBrowser(userAgent:string):boolean{
  return !/Mobile|Android|iPhone|iPad|iPod|CriOS|EdgiOS|EdgA|HeadlessChrome/i.test(userAgent)
    &&/Windows NT|Macintosh|X11|Linux/i.test(userAgent)&&/(?:Chrome|Edg)\/\d+/i.test(userAgent)
    &&!/OPR\/|Opera/i.test(userAgent);
}

export function summarizeCoreBenchmarkRun(run:CoreBenchmarkSummaryRun,activePlan:{id:string;sha256:string}):CoreBenchmarkRunSummary{
  const completed=run.cases.filter(entry=>entry.status==="completed"),observed=completed.filter((entry):entry is typeof entry&{result:CoreBenchmarkResult}=>!!entry.result);
  const identities=new Set(observed.map(entry=>adapterIdentity(entry.result.adapter)));
  const nonWebgpu=observed.some(entry=>entry.result.device!=="webgpu");
  const wrongMode=observed.some(entry=>entry.result.mode!==run.mode||entry.result.maxNewTokens!==(run.mode==="quality"?128:run.mode==="compatibility"?32:0));
  const adapterEvidence:CoreBenchmarkAdapterEvidence=!observed.length?"none":nonWebgpu?"non-webgpu":identities.size>1?"mixed"
    :observed[0].result.adapter?.softwareAdapter===true?"software":observed[0].result.adapter?.softwareAdapter===false?"hardware-looking":"unknown";
  const withheldReason=nonWebgpu?"A completed result did not use WebGPU; timings are not combined."
    :wrongMode?"Completed results do not share the run's inference mode and token limit; timings are not combined."
    :identities.size>1?"Completed results report different worker adapters; timings are not combined.":null;
  const timing=(warm:boolean):CoreBenchmarkTimingSummary=>{
    const entries=observed.filter(entry=>entry.result.modelReused===warm);
    return {count:entries.length,firstToken:metric(entries.map(entry=>entry.result.firstTokenMs),!!withheldReason),
      endToEnd:metric(entries.map(entry=>entry.elapsedMs),!!withheldReason),load:metric(entries.map(entry=>entry.result.loadMs),!!withheldReason)};
  };
  let classification:CoreBenchmarkRunClassification,classificationReason:string;
  const evaluation=checkedCoreBenchmarkEvaluation(run.evaluation);
  if(!evaluation){classification="legacy-unassigned";classificationReason="No evaluation plan was recorded for this run; it has not been assigned to the active desktop plan."}
  else if(evaluation.planId!==activePlan.id||evaluation.planSha256!==activePlan.sha256){classification="different-plan";classificationReason="This run belongs to a different evaluation plan. Its recorded plan identity is preserved."}
  else if(evaluation.target==="exploratory"){classification="exploratory";classificationReason="This run was recorded as exploratory, outside the desktop evaluation target."}
  else if(!desktopBrowser(run.browserContext?.userAgent??"")){classification="non-desktop-browser";classificationReason="The recorded browser does not identify desktop Chrome or Edge. Browser identity is self-reported."}
  else if(!observed.length){classification="no-completed-inference";classificationReason="No completed worker result is available; a preflight adapter alone is not execution evidence."}
  else if(nonWebgpu){classification="non-webgpu-execution";classificationReason=withheldReason!}
  else if(wrongMode){classification="mixed-execution-modes";classificationReason=withheldReason!}
  else if(adapterEvidence==="mixed"){classification="mixed-adapters";classificationReason=withheldReason!}
  else if(adapterEvidence==="software"){classification="software-adapter";classificationReason="Completed worker results identify a software adapter, outside the desktop hardware target."}
  else if(adapterEvidence==="unknown"){classification="unknown-adapter";classificationReason="Completed worker results do not identify whether the adapter is hardware or software."}
  else{classification="desktop-candidate";classificationReason="Completed worker results identify a hardware-looking adapter in desktop Chrome or Edge. This is candidate execution evidence, not physical-device verification or a completed evaluation."}
  const statusCount=(status:string)=>run.cases.filter(entry=>entry.status===status).length;
  return {mode:run.mode,counts:{selected:run.selectedCaseIds.length,unselected:Math.max(0,run.cohortCaseCount-run.selectedCaseIds.length),
    attempted:run.cases.filter(entry=>entry.status!=="not-started").length,completed:completed.length,completedWithResult:observed.length,
    failed:statusCount("failed"),timedOut:statusCount("timed-out"),interrupted:statusCount("interrupted"),cancelled:statusCount("cancelled"),notStarted:statusCount("not-started"),
    capped:observed.filter(entry=>entry.result.outputLimitReached).length},classification,classificationReason,adapterEvidence,workerAdapterCount:identities.size,
    physicalDeviceVerified:false,timings:{withheldReason,cold:timing(false),warm:timing(true)}};
}
