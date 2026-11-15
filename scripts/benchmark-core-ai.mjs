// Reproducible local CPU quality pilot. This does not measure browser or phone performance.
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {existsSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {createHash} from "node:crypto";
import {BENCHMARK_MODELS,loadBenchmarkModel,generateBenchmark,disposeBenchmarkModel} from "./core-ai-benchmark-runtime.mjs";

const root=resolve(import.meta.dirname,".."),folder=resolve(root,"docs/benchmarks/0.25.0-core-ai");
const arg=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1]};
const out=resolve(root,arg("--out")??".cache/v025-core-benchmark/run");
if(existsSync(out))throw new Error("Benchmark output path already exists. Preserve that run and use --out with a fresh directory.");
const requested=arg("--models")?.split(",")??BENCHMARK_MODELS.map(m=>m.id);
if(requested.some(id=>!BENCHMARK_MODELS.some(m=>m.id===id)))throw new Error("Unknown model identifier.");
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
const datasetBytes=await readFile(resolve(folder,"dataset-manifest.json")),inputsBytes=await readFile(resolve(folder,"inputs.json"));
const dataset=JSON.parse(datasetBytes.toString("utf8")),inputs=JSON.parse(inputsBytes.toString("utf8"));
const protocol=JSON.parse(await readFile(resolve(folder,"protocol.json"),"utf8"));
const references=await readFile(resolve(folder,"reference-review.json"));
const rubric=await readFile(resolve(folder,"rubric.md"));
if(!Array.isArray(inputs.inputs)||inputs.inputs.length!==8||!Array.isArray(dataset.samples)||dataset.samples.length!==8)
  throw new Error("The frozen pilot must contain eight source and input cases.");
if(protocol.generation.doSample!==false||protocol.generation.repetitionPenalty!==1.1||protocol.generation.maxNewTokens!==128)throw new Error("Generation settings differ from the frozen runtime protocol.");
const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
for(let i=0;i<inputs.inputs.length;i++){
  const sample=inputs.inputs[i],source=dataset.samples[i],id=`sample-${String(i+1).padStart(2,"0")}`;
  if(sample.id!==id||source.id!==id||sample.path!==`images/${id}.png`||source.path!==`images/${id}.jpeg`)
    throw new Error(`Frozen cases must appear exactly once in sample-01 through sample-08 order: ${id}`);
  if(!/^[a-f0-9]{64}$/.test(source.sha256)||sample.sourceSha256!==source.sha256)
    throw new Error(`Input/source SHA-256 linkage mismatch: ${id}`);
  const plan=sample.plan,pixels=plan?.pixels;
  if(![source.width,source.height].every(n=>Number.isSafeInteger(n)&&n>0)
    ||plan?.sourceWidth!==source.width||plan?.sourceHeight!==source.height||plan?.width!==512||plan?.height!==512
    ||pixels?.x!==0||pixels?.y!==0||pixels?.width!==source.width||pixels?.height!==source.height)
    throw new Error(`Frozen source/crop dimensions mismatch: ${id}`);
  const bytes=await readFile(resolve(folder,sample.path));
  if(bytes.length<33||bytes.length!==sample.bytes||bytes.length>2_100_000||digest(bytes)!==sample.sha256)
    throw new Error(`Input integrity mismatch: ${id}`);
  if(!bytes.subarray(0,8).equals(pngSignature)||bytes.readUInt32BE(8)!==13||bytes.toString("ascii",12,16)!=="IHDR"
    ||bytes.readUInt32BE(16)!==512||bytes.readUInt32BE(20)!==512)
    throw new Error(`Input must be the frozen 512-square PNG: ${id}`);
}
const report={format:"geomodel3d-core-image-pilot",version:1,startedAt:new Date().toISOString(),status:"running",
  appVersion:JSON.parse(await readFile(resolve(root,"package.json"),"utf8")).version,
  scope:"Local CPU quality screening with published real-core patches; assistant visual evaluation is separate from geologist-derived source labels. No geotechnical or native-device validation claim.",
  protocol,protocolSha256:digest(await readFile(resolve(folder,"protocol.json"))),referenceSha256:digest(references),rubricSha256:digest(rubric),
  datasetManifestSha256:digest(datasetBytes),inputsManifestSha256:digest(inputsBytes),
  runnerSourceSha256:digest(await readFile(resolve(root,"scripts/benchmark-core-ai.mjs"))),
  runtimeSourceSha256:digest(await readFile(resolve(root,"scripts/core-ai-benchmark-runtime.mjs"))),
  inputs:inputs.inputs.map(({id,sha256,sourceSha256,plan})=>({id,sha256,sourceSha256,width:plan.width,height:plan.height})),models:BENCHMARK_MODELS.filter(m=>requested.includes(m.id)),results:[]};
