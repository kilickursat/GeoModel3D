// Review the current draft at the contributing collars. Each decision applies to one logged interval.
import type {CollarIntervalAgreement} from "./correlation";
import {readCollarReview} from "./correlationSummary";
import {setCorrelationAcceptance} from "./correlationDecisions";
import {assignInterpretedBed,interpretedBedOptions} from "./interpretedBeds";
import type {GeoModel} from "./model";
import type {EditorTables} from "./tables";
import {showEvidence} from "./evidenceView";
import "./correlationReview.css";

export interface CorrelationReviewSelection { mode?:"differences"|"all"; collar?:string; interval?:string }
const escape=(s:string)=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]!));
const metres=(v:number)=>Number(v.toFixed(4)).toLocaleString("en-US",{maximumFractionDigits:4});
const collarKey=(i:CollarIntervalAgreement)=>JSON.stringify([i.kind,i.holeId]);
const intervalKey=(i:CollarIntervalAgreement)=>JSON.stringify([i.kind,i.holeId,i.from,i.to,i.intervalIndex]);

export function createCorrelationReview(host:HTMLElement,tables:EditorTables,model:GeoModel,selection:CorrelationReviewSelection,onChange:(message:string)=>void){
  const {audit,rows,pending,accepted}=readCollarReview(model);
  const differences=audit.intervals.filter(i=>i.discrepancies.length);
  host.innerHTML=`<h2>Correlation review</h2>
    <p>Compare the logged intervals with the interpreted beds at their own collars. Depths are in metres below each collar.</p>
    <dl class="cr-totals">${[["Logged",audit.loggedMetres],["Matching",audit.matchedMetres],["Different unit",audit.mismatchedMetres],["Without model coverage",audit.unknownMetres]]
      .map(([label,v])=>`<div><dt>${label}</dt><dd>${metres(Number(v))} m</dd></div>`).join("")}</dl>
    <p class="cr-summary" aria-live="polite"></p>
    <div class="cr-pickers"><label>Show intervals<select aria-label="Show intervals" class="cr-mode"><option value="differences">Differences</option><option value="all">All logged intervals</option></select></label>
    <label>Collar<select aria-label="Collar" class="cr-collar"></select></label><label>Logged interval<select aria-label="Logged interval" class="cr-interval"></select></label></div>
    <section class="cr-detail" aria-label="Interval review"></section>`;
  const summary=host.querySelector<HTMLElement>(".cr-summary")!;
  const acceptances=new Map(rows.map(r=>[r.interval,r.acceptance]));
  if(audit.status==="logs-only"){
    summary.textContent=model.logOnlyReason??"Only the logged intervals can be shown for this project.";
  }else if(pending||accepted){
    summary.textContent=`${pending} ${pending===1?"interval":"intervals"} pending review · ${accepted} accepted with a reason.`;
  }else{
    summary.textContent=audit.intervals.length?"All logged intervals match the model at their collars.":"No contributing intervals.";
  }
  const mode=host.querySelector<HTMLSelectElement>(".cr-mode")!;
  const collar=host.querySelector<HTMLSelectElement>(".cr-collar")!;
  const interval=host.querySelector<HTMLSelectElement>(".cr-interval")!;
  const detail=host.querySelector<HTMLElement>(".cr-detail")!;
  mode.value=selection.mode??(differences.length?"differences":"all");
  let shown:CollarIntervalAgreement[]=[];
  function chooseCollar(){
    const rows=mode.value==="all"?audit.intervals:differences;
    const collars=new Map(rows.map(i=>[collarKey(i),i]));
    const options=document.createDocumentFragment();
    for(const [id,i] of collars)options.append(new Option(i.kind==="cpt"?`CPT · ${i.holeId}`:i.holeId,id));
    collar.replaceChildren(options);
    if(selection.collar&&collars.has(selection.collar))collar.value=selection.collar;
    collar.disabled=!collars.size;
    chooseInterval();
  }
  function chooseInterval(){
    const rows=mode.value==="all"?audit.intervals:differences;
    shown=rows.filter(i=>collarKey(i)===collar.value);
    selection.collar=collar.value;
    const options=document.createDocumentFragment();
    shown.forEach((i,k)=>{
      const status=acceptances.get(i)?" · Accepted":audit.status==="modelled"&&i.discrepancies.length?" · Pending":"";
      options.append(new Option(`${i.holeId} · ${metres(i.from)}–${metres(i.to)} m · ${i.unit}${status}`,String(k)));
    });
    interval.replaceChildren(options);
    const previous=shown.findIndex(i=>intervalKey(i)===selection.interval);
    interval.selectedIndex=previous>=0?previous:shown.length?0:-1;
    interval.disabled=!shown.length;
    renderInterval();
  }
  function renderInterval(){
    const i=shown[interval.selectedIndex];
    if(!i){detail.textContent="No intervals in this selection.";return}
    selection.interval=intervalKey(i);
    const log=i.kind==="cpt"?model.project.cpts?.find(c=>c.id===i.holeId)?.layers?.[i.intervalIndex]:
      model.boreholes.find(b=>b.id===i.holeId)?.intervals[i.intervalIndex];
    const material=model.project.units.find(u=>u.id===i.unit)?.materialId??i.unit;
    const reason=acceptances.get(i)?.rationale;
    const order=model.project.units.map(u=>u.id);
    const existing=interpretedBedOptions(tables,i.unit).filter(id=>id!==i.unit);
    detail.innerHTML=`
      <h3>${escape(i.holeId)} · ${metres(i.from)}–${metres(i.to)} m</h3>
      <p><b>Logged material</b> ${escape(material)}${material!==i.unit?`<br><b>Interpreted bed</b> ${escape(i.unit)}`:""}${log?.name?`<br><b>Logged description</b> ${escape(log.name)}`:""}</p>
      ${log?.evidenceId&&model.project.evidence?'<button type="button" class="cr-evidence">View source evidence</button>':""}
      ${i.discrepancies.length?`<table class="cr-segments"><caption>Differences at this collar</caption>
        <thead><tr><th>Modelled unit</th><th>From (m)</th><th>To (m)</th><th>Thickness (m)</th></tr></thead><tbody>${i.discrepancies.map(d=>
          `<tr><td>${escape(d.modelledUnit??(d.reason==="no-solids"?"Logs only":"Outside model coverage"))}</td><td>${metres(d.mismatchFrom)}</td><td>${metres(d.mismatchTo)}</td><td>${metres(d.mismatchTo-d.mismatchFrom)}</td></tr>`).join("")}</tbody></table>
        ${reason?`<p><b>Accepted reason</b> ${escape(reason)}</p>`:""}
        ${i.unknownMetres?'<p>Part of this interval has no modelled solid. Check the model coverage and bed assignments.</p>':
          `<form class="cr-accept"><label>Reason for acceptance<textarea required rows="2"></textarea></label>
          <button type="submit">${reason?"Update acceptance reason":"Accept interval differences"}</button></form>`}`:'<p>The model matches this interval.</p>'}
      ${i.kind==="cpt"?'<p>This interval comes from a CPT interpretation. Use the CPT interpretation and its unit rules to revise the layer assignment.</p>':`
        <details class="cr-bed"><summary>Assign an interpreted bed</summary>
        <form class="cr-assign">
        <label>Bed assignment<select aria-label="Bed assignment" class="cr-target"><option value="new">Create a new bed</option>${existing.map((id,k)=>`<option value="${k}">Use ${escape(id)}</option>`).join("")}</select></label>
        <div class="cr-new"><label>New bed ID<input class="cr-id" required></label><label>Position in unit order<select aria-label="Position in unit order" class="cr-position" required><option value="">Choose position…</option>
          ${order.map((id,k)=>`<option value="${k}">Before ${escape(id)}</option>`).join("")}<option value="bottom">At the bottom</option></select></label></div>
        <button type="submit">Assign bed</button></form></details>`}
      <p class="cr-error" role="alert"></p>`;
    const error=detail.querySelector<HTMLElement>(".cr-error")!;
    const accept=detail.querySelector<HTMLFormElement>(".cr-accept");
    if(accept){
      const input=accept.querySelector("textarea")!;
      input.value=reason??"";
      accept.onsubmit=e=>{
        e.preventDefault();
        try{setCorrelationAcceptance(tables,model,i,input.value);onChange(`Acceptance saved for ${i.holeId} at ${metres(i.from)}–${metres(i.to)} m.`)}
        catch(err){error.textContent=(err as Error).message}
      };
    }
    detail.querySelector<HTMLButtonElement>(".cr-evidence")?.addEventListener("click",()=>{
      if(log?.evidenceId&&model.project.evidence)showEvidence(model.project.evidence,log.evidenceId,`Source evidence · ${i.holeId}`);
    });
    const assign=detail.querySelector<HTMLFormElement>(".cr-assign");
    if(!assign)return;
    const target=assign.querySelector<HTMLSelectElement>(".cr-target")!;
    const newFields=assign.querySelector<HTMLElement>(".cr-new")!;
    const id=assign.querySelector<HTMLInputElement>(".cr-id")!;
    const position=assign.querySelector<HTMLSelectElement>(".cr-position")!;
    target.onchange=()=>{newFields.hidden=id.disabled=position.disabled=target.value!=="new"};
    assign.onsubmit=e=>{
      e.preventDefault();
      const bed=target.value==="new"?{id:id.value.trim(),beforeUnit:position.value==="bottom"?null:order[Number(position.value)]}:{id:existing[Number(target.value)]};
      try{
        assignInterpretedBed(tables,i,bed);
        onChange(`Assigned ${i.holeId} at ${metres(i.from)}–${metres(i.to)} m to ${bed.id}. Collar comparisons updated.`);
      }catch(err){error.textContent=(err as Error).message}
    };
  }
  mode.onchange=()=>{selection.mode=mode.value==="all"?"all":"differences";chooseCollar()};
  collar.onchange=chooseInterval;
  interval.onchange=renderInterval;
  chooseCollar();
}
