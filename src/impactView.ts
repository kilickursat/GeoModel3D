// New logs test a pinned earlier interpretation before they become part of its updated model.
import type {WorkspaceRevision} from "./workspace";
import type {AddedBoreholeImpact,DataImpactReview,ImpactContact,InputChanges} from "./impact";
import {impactCsv} from "./impact";
import {createImpactJob} from "./impactJob";
import {ComparisonViewOptions,showComparison} from "./comparisonView";
import {parseCsv,toCsv} from "./io";
import "./impact.css";

const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const finite=(n:number|undefined):n is number=>n!==undefined&&Number.isFinite(n);
const format=(n:number|undefined,d=2)=>finite(n)?n.toLocaleString("en-US",{maximumFractionDigits:d}):"Unavailable";
const signed=(n:number|undefined)=>finite(n)?`${n>0?"+":""}${format(n)}`:"Unavailable";
const slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"revision";
const date=(s:string)=>Number.isFinite(Date.parse(s))?new Date(s).toLocaleString():s;
const metres=(n:number|undefined)=>`${format(n)}${finite(n)?" m":""}`;
const agreement=(hole:Pick<AddedBoreholeImpact,"matchingLength"|"comparedLength"|"loggedLength">)=>hole.comparedLength>0?`${format(100*hole.matchingLength/hole.comparedLength,1)}% · ${format(hole.matchingLength)} / ${format(hole.comparedLength)} m compared`:`Unavailable · 0 / ${format(hole.loggedLength)} m compared`;
let closeActive:(()=>void)|undefined,sequence=0;

