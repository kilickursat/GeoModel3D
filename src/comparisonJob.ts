// Inline the worker so comparison also works in the standalone HTML without fetching another script.
import ComparisonWorker from "./comparison.worker?worker&inline";
import type {ComparisonOptions,ProjectComparison} from "./comparison";
import type {GeoProject} from "./schema";

// Source-page images and review text are not calculation inputs. Keep them out of worker messages while retaining
// groundwater observations, CPT layer provenance and all numerical inputs used by the kernel.
function calculationProject(project:GeoProject):GeoProject{
  const {evidence,...rest}=project;
  return {...rest,boreholes:project.boreholes.map(({evidenceId,...b})=>({...b,
    intervals:b.intervals.map(({evidenceId,...i})=>i),
    ...(b.water?{water:b.water.map(({evidenceId,...w})=>w)}:{})})),
    ...(project.cpts?{cpts:project.cpts.map(c=>({...c,...(c.layers?{layers:c.layers.map(({evidenceId,...i})=>i)}:{})}))}:{})};
}
export interface ComparisonJob { result:Promise<ProjectComparison>;cancel():void }
export function createComparisonJob(before:GeoProject,after:GeoProject,options:ComparisonOptions):ComparisonJob{
  let worker:Worker|undefined,settled=false,rejectJob:(reason:unknown)=>void=()=>{};
  const finish=()=>{settled=true;worker?.terminate()};
  const result=new Promise<ProjectComparison>((resolve,reject)=>{
    rejectJob=reject;
    try{
      worker=new ComparisonWorker();
      worker.onmessage=(event:MessageEvent)=>{
        if(settled)return;
        finish();
        if(event.data?.type==="result")resolve(event.data.value as ProjectComparison);
        else reject(new Error(event.data?.message??"The comparison worker returned an invalid result."));
      };
      worker.onerror=event=>{
        if(settled)return;
        event.preventDefault();finish();reject(new Error(event.message||"The comparison worker could not run in this browser."));
      };
      worker.onmessageerror=()=>{
        if(settled)return;
        finish();reject(new Error("The comparison result could not be read."));
      };
      worker.postMessage({before:calculationProject(before),after:calculationProject(after),options});
    }catch(error){finish();reject(error)}
  });
  return {result,cancel(){
    if(settled)return;
    finish();rejectJob(new DOMException("Comparison cancelled.","AbortError"));
  }};
}
