import CorridorWorker from "./corridor.worker?worker&inline";
import type {Alignment,GeoProject} from "./schema";
import type {CorridorOptions,CorridorReport} from "./corridor";
import {createProjectJob,ModelJob} from "./modelJob";

export type CorridorJob=ModelJob<CorridorReport>;
export function createCorridorJob(project:GeoProject,alignment:Alignment,options:CorridorOptions={}):CorridorJob{
  return createProjectJob(()=>new CorridorWorker(),project,{alignment,settings:options},"corridor dashboard");
}
