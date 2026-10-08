// A printable report: the 3-D view with a title block and legend, the vertical section as vector graphics, and the
// boreholes, unit rules and notes. The browser's print dialog saves it as PDF with the system's fonts, so names in
// any script print correctly.
import {GeoModel,unitCubicMetres,footprintArea} from "./model";
import {Section} from "./section";
import {sectionSvg} from "./sectionSvg";
import {projectCrs} from "./crs";
import {boreholeDepth,sptN} from "./geology";

export interface ReportOptions {
  paper:"A3"|"A4";
  image?:string;             // PNG data URL of the 3-D view
  date:string;
  version:string;
  credits:string[];
  notes:string[];
  sectionBuffer:number;
  ve:number;
  hidden?:ReadonlySet<string>;  // units hidden in the view are left out of the 3-D image and the section
}

const esc=(s:string)=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]!));
const fmt=(v:number,d=0)=>Number.isFinite(v)?v.toLocaleString("en-US",{maximumFractionDigits:d,minimumFractionDigits:d}):"";
const volume=(v:number)=>v>=1e6?`${fmt(v/1e6,2)} M m³`:`${fmt(v)} m³`;
const range=(lo?:number,hi?:number,unit="")=>lo===undefined&&hi===undefined?"":`${lo===undefined?"":`≥ ${lo}${unit}`}${lo!==undefined&&hi!==undefined?", ":""}${hi===undefined?"":`< ${hi}${unit}`}`;

export function reportHtml(model:GeoModel,section:Section,o:ReportOptions){
  const p=model.project,crs=projectCrs(p);
  const [w,h]=o.paper==="A3"?[420,297]:[297,210];
  const azimuth=String(Math.round(section.azimuth)).padStart(3,"0");
  const sectionName=`Section A–A′ · ${azimuth}° · ${section.offset>=0?"+":""}${Math.round(section.offset)} m`;
  const foot=(part:string)=>`<div class="foot"><span>${esc(p.name)} · ${esc(o.date)} · GeoModel3D ${esc(o.version)}</span><span>${part}</span></div>`;
  const block:Array<[string,string]>=[
    ["Coordinate system",crs?`${crs.name}${crs.code?` (${crs.code})`:""}`:p.crs?`${p.crs} (not georeferenced)`:"Local, not georeferenced"],
    ["Boreholes",String(model.boreholes.length)],
    ["Footprint",model.triangles.length?`${fmt(footprintArea(model)/1e4,2)} ha`:"—"],
    ["Ground",p.terrain?`Terrain: ${p.terrain.source??"terrain grid"}, ${fmt(p.terrain.dx,1)} m cells`:"Surface through the collars"],
    ["Data",p.source??"—"],
    ["3-D view","Vertical exaggeration ×"+fmt(o.ve,1)],
    ["Date",o.date],
    ["Software",`GeoModel3D ${o.version}`]
  ];
  const legend=model.units.map((u,k)=>{
    const props=[u.gamma!==undefined?`γ ${fmt(u.gamma,1)} kN/m³`:"",u.gammaSat!==undefined?`γsat ${fmt(u.gammaSat,1)} kN/m³`:""].filter(Boolean).join(", ");
    return `<tr><td><i class="swatch" style="background:${esc(u.color)}"></i>${esc(u.name)}${u.erosive?' <span class="tag">erosive base</span>':""}</td><td class="num">${model.triangles.length?volume(unitCubicMetres(model,k)):""}</td><td>${esc(props)}${props&&u.source?` <span class="muted">(${esc(u.source)})</span>`:""}</td></tr>`;
  }).join("");
  const rules=p.rules?.length?`<h2>Units from logged descriptions (interpretation)</h2><table><thead><tr><th>Description matches</th><th>SPT N</th><th>Top elevation</th><th>Unit</th></tr></thead><tbody>${
    p.rules.map(r=>`<tr><td class="code">${esc(r.match)}</td><td>${esc(range(r.minN,r.maxN))}</td><td>${esc(range(r.minZ,r.maxZ," m"))}</td><td>${esc(model.units.find(u=>u.id===r.unit)?.name??r.unit)}</td></tr>`).join("")
  }</tbody></table><p class="muted">The first rule that matches an interval's description, its median SPT N-value and the elevation of its top gives its unit.</p><br>`:"";
  const holes=model.boreholes.map(b=>{
    const water=b.water?.length?Math.min(...b.water.map(x=>x.depth)):NaN,n=(b.spt??[]).map(sptN);
    return `<tr><td>${esc(b.id)}</td><td class="num">${fmt(b.x,1)}</td><td class="num">${fmt(b.y,1)}</td><td class="num">${fmt(b.z,2)}</td><td class="num">${fmt(boreholeDepth(b),2)}</td><td class="num">${b.lat===undefined?"":fmt(b.lat,6)}</td><td class="num">${b.lon===undefined?"":fmt(b.lon,6)}</td><td class="num">${fmt(water,2)}</td><td class="num">${n.length?`${n.length} (max ${fmt(Math.max(...n))})`:""}</td></tr>`;
  }).join("");
  const svg=sectionSvg(model,section,{width:1600,height:Math.round(1600*(h-60)/(w-24)),theme:"light",legend:true,buffer:o.sectionBuffer,title:false,roundVe:true,hidden:o.hidden});
  const hidden=model.units.filter(u=>o.hidden?.has(u.id)).map(u=>u.name);
  const notes=hidden.length?[`Hidden in the 3-D view and the section: ${hidden.join(", ")}`,...o.notes]:o.notes;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(p.name)} — GeoModel3D report</title><style>
