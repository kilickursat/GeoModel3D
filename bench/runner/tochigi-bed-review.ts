// Compare independent five-PDF and six-PDF exports before a human has assigned any beds.
// Run from the repository root. See bench/results/tochigi-119010496/README.md.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {basename} from "node:path";
import {parseCsv,toCsv} from "../../src/csv";
import {auditCollarAgreement} from "../../src/correlation";
import {importFiles,toProjectJson} from "../../src/io";
import {buildGeologicalModel,sampleModel} from "../../src/model";
import {loggedBedTops} from "../../src/observedContacts";
import type {GeoProject} from "../../src/schema";
import {crossValidate} from "../../src/validation";

const [trainingPath,allPath]=process.argv.slice(2);
if(!trainingPath||!allPath)throw new Error("Pass the five-PDF project JSON, then the six-PDF project JSON.");
const bench="bench/results/tochigi-119010496",heldFile="11901049603.pdf";
const pdfs=readFileSync(`${bench}/blind/SHA256SUMS.txt`,"utf8").trim().split(/\r?\n/).map(line=>{
  const [sha256,path]=line.split(/\s+/);return {sha256,name:basename(path)};
});
// Independent conversion of the published held-out collar only, using GDAL from EPSG:4326 to EPSG:6677.
const xy={x:6003.78896011239,y:45738.8511771082};
const readJson=(path:string)=>JSON.parse(readFileSync(path,"utf8"));
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const near=(a:number,b:number)=>Math.abs(a-b)<1e-7;
function load(path:string,training:boolean){
  const text=readFileSync(path,"utf8"),snapshot=JSON.parse(text);
  const project=importFiles([{name:"source.geomodel3d.json",text}]).project;
  const expected=pdfs.filter(p=>!training||p.name!==heldFile);
  const evidence=project.evidence;assert.ok(evidence);
  const namesById=new Map(evidence.sources.map(s=>[s.id,s.name]));
  const sourceByRecord=new Map(evidence.records.map(r=>[r.id,namesById.get(r.sourceId)]));
  assert.deepEqual(evidence.sources.map(s=>[s.name,s.sha256]).sort(),expected.map(s=>[s.name,s.sha256]).sort());
  const byFile=new Map(project.boreholes.map(b=>[sourceByRecord.get(b.evidenceId!),b]));
  assert.equal(project.boreholes.length,expected.length);
  assert.deepEqual([...byFile.keys()].sort(),expected.map(s=>s.name).sort());
  assert.equal(project.crsCode,"EPSG:6677");assert.equal(project.bedAssignments?.length??0,0);
  for(const [file,hole] of byFile){
    for(const interval of hole.intervals)assert.equal(sourceByRecord.get(interval.evidenceId!),file);
  }
  assert.deepEqual(evidence,snapshot.evidence);
  return {project,byFile,hash:sha(text)};
}
function atCollars(project:GeoProject){
  const before=toProjectJson(project),audit=auditCollarAgreement(buildGeologicalModel(project));
  assert.equal(toProjectJson(project),before);
  const again=importFiles([{name:"again.geomodel3d.json",text:before}]).project;
  assert.deepEqual(again.boreholes,project.boreholes);assert.deepEqual(again.evidence,project.evidence);
  return {intervals:audit.intervals.length,substituted:audit.intervals.filter(i=>i.mismatchedMetres>1e-6).length,
    logged_m:+audit.loggedMetres.toFixed(2),mismatched_m:+audit.mismatchedMetres.toFixed(2)};
}
const training=load(trainingPath,true),trainingAudit=atCollars(training.project);
const model=buildGeologicalModel(training.project,{probe:xy});
const predicted=sampleModel(model,xy.x,xy.y);assert.ok(predicted);
// Freeze model, bed order and prediction before reading any of the sixth hole's geology.
const all=load(allPath,false),held=all.byFile.get(heldFile);assert.ok(held);
for(const [file,hole] of training.byFile){
  const observation=(h:typeof hole)=>h.intervals.map(i=>[i.from,i.to,i.unit,i.name]);
  assert.deepEqual(observation(hole),observation(all.byFile.get(file)!));
}
const reference=readJson(`${bench}/reference.json`);
for(const row of reference.holes){
  const hole=all.byFile.get(row.pdf);assert.ok(hole);
  assert.equal(hole.id.normalize("NFKC"),row.sourceId.normalize("NFKC"));
  assert.equal(hole.z,row.ground_m);assert.deepEqual(hole.intervals.map(i=>i.to),row.intervalBases_m);
}
const historical=readJson(`${bench}/holdout.json`),marker=model.units.findIndex(u=>u.id==="Gravel");
assert.ok(near(predicted[0],historical.ground.predicted_m));assert.ok(marker>=0&&near(predicted[marker],historical.first_gravel.predicted_m));
// Evaluate the specified fold with its frozen training order. Copy only the held observations needed for scoring.
const foldProject={...training.project,boreholes:[...training.project.boreholes,{...held,...xy}]};
const fold=crossValidate(foldProject).boreholes.find(b=>b.id===held.id);assert.ok(fold&&!fold.outside);
assert.ok(near(fold.contacts.find(c=>c.k===0)!.predicted,predicted[0]));
const order=new Map(training.project.units.map((unit,i)=>[unit.id,i]));
assert.equal(loggedBedTops(held,order).tops.get("Gravel")?.ambiguous,true);
assert.ok(fold.omittedTops.some(top=>top.unit==="Gravel"&&top.reason==="reference"));
assert.ok(!fold.contacts.some(contact=>contact.k===marker));
// Direct interval intersection checks material overlap independently of the cross-validation scorer.
const groups=new Map(model.units.map(u=>[u.id,u.materialId??u.id]));
let matched=0;
for(const iv of held.intervals){
  for(const [k,unit] of model.units.entries()){
    if(groups.get(iv.unit)!==(unit.materialId??unit.id))continue;
    matched+=Math.max(0,Math.min(held.z-iv.from,predicted[k])-Math.max(held.z-iv.to,predicted[k+1]));
  }
}
assert.ok(near(matched,fold.materialRight));
const worksheet=readFileSync(`${bench}/blind/training-bed-assignments.csv`,"utf8");
const previous=toProjectJson(training.project);
const untouched=importFiles([{name:"training-bed-assignments.csv",text:worksheet}],training.project).project;
assert.equal(toProjectJson(untouched),previous);
// A deliberately wrong PDF hash must never attach an interpretation to this real interval.
const [header,bad]=parseCsv(worksheet,undefined,true);
const put=(field:string,value:string)=>{const i=header.indexOf(field);assert.ok(i>=0);bad[i]=value};
const bed=bad[header.indexOf("expected_bed")];
put("reviewed_bed",bed);put("bed_rank",String(training.project.units.findIndex(u=>u.id===bed)+1));
put("review_reason","Invalid-source test record");put("source_sha256","0".repeat(64));
assert.throws(()=>importFiles([{name:"bad-hash.csv",text:toCsv([header,bad])}],training.project),/source evidence does not match/i);
assert.equal(toProjectJson(training.project),previous);
console.log(JSON.stringify({trainingExport:training.hash,sixHoleExport:all.hash,
  fiveHoleAudit:trainingAudit,sixHoleAudit:atCollars(all.project),holdout:{insideHull:true,groundPredictionReproduced:true,
    provisionalGravelPredictionReproduced:true,ambiguousGravelContactOmitted:true,materialOverlapIndependentlyReproduced:true},
  sourceIntervalsAndEvidenceRoundTrip:true,blankWorksheetAppliedDecisions:0,wrongPdfHashRejected:true},null,2));
