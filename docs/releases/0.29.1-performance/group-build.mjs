import {build} from '/workspace/GeoModel3D/node_modules/esbuild/lib/main.js';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root='/workspace/GeoModel3D',base='37dfeb6927466a442cb221f6693e4dd5647cbf9a';
const paths=['src/disagreementValidation.ts','src/calibration.ts'];
const hash=text=>createHash('sha256').update(text).digest('hex');
const metadata={baseCommit:base,nodeVersion:process.version,platform:process.platform,architecture:process.arch,
 recordedAt:new Date().toISOString(),runOrder:['before','after'],workloads:[100,200,400,800],groupRadius:100,
 interpretations:2,geometry:'40 columns at 1m spacing; floor(index/40) row, grid in x/y, identical copies of valid logged contacts',
 methodology:'One fresh Node process per implementation, ascending workload sizes within each process, no repeated timing trials. Same esbuild harness; before substitutes the two grouping sources from the base commit. Wall-clock timings on a shared host are diagnostic, not a controlled performance benchmark.',
 sourceHashes:{},harnessSha256:hash(readFileSync('/tmp/geomodel3d-v0291-group-benchmark.ts'))};
for(const mode of ['before','after']){
 const sources=new Map(paths.map(path=>[`${root}/${path}`,mode==='before'?readFileSync(`/tmp/geomodel3d-v0291-group-base-${path.split('/').at(-1)}`,'utf8'):readFileSync(`${root}/${path}`,'utf8')]));
 metadata.sourceHashes[mode]=Object.fromEntries(paths.map(path=>[path,hash(sources.get(`${root}/${path}`))]));
 await build({entryPoints:['/tmp/geomodel3d-v0291-group-benchmark.ts'],bundle:true,platform:'node',format:'esm',outfile:`/tmp/geomodel3d-v0291-group-${mode}.mjs`,logLevel:'warning',plugins:[{name:'frozen-sources',setup(b){b.onLoad({filter:/\/src\/(?:disagreementValidation|calibration)\.ts$/},args=>({contents:sources.get(args.path),loader:'ts'}))}}]});
}
writeFileSync('/tmp/geomodel3d-v0291-group-benchmark-metadata.json',JSON.stringify(metadata,null,2)+'\n');
