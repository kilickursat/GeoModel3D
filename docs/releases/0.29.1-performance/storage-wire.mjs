import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as before from '/tmp/geomodel3d-v0291-storage-before.mjs';
import * as after from '/tmp/geomodel3d-v0291-storage-after.mjs';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBLkAAAAASUVORK5CYII=';
const p={name:'Wire preservation',units:[{id:'rock',name:'Rock',color:'#778899'}],boreholes:[{id:'BH',x:0,y:0,z:10,intervals:[{from:0,to:10,unit:'rock'}]}],
 cpts:[{id:'CPT',x:1,y:1,z:10,depth:[1,2,3],qc:[1,NaN,3]}],terrain:{x0:0,y0:0,dx:1,dy:1,ncols:2,nrows:2,z:[0,1,NaN,3]},alignments:[{name:'Line',points:[{x:0,y:0},{x:10,y:10}]}],
 evidence:{version:1,sources:[{id:'source',name:'source.png',pages:[{page:1,width:1,height:1,image:png}]}],records:[]},corePhotos:{version:1,runs:[]}};
let doc=before.checkpoint(before.createWorkspace(before.tablesFromProject(p),p),p,'First');
doc=before.createScenario(doc,'Alternative');p.name='Alternative';doc=before.checkpoint(doc,p,'Second');
const one=before.toWorkspaceJson(doc),two=after.toWorkspaceJson(doc);
if(one!==two)throw new Error('Serialization changed wire bytes for identical input');
const restored=after.parseWorkspace(JSON.parse(two));
if(restored.revisions.length!==2||restored.scenarios.length!==2||!Number.isNaN(restored.revisions[0].project.cpts[0].qc[1]))throw new Error('Roundtrip failed');
const hashes={wireBytesIdentical:true,bytes:Buffer.byteLength(one),sha256:createHash('sha256').update(one).digest('hex'),roundtrip:'all six pooled slots, images, NaN readings, multiple revisions and inactive scenario draft'};
const sample=JSON.parse(await readFile('/workspace/GeoModel3D/src/data/rotterdam-site.json','utf8'));
for(const [label,mod] of [['before',before],['after',after]]){
 let d=mod.createWorkspace(mod.tablesFromProject(sample),sample);
 for(let i=0;i<30;i++){const changed=structuredClone(sample);changed.boreholes[i%changed.boreholes.length].z+=i*.01;d=mod.checkpoint(d,changed,'Build')}
 const json=mod.toWorkspaceJson(d),times=[];
 for(let i=0;i<10;i++){const t=performance.now();mod.toWorkspaceJson(d);times.push(performance.now()-t)}
 times.sort((a,b)=>a-b);hashes[label]={historyRevisions:d.revisions.length,savedBytes:Buffer.byteLength(json),warmSamples:times.length,medianMs:(times[4]+times[5])/2,maxMs:times.at(-1)};
}
await writeFile('/tmp/geomodel3d-v0291-storage-wire.json',JSON.stringify(hashes,null,2)+'\n');console.log(JSON.stringify(hashes,null,2));
