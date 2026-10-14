// A printable report: the 3-D view with a title block and legend, the vertical section as vector graphics, and the
// boreholes, unit rules and notes. The browser's print dialog saves it as PDF with the system's fonts, so names in
// any script print correctly.
import {GeoModel,unitCubicMetres,footprintArea} from "./model";
import {Section} from "./section";
import {sectionSvg,sectionTitle} from "./sectionSvg";
import {chainageTable,outsideStretches,unitLabel,lineCrossings} from "./alignment";
import {projectCrs} from "./crs";
import {boreholeDepth,sptN} from "./schema";
import {SectionField,unitWeights} from "./fields";
import {unitStatistics,measuredProperties,propertyDef,formatValue} from "./properties";
import {CrossValidation} from "./validation";

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
  field?:SectionField;          // a field shown on the section gets a page of its own
  validation?:CrossValidation;  // a cross-validation of the model, run in the app, gets a page of its own
  chainageStep?:number;         // along an alignment, the step of the table by chainage (coarser where it would not fit)
}

const esc=(s:string)=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]!));
const fmt=(v:number,d=0)=>Number.isFinite(v)?v.toLocaleString("en-US",{maximumFractionDigits:d,minimumFractionDigits:d}):"";
const volume=(v:number)=>v>=1e6?`${fmt(v/1e6,2)} M m³`:`${fmt(v)} m³`;
const range=(lo?:number,hi?:number,unit="")=>lo===undefined&&hi===undefined?"":`${lo===undefined?"":`≥ ${lo}${unit}`}${lo!==undefined&&hi!==undefined?", ":""}${hi===undefined?"":`< ${hi}${unit}`}`;

