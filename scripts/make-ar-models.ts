// Writes the real sites as 3-D models for augmented reality, GLB and USDZ, with a page that opens them: in AR Quick
// Look on iPhone and iPad, in Scene Viewer on Android, and as downloads elsewhere. They are built from the bundled data,
// without the terrain the app downloads, at the exaggeration the app opens them with. The build runs it into dist/ar,
// so the files are published with the site and kept out of the repository.
//   npx esbuild scripts/make-ar-models.ts --bundle --platform=node --format=esm --outfile=.cache/make-ar-models.mjs && node .cache/make-ar-models.mjs dist/ar
import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {realSites} from "../src/geology";
import {arModel,toGlb,toUsdz} from "../src/ar";
import {buildGeologicalModel,modelBounds} from "../src/model";
import pkg from "../package.json";

// Node has no FileReader, which the GLB writer reads its buffers with.
(globalThis as {FileReader?:unknown}).FileReader??=class{
  result:ArrayBuffer|null=null;onloadend:(()=>void)|null=null;
  readAsArrayBuffer(b:Blob){void b.arrayBuffer().then(r=>{this.result=r;this.onloadend?.()})}
};

const out=process.argv[2]??"dist/ar";
mkdirSync(out,{recursive:true});
const esc=(s:string)=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]!));
const slugs=["sakae","antwerp","maasvlakte","creswick"];
const sites:Array<{slug:string;name:string;source:string;triangles:number;glb:number;usdz:number}>=[];
for(const [i,p] of realSites.entries()){
  // The exaggeration the viewer opens the site with.
  const m=buildGeologicalModel(p),b=modelBounds(m),extent=Math.max(b.maxX-b.minX,b.maxY-b.minY,(b.maxZ-b.minZ)/2,1);
  const ve=Math.min(5,Math.max(1,Math.round(extent/(Math.max(b.maxZ-b.minZ,1)*3)*2)/2));
  const {scene,triangles}=arModel(p,{ve});
  const credit=`${p.source??p.name} Model: GeoModel3D ${pkg.version}, ${pkg.homepage}, vertical exaggeration ×${ve}.`;
  const glb=new Uint8Array(await toGlb(scene,credit)),usdz=await toUsdz(scene,credit);
  writeFileSync(join(out,`${slugs[i]}.glb`),glb);
  writeFileSync(join(out,`${slugs[i]}.usdz`),usdz);
  sites.push({slug:slugs[i],name:p.name,source:p.source??"",triangles,glb:glb.byteLength,usdz:usdz.byteLength});
  console.log(`${p.name}: ${triangles} triangles, ×${ve}, GLB ${(glb.byteLength/1e6).toFixed(1)} MB, USDZ ${(usdz.byteLength/1e6).toFixed(1)} MB`);
}

// AR Quick Look opens a link marked rel="ar" whose only child is an image, so the label is drawn as one.
const label=(text:string)=>`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="132" height="34"><rect width="132" height="34" rx="7" fill="#78c9df"/><text x="66" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="600" fill="#071018">${text}</text></svg>`)}`;
const mb=(n:number)=>`${(n/1e6).toFixed(1)} MB`;
writeFileSync(join(out,"index.html"),`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GeoModel3D in AR</title>
<meta name="description" content="Real ground models from borehole logs, to set on a desk in augmented reality with a phone or tablet.">
<style>
:root{color-scheme:dark}
[hidden]{display:none!important}
body{margin:0;background:#071018;color:#e8f2f7;font:15px/1.5 system-ui,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:26px;margin:0 0 6px}
p{color:#c4d2d9}
.site{border:1px solid rgba(160,190,200,.2);border-radius:10px;padding:14px 16px;margin-top:16px}
.site h2{font-size:18px;margin:0 0 6px}
.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:10px 0 6px}
.actions a{color:#9bd3e3}
.ar img{display:block}
.button{display:inline-block;background:#78c9df;color:#071018;font-weight:600;border-radius:7px;padding:6px 14px;text-decoration:none}
.credit{font-size:12px;color:#8aa2ae}
a{color:#9bd3e3}
</style></head><body><main>
<h1>GeoModel3D in AR</h1>
<p>Four real ground models from published borehole logs, about 30 cm across, to set on a desk with a phone or tablet and walk around. On an iPhone or iPad they open in AR Quick Look; on Android, in Scene Viewer. Elsewhere, download the GLB for a 3-D viewer or the USDZ for Apple devices. The models are built from the bundled data, without the terrain the app downloads, with the vertical exaggeration the app opens them with. Explore them in full at <a href="../">GeoModel3D</a>.</p>
${sites.map(s=>`<section class="site"><h2>${esc(s.name)}</h2>
<div class="actions" data-slug="${s.slug}" data-title="${esc(s.name)}"><a class="ar" rel="ar" href="${s.slug}.usdz" hidden><img src="${label("View in AR")}" width="132" height="34" alt="View in AR"></a><a class="button scene" href="#" hidden>View in AR</a>
<a href="${s.slug}.glb" download>GLB, ${mb(s.glb)}</a><a href="${s.slug}.usdz" download>USDZ, ${mb(s.usdz)}</a></div>
<div class="credit">${s.triangles.toLocaleString("en-US")} triangles. ${esc(s.source)}</div></section>`).join("\n")}
<p class="credit">The data keep their own terms, listed with the changes made under <a href="https://github.com/kilickursat/GeoModel3D/blob/main/docs/sites.md#data-sources">Data sources</a>; each file carries its source credit. GeoModel3D ${esc(pkg.version)} is open source under the Apache-2.0 licence.</p>
</main>
<script>
// AR Quick Look where Safari supports it; Scene Viewer on Android, which needs the file's full address.
const quickLook=(()=>{try{return document.createElement("a").relList.supports("ar")}catch{return false}})();
const android=/android/i.test(navigator.userAgent);
for(const box of document.querySelectorAll(".actions")){
  const glb=new URL(box.dataset.slug+".glb",location.href).href;
  if(quickLook)box.querySelector(".ar").hidden=false;
  else if(android){
    const link=box.querySelector(".scene");
    link.href="intent://arvr.google.com/scene-viewer/1.2?file="+encodeURIComponent(glb)+"&mode=ar_preferred&title="+encodeURIComponent(box.dataset.title)+"#Intent;scheme=https;package=com.google.android.googlequicksearchbox;action=android.intent.action.VIEW;S.browser_fallback_url="+encodeURIComponent(glb)+";end;";
    link.hidden=false;
  }
}
</script></body></html>
`);
console.log(`${out}/index.html`);
