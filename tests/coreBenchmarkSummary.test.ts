import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {CORE_BENCHMARK_MODEL,CORE_BENCHMARK_ONNX_VERSION,CORE_BENCHMARK_PROMPT,CORE_BENCHMARK_PROMPT_VERSION,CORE_BENCHMARK_RUNTIME_VERSION,coreBenchmarkAdapterMetadata,coreBenchmarkMemoryMetadata} from "../src/coreBenchmark";
import type {CoreBenchmarkResult} from "../src/coreBenchmark";
import {checkedCoreBenchmarkEvaluation,summarizeCoreBenchmarkRun} from "../src/coreBenchmarkSummary";
import type {CoreBenchmarkSummaryRun} from "../src/coreBenchmarkSummary";

const plan={id:"desktop-webgpu-v1",sha256:"a".repeat(64)},evaluation={planId:plan.id,planSha256:plan.sha256,target:"desktop" as const};
const userAgent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const hardware=coreBenchmarkAdapterMetadata({info:{vendor:"nvidia",device:"GPU 1"}}),software=coreBenchmarkAdapterMetadata({info:{architecture:"swiftshader"}});
function result(patch:Partial<CoreBenchmarkResult>={}):CoreBenchmarkResult{
  return {caseId:"case-01",mode:"quality",modelId:CORE_BENCHMARK_MODEL.id,model:CORE_BENCHMARK_MODEL.repo,revision:CORE_BENCHMARK_MODEL.revision,dtypes:{...CORE_BENCHMARK_MODEL.dtype},
    prompt:CORE_BENCHMARK_PROMPT,promptVersion:CORE_BENCHMARK_PROMPT_VERSION,enableThinking:false,generation:{doSample:false,repetitionPenalty:1.1,maxNewTokens:128},
    text:"Synthetic observation for aggregation tests.",generatedTokens:7,inputTokens:334,maxNewTokens:128,outputLimitReached:false,
    imageSha256:"b".repeat(64),imageWidth:512,imageHeight:512,imageGrid:[[1,32,32]],loadMs:5,preprocessingMs:8,inferenceMs:20,totalMs:33,
    firstTokenMs:9,tokensPerSecond:350,modelReused:true,cacheState:"available",downloadBytes:0,device:"webgpu",
    runtimeVersion:CORE_BENCHMARK_RUNTIME_VERSION,onnxRuntimeVersion:CORE_BENCHMARK_ONNX_VERSION,adapter:hardware,memory:coreBenchmarkMemoryMetadata({}),...patch};
}
function run(cases:CoreBenchmarkSummaryRun["cases"],patch:Partial<CoreBenchmarkSummaryRun>={}):CoreBenchmarkSummaryRun{
  return {mode:"quality",cohortCaseCount:40,selectedCaseIds:cases.map((_,i)=>`case-${String(i+1).padStart(2,"0")}`),cases,evaluation,browserContext:{userAgent},preflightAdapter:hardware,...patch};
}
const summarize=(value:CoreBenchmarkSummaryRun)=>summarizeCoreBenchmarkRun(value,plan);

