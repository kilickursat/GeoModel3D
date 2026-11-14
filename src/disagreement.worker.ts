import {buildDisagreement,DisagreementCase} from "./disagreement";
import {validateDisagreement} from "./disagreementValidation";
import type {DisagreementJobOptions} from "./disagreementJob";
import type {GeoProject} from "./schema";

const port=globalThis as unknown as {
  onmessage:((event:MessageEvent<{projects:GeoProject[];options:{cases:Omit<DisagreementCase,"project">[];settings:DisagreementJobOptions}}>)=>void)|null;
  postMessage(value:unknown):void;
};
port.onmessage=event=>{
  try{
    const {projects,options}=event.data,cases=projects.map((project,i)=>({...options.cases[i],project}));
    const report=buildDisagreement(cases,options.settings);
    const validation=validateDisagreement(cases,{unitId:options.settings.unitId,maxHoldouts:options.settings.maxHoldouts});
    port.postMessage({type:"result",value:{report,validation}});
  }catch(error){port.postMessage({type:"error",message:error instanceof Error?error.message:String(error)})}
};
