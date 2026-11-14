// A saved source page and its read-out, independent of the document reader. Evidence can be inspected after a
// workspace has been reopened, including in the standalone app, without loading PDF.js or making a network request.
import type {EvidenceCollection} from "./evidence";
import "./evidence.css";

type RecordEvidence=EvidenceCollection["records"][number];
type FieldEvidence=RecordEvidence["fields"][string];
type SourceEvidence=EvidenceCollection["sources"][number];

const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const labels:Record<string,string>={id:"Borehole",boreholeId:"Borehole",x:"Easting (m)",y:"Northing (m)",lat:"Latitude",lon:"Longitude",z:"Ground level (m)",
  ground:"Ground level (m)",depth:"Depth (m)",final:"Final depth (m)",water:"Water depth (m)",from:"From (m)",to:"To (m)",unit:"Unit",description:"Description",date:"Date"};
const label=(key:string)=>Object.hasOwn(labels,key)?labels[key]:key;
const method=(value:RecordEvidence["method"])=>value==="pdf-text"?"PDF text":value==="ocr"?"OCR":"Entered manually";
const status=(value:FieldEvidence["status"])=>value==="accepted"?"Accepted":value==="corrected"?"Corrected; check before use":"Not explicitly accepted";
const numericFields=new Set(["x","y","lat","lon","z","ground","depth","final","water","from","to"]);
function sameValue(key:string,a:string,b:string):boolean{
  if(a===b)return true;
  if(!numericFields.has(key))return false;
  const numeric=(s:string)=>{
    const value=s.trim().replace(/^−/,"-").replace(",",".");
    return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)&&Number.isFinite(Number(value))?Number(value):undefined;
  };
  const left=numeric(a),right=numeric(b);
  return left!==undefined&&right!==undefined&&left===right;
}
const readable=(value:string)=>value===""?"(empty)":value;
const date=(value:string)=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():value;
let activeClose:(()=>void)|undefined,sequence=0;

export interface EvidenceViewOptions { onAccept?(field:string):void; currentValues?:Record<string,string> }

