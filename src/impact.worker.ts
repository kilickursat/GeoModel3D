import {reviewDataImpact} from "./impact";
import type {GeoProject} from "./schema";

const port=globalThis as unknown as {
  onmessage:((event:MessageEvent<{before:GeoProject;after:GeoProject}>)=>void)|null;
  postMessage(value:unknown):void;
};
port.onmessage=event=>{
  try{port.postMessage({type:"result",value:reviewDataImpact(event.data.before,event.data.after)})}
  catch(error){port.postMessage({type:"error",message:error instanceof Error?error.message:String(error)})}
};
