import {build} from '/workspace/GeoModel3D/node_modules/esbuild/lib/main.js';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root='/workspace/GeoModel3D',base='37dfeb6927466a442cb221f6693e4dd5647cbf9a';
const before=execFileSync('git',['show',base+':src/workspace.ts'],{cwd:root,encoding:'utf8'}),after=await readFile(root+'/src/workspace.ts','utf8');
const fixture=root+'/tests/fixtures/workspace-memory.mjs';
const result={baseCommit:base,recordedAt:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,notes:'Actual unchanged workspace source bundled with esbuild, plus re-export of its existing tablesFromProject import. Independent Node processes, explicit GC. Timings are local software measurements, not a device benchmark.',fixtureSha256:createHash('sha256').update(await readFile(fixture)).digest('hex'),variants:{}};
for(const [label,source] of [['before',before],['after',after]]){
 const out='/tmp/geomodel3d-v0291-storage-'+label+'.mjs';
 await build({stdin:{contents:source+'\nexport {tablesFromProject};',resolveDir:root+'/src',loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:out,logLevel:'silent'});
 result.variants[label]={sourceSha256:createHash('sha256').update(source).digest('hex'),runs:[]};
 for(let i=0;i<3;i++)result.variants[label].runs.push(JSON.parse(execFileSync(process.execPath,['--expose-gc',fixture,out],{cwd:root,encoding:'utf8',timeout:45000})));
}
await writeFile('/tmp/geomodel3d-v0291-storage-memory.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
