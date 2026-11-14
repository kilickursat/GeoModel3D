import InvestigationWorker from "./investigation.worker?worker&inline";
import type {Alignment,GeoProject} from "./schema";
import type {InvestigationOptions,InvestigationPlan} from "./investigation";
import {createProjectJob,ModelJob} from "./modelJob";

export type InvestigationJob=ModelJob<InvestigationPlan>;
export function createInvestigationJob(project:GeoProject,alignment:Alignment,options:InvestigationOptions={}):InvestigationJob{
  return createProjectJob(()=>new InvestigationWorker(),project,{alignment,settings:options},"investigation planner");
}
