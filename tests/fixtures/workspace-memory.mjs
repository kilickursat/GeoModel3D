// Isolated Node process with explicit GC: replacing documents must release serialization caches as well as data.
// The bundle passed on the command line contains the actual workspace module and tablesFromProject, unchanged.
import {pathToFileURL} from "node:url";
const {createWorkspace,checkpoint,toWorkspaceJson,parseWorkspace,tablesFromProject}=await import(pathToFileURL(process.argv[2]).href);
if(!global.gc)throw new Error("Run this fixture with --expose-gc.");
const collect=async()=>{await new Promise(resolve=>setImmediate(resolve));global.gc();await new Promise(resolve=>setImmediate(resolve));global.gc()};
function workspace(seed){
  const project={name:`Replacement ${seed}`,units:[{id:"rock",name:"Rock",color:"#778899"}],
    boreholes:[{id:`BH-${seed}`,x:0,y:0,z:10,intervals:[{from:0,to:10,unit:"rock"}]}],
    terrain:{x0:0,y0:0,dx:1,dy:1,ncols:200,nrows:200,z:Array.from({length:40000},(_,i)=>Math.sin(i+seed/10))}};
  let doc=checkpoint(createWorkspace(tablesFromProject(project),project),project,"Imported project");
  project.boreholes[0].z+=1;doc=checkpoint(doc,project,"Changed collar");
  return doc;
}
function replace(seed){toWorkspaceJson(workspace(seed))}
// Warm up the serializer, and keep one independent workspace live across all of the replacements.
const keep=workspace(-1),expected=toWorkspaceJson(keep);
for(let i=-4;i<-1;i++)replace(i);
await collect();
const before=process.memoryUsage().heapUsed;
for(let i=0;i<24;i++){replace(i);if(i%6===5)await collect()}
await collect();
const after=process.memoryUsage().heapUsed;
if(toWorkspaceJson(keep)!==expected)throw new Error("The live workspace's serialized content changed after replacements.");
const restored=parseWorkspace(JSON.parse(expected));
if(restored.revisions.length!==2||restored.revisions[1].project.boreholes[0].z!==11)throw new Error("The live workspace no longer round-trips.");
const timings=[];
for(let i=0;i<10;i++){const started=performance.now();toWorkspaceJson(keep);timings.push(performance.now()-started)}
timings.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,workload:{replacementWorkspaces:24,revisionsPerWorkspace:2,terrainCellsPerWorkspace:40000,retainedWorkspaces:1},
  measurement:"Node process.memoryUsage().heapUsed after explicit GC; excludes native and GPU allocations",heapBeforeBytes:before,heapAfterBytes:after,retainedHeapDeltaBytes:after-before,
  liveWorkspaceUnchanged:true,warmSerialization:{samples:timings.length,medianMs:(timings[4]+timings[5])/2,maxMs:timings.at(-1)}}));