@page{size:${o.paper} landscape;margin:12mm}
*{box-sizing:border-box}
html,body{margin:0;background:#fff;color:#1d2730;font-family:Inter,system-ui,"Segoe UI","Hiragino Sans","Noto Sans JP","Noto Sans CJK JP","Yu Gothic UI",Meiryo,sans-serif;font-size:${o.paper==="A3"?9.5:8}pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:${w-24}mm;min-height:${h-24}mm;display:flex;flex-direction:column;break-after:page;page-break-after:always}
.page:last-child{break-after:auto;page-break-after:auto}
header{display:flex;gap:8mm;justify-content:space-between;align-items:flex-start;border-bottom:1.2pt solid #1d2730;padding-bottom:3mm;margin-bottom:4mm}
h1{font-size:${o.paper==="A3"?17:14}pt;margin:0 0 1.5mm}
h2{font-size:12pt;margin:0 0 3mm}
h3{font-size:10pt;margin:4mm 0 2mm}
.desc{color:#5b6770;max-width:150mm}
table{border-collapse:collapse;width:100%}
th,td{border:0.4pt solid #c9d1d6;padding:0.9mm 1.8mm;text-align:left;vertical-align:top}
th{background:#eef2f4;font-weight:600}
table.block{width:auto;min-width:95mm;font-size:0.92em}
table.block th{width:32mm}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.code{font-family:ui-monospace,Menlo,Consolas,monospace}
.muted{color:#5b6770}
.tag{font-size:0.85em;color:#a35a1d;border:0.4pt solid #d08a4c;border-radius:1mm;padding:0 1mm}
.swatch{display:inline-block;width:3.2mm;height:3.2mm;border:0.3pt solid #555;vertical-align:-0.5mm;margin-right:1.6mm}
.main{display:grid;grid-template-columns:3fr 2fr;gap:6mm;flex:1}
.view img{width:100%;border:0.4pt solid #c9d1d6}
.view .missing{border:0.4pt dashed #c9d1d6;padding:20mm;text-align:center;color:#5b6770}
.section svg{width:100%;height:auto;display:block}
.notes{columns:2;column-gap:8mm;padding-left:4mm;margin:0;font-size:0.9em}
.notes li{break-inside:avoid;margin-bottom:0.8mm}
.foot{margin-top:auto;padding-top:3mm;border-top:0.4pt solid #c9d1d6;display:flex;justify-content:space-between;color:#5b6770;font-size:0.85em}
.credits{color:#5b6770;font-size:0.85em;margin-top:3mm}
</style></head><body>
<section class="page">
<header><div><h1>${esc(p.name)}</h1><div class="desc">${esc(p.description??"")}</div></div>
<table class="block"><tbody>${block.map(([k,v])=>`<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table></header>
<div class="main"><div class="view">${o.image?`<img src="${o.image}" alt="3-D view of the model">`:`<div class="missing">The 3-D view could not be captured with this renderer. Open the page with ?backend=webgl to include it.</div>`}
<div class="credits">${o.credits.map(esc).join(" · ")}</div></div>
<div><h3>Units</h3><table><thead><tr><th>Unit (top to bottom)</th><th>Volume in the model</th><th>Properties</th></tr></thead><tbody>${legend}</tbody></table>${rules?`<p class="muted">The units are assigned to the logged descriptions by rules; they are listed with the boreholes.</p>`:""}</div></div>
${foot("Overview")}</section>
<section class="page"><h2>${esc(sectionName)}</h2><div class="section">${svg}</div>
<p class="muted">From A (${fmt(section.x[0]??NaN,1)}, ${fmt(section.y[0]??NaN,1)}) to A′ (${fmt(section.x[section.x.length-1]??NaN,1)}, ${fmt(section.y[section.y.length-1]??NaN,1)}) in ${esc(crs?.name??p.crs??"project coordinates")}; boreholes within ${fmt(o.sectionBuffer)} m are projected onto it.</p>
${foot("Section")}</section>
<section class="page">${rules}<h2>Boreholes</h2>
<table><thead><tr><th>Borehole</th><th>Easting (m)</th><th>Northing (m)</th><th>Collar (m)</th><th>Depth (m)</th><th>Latitude</th><th>Longitude</th><th>Water (m deep)</th><th>SPT tests</th></tr></thead><tbody>${holes}</tbody></table>
${notes.length?`<h3>Notes on the model (${notes.length})</h3><ul class="notes">${notes.map(n=>`<li>${esc(n)}</li>`).join("")}</ul>`:""}
${foot(rules?"Interpretation, boreholes and notes":"Boreholes and notes")}</section>
</body></html>`;
}
