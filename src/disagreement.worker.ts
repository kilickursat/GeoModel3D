import {buildDisagreement,DisagreementCase} from "./disagreement";
import {validateDisagreement} from "./disagreementValidation";
import {calibrateDisagreement} from "./calibration";
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
    const {calibration:calibrationSettings,maxHoldouts:_,...pathSettings}=options.settings;
    const calibration=calibrationSettings?calibrateDisagreement(cases,{...pathSettings,...calibrationSettings}):undefined;
    port.postMessage({type:"result",value:{report,validation,...(calibration?{calibration}:{})}});
  }catch(error){port.postMessage({type:"error",message:error instanceof Error?error.message:String(error)})}
};
