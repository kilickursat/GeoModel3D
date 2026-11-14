// Proposed locations remain a separate planning document; they never become observations in the ground model.
import type {Alignment,GeoProject} from "./schema";
import type {InvestigationOptions,InvestigationPlan,InvestigationProposal,InvestigationDisagreementContext} from "./investigation";
import type {CorridorFlag} from "./corridor";
import {investigationCsv} from "./investigation";
import {createInvestigationJob} from "./investigationJob";
import {parseCsv,toCsv} from "./io";
import pkg from "../package.json";
import "./investigation.css";

export interface InvestigationViewOptions {
  download?(name:string,text:string,type:string):void;
  projectLabel?:string;engineVersion?:string;initialStep?:number;
  initialMinCover?:number;initialMaxSupportDistance?:number;
  disagreementContext?:InvestigationDisagreementContext;
  onSelectChainage?(chainage:number):void;
}
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const finite=(n:number|undefined):n is number=>n!==undefined&&Number.isFinite(n);
const format=(n:number|undefined,d=2)=>finite(n)?n.toLocaleString("en-US",{maximumFractionDigits:d}):"Unavailable";
const metres=(n:number|undefined)=>`${format(n)}${finite(n)?" m":""}`;
const slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"investigation";
const flagNames:Record<CorridorFlag,string>={"outside-model":"Outside model","missing-design":"Missing design level","above-ground":"Design above ground","below-model":"Design below model","low-cover":"Cover below screen","water-above-design":"Water above design top","water-unknown":"Groundwater unavailable","distant-support":"Log distance above screen","no-support":"No used logs"};
let closeActive:(()=>void)|undefined,sequence=0;

