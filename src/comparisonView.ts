// Compare pinned project revisions on one reference path. Calculations run only on request; changing settings
// invalidates the result and its CSV, while the worker can be stopped without changing either saved revision.
import type {WorkspaceRevision} from "./workspace";
import type {compareProjects,ProjectComparison} from "./comparison";
import {comparisonCsv} from "./comparison";
import {createComparisonJob} from "./comparisonJob";
import {parseCsv,toCsv} from "./io";
import "./comparison.css";

type ComparisonOptions=Parameters<typeof compareProjects>[2];
type ComparisonPoint=ProjectComparison["points"][number];
export interface ComparisonViewOptions { download?(name:string,text:string,type:string):void; beforeLabel?:string; afterLabel?:string }
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const format=(n:number|undefined,d=2)=>n!==undefined&&Number.isFinite(n)?n.toLocaleString("en-US",{maximumFractionDigits:d}):"Unavailable";
const delta=(a:number|undefined,b:number|undefined)=>a!==undefined&&b!==undefined&&Number.isFinite(a)&&Number.isFinite(b)?b-a:undefined;
const slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"revision";
const date=(s:string)=>Number.isFinite(Date.parse(s))?new Date(s).toLocaleString():s;
let closeActive:(()=>void)|undefined,sequence=0;

