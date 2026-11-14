import {planInvestigation,InvestigationOptions} from "./investigation";
import type {Alignment,GeoProject} from "./schema";

const port=globalThis as unknown as {
  onmessage:((event:MessageEvent<{project:GeoProject;options:{alignment:Alignment;settings:InvestigationOptions}}>)=>void)|null;
  postMessage(value:unknown):void;
};
port.onmessage=event=>{
  try{const {project,options}=event.data;port.postMessage({type:"result",value:planInvestigation(project,options.alignment,options.settings)})}
  catch(error){port.postMessage({type:"error",message:error instanceof Error?error.message:String(error)})}
};
