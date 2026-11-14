// The comparison kernel has no DOM dependencies. One worker handles one pinned pair of revisions and is then closed.
import {compareProjects,ComparisonOptions} from "./comparison";
import type {GeoProject} from "./schema";

const port=globalThis as unknown as {
  onmessage:((event:MessageEvent<{before:GeoProject;after:GeoProject;options:ComparisonOptions}>)=>void)|null;
  postMessage(value:unknown):void;
};
port.onmessage=event=>{
  try{port.postMessage({type:"result",value:compareProjects(event.data.before,event.data.after,event.data.options)})}
  catch(error){port.postMessage({type:"error",message:error instanceof Error?error.message:String(error)})}
};
