import {describe,it,expect,beforeAll} from "vitest";
import {createModelJob,createProjectJob} from "../src/modelJob";
import {reviewDataImpact} from "../src/impact";
import {analyzeCorridor} from "../src/corridor";
import type {GeoProject} from "../src/schema";

// The shared worker script registers its handler on the worker global; here the test global stands in for it.
const port=globalThis as unknown as {onmessage:((event:{data:unknown})=>void)|null;postMessage:(value:unknown)=>void};
let posted:any[]=[];
beforeAll(async()=>{
  port.postMessage=(value:unknown)=>{posted.push(value)};
  await import("../src/model.worker");
});
const run=(data:unknown)=>{posted=[];port.onmessage!({data});return posted[0]};

const site:GeoProject={name:"Worker site",units:[{id:"clay",name:"Clay",color:"#887766"},{id:"rock",name:"Rock",color:"#446688"}],
  boreholes:[[0,0],[40,0],[0,40],[40,40]].map(([x,y],i)=>({id:`BH${i}`,x,y,z:10,intervals:[{from:0,to:3+i,unit:"clay"},{from:3+i,to:12,unit:"rock"}]})),
  alignments:[{name:"Line",points:[{x:5,y:20},{x:35,y:20}],design:[{chainage:0,top:6,bottom:4},{chainage:30,top:6,bottom:4}]}]};

describe("shared model worker",()=>{
  it("dispatches each job kind to its calculation",()=>{
    const after=structuredClone(site);after.boreholes.push({id:"BH-new",x:20,y:20,z:10,intervals:[{from:0,to:4,unit:"clay"},{from:4,to:12,unit:"rock"}]});
    const impact=run({kind:"impact",before:site,after});
    expect(impact.type).toBe("result");
    expect(impact.value).toEqual(reviewDataImpact(site,after));
    const corridor=run({kind:"corridor",project:site,options:{alignment:site.alignments![0],settings:{step:10}}});
    expect(corridor.type).toBe("result");
    expect(corridor.value).toEqual(analyzeCorridor(site,site.alignments![0],{step:10}));
  });

  it("reports an unknown or missing kind instead of guessing a calculation",()=>{
    expect(run({kind:"__proto__",project:site})).toEqual({type:"error",message:"Unknown model calculation."});
    expect(run({project:site})).toEqual({type:"error",message:"Unknown model calculation."});
    expect(run({kind:"corridor",project:site,options:{alignment:{name:"Bad",points:[]},settings:{}}}).type).toBe("error");
  });

  it("tags job messages with their kind for the shared worker",async()=>{
    let message:any;
    const fake={postMessage(value:unknown){message=value},terminate(){}} as unknown as Worker;
    const impact=createModelJob(()=>fake,site,site,undefined,"impact review","impact");
    expect(message.kind).toBe("impact");
    impact.cancel();await expect(impact.result).rejects.toThrow(/cancelled/);
    const corridor=createProjectJob(()=>fake,site,{alignment:site.alignments![0],settings:{}},"corridor dashboard","corridor");
    expect(message.kind).toBe("corridor");expect(message.project.name).toBe("Worker site");
    corridor.cancel();await expect(corridor.result).rejects.toThrow(/cancelled/);
  });
});