export function reportHtml(model:GeoModel,section:Section,o:ReportOptions){
  const p=model.project,crs=projectCrs(p);
  const [w,h]=o.paper==="A3"?[420,297]:[297,210];
  const azimuth=String(Math.round(section.azimuth)).padStart(3,"0"),line=section.alignment;
  const sectionName=line?sectionTitle(section):`Section A–A′ · ${azimuth}° · ${section.offset>=0?"+":""}${Math.round(section.offset)} m`;
  const foot=(part:string)=>`<div class="foot"><span>${esc(p.name)} · ${esc(o.date)} · GeoModel3D ${esc(o.version)}</span><span>${part}</span></div>`;
  const block:Array<[string,string]>=[
    ["Coordinate system",crs?`${crs.name}${crs.code?` (${crs.code})`:""}`:p.crs?`${p.crs} (not georeferenced)`:"Local, not georeferenced"],
    ["Boreholes",String(model.boreholes.length)],
    ["Footprint",model.triangles.length?`${fmt(footprintArea(model)/1e4,2)} ha`:"—"],
    ["Ground",p.terrain?`Terrain: ${p.terrain.source??"terrain grid"}, ${fmt(p.terrain.dx,1)} m cells`:"Surface through the collars"],
    ["Data",p.source??"—"],
    ["Groundwater",model.water?model.water.source.replace(/^./,c=>c.toUpperCase()):"Not given"],
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
  // Ground parameters: the unit weights the stresses use, the unit's design values, and what was measured in it.
  const weights=unitWeights(model),stats=unitStatistics(model.boreholes,model.units),measured=measuredProperties(model.boreholes);
  const designKeys=[...new Set(model.units.flatMap(u=>Object.keys(u.params??{})))];
  const cell=(key:string,v?:{n:number;mean:number;min:number;max:number})=>v?`${formatValue(key,v.mean)}${v.n>1?` <span class="muted">(${formatValue(key,v.min)}–${formatValue(key,v.max)}, ${v.n})</span>`:` <span class="muted">(1)</span>`}`:"";
  const head=(key:string)=>{const d=propertyDef(key);return `${esc(d.symbol)}${d.unit?` (${esc(d.unit)})`:""}`};
  const params=model.units.length?`<h2>Ground parameters</h2><table><thead><tr><th>Unit</th><th>γ / γsat used (kN/m³)</th>${designKeys.map(k=>`<th>${head(k)} design</th>`).join("")}${measured.map(k=>`<th>${head(k)} measured</th>`).join("")}</tr></thead><tbody>${
    model.units.map((u,k)=>`<tr><td><i class="swatch" style="background:${esc(u.color)}"></i>${esc(u.name)}</td><td class="num">${formatValue("gamma",weights[k].above)} / ${formatValue("gamma",weights[k].below)} <span class="muted">${weights[k].source==="declared"?"given":weights[k].source==="measured"?`mean of ${weights[k].n} tests`:"assumed"}</span></td>${
      designKeys.map(key=>`<td class="num">${u.params?.[key]!==undefined?formatValue(key,u.params[key]):""}</td>`).join("")}${measured.map(key=>`<td class="num">${cell(key,stats.get(u.id)?.get(key))}</td>`).join("")}</tr>`).join("")
  }</tbody></table><p class="muted">Measured values: mean (range, number of values), by the logged interval each test lies in; SPT N-values as converted to 300 mm. Unit weights are the unit's own, else the mean measured bulk unit weight, else assumed (18 kN/m³ above and 20 kN/m³ below the water table).</p><br>`:"";
  const holes=model.boreholes.map(b=>{
    const water=b.water?.length?Math.min(...b.water.map(x=>x.depth)):NaN,n=(b.spt??[]).map(sptN);
    return `<tr><td>${esc(b.id)}</td><td class="num">${fmt(b.x,1)}</td><td class="num">${fmt(b.y,1)}</td><td class="num">${fmt(b.z,2)}</td><td class="num">${fmt(boreholeDepth(b),2)}</td><td class="num">${b.lat===undefined?"":fmt(b.lat,6)}</td><td class="num">${b.lon===undefined?"":fmt(b.lon,6)}</td><td class="num">${fmt(water,2)}</td><td class="num">${n.length?`${n.length} (max ${fmt(Math.max(...n))})`:""}</td></tr>`;
  }).join("");
  const crossings=lineCrossings(section,p.alignments??[]);
  const svg=sectionSvg(model,section,{width:1600,height:Math.round(1600*(h-60)/(w-24)),theme:"light",legend:true,buffer:o.sectionBuffer,title:false,roundVe:true,hidden:o.hidden,crossings});
  const fieldSvg=o.field?sectionSvg(model,section,{width:1600,height:Math.round(1600*(h-60)/(w-24)),theme:"light",legend:true,buffer:o.sectionBuffer,title:false,roundVe:true,hidden:o.hidden,field:o.field,crossings}):"";
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
.field-notes{margin:2mm 0 0;padding-left:4mm;font-size:0.9em}
table.chainage{font-size:0.86em}
table.chainage td,table.chainage th{padding:0.5mm 1.4mm}
</style></head><body>
<section class="page">
<header><div><h1>${esc(p.name)}</h1><div class="desc">${esc(p.description??"")}</div></div>
<table class="block"><tbody>${block.map(([k,v])=>`<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table></header>
<div class="main"><div class="view">${o.image?`<img src="${o.image}" alt="3-D view of the model">`:`<div class="missing">The 3-D view could not be captured with this renderer. Open the page with ?backend=webgl to include it.</div>`}
<div class="credits">${o.credits.map(esc).join(" · ")}</div></div>
<div><h3>Units</h3><table><thead><tr><th>Unit (top to bottom)</th><th>Volume in the model</th><th>Properties</th></tr></thead><tbody>${legend}</tbody></table>${rules?`<p class="muted">The units are assigned to the logged descriptions by rules; they are listed with the boreholes.</p>`:""}</div></div>
${foot("Overview")}</section>
<section class="page"><h2>${esc(sectionName)}</h2><div class="section">${svg}</div>
${line?`<p class="muted">Along ${esc(line.name)}, ${line.s.length} points from (${fmt(line.x[0],1)}, ${fmt(line.y[0],1)}) to (${fmt(line.x[line.x.length-1],1)}, ${fmt(line.y[line.y.length-1],1)}) in ${esc(crs?.name??p.crs??"project coordinates")}; boreholes within ${fmt(o.sectionBuffer)} m of the line are projected onto it at their nearest point.${outsideStretches(section).map(([a,b])=>` Chainage ${fmt(a)}–${fmt(b)} m lies outside the model.`).join("")}</p>`
  :`<p class="muted">From A (${fmt(section.x[0]??NaN,1)}, ${fmt(section.y[0]??NaN,1)}) to A′ (${fmt(section.x[section.x.length-1]??NaN,1)}, ${fmt(section.y[section.y.length-1]??NaN,1)}) in ${esc(crs?.name??p.crs??"project coordinates")}; boreholes within ${fmt(o.sectionBuffer)} m are projected onto it.</p>`}
${foot(line?"Longitudinal profile":"Section")}</section>
${line?chainagePage(model,section,o.chainageStep??10,foot):""}
${o.field?`<section class="page"><h2>${esc(sectionName)} · ${esc(o.field.name)} ${esc(o.field.symbol)}</h2><div class="section">${fieldSvg}</div>
<ul class="muted field-notes">${o.field.notes.map(n=>`<li>${esc(n)}</li>`).join("")}</ul>
${foot(`Section: ${o.field.name.toLowerCase()}`)}</section>`:""}
${o.validation?validationPage(o.validation,foot):""}
<section class="page">${params}${rules}<h2>Boreholes</h2>
<table><thead><tr><th>Borehole</th><th>Easting (m)</th><th>Northing (m)</th><th>Collar (m)</th><th>Depth (m)</th><th>Latitude</th><th>Longitude</th><th>Water (m deep)</th><th>SPT tests</th></tr></thead><tbody>${holes}</tbody></table>
${notes.length?`<h3>Notes on the model (${notes.length})</h3><ul class="notes">${notes.map(n=>`<li>${esc(n)}</li>`).join("")}</ul>`:""}
${foot(rules?"Ground parameters, interpretation, boreholes and notes":"Ground parameters, boreholes and notes")}</section>
</body></html>`;
}

// The cross-validation: what share of the logs the model predicts from the other boreholes, the errors of each
// surface, and the boreholes furthest from their prediction.
function validationPage(v:CrossValidation,foot:(part:string)=>string){
  const inside=v.boreholes.filter(b=>!b.outside),outside=v.boreholes.length-inside.length;
  const pct=(x:number)=>Number.isFinite(x)?`${fmt(100*x,1)} %`:"–",signed=(x:number)=>(x>0?"+":"")+fmt(x,2);
  const table=(list:CrossValidation["inside"])=>`<table><thead><tr><th>Surface</th><th>Boreholes</th><th>Bias (m)</th><th>Mean absolute (m)</th><th>RMS (m)</th><th>Largest (m)</th><th>at</th></tr></thead><tbody>${
    list.map(q=>`<tr><td>${esc(q.name)}</td><td class="num">${q.n}</td><td class="num">${signed(q.bias)}</td><td class="num">${fmt(q.mae,2)}</td><td class="num">${fmt(q.rms,2)}</td><td class="num">${signed(q.max)}</td><td>${esc(q.at)}</td></tr>`).join("")}</tbody></table>`;
  const worst=[...inside].filter(b=>Number.isFinite(b.mae)).sort((a,b)=>b.mae-a.mae).slice(0,12);
  return `<section class="page"><h2>Cross-validation</h2>
<p>Each borehole in turn was left out, the model was built from the others, and its log was compared with what that model predicts at its collar (leave-one-out cross-validation). ${inside.length} borehole${inside.length===1?"":"s"} lie inside the outline of the others: <b>${pct(v.share.inside)}</b> of their logged metres are predicted in the unit logged.${outside?` ${outside} lie outside it, where the prediction extrapolates: ${pct(v.share.outside)}.`:""}${v.terrain?" The ground between boreholes is the terrain grid.":""}</p>
<h3>Errors at the boreholes inside the others, predicted minus logged</h3>${table(v.inside)}
${v.outside.length?`<h3>Outside the others</h3>${table(v.outside)}`:""}
${worst.length?`<h3>Furthest from their prediction</h3><table><thead><tr><th>Borehole</th><th>Mean absolute error (m)</th><th>Largest error</th><th>Logged (m)</th><th>Predicted (m)</th></tr></thead><tbody>${
  worst.map(b=>`<tr><td>${esc(b.id)}</td><td class="num">${fmt(b.mae,2)}</td><td>${b.worst?`${esc(v.surfaces[b.worst.k])} ${signed(b.worst.error)} m`:""}</td><td class="num">${b.worst?fmt(b.worst.logged,2):""}</td><td class="num">${b.worst?fmt(b.worst.predicted,2):""}</td></tr>`).join("")}</tbody></table>`:""}
${v.notes.length?`<ul class="notes">${v.notes.map(n=>`<li>${esc(n)}</li>`).join("")}</ul>`:""}
${foot("Cross-validation")}</section>`;
}

// The table by chainage along an alignment: the ground, the water table and the design levels with the cover and the
// units at them, or without design levels each unit's thickness; at the step asked for, or a coarser round step that
// fits the page.
function chainagePage(model:GeoModel,section:Section,asked:number,foot:(part:string)=>string){
  const length=section.s.length>1?section.s[section.s.length-1]-section.s[0]:0;
  const step=[asked,1,2,5,10,20,25,50,100,200,250,500,1000].filter(v=>v>=asked).find(v=>length/v<=60)??1000;
  const rows=chainageTable(model,section,step),band=rows.some(r=>r.bottom!==undefined),design=rows.some(r=>r.top!==undefined),wet=rows.some(r=>r.water!==undefined);
  const head=["Chainage (m)","Ground (m)",...(wet?["Water table (m)"]:[]),
    ...(band?["Crown (m)","Invert (m)","Cover above crown (m)",...(wet?["Water above crown (m)"]:[]),"Unit at crown","Unit at invert"]
      :design?["Design level (m)","Depth below ground (m)",...(wet?["Water above level (m)"]:[]),"Unit at level"]
      :model.units.map(u=>`${u.name} (m)`))];
  const v=(x:number|undefined,d=2)=>x===undefined?"":fmt(x,d);
  const body=rows.map(r=>{
    const cover=r.top===undefined?undefined:r.ground-r.top,water=r.top===undefined||r.water===undefined?undefined:r.water-r.top;
    const cells=[fmt(r.chainage,step<1?1:0),v(r.ground),...(wet?[v(r.water)]:[]),
      ...(band?[v(r.top),v(r.bottom),v(cover),...(wet?[v(water)]:[])]:design?[v(r.top),v(cover),...(wet?[v(water)]:[])]:r.thickness.map(t=>v(t)))];
    const names=band?[unitLabel(model,r.unitTop),unitLabel(model,r.unitBottom)]:design?[unitLabel(model,r.unitTop)]:[];
    return `<tr>${cells.map(c=>`<td class="num">${c}</td>`).join("")}${names.map(n=>`<td>${esc(n)}</td>`).join("")}</tr>`;
  }).join("");
  const name=section.alignment!.name;
  return `<section class="page"><h2>${esc(name)}: by chainage</h2>
<table class="chainage"><thead><tr>${head.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>
<p class="muted">Every ${fmt(step)} m of chainage where the line is in the model${step>asked?`; the table by chainage in CSV has a row every ${fmt(asked)} m`:""}. Elevations in metres; the cover is the ground above the ${band?"crown":"design level"}, negative where the ${band?"crown":"level"} is above the ground.</p>
${foot("By chainage")}</section>`;
}
