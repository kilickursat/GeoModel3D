import {analyzeCorridor,CorridorOptions} from "./corridor";
import type {Alignment,GeoProject} from "./schema";

const port=globalThis as unknown as {
  onmessage:((event:MessageEvent<{project:GeoProject;options:{alignment:Alignment;settings:CorridorOptions}}>)=>void)|null;
  postMessage(value:unknown):void;
};
port.onmessage=event=>{
  try{const {project,options}=event.data;port.postMessage({type:"result",value:analyzeCorridor(project,options.alignment,options.settings)})}
  catch(error){port.postMessage({type:"error",message:error instanceof Error?error.message:String(error)})}
};