describe("evaluation-plan provenance",()=>{
  it("links the desktop overlay to unchanged frozen generation, review and image manifests",()=>{
    const read=(path:string)=>readFileSync(new URL(path,import.meta.url));
    const desktop=JSON.parse(read("../docs/benchmarks/0.27.0-desktop-ai/evaluation-plan.json").toString());
    const frozen=[
      ["sha256","../docs/benchmarks/0.26.0-core-ai/protocol.json","59048ae5c9210239225c04867675594b192d61d46e3d26ca1f4f92232b483ea1"],
      ["rubricSha256","../docs/benchmarks/0.26.0-core-ai/rubric.md","6422732b8ba1a6efe780e1e979c6b994a67737ca1501e0f126b4c3369fc77b09"],
      ["publicManifestSha256","../public/core-benchmark-v026/manifest.json","b61549c3de8714e2f015056276efc23dfb3c6f3e1206fbd6611b68af3712c391"],
      ["sourceManifestSha256","../docs/benchmarks/0.26.0-core-ai/dataset-manifest.json","301b53789551d3423730f56572762ab99cee8f59b1d1e7b3dfa30c6cf80141d2"]
    ];
    for(const [field,path,hash] of frozen){expect(createHash("sha256").update(read(path)).digest("hex")).toBe(hash);expect(desktop.baseProtocol[field]).toBe(hash)}
    expect(JSON.parse(read(frozen[0][1]).toString()).protocolId).toBe(desktop.baseProtocol.id);
  });
  it("preserves a bounded unknown plan without assigning the active plan or retaining extra fields",()=>{
    const unknown={planId:"future.study-2",planSha256:"f".repeat(64),target:"exploratory"};
    expect(checkedCoreBenchmarkEvaluation({...unknown,physicalDeviceVerified:true})).toEqual(unknown);
    expect(summarize(run([],{evaluation:checkedCoreBenchmarkEvaluation(unknown)}))).toMatchObject({classification:"different-plan",physicalDeviceVerified:false});
    expect(summarize(run([],{evaluation:undefined}))).toMatchObject({classification:"legacy-unassigned",physicalDeviceVerified:false});
    expect(summarize(run([],{evaluation:{...evaluation,target:"exploratory"}})).classification).toBe("exploratory");
    expect(summarize(run([],{evaluation:{...evaluation,planSha256:"f".repeat(64)}})).classification).toBe("different-plan");
  });
  it("rejects malformed metadata without normalizing it into a different identity",()=>{
    for(const invalid of [undefined,null,[],"desktop",{}, {...evaluation,planId:"../desktop"},{...evaluation,planId:"x".repeat(97)},
      {...evaluation,planId:"Desktop"},{...evaluation,planSha256:"A".repeat(64)},{...evaluation,planSha256:"a".repeat(63)},
      {...evaluation,target:"verified"},{...evaluation,target:null}])expect(checkedCoreBenchmarkEvaluation(invalid)).toBeUndefined();
    expect(checkedCoreBenchmarkEvaluation(evaluation)).toEqual(evaluation);
  });
});

