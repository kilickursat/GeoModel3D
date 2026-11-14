import ImpactWorker from "./impact.worker?worker&inline";
import type {GeoProject} from "./schema";
import type {DataImpactReview} from "./impact";
import {createModelJob,ModelJob} from "./modelJob";

export type ImpactJob=ModelJob<DataImpactReview>;
export function createImpactJob(before:GeoProject,after:GeoProject):ImpactJob{
  return createModelJob(()=>new ImpactWorker(),before,after,undefined,"impact review");
}