await mkdir(dirname(out),{recursive:true});
try{await mkdir(out)}catch(error){if(error.code==="EEXIST")throw new Error("Benchmark output path already exists. Use --out with a fresh directory.");throw error}
const save=()=>writeFile(resolve(out,"results.json"),JSON.stringify(report,null,2)+"\n");
await save();
try{
  for(const model of report.models){
    let handle;
    try{handle=await loadBenchmarkModel(model,{onProgress:event=>{if(event.status==="ready")console.log(JSON.stringify({model:model.id,phase:"ready"}))}})}
    catch(error){for(const sample of inputs.inputs)report.results.push({caseId:sample.id,modelId:model.id,status:"load-error",error:String(error)});await save();continue}
    for(const sample of inputs.inputs){
      const started=Date.now();console.log(JSON.stringify({model:model.id,caseId:sample.id,phase:"running"}));
      try{
        const result=await generateBenchmark(handle,resolve(folder,sample.path),protocol.prompt,{maxNewTokens:protocol.generation.maxNewTokens});
        if(result.imageSha256!==sample.sha256)throw new Error("The input file changed after validation; this output is excluded.");
        report.results.push({caseId:sample.id,modelId:model.id,status:result.text?"completed":"empty-output",wallMs:Date.now()-started,result,
          outputLimitReached:result.generatedTokens>=result.maxNewTokens});
      }catch(error){report.results.push({caseId:sample.id,modelId:model.id,status:"generation-error",wallMs:Date.now()-started,error:String(error)})}
      await save();
    }
    await disposeBenchmarkModel();
  }
  report.status=report.results.every(r=>r.status==="completed")?"completed":"completed-with-failures";
  report.completedAt=new Date().toISOString();await save();
  // Opaque labels conceal identities during the separate visual review; this is not an independent expert panel.
  const mapping=Object.fromEntries(inputs.inputs.map(input=>{
    const assignments=[...report.models].sort((a,b)=>digest(`20261115\0${input.id}\0${a.id}`).localeCompare(digest(`20261115\0${input.id}\0${b.id}`)));
    return [input.id,Object.fromEntries(assignments.map((m,i)=>[m.id,`Model ${String.fromCharCode(65+i)}`]))];
  }));
  await writeFile(resolve(out,"blinded-outputs.json"),JSON.stringify({scope:"Model identifiers masked for assistant visual review. Source references were frozen before inference.",
    cases:inputs.inputs.map(input=>({caseId:input.id,imagePath:resolve(folder,input.path),outputs:report.results.filter(r=>r.caseId===input.id).map(r=>({model:mapping[input.id][r.modelId],status:r.status,text:r.result?.text??"",outputLimitReached:r.outputLimitReached??false})).sort((a,b)=>a.model.localeCompare(b.model))}))},null,2)+"\n");
  await writeFile(resolve(out,"model-mapping.json"),JSON.stringify(mapping,null,2)+"\n");
  console.log(JSON.stringify({status:report.status,runs:report.results.length,out}));
}finally{await disposeBenchmarkModel()}