describe("single-run execution observations",()=>{
  it("counts every terminal outcome and keeps failed or unstarted cases out of timing samples",()=>{
    const value=run([{status:"completed",elapsedMs:50,result:result({outputLimitReached:true})},{status:"completed"},
      {status:"failed",elapsedMs:9000,result:result()},{status:"timed-out",elapsedMs:1_800_000},{status:"interrupted"},
      {status:"cancelled"},{status:"not-started"},{status:"running"}]);
    expect(summarize(value)).toMatchObject({counts:{selected:8,unselected:32,attempted:7,completed:2,completedWithResult:1,failed:1,timedOut:1,interrupted:1,cancelled:1,notStarted:1,capped:1},
      classification:"desktop-candidate",timings:{warm:{count:1,endToEnd:{count:1,medianMs:50,p95Ms:null}}},physicalDeviceVerified:false});
  });
  it("separates cold load from warm observations and computes nearest-rank p95 only after 30 valid samples",()=>{
    const cases=[{status:"completed",elapsedMs:100_000,result:result({modelReused:false,firstTokenMs:900,loadMs:80_000})},
      ...Array.from({length:30},(_,i)=>({status:"completed",elapsedMs:(i+1)*100,result:result({firstTokenMs:i+1,loadMs:0})}))];
    const summary=summarize(run(cases));
    expect(summary.timings).toEqual({withheldReason:null,cold:{count:1,firstToken:{count:1,medianMs:900,p95Ms:null},endToEnd:{count:1,medianMs:100_000,p95Ms:null},load:{count:1,medianMs:80_000,p95Ms:null}},
      warm:{count:30,firstToken:{count:30,medianMs:15.5,p95Ms:29},endToEnd:{count:30,medianMs:1550,p95Ms:2900},load:{count:30,medianMs:0,p95Ms:0}}});
    expect(summarize(run(cases.slice(0,-1))).timings.warm.endToEnd.p95Ms).toBeNull();
  });
  it("counts valid measurements independently and never replaces absent page elapsed time with worker total",()=>{
    const cases=Array.from({length:31},(_,i)=>({status:"completed",...(i===0?{}:{elapsedMs:i===30?NaN:i}),
      result:result({firstTokenMs:i===0?null:i,loadMs:i===0?Infinity:5,totalMs:99999})}));
    const warm=summarize(run(cases)).timings.warm;
    expect(warm).toEqual({count:31,firstToken:{count:30,medianMs:15.5,p95Ms:29},endToEnd:{count:29,medianMs:15,p95Ms:null},load:{count:30,medianMs:5,p95Ms:5}});
  });
  it("retains capped successful samples in latency and excludes stray results on failed entries",()=>{
    const summary=summarize(run([{status:"completed",elapsedMs:1,result:result()},{status:"completed",elapsedMs:999,result:result({outputLimitReached:true})},
      {status:"failed",elapsedMs:10000,result:result({outputLimitReached:true})}]));
    expect(summary.counts.capped).toBe(1);expect(summary.timings.warm.endToEnd).toEqual({count:2,medianMs:500,p95Ms:null});
  });
  it("does not substitute a hardware-looking preflight adapter for completed worker evidence",()=>{
    expect(summarize(run([{status:"failed",elapsedMs:900}]))).toMatchObject({classification:"no-completed-inference",adapterEvidence:"none",workerAdapterCount:0});
    expect(summarize(run([{status:"completed",result:result({adapter:software})}]))).toMatchObject({classification:"software-adapter",adapterEvidence:"software",physicalDeviceVerified:false});
    expect(summarize(run([{status:"completed",result:result({adapter:coreBenchmarkAdapterMetadata({})})}]))).toMatchObject({classification:"unknown-adapter",adapterEvidence:"unknown"});
  });
  it("withholds aggregate timings across distinct worker adapters, including two hardware vendors",()=>{
    for(const second of [software,coreBenchmarkAdapterMetadata({info:{vendor:"amd"}}),{...hardware,device:"GPU 2"}]){
      const summary=summarize(run([{status:"completed",elapsedMs:10,result:result()},{status:"completed",elapsedMs:20,result:result({adapter:second})}]));
      expect(summary).toMatchObject({classification:"mixed-adapters",adapterEvidence:"mixed",workerAdapterCount:2,timings:{warm:{count:2,endToEnd:{count:2,medianMs:null,p95Ms:null}}}});
      expect(summary.timings.withheldReason).toContain("different worker adapters");
    }
  });
  it("does not combine CPU/backend or mode-mismatched results with WebGPU quality measurements",()=>{
    const baseline={status:"completed",elapsedMs:10,result:result()};
    const cpu=result({device:"cpu" as never});
    expect(summarize(run([baseline,{status:"completed",elapsedMs:20,result:cpu}]))).toMatchObject({classification:"non-webgpu-execution",adapterEvidence:"non-webgpu",timings:{warm:{firstToken:{count:2,medianMs:null,p95Ms:null}}}});
    for(const changed of [{mode:"compatibility" as const,maxNewTokens:32},{maxNewTokens:32}])
      expect(summarize(run([baseline,{status:"completed",elapsedMs:20,result:result(changed)}]))).toMatchObject({classification:"mixed-execution-modes",timings:{warm:{endToEnd:{count:2,medianMs:null,p95Ms:null}}}});
    const compatibility=summarize(run([{status:"completed",result:result({mode:"compatibility",maxNewTokens:32})}],{mode:"compatibility"}));
    expect(compatibility.mode).toBe("compatibility");expect(compatibility).not.toHaveProperty("qualityScore");expect(compatibility).not.toHaveProperty("passed");
  });
  it("identifies only recorded desktop Chrome/Edge as candidates without treating a user agent as physical verification",()=>{
    const cases=[{status:"completed",result:result()}];
    for(const ua of [userAgent,userAgent+" Edg/142.0.0.0",userAgent.replace("Windows NT 10.0; Win64; x64","Macintosh; Intel Mac OS X 14_5"),userAgent.replace("Windows NT 10.0; Win64; x64","X11; Linux x86_64")])
      expect(summarize(run(cases,{browserContext:{userAgent:ua}}))).toMatchObject({classification:"desktop-candidate",physicalDeviceVerified:false});
    for(const ua of ["",userAgent+" Mobile",userAgent.replace("Windows NT 10.0; Win64; x64","iPhone; CPU iPhone OS 18_7"),userAgent.replace("Chrome/","HeadlessChrome/"),userAgent.replace("Chrome/142.0.0.0","Version/18.1"),userAgent+" OPR/100.0"])
      expect(summarize(run(cases,{browserContext:{userAgent:ua}})).classification).toBe("non-desktop-browser");
  });
});
