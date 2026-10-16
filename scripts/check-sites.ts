// Cross-validates the real sites as bundled (without the terrain the app downloads) and prints, for each, the share of
// logged metres predicted in the unit logged (of the boreholes and of the CPT logs apart, where a site has both), the
// errors of every surface and the logs furthest from their prediction.
//   npx esbuild scripts/check-sites.ts --bundle --platform=node --format=esm --outfile=.cache/check-sites.mjs && node .cache/check-sites.mjs [site]
import {realSites} from "../src/geology";
import {crossValidate} from "../src/validation";

const only=process.argv[2]?.toLowerCase();
const f=(v:number,d=1)=>Number.isFinite(v)?v.toFixed(d):"–";
for(const p of realSites){
  if(only&&!p.name.toLowerCase().includes(only))continue;
  const t0=Date.now();
  const v=crossValidate(p);
  const s=(Date.now()-t0)/1000,inside=v.boreholes.filter(b=>!b.outside),cpts=v.boreholes.filter(b=>b.cpt).length;
  const share=(l:typeof inside)=>{const a=l.reduce((t,b)=>t+b.logged,0);return a?l.reduce((t,b)=>t+b.right,0)/a:NaN};
  console.log(`\n${p.name}: ${v.boreholes.length-cpts} boreholes${cpts?` and ${cpts} CPT logs`:""} (${inside.length} inside the others), ${s.toFixed(0)} s`);
  console.log(`  logged metres in the unit logged: ${f(100*v.share.inside)} % inside, ${f(100*v.share.outside)} % outside`);
  if(cpts)console.log(`  inside the others: boreholes ${f(100*share(inside.filter(b=>!b.cpt)))} %, CPT logs ${f(100*share(inside.filter(b=>b.cpt)))} %`);
  console.log("  surface (inside)                  n    bias    MAE    RMS    max (at)");
  for(const q of v.inside)console.log(`  ${q.name.padEnd(32)} ${String(q.n).padStart(3)} ${f(q.bias,2).padStart(7)} ${f(q.mae,2).padStart(6)} ${f(q.rms,2).padStart(6)} ${f(q.max,2).padStart(7)} (${q.at})`);
  for(const b of [...inside].sort((a,c)=>c.mae-a.mae).slice(0,5))
    console.log(`  worst: ${b.id.padEnd(18)} mean |error| ${f(b.mae,2)} m; ${v.surfaces[b.worst!.k]} logged ${f(b.worst!.logged,2)} m, predicted ${f(b.worst!.predicted,2)} m`);
  for(const n of v.notes)console.log("  note: "+n);
}
