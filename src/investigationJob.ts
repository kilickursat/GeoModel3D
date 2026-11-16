import ModelWorker from "./model.worker?worker&inline";
import type {Alignment,GeoProject} from "./schema";
import type {InvestigationOptions,InvestigationPlan} from "./investigation";
import {calculationProject,createProjectJob,ModelJob} from "./modelJob";

export type InvestigationJob=ModelJob<InvestigationPlan>;
export function createInvestigationJob(project:GeoProject,alignment:Alignment,options:InvestigationOptions={}):InvestigationJob{
  const context=options.disagreementContext;
  const settings=context?{...options,disagreementContext:{...context,cases:context.cases.map(c=>({...c,project:calculationProject(c.project)}))}}:options;
  return createProjectJob(()=>new ModelWorker(),project,{alignment,settings},"investigation planner","investigation");
}
