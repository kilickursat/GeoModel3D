// Inline the worker so comparison also works in the standalone HTML without fetching another script.
import ComparisonWorker from "./comparison.worker?worker&inline";
import type {ComparisonOptions,ProjectComparison} from "./comparison";
import type {GeoProject} from "./schema";
import {createModelJob,ModelJob} from "./modelJob";

export type ComparisonJob=ModelJob<ProjectComparison>;
export function createComparisonJob(before:GeoProject,after:GeoProject,options:ComparisonOptions):ComparisonJob{
  return createModelJob(()=>new ComparisonWorker(),before,after,options,"comparison");
}
