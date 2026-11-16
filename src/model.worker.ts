// One inline worker for every numerical job (comparison, impact review, corridor, investigation planning, model
// disagreement), so the hosted app and the standalone HTML carry the model kernel once. Each job starts its own
// worker from this script, posts one message naming its kind, and closes the worker after the result.
import {compareProjects,ComparisonOptions} from "./comparison";
import {reviewDataImpact} from "./impact";
import {analyzeCorridor,CorridorOptions} from "./corridor";
import {planInvestigation,InvestigationOptions} from "./investigation";
import {buildDisagreement,DisagreementCase} from "./disagreement";
import {validateDisagreement} from "./disagreementValidation";
import {calibrateDisagreement} from "./calibration";
import type {DisagreementJobOptions} from "./disagreementJob";
import type {Alignment,GeoProject} from "./schema";
import type {ModelJobKind} from "./modelJob";

type Pair={before:GeoProject;after:GeoProject};
type Line={project:GeoProject;options:{alignment:Alignment}};
const jobs:Record<ModelJobKind,(data:any)=>unknown>={
  comparison:(data:Pair&{options:ComparisonOptions})=>compareProjects(data.before,data.after,data.options),
  impact:(data:Pair)=>reviewDataImpact(data.before,data.after),
  corridor:(data:Line&{options:{settings:CorridorOptions}})=>analyzeCorridor(data.project,data.options.alignment,data.options.settings),
  investigation:(data:Line&{options:{settings:InvestigationOptions}})=>planInvestigation(data.project,data.options.alignment,data.options.settings),
  disagreement:(data:{projects:GeoProject[];options:{cases:Omit<DisagreementCase,"project">[];settings:DisagreementJobOptions}})=>{
    const {projects,options}=data,cases=projects.map((project,i)=>({...options.cases[i],project}));
    const report=buildDisagreement(cases,options.settings);
    const validation=validateDisagreement(cases,{unitId:options.settings.unitId,maxHoldouts:options.settings.maxHoldouts});
    const {calibration:calibrationSettings,maxHoldouts:_,...pathSettings}=options.settings;
    const calibration=calibrationSettings?calibrateDisagreement(cases,{...pathSettings,...calibrationSettings}):undefined;
    return {report,validation,...(calibration?{calibration}:{})};
  }
};

const port=globalThis as unknown as {onmessage:((event:MessageEvent)=>void)|null;postMessage(value:unknown):void};
port.onmessage=event=>{
  try{
    const kind=event.data?.kind as ModelJobKind,job=Object.hasOwn(jobs,kind)?jobs[kind]:undefined;
    if(!job)throw new Error("Unknown model calculation.");
    port.postMessage({type:"result",value:job(event.data)});
  }catch(error){port.postMessage({type:"error",message:error instanceof Error?error.message:String(error)})}
};
