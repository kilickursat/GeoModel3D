import ModelWorker from "./model.worker?worker&inline";
import type {GeoProject} from "./schema";
import type {DataImpactReview} from "./impact";
import {createModelJob,ModelJob} from "./modelJob";

export type ImpactJob=ModelJob<DataImpactReview>;
export function createImpactJob(before:GeoProject,after:GeoProject):ImpactJob{
  return createModelJob(()=>new ModelWorker(),before,after,undefined,"impact review","impact");
}
