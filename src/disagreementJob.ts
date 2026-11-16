import ModelWorker from "./model.worker?worker&inline";
import type {DisagreementCase,DisagreementOptions,DisagreementReport} from "./disagreement";
import type {DisagreementValidation} from "./disagreementValidation";
import type {CalibrationOptions,ContactCalibration} from "./calibration";
import {createProjectsJob,ModelJob} from "./modelJob";

export type DisagreementJobOptions=DisagreementOptions&{maxHoldouts?:number;groupRadius?:number;calibration?:Pick<CalibrationOptions,"coverage"|"seed"|"trainingFraction"|"calibrationFraction">};
export interface DisagreementAnalysis { report:DisagreementReport;validation:DisagreementValidation;calibration?:ContactCalibration }
export function createDisagreementJob(cases:DisagreementCase[],options:DisagreementJobOptions):ModelJob<DisagreementAnalysis>{
  return createProjectsJob(()=>new ModelWorker(),cases.map(c=>c.project),{
    cases:cases.map(({id,label})=>({id,label})),settings:options},"model disagreement","disagreement");
}
