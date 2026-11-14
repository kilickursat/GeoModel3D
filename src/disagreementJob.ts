import DisagreementWorker from "./disagreement.worker?worker&inline";
import type {DisagreementCase,DisagreementOptions,DisagreementReport} from "./disagreement";
import type {DisagreementValidation} from "./disagreementValidation";
import {createProjectsJob,ModelJob} from "./modelJob";

export type DisagreementJobOptions=DisagreementOptions&{maxHoldouts?:number};
export interface DisagreementAnalysis { report:DisagreementReport;validation:DisagreementValidation }
export function createDisagreementJob(cases:DisagreementCase[],options:DisagreementJobOptions):ModelJob<DisagreementAnalysis>{
  return createProjectsJob(()=>new DisagreementWorker(),cases.map(c=>c.project),{
    cases:cases.map(({id,label})=>({id,label})),settings:options},"model disagreement");
}