export function showEvidence(evidence:EvidenceCollection,id:string,title="Source evidence",options:EvidenceViewOptions={}):void{
  activeClose?.();
  const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
  const oldOverflow=document.body.style.overflow;
  const record=evidence.records.find(r=>r.id===id),source=record?evidence.sources.find(s=>s.id===record.sourceId):undefined;
  const keys=Object.keys(record?.fields??{});
  const fieldLabel=(key:string)=>key==="depth"&&record?(Object.hasOwn(record.fields,"id")?"Final depth (m)":Object.hasOwn(record.fields,"boreholeId")?"Water depth (m)":label(key)):label(key);
  let selected=keys[0]??"",page=record?.fields[selected]?.boxes[0]?.page??source?.pages[0]?.page??1,closed=false,acceptError="";
  const headingId=`evidence-heading-${++sequence}`;
  const dialog=document.createElement("dialog");
  dialog.className="ev-dialog";
  dialog.setAttribute("aria-labelledby",headingId);
  dialog.innerHTML=`<header class="ev-header"><div><h2 id="${headingId}">${esc(title)}</h2><p class="ev-source"></p></div><button type="button" class="ev-close" aria-label="Close source evidence">Close</button></header>
<div class="ev-content"><section class="ev-values" aria-label="Evidence values"><div class="ev-fields" role="group" aria-label="Select a value"></div><div class="ev-detail"></div></section>
<section class="ev-source-page" aria-label="Source page"><div class="ev-page-toolbar"><button type="button" class="ev-page-prev" aria-label="Previous saved page">‹</button><span class="ev-page-number" aria-live="polite"></span><button type="button" class="ev-page-next" aria-label="Next saved page">›</button></div><div class="ev-page-body"></div></section></div>`;
  const $=<T extends HTMLElement>(selector:string)=>dialog.querySelector<T>(selector)!;
  const closeButton=$<HTMLButtonElement>(".ev-close"),fields=$(".ev-fields"),detail=$(".ev-detail"),sourceLine=$(".ev-source"),pageBody=$(".ev-page-body");
  const previous=$<HTMLButtonElement>(".ev-page-prev"),next=$<HTMLButtonElement>(".ev-page-next"),pageNumber=$(".ev-page-number");

  function close(){
    if(closed)return;
    closed=true;
    dialog.removeEventListener("keydown",onKey);
    if(dialog.open)dialog.close();
    dialog.remove();document.body.style.overflow=oldOverflow;
    if(activeClose===close)activeClose=undefined;
    if(opener?.isConnected)opener.focus({preventScroll:true});
  }
  function onKey(event:KeyboardEvent){
    if(event.key==="Escape"){event.preventDefault();close();return}
    if(event.key!=="Tab")return;
    const focusable=[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],summary,[tabindex="0"]')].filter(el=>el.getClientRects().length>0);
    const first=focusable[0],last=focusable[focusable.length-1];
    if(!first){event.preventDefault();closeButton.focus();return}
    if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last.focus()}
    else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first.focus()}
  }
  function pages(){
    return [...new Set([...(source?.pages.map(p=>p.page)??[]),...(record?.fields[selected]?.boxes.map(b=>b.page)??[])])].sort((a,b)=>a-b);
  }
  function renderPage(){
    const list=pages();
    if(!list.includes(page))page=list[0]??1;
    const at=list.indexOf(page),saved=source?.pages.find(p=>p.page===page),boxes=record?.fields[selected]?.boxes.filter(b=>b.page===page)??[];
    previous.disabled=at<=0;next.disabled=at<0||at>=list.length-1;
    pageNumber.textContent=list.length?`Page ${page}${list.length>1?` · ${list.length} saved pages`:""}`:"No source page";
    // Imported images have already passed evidence validation. Restrict the inspector too, so a direct API caller
    // cannot turn a source reference into an external image request or executable SVG.
    const image=saved?.image&&/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(saved.image)?saved.image:undefined;
    const picture=image&&saved?`<div class="ev-page-sheet" style="aspect-ratio:${saved.width}/${saved.height}"><img class="ev-page-image" src="${image}" alt="${esc(`Source page ${page}${source?` from ${source.name}`:""}`)}" draggable="false"><div class="ev-boxes" aria-hidden="true">${boxes.map(b=>
      `<span class="ev-box" style="left:${b.x0*100}%;top:${b.y0*100}%;width:${(b.x1-b.x0)*100}%;height:${(b.y1-b.y0)*100}%"></span>`).join("")}</div></div>`
      :'<p class="ev-missing">A page preview was not saved. Source text and page references are shown below where available.</p>';
    pageBody.innerHTML=picture+`<div class="ev-excerpts"><h3>Source text for ${esc(fieldLabel(selected)||"this value")}</h3>${boxes.length?boxes.map(b=>`<blockquote>${esc(b.text)}</blockquote>`).join(""):'<p>No source text is linked to this value on this page.</p>'}</div>`;
    pageBody.querySelector<HTMLImageElement>(".ev-page-image")?.addEventListener("error",()=>{
      const notice=document.createElement("p");notice.className="ev-missing";
      notice.textContent="The saved page preview could not be displayed. Its source text and page references remain available.";
      pageBody.querySelector(".ev-page-sheet")?.replaceWith(notice);
    },{once:true});
  }
  function render(){
    if(!record){
      sourceLine.textContent="No saved evidence is linked to this record.";
      fields.hidden=true;detail.innerHTML='<p class="ev-missing">This project may predate saved evidence, or this value may have been entered manually.</p>';
      renderPage();return;
    }
    sourceLine.textContent=`${source?.name??"Source document unavailable"} · ${method(record.method)}`;
    fields.innerHTML=keys.map(key=>`<button type="button" data-evidence-field="${esc(key)}" aria-pressed="${key===selected}">${esc(fieldLabel(key))}</button>`).join("");
    const field=record.fields[selected];
    if(!field){detail.innerHTML='<p class="ev-missing">No field evidence was saved for this record.</p>';renderPage();return}
    const current=options.currentValues&&Object.hasOwn(options.currentValues,selected)?options.currentValues[selected]:field.current;
    const changed=!sameValue(selected,current,field.current),state=changed?"changed":field.status;
    const stateLabel=changed?(field.status==="accepted"?"Changed after acceptance; check before use":"Value differs from recorded evidence; check before use"):status(field.status);
    detail.innerHTML=`<h3>${esc(fieldLabel(selected))}</h3><p class="ev-status" data-status="${state}">${esc(stateLabel)}</p>${field.note?`<p class="ev-note">${esc(field.note)}</p>`:""}
<dl class="ev-comparison"><div><dt>Originally read</dt><dd class="ev-original">${esc(readable(field.original))}</dd></div><div><dt>Current value</dt><dd class="ev-current">${esc(readable(current))}</dd></div></dl>
${options.onAccept?'<button type="button" class="ev-accept">Accept current value</button>':""}${acceptError?`<p class="ev-accept-error" role="alert">${esc(acceptError)}</p>`:""}
<details class="ev-events" open><summary>Review history (${field.events.length})</summary>${field.events.length?`<ol>${field.events.map(e=>`<li><b>${e.action==="accepted"?"Accepted":"Corrected"}</b> <time datetime="${esc(e.at)}" title="${esc(e.at)}">${esc(date(e.at))}</time><p>${e.previous!==undefined?`${esc(readable(e.previous))} → `:""}${esc(readable(e.value))}</p>${e.reason?`<p>${esc(e.reason)}</p>`:""}</li>`).join("")}</ol>`:'<p>No explicit acceptance or correction was recorded.</p>'}</details>
${sourceDetails(source)}`;
    renderPage();
  }
  function sourceDetails(value:SourceEvidence|undefined){
    if(!value)return "";
    const hash=value.sha256?`<dt>SHA-256</dt><dd class="ev-hash">${esc(value.sha256)}</dd>`:"";
    return `<details class="ev-document"><summary>Source document</summary><dl><dt>Name</dt><dd>${esc(value.name)}</dd>${value.size!==undefined?`<dt>Size</dt><dd>${value.size.toLocaleString()} bytes</dd>`:""}${hash}</dl><p>The preview is a saved image of the source page. Original document bytes are not included.</p></details>`;
  }

  fields.addEventListener("click",event=>{
    const button=(event.target as Element).closest<HTMLButtonElement>("[data-evidence-field]");
    if(!button||!record)return;
    selected=button.dataset.evidenceField!;
    acceptError="";
    page=record.fields[selected]?.boxes[0]?.page??page;
    render();
    [...fields.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.dataset.evidenceField===selected)?.focus({preventScroll:true});
  });
  detail.addEventListener("click",event=>{
    if(!(event.target as Element).closest(".ev-accept")||!options.onAccept||!record?.fields[selected])return;
    try{options.onAccept(selected);acceptError=""}
    catch(error){acceptError=`The value could not be accepted: ${error instanceof Error?error.message:String(error)}`}
    render();detail.querySelector<HTMLButtonElement>(".ev-accept")?.focus({preventScroll:true});
  });
  previous.onclick=()=>{const list=pages();page=list[Math.max(0,list.indexOf(page)-1)]??page;renderPage()};
  next.onclick=()=>{const list=pages();page=list[Math.min(list.length-1,list.indexOf(page)+1)]??page;renderPage()};
  closeButton.onclick=close;
  dialog.addEventListener("cancel",event=>{event.preventDefault();close()});
  dialog.addEventListener("close",close);
  dialog.addEventListener("keydown",onKey);
  render();document.body.appendChild(dialog);document.body.style.overflow="hidden";activeClose=close;
  dialog.showModal();closeButton.focus({preventScroll:true});
}
