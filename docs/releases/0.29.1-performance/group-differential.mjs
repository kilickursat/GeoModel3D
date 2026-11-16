import {locationGroups as oldGroups} from './group-review-output/group-review-before.mjs';
import {locationGroups as newGroups} from './group-review-output/group-review-after.mjs';
let seed=8675309;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32};
const normalized=g=>JSON.stringify(Object.fromEntries(['keys','boreholeIds','cptIds'].map(k=>[k,[...g[k]].sort()])));
let comparisons=0;
for(let trial=0;trial<1000;trial++){
 const radius=[0,0.000001,0.001,1,5,1000][trial%6];
 const cases=Array.from({length:2+Math.floor(random()*3)},(_,c)=>({id:String(c),project:{boreholes:[],cpts:[]}}));
 const pool=Array.from({length:20},()=>({x:(Math.floor(random()*40)-20)+(random()<.3?.0004:0),y:(Math.floor(random()*40)-20)+(random()<.3?.0004:0)}));
 for(const c of cases)for(let i=0;i<40;i++){
   const p=pool[Math.floor(random()*pool.length)],kind=random()<.5?'boreholes':'cpts';
   c.project[kind].push({id:'id-'+Math.floor(random()*25),x:p.x,y:p.y});
 }
 const old=oldGroups(cases,radius),now=newGroups(cases,radius);
 for(const p of [...pool,{x:99999,y:99999},{x:NaN,y:Infinity}]){
   comparisons++;
   if(normalized(old(p))!==normalized(now(p)))throw new Error(JSON.stringify({trial,radius,p,old:normalized(old(p)),new:normalized(now(p))}));
 }
}
console.log(JSON.stringify({status:'passed',trials:1000,comparisons,seed:8675309,radii:[0,.000001,.001,1,5,1000]}));
