// A pinned alignment is screened at explicit stations. The dashboard never turns missing inputs into safe results.
import type {Alignment,GeoProject} from "./schema";
import type {CorridorFlag,CorridorOptions,CorridorPosition,CorridorReport,CorridorStation} from "./corridor";
import {corridorCsv} from "./corridor";
import {createCorridorJob} from "./corridorJob";
import {showInvestigationPlanner} from "./investigationView";
import {parseCsv,toCsv} from "./io";
import pkg from "../package.json";
import "./corridor.css";

export interface CorridorViewOptions {
  download?(name:string,text:string,type:string):void;
  projectLabel?:string;engineVersion?:string;initialStep?:number;
  onSelectChainage?(chainage:number):void;
}
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const finite=(n:number|undefined):n is number=>n!==undefined&&Number.isFinite(n);
const format=(n:number|undefined,d=2)=>finite(n)?n.toLocaleString("en-US",{maximumFractionDigits:d}):"Unavailable";
const metres=(n:number|undefined)=>`${format(n)}${finite(n)?" m":""}`;
const slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"corridor";
const flagNames:Record<CorridorFlag,string>={"outside-model":"Outside model","missing-design":"Missing design level","above-ground":"Design above ground","below-model":"Design below model","low-cover":"Cover below screen","water-above-design":"Water above design top","water-unknown":"Groundwater unavailable","distant-support":"Log distance above screen","no-support":"No used logs"};
const positions:Record<CorridorPosition,string>={inside:"Within model","above-ground":"Above ground","below-model":"Below model","outside-model":"Outside model"};
let closeActive:(()=>void)|undefined,sequence=0;

