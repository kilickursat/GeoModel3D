// Local core photographs are registered and reviewed before they become model observations.
import type {GeoProject} from "./schema";
import {newEvidenceId,validateEvidence,EVIDENCE_MAX_PAGE_IMAGE_BYTES} from "./evidence";
import type {EvidenceSource} from "./evidence";
import {acceptCoreRun,calculateCoreRun,coreDepthAt,corePieceBox,validateCorePhotos} from "./corePhoto";
import type {CoreRun,CoreRow,CorePiece} from "./corePhoto";
import {showCoreAi} from "./coreAiView";
import "./corePhoto.css";

const esc=(value:string)=>value.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const fmt=(value:number,d=3)=>value.toLocaleString("en-US",{maximumFractionDigits:d});
const id=()=>newEvidenceId();
const option=(value:string,label:string,selected:string)=>`<option value="${esc(value)}"${value===selected?" selected":""}>${esc(label)}</option>`;
let activeClose:(()=>boolean)|undefined,sequence=0;

export interface CorePhotoViewOptions {
  onSave(project:GeoProject):void;
  initialRunId?:string;
  readOnly?:boolean;
}

async function photograph(file:File):Promise<{source:EvidenceSource;note:string}>{
  if(!["image/png","image/jpeg","image/webp"].includes(file.type))throw new Error("Choose a PNG, JPEG or WebP photograph.");
  if(file.size>32*1024*1024)throw new Error("This photograph exceeds 32 MiB. Crop or resize it before importing.");
  const bytes=await file.arrayBuffer();
  const sha=globalThis.crypto?.subtle?Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(v=>v.toString(16).padStart(2,"0")).join(""):undefined;
  const url=URL.createObjectURL(file),image=new Image();
  try{
    await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error("This photograph could not be decoded."));image.src=url});
    const originalWidth=image.naturalWidth,originalHeight=image.naturalHeight;
    if(originalWidth<1||originalHeight<1||originalWidth*originalHeight>100_000_000)throw new Error("The photograph has unsupported dimensions. Crop it into smaller core-box images.");
    const canvas=document.createElement("canvas"),context=canvas.getContext("2d");
    if(!context)throw new Error("Image processing is unavailable in this browser.");
    let scale=Math.min(1,4096/Math.max(originalWidth,originalHeight)),saved="";
    for(;;){
      canvas.width=Math.max(1,Math.round(originalWidth*scale));canvas.height=Math.max(1,Math.round(originalHeight*scale));
      context.drawImage(image,0,0,canvas.width,canvas.height);saved=canvas.toDataURL("image/png");
      const payload=saved.split(",")[1]??"",size=payload.length/4*3-(payload.endsWith("==")?2:payload.endsWith("=")?1:0);
      if(size<=EVIDENCE_MAX_PAGE_IMAGE_BYTES)break;
      if(Math.max(canvas.width,canvas.height)<=1024)throw new Error("A readable saved photograph cannot fit the 2 MiB image limit. Crop the box into smaller photographs and import each run separately.");
      scale=Math.max(1024/Math.max(originalWidth,originalHeight),scale*.8);
    }
    const source:EvidenceSource={id:id(),name:file.name,size:file.size,...(sha?{sha256:sha}:{}),pages:[{page:1,width:canvas.width,height:canvas.height,image:saved}]};
    validateEvidence({version:1,sources:[source],records:[]});
    return {source,note:`Saved ${canvas.width} × ${canvas.height} pixels${canvas.width!==originalWidth||canvas.height!==originalHeight?` from ${originalWidth} × ${originalHeight}`:""}. Check that fractures and scale marks remain readable. Original file bytes are not included.`};
  }finally{URL.revokeObjectURL(url)}
}

