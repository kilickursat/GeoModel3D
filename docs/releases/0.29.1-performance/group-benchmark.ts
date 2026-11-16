import {calibrateDisagreement} from '/workspace/GeoModel3D/src/calibration';
import type {GeoProject} from '/workspace/GeoModel3D/src/schema';
for(const n of [100,200,400,800]){
 const p:GeoProject={name:'group performance',crs:'Local grid',base:-10,units:[{id:'fill',name:'Fill',color:'#888'},{id:'sand',name:'Sand',color:'#db8'}],boreholes:Array.from({length:n},(_,i)=>({id:`BH-${i}`,x:i%40,y:Math.floor(i/40),z:10,intervals:[{from:0,to:2,unit:'fill'},{from:2,to:12,unit:'sand'}]}))};
 const cases=[{id:'a',label:'A',project:p},{id:'b',label:'B',project:structuredClone(p)}];
 const start=performance.now();
 const r=calibrateDisagreement(cases,{unitId:'sand',mode:'section',azimuth:0,offset:0,gridSize:2,step:10,groupRadius:100});
 console.log(JSON.stringify({n,elapsedMs:Math.round(performance.now()-start),groups:r.partition.groups.length,training:r.partition.trainingCount}));
}
