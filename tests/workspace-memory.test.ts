/// <reference types="node" />
import {it,expect} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {buildSync} from "esbuild";

it("releases serialized terrain from replaced workspaces while another workspace stays live",()=>{
  const dir=mkdtempSync(join(tmpdir(),"geomodel-workspace-memory-")),bundle=join(dir,"workspace.mjs");
  try{
    buildSync({stdin:{contents:'export * from "./src/workspace"; export {tablesFromProject} from "./src/tables";',resolveDir:resolve("."),loader:"ts"},
      bundle:true,platform:"node",format:"esm",outfile:bundle,logLevel:"silent"});
    const run=spawnSync(process.execPath,["--expose-gc",resolve("tests/fixtures/workspace-memory.mjs"),bundle],{encoding:"utf8",timeout:45000});
    if(run.error)throw run.error;
    expect(run.status,run.stderr).toBe(0);
    const result=JSON.parse(run.stdout);
    expect(result.liveWorkspaceUnchanged).toBe(true);
    // The 0.29.0 global cache retained about 19 MiB for this workload. Allow ample GC/runtime variation while
    // detecting the unbounded lifetime; exact heap bytes and collection timing are not product guarantees.
    expect(result.retainedHeapDeltaBytes).toBeLessThan(8*1024*1024);
  }finally{rmSync(dir,{recursive:true,force:true})}
},60000);
