import {describe,it,expect} from "vitest";
import {createModelJob,createProjectJob} from "../src/modelJob";
import type {GeoProject} from "../src/schema";

class TestWorker {
  onmessage:((event:MessageEvent)=>void)|null=null;
  onerror:((event:ErrorEvent)=>void)|null=null;
  onmessageerror:(()=>void)|null=null;
  terminated=false;
  message:any;
  postMessage(value:unknown){this.message=structuredClone(value)}
  terminate(){this.terminated=true}
  worker(){return this as unknown as Worker}
}
const project:GeoProject={name:"Private source",units:[{id:"sand",name:"Sand",color:"#aaa"}],
  boreholes:[{id:"BH1",x:0,y:0,z:10,evidenceId:"bh-source",intervals:[{from:0,to:10,unit:"sand",evidenceId:"log-source"}],
    water:[{depth:2,date:"2026-01-01",evidenceId:"water-source"}]}],
  groundwater:{mode:"as-of",date:"2026-01-02"},cpts:[{id:"CPT1",x:1,y:1,z:10,depth:[1],qc:[2],
    layersSource:"reviewed",layers:[{from:0,to:3,unit:"sand",evidenceId:"cpt-source"}]}]};

describe("numerical worker jobs",()=>{
  it("keeps source pages out of workers while preserving calculation inputs and original projects",async()=>{
    const before={...structuredClone(project),evidence:{largePage:"private source image"}} as unknown as GeoProject;
    const original=structuredClone(before),worker=new TestWorker();
    const job=createModelJob<number>(()=>worker.worker(),before,before,{step:5},"review");
    expect(worker.message.before.evidence).toBeUndefined();
    expect(worker.message.before.boreholes[0].evidenceId).toBeUndefined();
    expect(worker.message.before.boreholes[0].intervals[0].evidenceId).toBeUndefined();
    expect(worker.message.before.boreholes[0].water).toEqual([{depth:2,date:"2026-01-01"}]);
    expect(worker.message.before.groundwater).toEqual(before.groundwater);
    expect(worker.message.before.cpts[0].layersSource).toBe("reviewed");
    expect(worker.message.before.cpts[0].layers).toEqual([{from:0,to:3,unit:"sand"}]);
    expect(worker.message.options).toEqual({step:5});expect(before).toEqual(original);
    worker.onmessage!({data:{type:"result",value:42}} as MessageEvent);
    expect(await job.result).toBe(42);expect(worker.terminated).toBe(true);
    job.cancel();expect(await job.result).toBe(42);
  });

  it("cancels active work and ignores a late result",async()=>{
    const worker=new TestWorker(),job=createModelJob(()=>worker.worker(),project,project,undefined,"review");
    job.cancel();worker.onmessage!({data:{type:"result",value:"late"}} as MessageEvent);
    await expect(job.result).rejects.toMatchObject({name:"AbortError"});
    expect(worker.terminated).toBe(true);job.cancel();
  });

  it("runs single-project dashboards without duplicating source data and can cancel them",async()=>{
    const worker=new TestWorker(),options={alignment:{name:"Survey",points:[{x:0,y:0},{x:10,y:0}]},settings:{step:5}};
    const job=createProjectJob(()=>worker.worker(),project,options,"dashboard");
    expect(worker.message.project.groundwater).toEqual(project.groundwater);
    expect(worker.message.project.boreholes[0].intervals[0].evidenceId).toBeUndefined();
    expect(worker.message.before).toBeUndefined();expect(worker.message.after).toBeUndefined();
    expect(worker.message.options).toEqual(options);
    job.cancel();await expect(job.result).rejects.toMatchObject({name:"AbortError"});expect(worker.terminated).toBe(true);
  });

  it("terminates and reports scientific calculation and browser worker failures",async()=>{
    const worker=new TestWorker(),job=createModelJob(()=>worker.worker(),project,project,undefined,"review");
    worker.onmessage!({data:{type:"error",message:"Different coordinate systems"}} as MessageEvent);
    await expect(job.result).rejects.toThrow("Different coordinate systems");expect(worker.terminated).toBe(true);
    const broken=new TestWorker(),failure=createModelJob(()=>broken.worker(),project,project,undefined,"review");
    broken.onmessageerror!();
    await expect(failure.result).rejects.toThrow("review result could not be read");expect(broken.terminated).toBe(true);
    const denied=createModelJob(()=>{throw new Error("Worker unavailable")},project,project,undefined,"review");
    await expect(denied.result).rejects.toThrow("Worker unavailable");
  });
});