export function showInvestigationPlanner(source:GeoProject,line:Alignment,options:InvestigationViewOptions={}):void{
  closeActive?.();
  const project=structuredClone(source),alignment=structuredClone(line),capturedAt=new Date().toISOString(),engineVersion=options.engineVersion??pkg.version;
  const disagreementContext=options.disagreementContext?structuredClone(options.disagreementContext):undefined;
  const opener=document.activeElement instanceof HTMLElement?document.activeElement:null,oldOverflow=document.body.style.overflow;
  let result:InvestigationPlan|undefined,request:ReturnType<typeof createInvestigationJob>|undefined,generation=0,closed=false,busy=false,selected=0;
  const heading=`planner-heading-${++sequence}`,dialog=document.createElement("dialog");
  dialog.className="planner-dialog";dialog.setAttribute("aria-labelledby",heading);
  dialog.innerHTML=`<header class="planner-header"><h2 id="${heading}">Investigation planner</h2><button type="button" class="planner-close" aria-label="Close investigation planner">Close</button></header>
<div class="planner-body"><div class="planner-context"><b>${esc(options.projectLabel?`${options.projectLabel} · ${project.name}`:project.name)}</b><span>Alignment: ${esc(alignment.name)}</span><small>Snapshot opened ${esc(new Date(capturedAt).toLocaleString())} · GeoModel3D ${esc(engineVersion)}</small></div>
<p>Propose locations at sampled corridor stations, starting with gaps in the logs used by the model. Proposals are a planning document; no boreholes or measurements are added to the model.</p>
<form class="planner-controls" novalidate>
<label>Location budget (count)<input class="planner-budget" type="number" min="1" max="50" step="1" value="5" required></label>
<label>Minimum location spacing (plan m)<input class="planner-spacing" type="number" min="0" step="any" value="20" required></label>
<label>Candidate spacing (chainage m)<input class="planner-step" type="number" min="0" step="any" value="${finite(options.initialStep)&&options.initialStep!>0?options.initialStep:10}" required></label>
<label>Depth below design (m), optional<input class="planner-depth" type="number" min="0" step="any" placeholder="No depth proposal"></label>
<label>Cover screen for flag priority (m), optional<input class="planner-min-cover" type="number" min="0" step="any" value="${finite(options.initialMinCover)?options.initialMinCover:""}" placeholder="Off"></label>
<label>Used-log distance screen (m), optional<input class="planner-max-distance" type="number" min="0" step="any" value="${finite(options.initialMaxSupportDistance)?options.initialMaxSupportDistance:""}" placeholder="Off"></label>
<label class="planner-check"><input type="checkbox" class="planner-outside"><span>Include stations outside the model</span></label><label class="planner-check"><input type="checkbox" class="planner-prioritize"><span>Prioritize known screening flags before coverage gaps</span></label>
<label class="planner-check"><input type="checkbox" class="planner-disagreement"${disagreementContext?" checked":" disabled"}><span>Prioritize selected-model disagreement before coverage gaps</span></label>
<p class="planner-setting-note planner-disagreement-context">${disagreementContext?`Selected contact: ${esc(disagreementContext.unitId)}. Pinned interpretations: ${disagreementContext.cases.map(c=>`${esc(c.label??c.project.name)} (${esc(c.id)})`).join(", ")}. In this mode, spacing also avoids recorded collars from every selected case.`:"Open the planner from Model disagreement to enable a priority based on selected saved interpretations."}</p>
<p class="planner-setting-note">Budget is a number of locations, not money. Minimum spacing uses horizontal distance from all recorded collars and other proposals. Clear optional fields to turn them off. Flag priority uses the screens shown here and known design/water conditions; missing data are not a severity score.</p>
<div class="planner-actions"><button type="submit" class="planner-run">Generate plan</button><button type="button" class="planner-cancel" hidden>Cancel</button><button type="button" class="planner-csv" disabled>Download proposal CSV</button><button type="button" class="planner-json" disabled>Download plan JSON</button></div></form>
<p class="planner-status" role="status">Choose the location count and spacing, then generate a plan.</p><p class="planner-error" role="alert" hidden></p><div class="planner-results" hidden></div></div>`;
  const $=<T extends HTMLElement>(selector:string)=>dialog.querySelector<T>(selector)!;
  const controls=$<HTMLFormElement>(".planner-controls"),runButton=$<HTMLButtonElement>(".planner-run"),cancelButton=$<HTMLButtonElement>(".planner-cancel"),csvButton=$<HTMLButtonElement>(".planner-csv"),jsonButton=$<HTMLButtonElement>(".planner-json"),closeButton=$<HTMLButtonElement>(".planner-close"),status=$(".planner-status"),error=$(".planner-error"),results=$(".planner-results");
  function stop(){generation++;request?.cancel();request=undefined;busy=false;runButton.disabled=false;cancelButton.hidden=true}
  function reset(message="Settings changed. Generate a plan to update proposals."){stop();result=undefined;csvButton.disabled=true;jsonButton.disabled=true;results.hidden=true;results.replaceChildren();error.hidden=true;status.textContent=message}
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
    const focusable=[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(e=>e.getClientRects().length>0),first=focusable[0],last=focusable.at(-1);
    if(!first||!last){event.preventDefault();closeButton.focus();return}
    if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last.focus()}
    else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first.focus()}
  }
  function numeric(selector:string,label:string,optional=false,positive=false){
    const input=$<HTMLInputElement>(selector),raw=input.value.trim();
    if(input.validity.badInput)throw new Error(`${label} must be a finite number.`);
    if(optional&&!raw)return undefined;
    if(!raw||!Number.isFinite(Number(raw)))throw new Error(`${label} must be a finite number.`);
    const value=Number(raw);if(positive?value<=0:value<0)throw new Error(`${label} must be ${positive?"greater than zero":"zero or greater"}.`);
    return value;
  }
  function settings():InvestigationOptions{
    const budget=numeric(".planner-budget","Location budget",false,true)!,minSpacing=numeric(".planner-spacing","Minimum spacing")!,step=numeric(".planner-step","Candidate spacing",false,true)!;
    if(!Number.isInteger(budget)||budget>50)throw new Error("Location budget must be a whole number from 1 to 50.");
    const depthBelowDesign=numeric(".planner-depth","Depth below design",true),minCover=numeric(".planner-min-cover","Cover screen",true),maxSupportDistance=numeric(".planner-max-distance","Used-log distance screen",true);
    const prioritizeDisagreement=$<HTMLInputElement>(".planner-disagreement").checked;
    return {budget,minSpacing,step,includeOutside:$<HTMLInputElement>(".planner-outside").checked,prioritizeFlags:$<HTMLInputElement>(".planner-prioritize").checked,
      ...(prioritizeDisagreement?{prioritizeDisagreement:true,disagreementContext}:{}),
      ...(depthBelowDesign===undefined?{}:{depthBelowDesign}),...(minCover===undefined?{}:{minCover}),...(maxSupportDistance===undefined?{}:{maxSupportDistance})};
  }
  async function run(){
    reset("Preparing investigation plan…");let specification:InvestigationOptions;
    try{specification=settings()}catch(err){error.textContent=(err as Error).message;error.hidden=false;status.textContent="Plan not generated.";return}
    const token=generation;busy=true;runButton.disabled=true;cancelButton.hidden=false;status.textContent="Selecting locations on the pinned corridor…";
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));if(closed||token!==generation)return;
    try{
      request=createInvestigationJob(project,alignment,specification);const planned=await request.result;
      if(closed||token!==generation)return;
      result=planned;selected=0;render();csvButton.disabled=false;jsonButton.disabled=false;
      status.textContent=`Plan ready: ${format(planned.proposals.length,0)} of ${format(planned.options.budget,0)} requested locations proposed.`;
    }catch(err){if(closed||token!==generation)return;error.textContent=err instanceof Error?err.message:String(err);error.hidden=false;status.textContent="Plan could not be generated."}
    finally{if(token===generation){request=undefined;busy=false;runButton.disabled=false;cancelButton.hidden=true}}
  }
  function flags(site:InvestigationProposal){return site.flags.length?site.flags.map(flag=>`<span class="planner-flag">${flagNames[flag]}</span>`).join(" "):"No screening flags at this sampled station"}
  function render(){
    if(!result)return;const r=result,s=r.summary;
    results.innerHTML=`<dl class="planner-summary"><div><dt>Proposals / location budget</dt><dd>${format(s.proposedCount,0)} / ${format(r.options.budget,0)}</dd></div><div><dt>Eligible candidate stations</dt><dd>${format(s.eligibleCount,0)}</dd></div><div><dt>Sampled max gap to used logs</dt><dd>${metres(s.maxGapBefore)}</dd></div><div><dt>Hypothetical max gap with proposals</dt><dd>${metres(s.maxGapAfter)}</dd></div></dl>
<p class="planner-proxy-note">Distance summaries refer to the same eligible candidate grid, first using existing logs and then treating proposed locations as hypothetical support points. They do not mean that the geological model has improved or that drilling has occurred.</p>
${s.budgetShortfall?`<p class="planner-shortfall">${format(s.budgetShortfall,0)} requested locations could not be placed on this candidate grid with these spacing and coverage settings. Reduce spacing, change candidate sampling, or review outside-model locations explicitly.</p>`:""}
<details class="planner-exclusions"><summary>Candidate exclusions</summary><p>${format(s.stationCount,0)} sampled stations: ${format(s.excludedOutside,0)} outside-model exclusions, ${format(s.excludedRecorded,0)} too close to recorded collars, and ${format(s.excludedDuplicate,0)} repeated locations.${s.excludedDisagreement!==undefined?` ${format(s.excludedDisagreement,0)} candidates lacked a complete selected-model range.`:""} ${format(s.excludedByProposals,0)} remaining candidates were blocked by spacing to selected proposals.</p></details>
<h3>Proposed location map</h3><div class="planner-map">${map(r)}</div><p class="planner-map-key"><span class="planner-line-key">Alignment</span><span class="planner-used-key">Log used by model</span><span class="planner-recorded-key">Other recorded collar</span><span class="planner-proposed-key">Proposed location · selection rank</span></p><p class="planner-caption">X and Y use the same scale. Markers are proposed investigation sites; they do not represent measured borehole data or an area of influence.</p>
${r.proposals.length?`<h3>Locations in selection order</h3><p>${r.options.prioritizeDisagreement?`Locations prioritize the complete selected-interpretation range for contact ${esc(r.disagreement!.unitId)}, then horizontal coverage gaps. These ranges are model disagreement, not calibrated probabilities.`:r.options.prioritizeFlags?"Known screening flags are prioritized, then horizontal coverage gaps.":"Locations are selected by the largest remaining horizontal gap to used logs and earlier proposals."} Reasons below describe each selection; a later rank is not a lower geological risk classification.</p><div class="planner-table-wrap" tabindex="0" aria-label="Proposed investigation locations; scroll horizontally on small screens"><table class="planner-sites"><thead><tr><th>Proposal</th><th>Chainage (m)</th><th>X (m)</th><th>Y (m)</th><th>Model coverage</th><th>Nearest used-log distance (m)</th><th>Gap when selected (m)</th>${r.disagreement?"<th>Selected range (m)</th>":""}<th>Proposed depth (m)</th></tr></thead><tbody>${r.proposals.map((site,index)=>`<tr data-planner-row="${index}"><th scope="row"><button type="button" data-planner-index="${index}">${esc(site.id)} · ${format(site.rank,0)}</button></th><td>${format(site.chainage)}</td><td>${format(site.x)}</td><td>${format(site.y)}</td><td>${site.inside?"Within model":"Outside model"}</td><td>${format(site.baselineDistance)}</td><td>${format(site.planningDistance)}</td>${r.disagreement?`<td>${format(site.modelRange?.width)}</td>`:""}<td>${format(site.proposedDepth)}</td></tr>`).join("")}</tbody></table></div><section class="planner-detail"><div class="planner-site-actions"><label>Selected proposal<select class="planner-site">${r.proposals.map((site,index)=>`<option value="${index}">${esc(site.id)} · chainage ${format(site.chainage)} m</option>`).join("")}</select></label>${options.onSelectChainage?'<button type="button" class="planner-view-chainage">View at chainage</button>':""}</div><div class="planner-selected"></div></section>`:'<p class="planner-empty">No locations were proposed with these settings. The model and its observations are unchanged; the exports preserve this empty planning result and its reasons.</p>'}
<details class="planner-methods"><summary>How this plan was selected</summary><ul>${r.notes.map(note=>`<li>${esc(note)}</li>`).join("")}</ul><p>Proposed depths, if supplied, are based on model-derived ground and design elevations. Verify access, utilities, ground levels and investigation requirements before using a location in the field.</p></details>`;
    results.hidden=false;renderSelected();
  }
  function map(r:InvestigationPlan){
    const points=[...r.recordedLogs,...alignment.points,...r.proposals].filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
    if(!points.length)return '<p class="planner-unavailable">Location map unavailable.</p>';
    const W=820,H=390,m={l:80,r:38,t:24,b:50},pw=W-m.l-m.r,ph=H-m.t-m.b;
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys),cx=(x0+x1)/2,cy=(y0+y1)/2;
    const scale=Math.min(pw/(Math.max(1,x1-x0)*1.14),ph/(Math.max(1,y1-y0)*1.14)),x=(v:number)=>m.l+pw/2+(v-cx)*scale,y=(v:number)=>m.t+ph/2-(v-cy)*scale;
    const grid=Array.from({length:5},(_,i)=>{const px=m.l+pw*i/4,py=m.t+ph*i/4,vx=cx+(px-m.l-pw/2)/scale,vy=cy-(py-m.t-ph/2)/scale;return `<line x1="${px}" y1="${m.t}" x2="${px}" y2="${m.t+ph}" stroke="#e3e8ec"/><line x1="${m.l}" y1="${py}" x2="${m.l+pw}" y2="${py}" stroke="#e3e8ec"/><text x="${px}" y="${m.t+ph+19}" text-anchor="middle">${format(vx,1)}</text><text x="${m.l-8}" y="${py+4}" text-anchor="end">${format(vy,1)}</text>`}).join("");
    const key=(log:{kind:string;id:string;x:number;y:number})=>JSON.stringify([log.kind,log.id,log.x,log.y]),used=new Set(r.usedLogs.map(key));
    const recorded=r.recordedLogs.map(log=>`<circle cx="${x(log.x)}" cy="${y(log.y)}" r="4" fill="${used.has(key(log))?"#5c6b78":"white"}" stroke="#5c6b78" stroke-width="1.5"><title>${esc(`${log.id} (${log.kind}), ${used.has(key(log))?"used by model":"other recorded collar"}`)}</title></circle>`).join("");
    const route=alignment.points.map((p,index)=>`${index?"L":"M"}${x(p.x)},${y(p.y)}`).join("");
    const proposed=r.proposals.map((site,index)=>`<g role="button" tabindex="0" class="planner-map-site" data-planner-index="${index}" aria-label="${esc(`${site.id}, selection rank ${site.rank}, chainage ${format(site.chainage)} metres`)}"><circle cx="${x(site.x)}" cy="${y(site.y)}" r="11" fill="#1f6fd1" stroke="white" stroke-width="2"/><text x="${x(site.x)}" y="${y(site.y)+4}" fill="white" text-anchor="middle" font-size="11" font-weight="600">${site.rank}</text><title>${esc(site.id)}</title></g>`).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="group" aria-label="Recorded and proposed investigation locations along ${esc(alignment.name)}"><rect width="${W}" height="${H}" fill="white"/><g font-family="sans-serif" font-size="11" fill="#4d5964">${grid}<text x="${m.l}" y="14">Y (m)</text><text x="${m.l+pw/2}" y="${H-6}" text-anchor="middle">X (m)</text></g><path d="${route}" fill="none" stroke="#918273" stroke-width="2"/>${recorded}${proposed}</svg>`;
  }
  function renderSelected(){
    if(!result?.proposals.length)return;const site=result.proposals[selected];if(!site)return;
    $<HTMLSelectElement>(".planner-site").value=String(selected);
    $(".planner-selected").innerHTML=`<h3 class="planner-selected-name">${esc(site.id)} · selection rank ${format(site.rank,0)}</h3><p class="planner-location">Chainage ${format(site.chainage)} m · X ${format(site.x)} m · Y ${format(site.y)} m · ${site.inside?"Within model coverage":"Outside model coverage"}.</p><ul class="planner-reasons">${site.reasons.map(reason=>`<li>${esc(reason)}</li>`).join("")}</ul><dl class="planner-readouts"><div><dt>Nearest used-log distance before planning</dt><dd>${metres(site.baselineDistance)}</dd></div><div><dt>Gap to used logs and earlier proposals at selection</dt><dd>${metres(site.planningDistance)}</dd></div><div><dt>Nearest recorded collar</dt><dd>${metres(site.nearestRecordedDistance)}</dd></div><div><dt>Model-derived ground elevation</dt><dd>${metres(site.ground)}</dd></div><div><dt>Design top / bottom</dt><dd>${metres(site.top)} / ${metres(site.bottom)}</dd></div><div><dt>Proposed depth below model-derived ground</dt><dd>${metres(site.proposedDepth)}</dd></div><div><dt>Depth target reference</dt><dd>${site.targetReference==="design-bottom"?"Design bottom":site.targetReference==="design-top"?"Design top":"Unavailable"} · ${metres(site.targetElevation)}</dd></div><div><dt>Proposed termination elevation</dt><dd>${metres(site.terminationElevation)}</dd></div>${site.modelRange?`<div class="planner-model-range"><dt>Selected-interpretation contact range</dt><dd>${metres(site.modelRange.min)} to ${metres(site.modelRange.max)} · width ${metres(site.modelRange.width)} · ${site.modelRange.count}/${site.modelRange.total} cases</dd></div>`:""}<div><dt>Unit at design top / bottom</dt><dd>${esc(site.unitTop?.name??site.topPosition??"Unavailable")} / ${esc(site.unitBottom?.name??site.bottomPosition??"Unavailable")}</dd></div></dl>${site.belowModel?'<p class="planner-depth-note">Proposed termination is below the current model. The model does not predict the deeper geology.</p>':""}<div class="planner-selected-flags">${flags(site)}</div>`;
    for(const row of results.querySelectorAll<HTMLElement>("[data-planner-row]"))row.classList.toggle("planner-selected-row",Number(row.dataset.plannerRow)===selected);
    for(const marker of results.querySelectorAll<SVGGElement>(".planner-map-site"))marker.setAttribute("aria-pressed",String(Number(marker.dataset.plannerIndex)===selected));
  }
  function choose(index:number){if(result&&Number.isInteger(index)&&result.proposals[index]){selected=index;renderSelected()}}
  function download(name:string,text:string,type:string){
    if(options.download){options.download(name,text,type);return}
    const a=document.createElement("a"),url=URL.createObjectURL(new Blob([text],{type}));a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
  }
  function exportCsv(){
    if(!result||busy)return;
    const rows=parseCsv(investigationCsv(result),","),names=["snapshot_captured_at","engine_version","scenario_label"],values=[capturedAt,engineVersion,options.projectLabel??""];
    if(rows.length===1)rows.push(rows[0].map(()=>""));
    download(`${slug(project.name)}-${slug(alignment.name)}-investigation.csv`,toCsv(rows.map((row,i)=>[...row,...(i===0?names:values)])),"text/csv");
  }
  function exportJson(){if(result&&!busy)download(`${slug(project.name)}-${slug(alignment.name)}-investigation-plan.json`,JSON.stringify({...result,snapshotCapturedAt:capturedAt,engineVersion,scenarioLabel:options.projectLabel??""},null,2)+"\n","application/json")}
  controls.addEventListener("submit",event=>{event.preventDefault();void run()});
  controls.addEventListener("input",event=>{
    const input=event.target as HTMLInputElement;
    if(input.checked&&input.classList.contains("planner-disagreement"))$<HTMLInputElement>(".planner-prioritize").checked=false;
    if(input.checked&&input.classList.contains("planner-prioritize"))$<HTMLInputElement>(".planner-disagreement").checked=false;
    reset();
  });controls.addEventListener("change",()=>reset());
  cancelButton.onclick=()=>{reset("Investigation planning canceled.");runButton.focus({preventScroll:true})};csvButton.onclick=exportCsv;jsonButton.onclick=exportJson;closeButton.onclick=close;
  results.addEventListener("change",event=>{if(event.target instanceof HTMLSelectElement&&event.target.classList.contains("planner-site"))choose(Number(event.target.value))});
  results.addEventListener("click",event=>{if(!(event.target instanceof Element))return;const marker=event.target.closest<HTMLElement|SVGGElement>("[data-planner-index]");if(marker){choose(Number(marker.dataset.plannerIndex));return}if(event.target.closest(".planner-view-chainage")){const site=result?.proposals[selected];if(site){close();options.onSelectChainage?.(site.chainage)}}});
  results.addEventListener("keydown",event=>{if((event.key==="Enter"||event.key===" ")&&event.target instanceof SVGElement){const marker=event.target.closest<SVGGElement>("[data-planner-index]");if(marker){event.preventDefault();choose(Number(marker.dataset.plannerIndex))}}});
  dialog.addEventListener("cancel",event=>{event.preventDefault();close()});dialog.addEventListener("close",close);dialog.addEventListener("keydown",onKey);
  document.body.appendChild(dialog);document.body.style.overflow="hidden";closeActive=close;dialog.showModal();closeButton.focus({preventScroll:true});
}