export function showComparison(before:WorkspaceRevision,after:WorkspaceRevision,viewOptions:ComparisonViewOptions={}):void{
  closeActive?.();
  const opener=document.activeElement instanceof HTMLElement?document.activeElement:null,oldOverflow=document.body.style.overflow;
  const alignments=before.project.alignments??[];
  let result:ProjectComparison|undefined,request:ReturnType<typeof createComparisonJob>|undefined,generation=0,closed=false,busy=false;
  const heading=`comparison-heading-${++sequence}`,dialog=document.createElement("dialog");
  dialog.className="cmp-dialog";dialog.setAttribute("aria-labelledby",heading);
  const revision=(r:WorkspaceRevision,which:string,scenarioLabel?:string)=>`<div class="cmp-revision"><b>${which}: ${scenarioLabel?`${esc(scenarioLabel)} · `:""}${esc(r.project.name)}</b><span>${esc(r.id)}</span><small>${esc(date(r.createdAt))} · GeoModel3D ${esc(r.engineVersion)}</small></div>`;
  dialog.innerHTML=`<header class="cmp-header"><h2 id="${heading}">Compare project revisions</h2><button type="button" class="cmp-close" aria-label="Close comparison">Close</button></header>
<div class="cmp-body"><div class="cmp-revisions">${revision(before,"Before",viewOptions.beforeLabel)}${revision(after,"After",viewOptions.afterLabel)}</div>
<p>Both revisions are sampled at the same coordinates. Differences are <b>after minus before</b>.</p>
<form class="cmp-controls" novalidate>
<label>Reference path<select class="cmp-mode"><option value="section">Straight section</option><option value="alignment"${alignments.length?"":" disabled"}>Alignment from before revision</option></select></label>
<label data-cmp-mode="section">Direction (°)<input class="cmp-azimuth" type="number" min="0" max="179" step="1" value="0" required></label>
<label data-cmp-mode="section">Offset (m)<input class="cmp-offset" type="number" step="any" value="0" required></label>
<label data-cmp-mode="alignment" hidden>Reference alignment<select class="cmp-alignment">${alignments.map((a,i)=>`<option value="${i}">${esc(a.name)}</option>`).join("")}</select></label>
<label>Sample spacing (m)<input class="cmp-step" type="number" min="0" step="any" value="10" required></label>
<label>Readout elevation (m), optional<input class="cmp-elevation" type="number" step="any" placeholder="No level readout"></label>
<div class="cmp-actions"><button type="submit" class="cmp-run">Run comparison</button><button type="button" class="cmp-cancel" hidden>Cancel</button><button type="button" class="cmp-csv" disabled>Download comparison CSV</button></div>
</form>
<p class="cmp-status" role="status">Choose settings, then run the comparison.</p><p class="cmp-error" role="alert" hidden></p>
<div class="cmp-results" hidden></div></div>`;
  const $=<T extends HTMLElement>(selector:string)=>dialog.querySelector<T>(selector)!;
  const closeButton=$<HTMLButtonElement>(".cmp-close"),controls=$<HTMLFormElement>(".cmp-controls"),mode=$<HTMLSelectElement>(".cmp-mode"),alignment=$<HTMLSelectElement>(".cmp-alignment");
  const runButton=$<HTMLButtonElement>(".cmp-run"),cancelButton=$<HTMLButtonElement>(".cmp-cancel"),csvButton=$<HTMLButtonElement>(".cmp-csv"),status=$(".cmp-status"),error=$(".cmp-error"),results=$(".cmp-results");

  function stop(){generation++;request?.cancel();request=undefined;busy=false;runButton.disabled=false;cancelButton.hidden=true}
  function invalidate(message="Settings changed. Run comparison to update the results."){
    stop();result=undefined;csvButton.disabled=true;results.hidden=true;results.replaceChildren();error.hidden=true;status.textContent=message;
  }
  function close(){
    if(closed)return;
    closed=true;stop();dialog.removeEventListener("keydown",onKey);
    if(dialog.open)dialog.close();dialog.remove();document.body.style.overflow=oldOverflow;
    if(closeActive===close)closeActive=undefined;
    if(opener?.isConnected)opener.focus({preventScroll:true});
  }
  function onKey(event:KeyboardEvent){
    if(event.key==="Escape"){event.preventDefault();close();return}
    if(event.key!=="Tab")return;
    const focusable=[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(e=>e.getClientRects().length>0);
    const first=focusable[0],last=focusable.at(-1);
    if(!first||!last){event.preventDefault();closeButton.focus();return}
    if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last.focus()}
    else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first.focus()}
  }
  function readNumber(selector:string,name:string,optional=false){
    const raw=$<HTMLInputElement>(selector).value.trim();
    if(optional&&!raw)return undefined;
    if(!raw||!Number.isFinite(Number(raw)))throw new Error(`${name} must be a finite number.`);
    return Number(raw);
  }
  function settings():ComparisonOptions{
    const step=readNumber(".cmp-step","Sample spacing")!,elevation=readNumber(".cmp-elevation","Readout elevation",true);
    if(!(step>0))throw new Error("Sample spacing must be greater than zero.");
    if(mode.value==="alignment"){
      const reference=alignments[Number(alignment.value)];
      if(!reference)throw new Error("Choose an alignment from the before revision.");
      return {mode:"alignment",alignment:reference,step,...(elevation===undefined?{}:{elevation})};
    }
    const azimuth=readNumber(".cmp-azimuth","Direction")!,offset=readNumber(".cmp-offset","Offset")!;
    if(azimuth<0||azimuth>179)throw new Error("Direction must be between 0 and 179 degrees.");
    return {mode:"section",azimuth,offset,step,...(elevation===undefined?{}:{elevation})};
  }
  function syncMode(){
    for(const el of controls.querySelectorAll<HTMLElement>("[data-cmp-mode]")){
      el.hidden=el.dataset.cmpMode!==mode.value;
      for(const input of el.querySelectorAll<HTMLInputElement|HTMLSelectElement>("input,select"))input.disabled=el.hidden;
    }
  }
  async function run(){
    invalidate("Preparing comparison…");
    let specification:ComparisonOptions;
    try{specification=settings()}
    catch(err){error.textContent=(err as Error).message;error.hidden=false;status.textContent="Comparison not run.";return}
    const token=generation;busy=true;runButton.disabled=true;cancelButton.hidden=false;status.textContent="Comparing pinned revisions…";
    // Give the status and Cancel button a frame before creating the calculation worker.
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    if(closed||token!==generation)return;
    try{
      request=createComparisonJob(before.project,after.project,specification);
      const compared=await request.result;
      if(closed||token!==generation)return;
      result=compared;renderResult();csvButton.disabled=false;
      status.textContent=`Comparison ready: ${format(compared.summary.overlapSamples,0)} shared sample positions of ${format(compared.summary.sampleCount,0)}.`;
    }catch(err){
      if(closed||token!==generation)return;
      error.textContent=err instanceof Error?err.message:String(err);error.hidden=false;status.textContent="Comparison could not be completed.";
    }finally{
      if(token===generation){request=undefined;busy=false;runButton.disabled=false;cancelButton.hidden=true}
    }
  }
  function valueAt(point:ComparisonPoint,side:"before"|"after",surface:string){
    const value=point[side];
    if(!value)return undefined;
    return surface==="ground"?value.ground:surface==="water"?value.water:value.contacts[surface.slice(5)];
  }
  function plot(surface:string){
    if(!result)return "";
    const points=result.points,values=points.flatMap(p=>[valueAt(p,"before",surface),valueAt(p,"after",surface)]).filter((v):v is number=>v!==undefined&&Number.isFinite(v));
    if(!values.length)return '<p class="cmp-unavailable">Unavailable: neither revision has values for this surface along the reference path.</p>';
    const W=800,H=340,m={l:68,r:20,t:26,b:52},pw=W-m.l-m.r,ph=H-m.t-m.b;
    const x0=result.path.start,x1=result.path.end,xSpan=x1-x0||1,low=Math.min(...values),high=Math.max(...values),pad=Math.max((high-low)*.12,.5),y0=low-pad,y1=high+pad;
    const x=(v:number)=>m.l+(v-x0)/xSpan*pw,y=(v:number)=>m.t+(y1-v)/(y1-y0)*ph;
    const paths=(side:"before"|"after")=>{
      let path="",open=false;
      for(const p of points){
        const v=valueAt(p,side,surface);
        if(v===undefined||!Number.isFinite(v)){open=false;continue}
        path+=`${open?"L":"M"}${x(p.distance).toFixed(2)},${y(v).toFixed(2)}`;open=true;
      }
      return `<path class="cmp-${side}-line" d="${path}" fill="none" stroke="${side==="before"?"#1f6fd1":"#c35a17"}" stroke-width="2.5"${side==="before"?' stroke-dasharray="7 5"':""}/>`;
    };
    const grid=Array.from({length:6},(_,i)=>{
      const vx=x0+xSpan*i/5,vy=y0+(y1-y0)*i/5;
      return `<line x1="${x(vx)}" y1="${m.t}" x2="${x(vx)}" y2="${m.t+ph}" stroke="#e3e8ec"/><line x1="${m.l}" y1="${y(vy)}" x2="${m.l+pw}" y2="${y(vy)}" stroke="#e3e8ec"/><text x="${x(vx)}" y="${m.t+ph+20}" text-anchor="middle">${format(vx)}</text><text x="${m.l-8}" y="${y(vy)+4}" text-anchor="end">${format(vy)}</text>`;
    }).join("");
    const name=surface==="ground"?"Ground":surface==="water"?"Groundwater":`Top of ${result.surfaces.find(s=>s.unitId===surface.slice(5))?.afterName??result.surfaces.find(s=>s.unitId===surface.slice(5))?.beforeName??surface.slice(5)}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${name}: before and after on shared plot scales`)}"><rect width="${W}" height="${H}" fill="white"/><g fill="#4d5964" font-family="sans-serif" font-size="12">${grid}<text x="${m.l}" y="16">Elevation (m)</text><text x="${m.l+pw/2}" y="${H-7}" text-anchor="middle">${esc(result.axisLabel)}</text></g>${paths("before")}${paths("after")}</svg>`;
  }
  function renderResult(){
    if(!result)return;
    const r=result,shared=r.surfaces.filter(s=>s.status==="shared"),introduced=r.surfaces.filter(s=>s.status==="introduced"),removed=r.surfaces.filter(s=>s.status==="removed");
    const changed=(list:typeof r.surfaces)=>list.length?list.map(s=>`${s.afterName??s.beforeName??s.unitId} (${s.unitId})`).map(esc).join(", "):"None";
    const row=(name:string,count:number,min:number|undefined,max:number|undefined,mean:number|undefined)=>`<tr><th scope="row">${esc(name)}</th><td>${format(count,0)}</td><td>${format(min)}</td><td>${format(max)}</td><td>${format(mean)}</td></tr>`;
    const contacts=row("Ground",r.summary.ground.count,r.summary.ground.minDelta,r.summary.ground.maxDelta,r.summary.ground.meanDelta)+row("Groundwater",r.summary.water.count,r.summary.water.minDelta,r.summary.water.maxDelta,r.summary.water.meanDelta)+shared.map(s=>row(`Top of ${s.afterName??s.beforeName??s.unitId} (${s.unitId})`,s.count,s.minDelta,s.maxDelta,s.meanDelta)).join("");
    results.innerHTML=`<dl class="cmp-summary"><div><dt>Shared sample positions</dt><dd>${format(r.summary.overlapSamples,0)}</dd></div><div><dt>Before only / after only</dt><dd>${format(r.summary.beforeOnlySamples,0)} / ${format(r.summary.afterOnlySamples,0)}</dd></div><div><dt>Max |ground difference|</dt><dd>${format(r.summary.maxGroundDelta)}${r.summary.maxGroundDelta===undefined?"":" m"}</dd></div><div><dt>Max |water difference|</dt><dd>${format(r.summary.maxWaterDelta)}${r.summary.maxWaterDelta===undefined?"":" m"}</dd></div></dl>
<div class="cmp-notes"><p>${r.mode==="alignment"?`Reference alignment: ${esc(r.path.alignmentName??"Alignment")}, using the before revision's geometry.`:`Straight reference section: direction ${format(r.path.azimuth)}°, offset ${format(r.path.offset)} m from the before model's centre.`} Sample spacing: ${format(r.path.step,4)} m.</p><ul>${r.notes.map(n=>`<li>${esc(n)}</li>`).join("")}</ul></div>
<div class="cmp-plot-head"><label>Surface<select class="cmp-surface"><option value="ground">Ground</option><option value="water">Groundwater</option>${shared.map(s=>`<option value="unit:${esc(s.unitId)}">Top of ${esc(s.afterName??s.beforeName??s.unitId)} (${esc(s.unitId)})</option>`).join("")}</select></label><div class="cmp-legend"><span class="cmp-before-key">Before · dashed</span><span class="cmp-after-key">After · solid</span></div></div>
<div class="cmp-plot" tabindex="0" aria-label="Surface comparison chart; scroll horizontally on small screens">${plot("ground")}</div><p class="cmp-caption">Both lines use the same axes. Gaps mean the surface is unavailable; differences are calculated only where both values exist.</p>
<h3>Contact elevation differences (m)</h3><div class="cmp-table-wrap"><table class="cmp-contacts"><thead><tr><th>Surface</th><th>Shared samples</th><th>Minimum Δ</th><th>Maximum Δ</th><th>Mean Δ</th></tr></thead><tbody>${contacts}</tbody></table></div>
<dl class="cmp-unit-changes"><dt>Introduced contact IDs</dt><dd>${changed(introduced)}</dd><dt>Removed contact IDs</dt><dd>${changed(removed)}</dd></dl>
${r.path.elevation!==undefined?`<p class="cmp-level-summary">At elevation ${format(r.path.elevation)} m, unit assignments differ at ${format(r.summary.changedUnitSamples,0)} of ${format(r.summary.comparedUnitSamples,0)} comparable sample positions.</p>`:""}
<details class="cmp-point-details"><summary>Sample readouts${r.points.length>200?" (first 200; CSV contains all samples)":""}</summary><div class="cmp-table-wrap">${pointTable(r)}</div></details>`;
    results.hidden=false;
  }
  function pointTable(r:ProjectComparison){
    const level=r.path.elevation!==undefined;
    const headers=[r.axisLabel,"Before ground (m)","After ground (m)","Ground Δ (m)","Before water (m)","After water (m)","Water Δ (m)",...(level?["Before unit","After unit","Before σ′v (kPa)","After σ′v (kPa)","σ′v Δ (kPa)"]:[])];
    const rows=r.points.slice(0,200).map(p=>{
      const values=[format(p.distance),format(p.before?.ground),format(p.after?.ground),format(delta(p.before?.ground,p.after?.ground)),format(p.before?.water),format(p.after?.water),format(delta(p.before?.water,p.after?.water)),
        ...(level?[p.before?.unitIdAtLevel??"Unavailable",p.after?.unitIdAtLevel??"Unavailable",format(p.before?.stress?.s),format(p.after?.stress?.s),format(delta(p.before?.stress?.s,p.after?.stress?.s))]:[])];
      return `<tr>${values.map(v=>`<td>${esc(v)}</td>`).join("")}</tr>`;
    }).join("");
    return `<table class="cmp-points"><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
  }
  function exportCsv(){
    if(!result||busy)return;
    const rows=parseCsv(comparisonCsv(result),",");
    const names=["before_revision_id","after_revision_id","before_revision_created_at","after_revision_created_at","before_engine_version","after_engine_version","comparison_mode","section_azimuth_deg","section_offset_m","reference_alignment","actual_step_m","readout_elevation_m"];
    const values=[before.id,after.id,before.createdAt,after.createdAt,before.engineVersion,after.engineVersion,result.mode,String(result.path.azimuth??""),String(result.path.offset??""),result.path.alignmentName??"",String(result.path.step),String(result.path.elevation??"")];
    if(viewOptions.beforeLabel!==undefined||viewOptions.afterLabel!==undefined){names.push("before_scenario","after_scenario");values.push(viewOptions.beforeLabel??"",viewOptions.afterLabel??"")}
    const text=toCsv(rows.map((row,i)=>[...row,...(i===0?names:values)])),name=`${slug(before.project.name)}-${slug(before.id).slice(0,12)}-to-${slug(after.project.name)}-${slug(after.id).slice(0,12)}-comparison.csv`;
    if(viewOptions.download)viewOptions.download(name,text,"text/csv");
    else{
      const a=document.createElement("a"),url=URL.createObjectURL(new Blob([text],{type:"text/csv"}));
      a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
    }
  }

  controls.addEventListener("submit",event=>{event.preventDefault();void run()});
  controls.addEventListener("input",()=>{syncMode();invalidate()});
  controls.addEventListener("change",()=>{syncMode();invalidate()});
  cancelButton.onclick=()=>{invalidate("Comparison canceled.");runButton.focus({preventScroll:true})};
  csvButton.onclick=exportCsv;closeButton.onclick=close;
  results.addEventListener("change",event=>{
    const select=event.target as HTMLSelectElement;
    if(select.classList.contains("cmp-surface"))results.querySelector(".cmp-plot")!.innerHTML=plot(select.value);
  });
  dialog.addEventListener("cancel",event=>{event.preventDefault();close()});dialog.addEventListener("close",close);dialog.addEventListener("keydown",onKey);
  syncMode();document.body.appendChild(dialog);document.body.style.overflow="hidden";closeActive=close;dialog.showModal();closeButton.focus({preventScroll:true});
}