export function showDataImpact(before:WorkspaceRevision,after:WorkspaceRevision,options:ComparisonViewOptions={}):void{
  closeActive?.();
  const opener=document.activeElement instanceof HTMLElement?document.activeElement:null,oldOverflow=document.body.style.overflow;
  let result:DataImpactReview|undefined,request:ReturnType<typeof createImpactJob>|undefined,generation=0,closed=false,busy=false,selected=0;
  const heading=`impact-heading-${++sequence}`,dialog=document.createElement("dialog");
  dialog.className="impact-dialog";dialog.setAttribute("aria-labelledby",heading);
  const revision=(r:WorkspaceRevision,side:string,label?:string)=>`<div class="impact-revision"><b>${side}: ${label?`${esc(label)} · `:""}${esc(r.project.name)}</b><span>${esc(r.id)}</span><small>${esc(date(r.createdAt))} · GeoModel3D ${esc(r.engineVersion)}</small></div>`;
  dialog.innerHTML=`<header class="impact-header"><h2 id="${heading}">New-data impact review</h2><button type="button" class="impact-close" aria-label="Close impact review">Close</button></header>
<div class="impact-body"><div class="impact-revisions">${revision(before,"Before",options.beforeLabel)}${revision(after,"After",options.afterLabel)}</div>
<p>Check the earlier model's forecasts against newly added borehole logs, then see how the updated interpretation differs at those same collars. Unbuilt edits are excluded.</p>
<div class="impact-actions"><button type="button" class="impact-run">Run impact review</button><button type="button" class="impact-cancel" hidden>Cancel</button><button type="button" class="impact-csv" disabled>Download impact CSV</button><button type="button" class="impact-compare">Compare along section</button></div>
<p class="impact-status" role="status">Run the review to compare these saved revisions.</p><p class="impact-error" role="alert" hidden></p><div class="impact-results" hidden></div></div>`;
  const $=<T extends HTMLElement>(selector:string)=>dialog.querySelector<T>(selector)!;
  const runButton=$<HTMLButtonElement>(".impact-run"),cancelButton=$<HTMLButtonElement>(".impact-cancel"),csvButton=$<HTMLButtonElement>(".impact-csv"),closeButton=$<HTMLButtonElement>(".impact-close");
  const status=$(".impact-status"),error=$(".impact-error"),results=$(".impact-results");
  function stop(){generation++;request?.cancel();request=undefined;busy=false;runButton.disabled=false;cancelButton.hidden=true}
  function reset(message:string){stop();result=undefined;results.hidden=true;results.replaceChildren();csvButton.disabled=true;error.hidden=true;status.textContent=message}
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
    const focusable=[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(e=>e.getClientRects().length>0);
    const first=focusable[0],last=focusable.at(-1);
    if(!first||!last){event.preventDefault();closeButton.focus();return}
    if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last.focus()}
    else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first.focus()}
  }
  async function run(){
    reset("Preparing impact review…");
    const token=generation;busy=true;runButton.disabled=true;cancelButton.hidden=false;status.textContent="Reviewing pinned revisions…";
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    if(closed||token!==generation)return;
    try{
      request=createImpactJob(before.project,after.project);const reviewed=await request.result;
      if(closed||token!==generation)return;
      result=reviewed;selected=0;render();csvButton.disabled=false;
      status.textContent=`Impact review ready: ${format(reviewed.summary.addedBoreholes,0)} added boreholes; ${format(reviewed.summary.reviewedBoreholes,0)} new collars within the earlier model.`;
    }catch(err){
      if(closed||token!==generation)return;
      error.textContent=err instanceof Error?err.message:String(err);error.hidden=false;status.textContent="Impact review could not be completed.";
    }finally{if(token===generation){request=undefined;busy=false;runButton.disabled=false;cancelButton.hidden=true}}
  }
  function inventory(name:string,changes:InputChanges){
    const counts=[changes.added.length,changes.modified.length,changes.removed.length,changes.unchanged.length];
    return `<tr><th scope="row">${name}</th>${counts.map(n=>`<td>${format(n,0)}</td>`).join("")}</tr>`;
  }
  function changeDetails(name:string,changes:InputChanges){
    return `<div><dt>${name}</dt><dd>${([['Added',changes.added],['Modified',changes.modified],['Removed',changes.removed]] as const).map(([label,ids])=>`${label}: ${ids.length?ids.map(esc).join(", "):"None"}`).join("<br>")}</dd></div>`;
  }
  function render(){
    if(!result)return;
    const r=result,s=r.summary,confounded=r.otherChanges.length>0||r.boreholes.modified.length>0||r.boreholes.removed.length>0||r.cpts.added.length>0||r.cpts.modified.length>0||r.cpts.removed.length>0;
    results.innerHTML=`<dl class="impact-summary"><div><dt>Added boreholes</dt><dd>${format(s.addedBoreholes,0)}</dd></div><div><dt>New collars within earlier model</dt><dd>${format(s.reviewedBoreholes,0)}</dd></div><div><dt>Outside earlier model</dt><dd>${format(s.outsideBefore,0)}</dd></div><div><dt>Max |contact forecast error|</dt><dd>${metres(s.maxAbsContactError)}</dd></div></dl>${r.additions.some(h=>h.previouslyObserved)?`<p class="impact-collar-exclusions">${format(r.additions.filter(h=>h.previouslyObserved).length,0)} added IDs use a previously modelled collar. Their forecast errors and logged agreement are excluded because these are not independent new observations.</p>`:""}
<h3>What changed</h3><div class="impact-table-wrap" tabindex="0" aria-label="Input change counts; scroll horizontally on small screens"><table class="impact-inventory"><thead><tr><th>Inputs</th><th>Added</th><th>Modified</th><th>Removed</th><th>Unchanged</th></tr></thead><tbody>${inventory("Boreholes",r.boreholes)}${inventory("CPTs",r.cpts)}</tbody></table></div>
<details class="impact-id-details"><summary>Changed input IDs</summary><dl>${changeDetails("Boreholes",r.boreholes)}${changeDetails("CPTs",r.cpts)}</dl></details>
<section class="impact-changes"><h3>Other interpretation changes</h3>${r.otherChanges.length?`<ul>${r.otherChanges.map(c=>`<li>${esc(c)}</li>`).join("")}</ul>`:"<p>No other interpretation settings changed.</p>"}${confounded?"<p><b>Other inputs or assumptions also changed. Updated model shifts cannot be attributed to the added boreholes alone.</b> See the input change register and settings above.</p>":s.addedBoreholes?"<p>Only boreholes were added among the reviewed inputs; shifts describe their combined update.</p>":"<p>No changes to the reviewed input values or interpretation settings.</p>"}</section>
${r.additions.length?`<h3>New borehole locations</h3><div class="impact-map">${map(r)}</div><p class="impact-map-key"><span class="impact-existing-key">Earlier borehole</span><span class="impact-low-key">Contact error = 0 m</span>${s.maxAbsContactError?`<span class="impact-high-key">Largest error = ${metres(s.maxAbsContactError)}</span>`:""}<span class="impact-missing-key">No comparable contacts</span></p><p class="impact-caption">Marker colours show the largest absolute contact forecast error at each new collar. They do not show an area of influence. X and Y use the same scale.</p>
<h3>Earlier forecasts at added boreholes</h3><p>Ranked by largest absolute contact forecast error, with unavailable results last. Agreement is matching logged length divided by the length covered by the earlier model.</p>
<div class="impact-table-wrap" tabindex="0" aria-label="New borehole forecast results; scroll horizontally on small screens"><table class="impact-holes"><thead><tr><th>Borehole</th><th>Earlier coverage</th><th>Max |contact error| (m)</th><th>Logged agreement</th><th>Compared / logged (m)</th></tr></thead><tbody>${r.additions.map((hole,index)=>({hole,index})).sort((a,b)=>(b.hole.maxAbsContactError??-Infinity)-(a.hole.maxAbsContactError??-Infinity)).map(({hole,index})=>`<tr data-impact-row="${index}"><th scope="row"><button type="button" data-impact-hole="${index}">${esc(hole.id)}</button></th><td>${hole.previouslyObserved?"Previously used collar":hole.beforeInside?"Within model":"Outside model"}</td><td>${format(hole.maxAbsContactError)}</td><td>${agreement(hole)}</td><td>${format(hole.comparedLength)} / ${format(hole.loggedLength)}</td></tr>`).join("")}</tbody></table></div>
<section class="impact-detail"><label class="impact-hole-label">Borehole details<select class="impact-hole">${r.additions.map((hole,index)=>`<option value="${index}">${esc(hole.id)}</option>`).join("")}</select></label><div class="impact-selected"></div></section>`:"<p class=\"impact-empty\">No added boreholes in these revisions. The change register still records additions, modifications and removals; compare along a section to inspect interpretation differences.</p>"}
<details class="impact-methods"><summary>How to read this review</summary><ul>${r.notes.map(note=>`<li>${esc(note)}</li>`).join("")}</ul><p>Forecast error = before prediction minus the newly logged elevation. Model shift = after prediction minus before prediction. These are differences between interpretations and observations, not statistical confidence or measured ground movement. Unknown values remain unavailable.</p></details>`;
    results.hidden=false;renderSelected();
  }
  function map(r:DataImpactReview){
    const points=[...before.project.boreholes,...r.additions].filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
    if(!points.length)return '<p class="impact-unavailable">Location map unavailable.</p>';
    const W=700,H=340,m={l:70,r:22,t:24,b:46},pw=W-m.l-m.r,ph=H-m.t-m.b;
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
    const spanX=x1-x0||1,spanY=y1-y0||1,scale=Math.min(pw/(spanX*1.14),ph/(spanY*1.14)),cx=(x0+x1)/2,cy=(y0+y1)/2;
    const x=(v:number)=>m.l+pw/2+(v-cx)*scale,y=(v:number)=>m.t+ph/2-(v-cy)*scale;
    const max=r.summary.maxAbsContactError??0;
    const colour=(value:number|undefined)=>!finite(value)?"#737d87":`rgb(${Math.round(31+(195-31)*(max?Math.min(1,value/max):0))},${Math.round(111+(90-111)*(max?Math.min(1,value/max):0))},${Math.round(209+(23-209)*(max?Math.min(1,value/max):0))})`;
    const grid=Array.from({length:5},(_,i)=>{
      const px=m.l+pw*i/4,py=m.t+ph*i/4,vx=cx+(px-m.l-pw/2)/scale,vy=cy-(py-m.t-ph/2)/scale;
      return `<line x1="${px}" y1="${m.t}" x2="${px}" y2="${m.t+ph}" stroke="#e3e8ec"/><line x1="${m.l}" y1="${py}" x2="${m.l+pw}" y2="${py}" stroke="#e3e8ec"/><text x="${px}" y="${m.t+ph+18}" text-anchor="middle">${format(vx,1)}</text><text x="${m.l-8}" y="${py+4}" text-anchor="end">${format(vy,1)}</text>`;
    }).join("");
    const old=before.project.boreholes.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)).map(p=>`<circle cx="${x(p.x)}" cy="${y(p.y)}" r="3.5" fill="#c5cdd4" stroke="#5d6872"><title>Earlier borehole: ${esc(p.id)}</title></circle>`).join("");
    const added=r.additions.map((p,index)=>({p,index})).filter(({p})=>Number.isFinite(p.x)&&Number.isFinite(p.y)).map(({p,index})=>`<g class="impact-map-point" role="button" tabindex="0" data-impact-hole="${index}" aria-label="${esc(`${p.id}: maximum contact forecast error ${metres(p.maxAbsContactError)}; ${p.beforeInside?"within":"outside"} earlier model`)}"><circle cx="${x(p.x)}" cy="${y(p.y)}" r="7" fill="${colour(p.maxAbsContactError)}" stroke="white" stroke-width="2"/><title>${esc(p.id)}: ${metres(p.maxAbsContactError)}</title></g>`).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="group" aria-label="Earlier and added borehole locations in project coordinates"><rect width="${W}" height="${H}" fill="white"/><g font-family="sans-serif" font-size="11" fill="#4d5964">${grid}<text x="${m.l}" y="14">Y (m)</text><text x="${m.l+pw/2}" y="${H-5}" text-anchor="middle">X (m)</text></g>${old}${added}</svg>`;
  }
  function contactRow(contact:ImpactContact){
    return `<tr><th scope="row">${esc(contact.unitName)}${contact.unitId==="__ground__"?"":` <small>(${esc(contact.unitId)})</small>`}</th><td>${format(contact.logged)}</td><td>${format(contact.before)}</td><td>${format(contact.after)}</td><td>${signed(contact.predictionError)}</td><td>${signed(contact.modelShift)}</td></tr>${contact.unavailableReason?`<tr class="impact-contact-note"><td colspan="6">${esc(contact.unavailableReason)} Any model elevations shown are sampled surfaces; an unavailable forecast error is excluded from the score.</td></tr>`:""}`;
  }
  function renderSelected(){
    if(!result?.additions.length)return;
    const hole=result.additions[selected];if(!hole)return;
    $<HTMLSelectElement>(".impact-hole").value=String(selected);
    $(".impact-selected").innerHTML=`<h3 class="impact-selected-name">${esc(hole.id)}</h3><p class="impact-collar">X ${format(hole.x)} m · Y ${format(hole.y)} m · Collar ${format(hole.z)} m. Earlier model: ${hole.beforeInside?"within coverage":"outside coverage"}; updated model: ${hole.afterInside?"within coverage":"outside coverage"}.</p><p class="impact-agreement">Logged agreement: ${agreement(hole)}. Compared ${format(hole.comparedLength)} of ${format(hole.loggedLength)} logged metres.</p><p class="impact-signs"><b>Forecast error = before − logged. Model shift = after − before.</b></p><div class="impact-table-wrap" tabindex="0" aria-label="Selected borehole contact elevations; scroll horizontally on small screens"><table class="impact-contact-table"><thead><tr><th>Surface</th><th>Logged (m)</th><th>Before (m)</th><th>After (m)</th><th>Forecast error (m)</th><th>Model shift (m)</th></tr></thead><tbody>${contactRow(hole.ground)}${hole.contacts.map(contactRow).join("")}</tbody></table></div>${hole.notes.length?`<ul class="impact-hole-notes">${hole.notes.map(n=>`<li>${esc(n)}</li>`).join("")}</ul>`:""}`;
    for(const row of results.querySelectorAll<HTMLElement>("[data-impact-row]"))row.classList.toggle("impact-selected-row",Number(row.dataset.impactRow)===selected);
    for(const point of results.querySelectorAll<SVGGElement>(".impact-map-point"))point.setAttribute("aria-pressed",String(Number(point.dataset.impactHole)===selected));
  }
  function choose(target:Element){
    const item=target.closest<HTMLElement|SVGGElement>("[data-impact-hole]");
    if(!item)return false;
    const index=Number(item.dataset.impactHole);
    if(!result||!Number.isInteger(index)||!result.additions[index])return false;
    selected=index;renderSelected();return true;
  }
  function exportCsv(){
    if(!result||busy)return;
    const rows=parseCsv(impactCsv(result),",");
    const names=["before_revision_id","after_revision_id","before_revision_created_at","after_revision_created_at","before_engine_version","after_engine_version","before_scenario","after_scenario"];
    const values=[before.id,after.id,before.createdAt,after.createdAt,before.engineVersion,after.engineVersion,options.beforeLabel??"",options.afterLabel??""];
    const text=toCsv(rows.map((row,i)=>[...row,...(i===0?names:values)])),name=`${slug(before.project.name)}-${slug(before.id).slice(0,12)}-to-${slug(after.project.name)}-${slug(after.id).slice(0,12)}-impact.csv`;
    if(options.download)options.download(name,text,"text/csv");
    else{const a=document.createElement("a"),url=URL.createObjectURL(new Blob([text],{type:"text/csv"}));a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000)}
  }
  runButton.onclick=()=>{void run()};cancelButton.onclick=()=>{reset("Impact review canceled.");runButton.focus({preventScroll:true})};csvButton.onclick=exportCsv;closeButton.onclick=close;
  $<HTMLButtonElement>(".impact-compare").onclick=()=>{close();showComparison(before,after,options)};
  results.addEventListener("click",event=>{if(event.target instanceof Element)choose(event.target)});
  results.addEventListener("keydown",event=>{if((event.key==="Enter"||event.key===" ")&&event.target instanceof SVGElement&&choose(event.target))event.preventDefault()});
  results.addEventListener("change",event=>{if(event.target instanceof HTMLSelectElement&&event.target.classList.contains("impact-hole")){selected=Number(event.target.value);renderSelected()}});
  dialog.addEventListener("cancel",event=>{event.preventDefault();close()});dialog.addEventListener("close",close);dialog.addEventListener("keydown",onKey);
  document.body.appendChild(dialog);document.body.style.overflow="hidden";closeActive=close;dialog.showModal();closeButton.focus({preventScroll:true});
}