export function showCorridor(source:GeoProject,line:Alignment,options:CorridorViewOptions={}):void{
  closeActive?.();
  // These inputs remain fixed while the live viewer can subsequently load another project or interpretation.
  const project=structuredClone(source),alignment=structuredClone(line),capturedAt=new Date().toISOString(),engineVersion=options.engineVersion??pkg.version;
  const opener=document.activeElement instanceof HTMLElement?document.activeElement:null,oldOverflow=document.body.style.overflow;
  let result:CorridorReport|undefined,request:ReturnType<typeof createCorridorJob>|undefined,generation=0,closed=false,busy=false,selected=0;
  const heading=`corridor-heading-${++sequence}`,dialog=document.createElement("dialog");
  dialog.className="corridor-dialog";dialog.setAttribute("aria-labelledby",heading);
  dialog.innerHTML=`<header class="corridor-header"><h2 id="${heading}">Corridor dashboard</h2><button type="button" class="corridor-close" aria-label="Close corridor dashboard">Close</button></header>
<div class="corridor-body"><div class="corridor-context"><b>${esc(options.projectLabel?`${options.projectLabel} · ${project.name}`:project.name)}</b><span>Alignment: ${esc(alignment.name)}</span><small>Snapshot opened ${esc(new Date(capturedAt).toLocaleString())} · GeoModel3D ${esc(engineVersion)}</small></div>
<p>Review ground, design levels and nearby used logs along this alignment. Flags describe screening conditions at sampled stations; they are not safety or design acceptance criteria.</p>
<form class="corridor-controls" novalidate><label>Station spacing (chainage m)<input class="corridor-step" type="number" min="0" step="any" required value="${finite(options.initialStep)&&options.initialStep!>0?options.initialStep:10}"></label><label>Minimum cover screen (m), optional<input class="corridor-min-cover" type="number" min="0" step="any" value="5" placeholder="Off"></label><label>Maximum used-log distance screen (m), optional<input class="corridor-max-distance" type="number" min="0" step="any" value="100" placeholder="Off"></label><p class="corridor-setting-note">The 5 m cover and 100 m distance screens are editable starting values. Clear either field to disable that screen. Log distance is measured in plan and does not measure confidence.</p><div class="corridor-actions"><button type="submit" class="corridor-run">Run dashboard</button><button type="button" class="corridor-cancel" hidden>Cancel</button><button type="button" class="corridor-csv" disabled>Download corridor CSV</button><button type="button" class="corridor-plan">Plan investigation</button></div></form>
<p class="corridor-status" role="status">Choose screening settings, then run the dashboard.</p><p class="corridor-error" role="alert" hidden></p><div class="corridor-results" hidden></div></div>`;
  const $=<T extends HTMLElement>(selector:string)=>dialog.querySelector<T>(selector)!;
  const closeButton=$<HTMLButtonElement>(".corridor-close"),runButton=$<HTMLButtonElement>(".corridor-run"),cancelButton=$<HTMLButtonElement>(".corridor-cancel"),csvButton=$<HTMLButtonElement>(".corridor-csv");
  const controls=$<HTMLFormElement>(".corridor-controls"),status=$(".corridor-status"),error=$(".corridor-error"),results=$(".corridor-results");
  function stop(){generation++;request?.cancel();request=undefined;busy=false;runButton.disabled=false;cancelButton.hidden=true}
  function reset(message="Settings changed. Run dashboard to update results."){stop();result=undefined;csvButton.disabled=true;results.hidden=true;results.replaceChildren();error.hidden=true;status.textContent=message}
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
  function numeric(selector:string,label:string,optional=false){
    const input=$<HTMLInputElement>(selector),raw=input.value.trim();
    if(input.validity.badInput)throw new Error(`${label} must be a finite number.`);
    if(optional&&!raw)return undefined;
    if(!raw||!Number.isFinite(Number(raw)))throw new Error(`${label} must be a finite number.`);
    const value=Number(raw);if(optional?value<0:value<=0)throw new Error(`${label} must be ${optional?"zero or greater":"greater than zero"}.`);
    return value;
  }
  function settings():CorridorOptions{
    const step=numeric(".corridor-step","Station spacing")!,minCover=numeric(".corridor-min-cover","Minimum cover",true),maxSupportDistance=numeric(".corridor-max-distance","Maximum used-log distance",true);
    return {step,...(minCover===undefined?{}:{minCover}),...(maxSupportDistance===undefined?{}:{maxSupportDistance})};
  }
  async function run(){
    reset("Preparing corridor dashboard…");
    let specification:CorridorOptions;
    try{specification=settings()}catch(err){error.textContent=(err as Error).message;error.hidden=false;status.textContent="Dashboard not run.";return}
    const token=generation;busy=true;runButton.disabled=true;cancelButton.hidden=false;status.textContent="Screening the pinned alignment…";
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    if(closed||token!==generation)return;
    try{
      request=createCorridorJob(project,alignment,specification);const report=await request.result;
      if(closed||token!==generation)return;
      result=report;selected=0;render();csvButton.disabled=false;
      status.textContent=`Dashboard ready: ${format(report.summary.stationCount,0)} stations; ${format(report.summary.insideCount,0)} within the model; ${format(report.summary.flaggedStationCount,0)} with screening flags.`;
    }catch(err){
      if(closed||token!==generation)return;
      error.textContent=err instanceof Error?err.message:String(err);error.hidden=false;status.textContent="Dashboard could not be completed.";
    }finally{if(token===generation){request=undefined;busy=false;runButton.disabled=false;cancelButton.hidden=true}}
  }
  function flags(station:CorridorStation){return station.flags.length?station.flags.map(f=>`<span class="corridor-flag" data-corridor-flag="${f}">${flagNames[f]}</span>`).join(" "):'<span class="corridor-no-flags">None at this station</span>'}
  function unit(station:CorridorStation,side:"top"|"bottom"){
    const definition=side==="top"?station.unitTop:station.unitBottom,position=side==="top"?station.topPosition:station.bottomPosition;
    return definition?`${definition.name} (${definition.id})`:position?positions[position]:"Unavailable";
  }
  function extreme(value:{chainage:number;value:number}|undefined){return value?`${metres(value.value)} at ${format(value.chainage)} m`:"Unavailable"}
  function render(){
    if(!result)return;
    const r=result,s=r.summary;
    results.innerHTML=`<dl class="corridor-summary"><div><dt>Stations within model / total</dt><dd>${format(s.insideCount,0)} / ${format(s.stationCount,0)}</dd></div><div><dt>Sampled minimum cover</dt><dd>${extreme(s.minCover)}</dd></div><div><dt>Sampled maximum water − design top</dt><dd>${extreme(s.maxWaterHead)}</dd></div><div><dt>Stations with screening flags</dt><dd>${format(s.flaggedStationCount,0)}</dd></div></dl>
<p class="corridor-sampling">Chainage ${format(r.range.start)}–${format(r.range.end)} m. Regular spacing ${format(r.range.actualStep,4)} chainage m, plus alignment, design and model-boundary stations. Counts describe stations, not corridor length. Conditions between stations may be missed.</p>
<h3>Longitudinal profile</h3><div class="corridor-legend"><span class="corridor-ground-key">Ground</span><span class="corridor-water-key">Groundwater</span><span class="corridor-top-key">Design top</span><span class="corridor-bottom-key">Design bottom</span></div><div class="corridor-plot" tabindex="0" role="group" aria-label="Corridor elevation profile; use left and right arrows to select a station">${plot()}</div><p class="corridor-caption">All elevations use the same scale. Gaps indicate unavailable values. Select a station from the profile or table; use left and right arrows on the profile to move between stations.</p>
<section class="corridor-detail"><div class="corridor-station-actions"><label>Selected chainage (m)<select class="corridor-station">${r.stations.map((station,index)=>`<option value="${index}">${format(station.chainage)}</option>`).join("")}</select></label>${options.onSelectChainage?'<button type="button" class="corridor-view corridor-view-chainage">View at chainage</button>':""}</div><div class="corridor-selected"></div></section>
<h3>Screening flag counts</h3><p>Flags can overlap at a station. No flags means only that none of these screens triggered at that sampled location.</p><div class="corridor-flag-counts">${Object.entries(s.counts).filter(([,count])=>count>0).map(([flag,count])=>`<span>${flagNames[flag as CorridorFlag]}: <b>${format(count,0)}</b></span>`).join("")||"No screening flags at the sampled stations."}</div>
<h3>Stations by chainage</h3><label class="corridor-filter-label">Show stations<select class="corridor-filter"><option value="all">All stations</option><option value="flagged">With screening flags</option><option value="outside-model">Outside model</option><option value="low-cover">Cover below screen</option><option value="water-above-design">Water above design top</option><option value="distant-support">Log distance above screen</option></select></label><div class="corridor-table-wrap" tabindex="0" aria-label="Corridor station values; scroll horizontally on small screens"><table class="corridor-stations"><thead><tr><th>Chainage (m)</th><th>Model coverage</th><th>Ground (m)</th><th>Design top (m)</th><th>Cover (m)</th><th>Water − top (m)</th><th>Unit at top</th><th>Unit at bottom</th><th>Nearest used log</th><th>Plan distance (m)</th><th>Screening flags</th></tr></thead><tbody>${stationRows(r)}</tbody></table></div>
<details class="corridor-methods"><summary>How to read this dashboard</summary><ul>${r.notes.map(n=>`<li>${esc(n)}</li>`).join("")}</ul><p>Cover = ground elevation − design top. Water above design top = water elevation − design top; negative values mean water below that level. This is a geometric water-level difference, not a groundwater flow calculation. All results refer to the snapshot named above.</p></details>`;
    results.hidden=false;renderSelected();
  }
  function stationRows(r:CorridorReport){
    return r.stations.map((station,index)=>`<tr data-corridor-row="${index}"><th scope="row"><button type="button" data-corridor-index="${index}">${format(station.chainage)}</button></th><td>${station.inside?"Within model":"Outside model"}</td><td>${format(station.ground)}</td><td>${format(station.top)}</td><td>${format(station.cover)}</td><td>${format(station.waterHead)}</td><td>${esc(unit(station,"top"))}</td><td>${esc(unit(station,"bottom"))}</td><td>${station.nearestLog?`${esc(station.nearestLog.id)} (${station.nearestLog.kind==="cpt"?"CPT":"borehole"})`:"Unavailable"}</td><td>${format(station.nearestLog?.distance)}</td><td class="corridor-flags">${flags(station)}</td></tr>`).join("");
  }
  function plot(){
    if(!result)return "";
    const r=result,values=r.stations.flatMap(station=>[station.ground,station.water,station.top,station.bottom]).filter(finite);
    if(!values.length)return '<p class="corridor-unavailable">No model or design elevations are available along this alignment.</p>';
    const W=860,H=330,m={l:70,r:28,t:24,b:48},pw=W-m.l-m.r,ph=H-m.t-m.b;
    const x0=r.range.start,x1=r.range.end,xspan=x1-x0||1,low=Math.min(...values),high=Math.max(...values),pad=Math.max(.5,(high-low)*.12),y0=low-pad,y1=high+pad;
    const x=(value:number)=>m.l+(value-x0)/xspan*pw,y=(value:number)=>m.t+(y1-value)/(y1-y0)*ph;
    const paths=([['ground','#5d4936',''],['water','#237cc1','6 4'],['top','#b23c42',''],['bottom','#98569c','4 3']] as const).map(([key,colour,dash])=>{
      let path="",open=false;
      for(const station of r.stations){const value=station[key];if(!finite(value)){open=false;continue}path+=`${open?"L":"M"}${x(station.chainage).toFixed(2)},${y(value).toFixed(2)}`;open=true}
      return `<path class="corridor-${key}-line" d="${path}" fill="none" stroke="${colour}" stroke-width="2.5"${dash?` stroke-dasharray="${dash}"`:""}/>`;
    }).join("");
    const grid=Array.from({length:6},(_,i)=>{const vx=x0+xspan*i/5,vy=y0+(y1-y0)*i/5;return `<line x1="${x(vx)}" y1="${m.t}" x2="${x(vx)}" y2="${m.t+ph}" stroke="#e3e8ec"/><line x1="${m.l}" y1="${y(vy)}" x2="${m.l+pw}" y2="${y(vy)}" stroke="#e3e8ec"/><text x="${x(vx)}" y="${m.t+ph+20}" text-anchor="middle">${format(vx)}</text><text x="${m.l-8}" y="${y(vy)+4}" text-anchor="end">${format(vy)}</text>`}).join("");
    const marker=r.stations[selected];
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Ground, groundwater and design elevations along ${esc(alignment.name)}"><rect width="${W}" height="${H}" fill="white"/><g font-family="sans-serif" font-size="12" fill="#4d5964">${grid}<text x="${m.l}" y="15">Elevation (m)</text><text x="${m.l+pw/2}" y="${H-5}" text-anchor="middle">Chainage (m)</text></g>${paths}${marker?`<line class="corridor-marker" x1="${x(marker.chainage)}" y1="${m.t}" x2="${x(marker.chainage)}" y2="${m.t+ph}" stroke="#24313c" stroke-width="1.5" stroke-dasharray="2 3"/>`:""}</svg>`;
  }
  function renderSelected(){
    if(!result)return;
    const station=result.stations[selected];if(!station)return;
    $<HTMLSelectElement>(".corridor-station").value=String(selected);
    $(".corridor-selected").innerHTML=`<h3 class="corridor-selected-chainage">Chainage ${format(station.chainage)} m</h3><p class="corridor-location">X ${format(station.x)} m · Y ${format(station.y)} m · ${station.inside?"Within model coverage":"Outside model coverage"}.</p><dl class="corridor-readouts"><div><dt>Ground elevation</dt><dd>${metres(station.ground)}</dd></div><div><dt>Design top / bottom</dt><dd>${metres(station.top)} / ${metres(station.bottom)}</dd></div><div><dt>Cover above design top</dt><dd>${metres(station.cover)}</dd></div><div><dt>Water elevation / water − top</dt><dd>${metres(station.water)} / ${metres(station.waterHead)}</dd></div><div><dt>Unit at design top</dt><dd>${esc(unit(station,"top"))}</dd></div><div><dt>Unit at design bottom</dt><dd>${esc(unit(station,"bottom"))}</dd></div><div><dt>Nearest used log / plan distance</dt><dd>${station.nearestLog?`${esc(station.nearestLog.id)} (${station.nearestLog.kind==="cpt"?"CPT":"borehole"}) · ${metres(station.nearestLog.distance)}`:"Unavailable"}</dd></div></dl><div class="corridor-selected-flags">${flags(station)}</div>`;
    $(".corridor-plot").innerHTML=plot();
    for(const row of results.querySelectorAll<HTMLElement>("[data-corridor-row]"))row.classList.toggle("corridor-selected-row",Number(row.dataset.corridorRow)===selected);
  }
  function choose(index:number){if(result&&Number.isInteger(index)&&result.stations[index]){selected=index;renderSelected()}}
  function filter(value:string){
    if(!result)return;
    for(const row of results.querySelectorAll<HTMLElement>("[data-corridor-row]")){
      const station=result.stations[Number(row.dataset.corridorRow)];row.hidden=value==="all"?false:value==="flagged"?!station.flags.length:!station.flags.includes(value as CorridorFlag);
    }
  }
  function exportCsv(){
    if(!result||busy)return;
    const rows=parseCsv(corridorCsv(result),","),names=["snapshot_captured_at","engine_version","scenario_label"],values=[capturedAt,engineVersion,options.projectLabel??""];
    const text=toCsv(rows.map((row,i)=>[...row,...(i===0?names:values)])),name=`${slug(project.name)}-${slug(alignment.name)}-corridor.csv`;
    if(options.download)options.download(name,text,"text/csv");
    else{const a=document.createElement("a"),url=URL.createObjectURL(new Blob([text],{type:"text/csv"}));a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000)}
  }
  controls.addEventListener("submit",event=>{event.preventDefault();void run()});
  controls.addEventListener("input",()=>reset());controls.addEventListener("change",()=>reset());
  cancelButton.onclick=()=>{reset("Corridor dashboard canceled.");runButton.focus({preventScroll:true})};csvButton.onclick=exportCsv;closeButton.onclick=close;
  $<HTMLButtonElement>(".corridor-plan").onclick=()=>{
    let initial:CorridorOptions;
    try{initial=settings()}catch(err){error.textContent=(err as Error).message;error.hidden=false;status.textContent="Fix the settings before opening the planner.";return}
    close();
    showInvestigationPlanner(project,alignment,{download:options.download,projectLabel:options.projectLabel,engineVersion,
      initialStep:initial.step,initialMinCover:initial.minCover,initialMaxSupportDistance:initial.maxSupportDistance,
      onSelectChainage:options.onSelectChainage});
  };
  results.addEventListener("change",event=>{
    const select=event.target as HTMLSelectElement;
    if(select.classList.contains("corridor-station"))choose(Number(select.value));
    else if(select.classList.contains("corridor-filter"))filter(select.value);
  });
  results.addEventListener("click",event=>{
    if(!(event.target instanceof Element))return;
    const button=event.target.closest<HTMLElement>("[data-corridor-index]");if(button){choose(Number(button.dataset.corridorIndex));return}
    if(event.target.closest(".corridor-view-chainage")){const station=result?.stations[selected];if(station){close();options.onSelectChainage?.(station.chainage)}return}
    const svg=event.target.closest(".corridor-plot svg");
    if(svg&&result&&event instanceof MouseEvent){const box=svg.getBoundingClientRect(),c=result.range.start+((event.clientX-box.left)/box.width*860-70)/(860-70-28)*(result.range.end-result.range.start);let best=0;result.stations.forEach((station,index)=>{if(Math.abs(station.chainage-c)<Math.abs(result!.stations[best].chainage-c))best=index});choose(best)}
  });
  results.addEventListener("keydown",event=>{if((event.key==="ArrowLeft"||event.key==="ArrowRight")&&event.target instanceof Element&&event.target.closest(".corridor-plot")&&result){event.preventDefault();choose(Math.min(result.stations.length-1,Math.max(0,selected+(event.key==="ArrowRight"?1:-1))))}});
  dialog.addEventListener("cancel",event=>{event.preventDefault();close()});dialog.addEventListener("close",close);dialog.addEventListener("keydown",onKey);
  document.body.appendChild(dialog);document.body.style.overflow="hidden";closeActive=close;dialog.showModal();closeButton.focus({preventScroll:true});
}
