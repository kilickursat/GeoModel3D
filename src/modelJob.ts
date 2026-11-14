import type {GeoProject} from "./schema";

// Source images and review text are not calculation inputs. Avoid cloning them into numerical workers.
function calculationProject(project:GeoProject):GeoProject{
  const {evidence,...rest}=project;
  return {...rest,boreholes:project.boreholes.map(({evidenceId,...b})=>({...b,
    intervals:b.intervals.map(({evidenceId,...i})=>i),
    ...(b.water?{water:b.water.map(({evidenceId,...w})=>w)}:{})})),
    ...(project.cpts?{cpts:project.cpts.map(c=>({...c,...(c.layers?{layers:c.layers.map(({evidenceId,...i})=>i)}:{})}))}:{})};
}
export interface ModelJob<T> { result:Promise<T>;cancel():void }

// One pinned pair per worker. Both views share termination, cancellation and structured-clone error handling.
export function createModelJob<T>(makeWorker:()=>Worker,before:GeoProject,after:GeoProject,options:unknown,label:string):ModelJob<T>{
  let worker:Worker|undefined,settled=false,rejectJob:(reason:unknown)=>void=()=>{};
  const finish=()=>{settled=true;worker?.terminate()};
  const result=new Promise<T>((resolve,reject)=>{
    rejectJob=reject;
    try{
      worker=makeWorker();
      worker.onmessage=(event:MessageEvent)=>{
        if(settled)return;
        finish();
        if(event.data?.type==="result")resolve(event.data.value as T);
        else reject(new Error(event.data?.message??`The ${label} worker returned an invalid result.`));
      };
      worker.onerror=event=>{
        if(settled)return;
        event.preventDefault();finish();reject(new Error(event.message||`The ${label} worker could not run in this browser.`));
      };
      worker.onmessageerror=()=>{
        if(settled)return;
        finish();reject(new Error(`The ${label} result could not be read.`));
      };
      worker.postMessage({before:calculationProject(before),after:calculationProject(after),options});
    }catch(error){finish();reject(error)}
  });
  return {result,cancel(){
    if(settled)return;
    finish();rejectJob(new DOMException(`${label} cancelled.`,"AbortError"));
  }};
}