export function showCorePhotos(project:GeoProject,options:CorePhotoViewOptions):void{
  if(activeClose&&!activeClose())return;
  let working=structuredClone(project),selected=options.initialRunId??project.corePhotos?.runs[0]?.id??"",rowId="",dirty=false,closed=false,busy=false;
  let pending:EvidenceSource|undefined,photoNote="",notice="",error=false,mode:"view"|"draw"|"cut"="view";
  let reviewer="",replace=false;
  let closeAi:(()=>void)|undefined;
  const opener=document.activeElement instanceof HTMLElement?document.activeElement:null,oldOverflow=document.body.style.overflow;
  const dialog=document.createElement("dialog"),heading=`core-photo-heading-${++sequence}`;
  dialog.className="core-dialog";dialog.setAttribute("aria-labelledby",heading);
  dialog.innerHTML=`<header class="core-header"><div><h2 id="${heading}">Core photographs</h2><p>Depth-register a photograph, review pieces, then accept a log into the ground model.</p></div><button type="button" class="core-close" aria-label="Close core photographs">Close</button></header><div class="core-content"></div><footer class="core-footer"><p class="core-notice" role="status"></p><button type="button" class="core-save">Save draft</button></footer>`;
  const $=<T extends HTMLElement>(selector:string)=>dialog.querySelector<T>(selector)!;
  const content=$(".core-content"),status=$(".core-notice"),closeButton=$<HTMLButtonElement>(".core-close");
  const runs=()=>working.corePhotos?.runs??[];
  const run=()=>runs().find(r=>r.id===selected);
  const row=()=>run()?.rows.find(r=>r.id===rowId);
  const source=()=>{const current=run();return current?working.evidence?.sources.find(s=>s.id===current.sourceId):pending};
  const readonly=!!options.readOnly;

  function setNotice(text:string,isError=false){notice=text;error=isError;status.textContent=text;status.classList.toggle("core-error",isError)}
  function changed(){
    dirty=true;const current=run();if(current){current.status="draft";delete current.reviewedBy;delete current.acceptedAt;delete current.reviewEvidenceId}
    setNotice("Unsaved photo annotations. The model keeps its last accepted log until you accept this draft.");
  }
  function close():boolean{
    if(closed)return true;
    if(dirty&&!confirm("Close without saving these core-photo annotations? Choose Cancel, then Save draft to keep them."))return false;
    closeAi?.();closed=true;if(dialog.open)dialog.close();dialog.remove();document.body.style.overflow=oldOverflow;
    if(activeClose===close)activeClose=undefined;
    const focusTarget=opener?.isConnected?opener:document.querySelector<HTMLElement>('.workspace:not([hidden]) .ws-core-photos');
    focusTarget?.focus({preventScroll:true});return true;
  }
  function save(){
    try{
      if(working.corePhotos)working.corePhotos=validateCorePhotos(working.corePhotos,{evidence:working.evidence});
      if(working.evidence)working.evidence=validateEvidence(working.evidence);
      options.onSave(structuredClone(working));dirty=false;setNotice("Core-photo draft saved in this workspace. Build model after accepting a log.");
    }catch(e){setNotice((e as Error).message,true)}
  }
  const number=(selector:string)=>{
    const input=$<HTMLInputElement>(selector),value=Number(input.value);
    if(input.value.trim()===""||!Number.isFinite(value))throw new Error(`${input.labels?.[0]?.textContent??"Value"} must be a number.`);
    return value;
  };
  function imageHtml(){
    const src=source(),page=src?.pages.find(p=>p.page===1),current=run();
    if(!page?.image||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(page.image))return '<div class="core-empty-photo">Import a photograph of a core box. It stays in this browser and travels with the saved workspace.</div>';
    const regions=(current?.rows??[]).map((r,i)=>{
      const box=r.box;
      return `<button type="button" class="core-photo-row${r.id===rowId?" selected":""}" data-row="${esc(r.id)}" aria-label="Select row ${i+1}: ${fmt(r.from)} to ${fmt(r.to)} metres" style="left:${box.x0*100}%;top:${box.y0*100}%;width:${(box.x1-box.x0)*100}%;height:${(box.y1-box.y0)*100}%"><span>${i+1}: ${fmt(r.from)}–${fmt(r.to)} m ${r.direction==="rtl"?"←":"→"}</span></button>`;
    }).join("");
    const selectedRow=row();let start=selectedRow?.from??0;
    const pieces=selectedRow?.pieces.map(p=>{const box=corePieceBox(selectedRow,start,p.end);start=p.end;return `<span class="core-photo-piece" style="left:${box.x0*100}%;top:${box.y0*100}%;width:${(box.x1-box.x0)*100}%;height:${(box.y1-box.y0)*100}%"></span>`}).join("")??"";
    return `<div class="core-photo-sheet" data-mode="${mode}"><img class="core-photo" src="${page.image}" alt="Core-box photograph: ${esc(src!.name)}" draggable="false"><div class="core-photo-regions">${regions}${pieces}<span class="core-drawing" hidden></span></div></div><p class="core-photo-source">${esc(src!.name)} · saved ${page.width} × ${page.height} pixels. Original file bytes are not included.</p>`;
  }
  function resultHtml(current:CoreRun){
    const result=calculateCoreRun(current);
    return `<div class="core-result"><dl><div><dt>Drilled run</dt><dd>${fmt(result.runLength)} m</dd></div><div><dt>Registered recovery</dt><dd>${fmt(result.recoveredLength)} m · ${fmt(result.recoveryPercent,1)}%</dd></div><div><dt>Unrepresented depth</dt><dd>${fmt(result.missingLength)} m</dd></div><div><dt>Photo-derived RQD</dt><dd>${result.rqdPercent===undefined?"Pending review":`${fmt(result.rqdPercent,1)}%`}</dd></div></dl>${result.issues.length?`<ul>${result.issues.map(v=>`<li>${esc(v)}</li>`).join("")}</ul>`:""}<p>RQD uses sound lengths ≥100 mm divided by the full drilled run. Matched mechanical breaks and unbroken logging boundaries rejoin pieces; missing or unsound core does not count. This is a reviewed photo interpretation, separate from laboratory measurements.</p></div>`;
  }
  function pieceHtml(current:CoreRow){
    let start=current.from;
    return current.pieces.map((piece,i)=>{
      const from=start;start=piece.end;
      return `<fieldset class="core-piece" data-piece="${esc(piece.id)}"><legend>Piece ${i+1} · ${fmt(from)}–${fmt(piece.end)} m · ${fmt((piece.end-from)*1000,1)} mm</legend><div class="core-fields"><label>Soundness<select class="core-piece-sound"${readonly?" disabled":""}>${option("unknown","Not reviewed",piece.sound)}${option("sound","Sound",piece.sound)}${option("unsound","Unsound",piece.sound)}</select></label><label>Break after piece<select class="core-piece-break"${readonly?" disabled":""}>${option("unknown","Not reviewed",piece.breakAfter)}${option("natural","Natural fracture",piece.breakAfter)}${option("mechanical","Matched mechanical break",piece.breakAfter)}${option("continuous","No break · logging boundary",piece.breakAfter)}${option("end","Run end or gap",piece.breakAfter)}</select></label><label>Geological unit<select class="core-piece-unit"${readonly?" disabled":""}>${option("","Choose a unit",piece.unit)}${piece.unit&&!working.units.some(u=>u.id===piece.unit)?option(piece.unit,`Missing unit: ${piece.unit}`,piece.unit):""}${working.units.map(u=>option(u.id,u.name||u.id,piece.unit)).join("")}</select></label></div><label>Description<textarea class="core-piece-description" rows="2" maxlength="4096"${readonly?" readonly":""}>${esc(piece.description)}</textarea></label>${!readonly&&i<current.pieces.length-1?'<button type="button" class="core-remove-cut">Remove break after this piece</button>':""}</fieldset>`;
    }).join("");
  }
  function render(){
    const focused=document.activeElement instanceof HTMLElement&&content.contains(document.activeElement)?document.activeElement:undefined;
    const focusClass=focused?.classList[0],focusPiece=focused?.closest<HTMLElement>("[data-piece]")?.dataset.piece;
    const current=run();
    if(current&&!current.rows.some(r=>r.id===rowId))rowId=current.rows[0]?.id??"";
    const selectedRow=row();
    content.innerHTML=`<div class="core-top"><label>Registered run<select class="core-run">${readonly?"":option("","New photograph / run",selected)}${runs().map(r=>option(r.id,`${r.boreholeId} · ${fmt(r.from)}–${fmt(r.to)} m · ${r.status}`,selected)).join("")}</select></label><p class="core-scope">Vertical boreholes. Only registered recovered intervals are observations; the 3D model interpolates through unlogged gaps. No rock classifier or strength prediction is applied.</p></div><div class="core-layout"><section class="core-image-panel" aria-label="Core photograph">${!readonly?`<div class="core-photo-tools"><button type="button" class="core-photo-view" aria-pressed="${mode==="view"}">Inspect</button><button type="button" class="core-photo-draw" aria-pressed="${mode==="draw"}"${!current?" disabled":""}>Draw row bounds</button><button type="button" class="core-photo-cut" aria-pressed="${mode==="cut"}"${!selectedRow?" disabled":""}>Place break on photo</button></div>`:""}${imageHtml()}${mode==="draw"?'<p class="core-mode-help">Drag around one continuous row of recovered core. Then enter its known start and end depths and add the row. Numeric bounds below are an alternative.</p>':mode==="cut"?'<p class="core-mode-help">Click a break within the selected row. Its depth is estimated from your registered scale; review it using the numeric depth control.</p>':""}${photoNote?`<p class="core-photo-note">${esc(photoNote)}</p>`:""}</section><section class="core-review-panel" aria-label="Core registration and review">${!current?newRunHtml():`<div class="core-run-heading"><h3>${esc(current.boreholeId)} · ${fmt(current.from)}–${fmt(current.to)} m</h3><p class="core-run-state">${current.status==="accepted"?`Accepted by ${esc(current.reviewedBy??"")} · ${esc(current.acceptedAt??"")}`:"Draft — no new observations applied to the model"}</p></div>${resultHtml(current)}<div class="core-row-list"><label>Photo row<select class="core-row">${current.rows.length?current.rows.map((r,i)=>option(r.id,`Row ${i+1}: ${fmt(r.from)}–${fmt(r.to)} m (${r.direction==="rtl"?"right to left":"left to right"})`,rowId)).join(""):'<option value="">Add a registered row</option>'}</select></label></div>${selectedRow?`<section class="core-row-review"><h3>Review row ${current.rows.indexOf(selectedRow)+1}</h3><button type="button" class="core-ai-open">Describe this interval · local AI</button><p>Depth ${fmt(selectedRow.from)}–${fmt(selectedRow.to)} m; ${selectedRow.direction==="rtl"?"right to left":"left to right"}. Image width maps linearly to depth.</p><label class="core-check"><input type="checkbox" class="core-registration"${selectedRow.registrationReviewed?" checked":""}${readonly?" disabled":""}>I checked row bounds, direction, scale and depth against the core labels. The depth span equals the actual recovered length; there is no missing core, bend or tray gap inside this straight row.</label>${!readonly?`<div class="core-cut-controls"><label>Break depth (m)<input class="core-cut-depth" type="number" step="any" min="${selectedRow.from}" max="${selectedRow.to}" value="${Number(((selectedRow.from+selectedRow.to)/2).toFixed(6))}"></label><button type="button" class="core-add-cut">Add break at depth</button></div>`:""}<div class="core-pieces">${pieceHtml(selectedRow)}</div>${!readonly?'<button type="button" class="core-delete-row">Delete selected row</button>':""}</section>`:""}${!readonly?addRowHtml(current)+editRunHtml(current):""}${reviewHtml(current)}`}</section></div>`;
    $<HTMLButtonElement>(".core-save").hidden=readonly;
    $<HTMLButtonElement>(".core-save").disabled=busy||!working.corePhotos;
    setNotice(notice,error);
    if(focusClass){const prefix=focusPiece?`[data-piece="${CSS.escape(focusPiece)}"] `:"";dialog.querySelector<HTMLElement>(`${prefix}.${CSS.escape(focusClass)}`)?.focus({preventScroll:true})}
  }
  function newRunHtml(){
    if(readonly)return '<p>No saved core-photo run is available.</p>';
    return `<section class="core-new-run"><h3>Register a core-box photograph</h3><p>Use an existing vertical borehole with a surveyed collar. Add its collar and geological units in Input data first. Each photo run needs known drilled start and end depths.</p><label>Core-box photograph<input type="file" class="core-upload" accept="image/png,image/jpeg,image/webp"${busy?" disabled":""}></label><p class="core-upload-status">${pending?`Ready: ${esc(pending.name)}`:busy?"Preparing local photograph…":"PNG, JPEG or WebP. No upload to a server."}</p><label>Borehole<select class="core-borehole">${working.boreholes.map(b=>option(b.id,b.id,working.boreholes[0]?.id??"")).join("")}</select></label><div class="core-fields"><label>Run from (m)<input class="core-from" type="number" min="0" step="any" value="0"></label><label>Run to (m)<input class="core-to" type="number" min="0" step="any" value="1"></label></div><button type="button" class="core-add-run"${!pending||busy||!working.boreholes.length?" disabled":""}>Register photograph</button></section>`;
  }
  function addRowHtml(current:CoreRun){
    const start=current.rows.length?Math.max(...current.rows.map(r=>r.to)):current.from;
    return `<details class="core-add-row-panel"${!current.rows.length?" open":""}><summary>Add a photo row</summary><p>A row must cover continuous recovered core with known depth anchors and uniform scale. Split it at missing core or tray gaps. Unregistered run depth remains unrepresented.</p><div class="core-fields"><label>Row from (m)<input class="core-row-from" type="number" min="${current.from}" max="${current.to}" step="any" value="${start}"></label><label>Row to (m)<input class="core-row-to" type="number" min="${current.from}" max="${current.to}" step="any" value="${current.to}"></label><label>Depth direction<select class="core-row-direction"><option value="ltr">Left to right</option><option value="rtl">Right to left</option></select></label></div><div class="core-fields core-bounds"><label>Left (%)<input class="core-row-x0" type="number" min="0" max="100" step="any" value="5"></label><label>Top (%)<input class="core-row-y0" type="number" min="0" max="100" step="any" value="10"></label><label>Right (%)<input class="core-row-x1" type="number" min="0" max="100" step="any" value="95"></label><label>Bottom (%)<input class="core-row-y1" type="number" min="0" max="100" step="any" value="30"></label></div><button type="button" class="core-add-row">Add registered row</button></details>`;
  }
  function reviewHtml(current:CoreRun){
    if(readonly)return current.status==="accepted"?'<p class="core-readonly">Saved review snapshot. Later edits to the model log do not change these photo annotations.</p>':'<p class="core-readonly">Saved draft; not accepted into the model. Review the registration and pieces in Input data.</p>';
    return `<section class="core-accept-panel"><h3>Review and accept</h3>${working.units.length?"":'<p class="core-error">Add geological units in Input data before accepting a photo log.</p>'}<label class="core-check"><input type="checkbox" class="core-loss-reviewed"${current.lossReviewed?" checked":""}>I checked run limits and recovery. Every unrepresented depth interval is missing core, and no recovered core was omitted.</label><label>Reviewer<input class="core-reviewer" type="text" maxlength="256" value="${esc(reviewer||current.reviewedBy||"")}" placeholder="Name or initials"></label><label class="core-check"><input type="checkbox" class="core-replace"${replace?" checked":""}>Replace existing log intervals inside ${fmt(current.from)}–${fmt(current.to)} m for ${esc(current.boreholeId)}. Unrepresented depth receives no photo observation.</label><p>Acceptance writes reviewed unit intervals and their photo evidence to the draft. Build model applies them in 3D. It does not create strength, stiffness or permeability measurements.</p><button type="button" class="core-accept">Accept reviewed log</button></section>`;
  }
  function editRunHtml(current:CoreRun){
    return `<details class="core-edit-run-panel"><summary>Correct or remove this registration</summary><p>Changing the run resets its acceptance and recovery review. Existing model observations remain until you accept a replacement. To change a row's depth or image bounds, delete that row and register it again.</p><label>Borehole for this run<select class="core-edit-borehole">${working.boreholes.some(b=>b.id===current.boreholeId)?"":option(current.boreholeId,`Missing borehole: ${current.boreholeId}`,current.boreholeId)}${working.boreholes.map(b=>option(b.id,b.id,current.boreholeId)).join("")}</select></label><div class="core-fields"><label>Corrected run from (m)<input class="core-edit-from" type="number" min="0" step="any" value="${current.from}"></label><label>Corrected run to (m)<input class="core-edit-to" type="number" min="0" step="any" value="${current.to}"></label></div><button type="button" class="core-edit-run">Apply run correction</button><button type="button" class="core-delete-run">Remove photo registration</button></details>`;
  }
  function validatedMutation(change:()=>void){
    const previous=structuredClone(working),previousSelected=selected,previousRow=rowId,previousDirty=dirty;
    try{change();changed();if(working.corePhotos)validateCorePhotos(working.corePhotos,{evidence:working.evidence});render()}
    catch(e){working=previous;selected=previousSelected;rowId=previousRow;dirty=previousDirty;render();setNotice((e as Error).message,true)}
  }
  function addCut(depth:number){
    const current=row();if(!current)throw new Error("Select a row before placing a break.");
    let from=current.from,index=-1;
    for(let i=0;i<current.pieces.length;i++){if(depth>from+1e-9&&depth<current.pieces[i].end-1e-9){index=i;break}from=current.pieces[i].end}
    if(index<0)throw new Error("The break must be strictly inside a piece, rather than on an existing boundary.");
    const previous=current.pieces[index];
    current.pieces.splice(index,1,{...previous,id:id(),end:depth,sound:"unknown",breakAfter:"unknown"},{...previous,id:id(),sound:"unknown"});
  }

  dialog.addEventListener("click",event=>{
    const target=(event.target as Element).closest<HTMLButtonElement>("button");if(!target)return;
    if(target.classList.contains("core-close")){close();return}
    if(target.classList.contains("core-save")){save();return}
    if(target.dataset.row&&mode==="view"){rowId=target.dataset.row;render();return}
    if(target.classList.contains("core-ai-open")){
      const current=run(),selectedRow=row(),src=source(),image=src?.pages.find(p=>p.page===1)?.image;
      if(current&&selectedRow&&src&&image)closeAi=showCoreAi({image,sourceId:src.id,sourceName:src.name,sourceSha256:src.sha256,runId:current.id,boreholeId:current.boreholeId,row:selectedRow});
      else setNotice("Register a photo row with a saved source image before describing an interval.",true);
      return;
    }
    if(readonly)return;
    try{
      if(target.classList.contains("core-photo-view")||target.classList.contains("core-photo-draw")||target.classList.contains("core-photo-cut")){
        mode=target.classList.contains("core-photo-draw")?"draw":target.classList.contains("core-photo-cut")?"cut":"view";render();return;
      }
      if(target.classList.contains("core-add-run")){
        if(!pending)throw new Error("Choose a photograph first.");
        const from=number(".core-from"),to=number(".core-to"),boreholeId=$<HTMLSelectElement>(".core-borehole").value,sourceId=pending.id;
        if(from<0||to<=from)throw new Error("Run depths must satisfy 0 ≤ from < to.");
        const current:CoreRun={id:id(),boreholeId,sourceId,from,to,rows:[],lossReviewed:false,status:"draft"};
        validatedMutation(()=>{
          working.evidence??={version:1,sources:[],records:[]};working.evidence.sources.push(pending!);validateEvidence(working.evidence);
          working.corePhotos??={version:1,runs:[]};working.corePhotos.runs.push(current);selected=current.id;rowId="";
        });
        if(run()?.id===current.id)pending=undefined;return;
      }
      if(target.classList.contains("core-add-row")){
        const current=run();if(!current)return;
        const from=number(".core-row-from"),to=number(".core-row-to"),box={x0:number(".core-row-x0")/100,y0:number(".core-row-y0")/100,x1:number(".core-row-x1")/100,y1:number(".core-row-y1")/100};
        const next:CoreRow={id:id(),box,from,to,direction:$<HTMLSelectElement>(".core-row-direction").value as "ltr"|"rtl",registrationReviewed:false,pieces:[{id:id(),end:to,sound:"unknown",breakAfter:"end",unit:"",description:""}]};
        validatedMutation(()=>{current.rows.push(next);current.lossReviewed=false;rowId=next.id;mode="view"});return;
      }
      if(target.classList.contains("core-add-cut")){const depth=number(".core-cut-depth");validatedMutation(()=>addCut(depth));return}
      if(target.classList.contains("core-delete-row")){
        validatedMutation(()=>{const current=run();if(current){current.rows=current.rows.filter(r=>r.id!==rowId);current.lossReviewed=false}rowId=""});return;
      }
      if(target.classList.contains("core-edit-run")){
        const current=run();if(!current)return;
        const boreholeId=$<HTMLSelectElement>(".core-edit-borehole").value,from=number(".core-edit-from"),to=number(".core-edit-to");
        validatedMutation(()=>{current.boreholeId=boreholeId;current.from=from;current.to=to;current.lossReviewed=false});return;
      }
      if(target.classList.contains("core-delete-run")){
        if(!confirm("Remove this photo registration? Accepted log intervals and their source evidence stay in the project. Save draft to keep this removal."))return;
        validatedMutation(()=>{working.corePhotos!.runs=runs().filter(r=>r.id!==selected);selected="";rowId=""});return;
      }
      if(target.classList.contains("core-remove-cut")){
        const pieceId=target.closest<HTMLElement>("[data-piece]")?.dataset.piece;
        validatedMutation(()=>{const current=row(),index=current?.pieces.findIndex(p=>p.id===pieceId)??-1;if(!current||index<0||index>=current.pieces.length-1)return;
          const a=current.pieces[index],b=current.pieces[index+1];current.pieces.splice(index,2,{...a,end:b.end,sound:"unknown",breakAfter:b.breakAfter,unit:a.unit===b.unit?a.unit:"",description:a.description===b.description?a.description:""})});return;
      }
      if(target.classList.contains("core-accept")){
        const current=run();if(!current)return;
        reviewer=$<HTMLInputElement>(".core-reviewer").value.trim();replace=$<HTMLInputElement>(".core-replace").checked;
        const accepted=acceptCoreRun(working,current.id,{reviewer,replaceExisting:replace});
        options.onSave(structuredClone(accepted));working=accepted;dirty=false;setNotice("Reviewed photo log accepted and saved. Build model to use it in 3D; click a source-linked interval to inspect the photograph.");render();return;
      }
    }catch(e){setNotice((e as Error).message,true)}
  });
  dialog.addEventListener("change",event=>{
    const target=event.target as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement;
    if(target.classList.contains("core-run")){selected=target.value;rowId="";mode="view";reviewer="";replace=false;render();return}
    if(target.classList.contains("core-row")){rowId=target.value;mode="view";render();return}
    if(readonly)return;
    if(target.classList.contains("core-upload")){
      const file=(target as HTMLInputElement).files?.[0];if(!file)return;
      busy=true;pending=undefined;setNotice("Preparing a local photograph…");render();
      void photograph(file).then(result=>{if(closed)return;pending=result.source;photoNote=result.note;setNotice("Photograph ready. Enter its borehole and drilled run depths.")})
        .catch(e=>{if(!closed)setNotice((e as Error).message,true)}).finally(()=>{busy=false;if(!closed)render()});return;
    }
    if(target.classList.contains("core-reviewer")){reviewer=target.value;return}
    if(target.classList.contains("core-replace")){replace=(target as HTMLInputElement).checked;return}
    const current=run(),selectedRow=row();if(!current)return;
    if(target.classList.contains("core-registration")&&selectedRow){selectedRow.registrationReviewed=(target as HTMLInputElement).checked;changed();render();return}
    if(target.classList.contains("core-loss-reviewed")){current.lossReviewed=(target as HTMLInputElement).checked;changed();render();return}
    const pieceId=target.closest<HTMLElement>("[data-piece]")?.dataset.piece,piece=selectedRow?.pieces.find(p=>p.id===pieceId);
    if(piece){
      if(target.classList.contains("core-piece-sound"))piece.sound=target.value as CorePiece["sound"];
      else if(target.classList.contains("core-piece-break"))piece.breakAfter=target.value as CorePiece["breakAfter"];
      else if(target.classList.contains("core-piece-unit"))piece.unit=target.value;
      else if(target.classList.contains("core-piece-description")){piece.description=target.value;changed();const state=dialog.querySelector<HTMLElement>(".core-run-state");if(state)state.textContent="Draft — no new observations applied to the model";return}
      else return;
      changed();render();
    }
  });
  let drag:{x:number;y:number;pointer:number}|undefined;
  const point=(event:PointerEvent,sheet:HTMLElement)=>{const rect=sheet.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))}};
  dialog.addEventListener("pointerdown",event=>{
    const sheet=(event.target as Element).closest<HTMLElement>(".core-photo-sheet");if(!sheet||readonly||mode==="view")return;
    const p=point(event,sheet);event.preventDefault();
    if(mode==="cut"){
      const current=row();if(!current)return;
      if(p.x<current.box.x0||p.x>current.box.x1||p.y<current.box.y0||p.y>current.box.y1){setNotice("Place the break inside the selected row.",true);return}
      const depth=Number(coreDepthAt(current,p.x).toFixed(6));validatedMutation(()=>addCut(depth));return;
    }
    drag={...p,pointer:event.pointerId};sheet.setPointerCapture(event.pointerId);
  });
  dialog.addEventListener("pointermove",event=>{
    if(!drag)return;const sheet=$(".core-photo-sheet"),p=point(event,sheet),drawing=$(".core-drawing");
    drawing.hidden=false;Object.assign(drawing.style,{left:`${Math.min(drag.x,p.x)*100}%`,top:`${Math.min(drag.y,p.y)*100}%`,width:`${Math.abs(drag.x-p.x)*100}%`,height:`${Math.abs(drag.y-p.y)*100}%`});
  });
  dialog.addEventListener("pointerup",event=>{
    if(!drag||event.pointerId!==drag.pointer)return;
    const p=point(event,$(".core-photo-sheet")),bounds={x0:Math.min(drag.x,p.x),y0:Math.min(drag.y,p.y),x1:Math.max(drag.x,p.x),y1:Math.max(drag.y,p.y)};drag=undefined;
    if(bounds.x1-bounds.x0<.005||bounds.y1-bounds.y0<.005){setNotice("Draw a rectangle around the full length and width of one core row.",true);return}
    $<HTMLDetailsElement>(".core-add-row-panel").open=true;
    for(const [key,value] of Object.entries(bounds))$<HTMLInputElement>(`.core-row-${key}`).value=String(Number((value*100).toFixed(3)));
    setNotice("Row bounds selected. Enter its known depth anchors, direction and add the row.");
    $<HTMLInputElement>(".core-row-from").focus();
  });
  dialog.addEventListener("pointercancel",()=>{drag=undefined;const drawing=dialog.querySelector<HTMLElement>(".core-drawing");if(drawing)drawing.hidden=true});
  dialog.addEventListener("cancel",event=>{event.preventDefault();close()});
  dialog.addEventListener("keydown",event=>{
    if(event.key!=="Tab")return;
    const elements=[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]')].filter(e=>e.getClientRects().length>0),first=elements[0],last=elements.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
  });
  render();document.body.appendChild(dialog);document.body.style.overflow="hidden";activeClose=close;dialog.showModal();closeButton.focus({preventScroll:true});
}
