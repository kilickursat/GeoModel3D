// The review of the boreholes read from PDFs: each borehole's values and layers beside the page they were read from,
// with a box on the page around the text of every value. Pointing at a value lights its box, and pointing at a box
// lights its value; focusing a value turns the page to it. Values the reader is unsure of are marked with the reason,
// until they are edited or confirmed. The checks run as values are edited, and "Use these boreholes" hands the
// boreholes to the Input data tables, which check them again as typed data.
import type {Doc} from "./pdftext";
import {DraftHole,Check,FIELDS,Field,checkDraft,draftTables,unitFor,pageRanges,num} from "./draft";
import type {TextLine} from "./reconstruct";
import {lithologyRules,japaneseLithologyRules} from "../rules";
import type {EditorTables} from "../tables";

export interface ReviewHost { onUse(tables:EditorTables,message:string,notes:string[]):void; onClose():void }
// A page no log was read from: a scanned image, a page that looked like a log but could not be read, or any other.
export interface Unread { doc:number; page:number; id?:string; error:string; scanned?:boolean; log?:boolean }

const esc=(s:string)=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]!));
const plural=(n:number,word:string)=>`${n} ${word}${n===1?"":"s"}`;
const ZOOMS=[1,1.5,2,3,4];
const RULE_UNITS=[...new Set([...lithologyRules,...japaneseLithologyRules].map(r=>r.unit))];

export function createReview(host:ReviewHost){
  const docs:Doc[]=[],sizes=new Map<string,{width:number;height:number}>(),closing:Array<()=>void>=[];
  let holes:DraftHole[]=[],checks:Check[]=[],unread:Unread[]=[],problems:string[]=[];
  let current=0,active="",edited=false,closed=false,ready=false,timer:ReturnType<typeof setTimeout>|undefined;
  const view={doc:0,page:1,zoom:0};
  let job:{cancel():void}|null=null,shown="";

  const el=document.createElement("section");
  el.className="dr";
  el.setAttribute("role","dialog");
  el.setAttribute("aria-modal","true");
  el.setAttribute("aria-label","Borehole logs read from documents");
  el.innerHTML=`<header class="dr-head"><div class="dr-title"><b>Borehole logs from documents</b><span class="dr-sub" aria-live="polite">Opening…</span></div>
<span class="dr-say" aria-live="assertive"></span><button class="dr-cancel">Cancel</button><button class="dr-use" disabled>Use these boreholes</button></header>
<div class="dr-main">
  <div class="dr-side"><div class="dr-checks"></div><div class="dr-tabs" role="tablist" aria-label="Boreholes read"></div><div class="dr-hole" role="tabpanel"></div><div class="dr-unread"></div></div>
  <div class="dr-view"><div class="dr-bar"><button class="dr-prev" aria-label="Previous page">‹</button><span class="dr-pageno"></span><button class="dr-next" aria-label="Next page">›</button>
    <span class="dr-gap"></span><button class="dr-zoom" data-zoom="-1" aria-label="Zoom out">−</button><button class="dr-zoom" data-zoom="0">Fit width</button><button class="dr-zoom" data-zoom="1" aria-label="Zoom in">+</button></div>
    <div class="dr-scroll"><div class="dr-sheet"><canvas></canvas><div class="dr-boxes"></div></div><p class="dr-page-note"></p></div></div>
</div><datalist id="dr-units"></datalist>`;
  const $=<T extends Element>(s:string)=>el.querySelector<T&HTMLElement>(s)!;
  const sub=$(".dr-sub"),sayEl=$(".dr-say"),useButton=$<HTMLButtonElement>(".dr-use"),checksEl=$(".dr-checks"),tabs=$(".dr-tabs"),panel=$(".dr-hole"),unreadEl=$(".dr-unread");
  const scroller=$(".dr-scroll"),sheet=$(".dr-sheet"),boxes=$(".dr-boxes"),pageNo=$(".dr-pageno"),pageNote=$(".dr-page-note");
  const say=(text:string)=>{sayEl.textContent=text};

  // ---------- the side: checks, boreholes, the borehole shown, pages not read ----------

  const label=(h:DraftHole)=>h.values.id.trim()||"(no ID)";
  const where=(c:Check)=>c.field?`f:${c.field}`:c.layer!==undefined?`l:${c.layer}`:"";
  function renderChecks(){
    const used=holes.filter(h=>h.use).length;
    const shown=checks.filter(c=>c.level!=="note"),errors=checks.filter(c=>c.level==="error").length;
    const summary=!holes.length?"<p><b>No borehole log was read.</b> Logs drawn with a depth scale, and logs set out as tables with From and To columns, are read from digital PDFs. You can type the boreholes in under Input data.</p>"
      :`<p><b>${plural(holes.length,"borehole")} read</b>${used<holes.length?`, ${used} to use`:""}. ${errors?`<span class="dr-n-error">${plural(errors,"problem")}</span> to fix before use. `:""}${shown.length-errors?`${plural(shown.length-errors,"value")} to check against the page.`:errors?"":"Nothing marked: still compare the values with the page."}</p>`;
    const item=(c:Check)=>`<li class="${c.level}"><button data-hole="${c.hole}" data-go="${where(c)}"><b>${esc(label(holes[c.hole]))}</b> ${esc(c.text)}</button></li>`;
    const order={error:0,warn:1,note:2},list=[...checks].sort((a,b)=>order[a.level]-order[b.level]||a.hole-b.hole);
    checksEl.innerHTML=summary+(list.length?`<ul>${list.slice(0,5).map(item).join("")}</ul>${list.length>5?`<details><summary>${list.length-5} more</summary><ul>${list.slice(5).map(item).join("")}</ul></details>`:""}`:"");
    useButton.disabled=!used;
  }
  function renderTabs(){
    tabs.innerHTML=holes.map((h,i)=>{
      const n=checks.filter(c=>c.hole===i&&c.level!=="note").length,file=docs.length>1?`${docs[h.doc].name}, `:"";
      return `<div class="dr-tab${i===current?" on":""}${h.use?"":" off"}"><input type="checkbox" data-use="${i}"${h.use?" checked":""} aria-label="Use ${esc(label(h))}" title="Use this borehole"><button role="tab" data-hole="${i}" aria-selected="${i===current}">${esc(label(h))}<small>${esc(file)}p. ${pageRanges(h.pages)}</small>${n&&h.use?`<i title="${plural(n,"value")} to check">${n}</i>`:""}</button></div>`;
    }).join("");
  }
  // A description box is as tall as its text.
  const fit=(t:HTMLTextAreaElement)=>{t.style.height="auto";t.style.height=`${t.scrollHeight+2}px`};
  function renderHole(){
    const h=holes[current];
    if(!h){panel.innerHTML="";return}
    const field=(f:typeof FIELDS[number])=>{
      const flag=h.flags[f.key],key=`f:${f.key}`;
      return `<div class="dr-field${flag?" flag":""}" data-key="${key}"><label for="dr-f-${f.key}">${f.label}</label><input id="dr-f-${f.key}" data-field="${f.key}" value="${esc(h.values[f.key])}"${f.numeric?' inputmode="decimal"':""} spellcheck="false" placeholder="${h.src[f.key]?"":"not read"}">${
        flag?`<small class="dr-flag">${esc(flag)} <button class="dr-ok" data-ok="${key}">Looks right</button></small>`:""}</div>`;
    };
    const layer=(l:DraftHole["layers"][number],k:number)=>{
      const key=`l:${k}`,name={from:"From (m)",to:"To (m)",unit:"Unit"};
      const cellOf=(c:"from"|"to"|"unit",extra="")=>`<td data-label="${name[c]}"><input data-layer="${k}" data-c="${c}" value="${esc(l[c])}" aria-label="Layer ${k+1}, ${name[c]}"${extra} spellcheck="false"></td>`;
      return `<tr class="dr-row${l.flag?" flag":""}" data-key="${key}"><td class="dr-n">${k+1}</td>${cellOf("from",' inputmode="decimal"')}${cellOf("to",' inputmode="decimal"')}${cellOf("unit",' list="dr-units"')}
<td><textarea data-layer="${k}" data-c="description" rows="1" aria-label="Layer ${k+1}, description">${esc(l.description)}</textarea></td>
<td class="dr-acts"><button class="dr-ins" data-layer="${k}" title="Add a layer below" aria-label="Add a layer below layer ${k+1}">+</button><button class="dr-del" data-layer="${k}" title="Delete this layer" aria-label="Delete layer ${k+1}">×</button></td></tr>${
        l.flag?`<tr class="dr-why" data-key="${key}"><td></td><td colspan="5">${esc(l.to)} m: ${esc(l.flag)} <button class="dr-ok" data-ok="${key}">Looks right</button></td></tr>`:""}`;
    };
    panel.innerHTML=`<div class="dr-fields">${FIELDS.map(field).join("")}</div>
<div class="dr-layers-head"><b>Layers</b><span>${h.kind==="table"?"read from the From and To columns of a table":"read by the depth scale on the page"}${h.ocr?", by OCR from a scanned page":""}</span><button class="dr-add">Add layer</button></div>
<div class="dr-table-wrap"><table class="dr-layers"><thead><tr><th></th><th>From (m)</th><th>To (m)</th><th>Unit</th><th>Description</th><th></th></tr></thead><tbody>${h.layers.map(layer).join("")}</tbody></table>${
      h.layers.length?"":'<p class="dr-empty">No layers: add them, or leave this borehole out.</p>'}</div>`;
    $("#dr-units").innerHTML=[...new Set([...holes.flatMap(h=>h.layers.map(l=>l.unit.trim())),...RULE_UNITS])].filter(Boolean).map(u=>`<option value="${esc(u)}">`).join("");
    panel.querySelectorAll("textarea").forEach(fit);
  }
  function renderUnread(){
    const parts:string[]=[...problems.map(p=>`<li class="error">${esc(p)}</li>`)];
    docs.forEach((d,i)=>{
      const of=unread.filter(u=>u.doc===i),name=docs.length>1?`${d.name}: `:"";
      const go=(u:Unread)=>`<button data-doc="${i}" data-page="${u.page}">page ${u.page}</button>`;
      const scanned=of.filter(u=>u.scanned),logs=of.filter(u=>!u.scanned&&u.log),other=of.filter(u=>!u.scanned&&!u.log).map(u=>u.page);
      for(const why of new Set(scanned.map(u=>u.error))){
        const pages=scanned.filter(u=>u.error===why).map(u=>u.page);
        parts.push(`<li>${esc(name)}${pages.length===1?"Page":"Pages"} ${pageRanges(pages)}: scanned, not read: ${esc(why)}.</li>`);
      }
      for(const u of logs)parts.push(`<li>${esc(name)}${go(u)}${u.id?` (${esc(u.id)})`:""}: looks like a log, but ${esc(u.error)}.</li>`);
      if(other.length)parts.push(`<li>${esc(name)}${other.length===1?"Page":"Pages"} ${pageRanges(other)}: no borehole log found.</li>`);
    });
    const n=unread.length;
    unreadEl.innerHTML=parts.length?`<details${holes.length?"":" open"}><summary>${n?`${plural(n,"page")} not read`:"Not read"}</summary><ul>${parts.join("")}</ul></details>`:"";
  }
  function renderAll(){checks=checkDraft(holes);renderChecks();renderTabs();renderHole();renderUnread()}
  // The checks follow the typing, without redrawing the field being typed in.
  function recheck(){clearTimeout(timer);timer=setTimeout(()=>{checks=checkDraft(holes);renderChecks();renderTabs()},250)}

  // ---------- the page ----------

  const key=(doc:number,page:number)=>`${doc}#${page}`;
  // The lines a value was read from.
  function evidence(h:DraftHole,k:string):TextLine[]{
    if(k.startsWith("f:")){const s=h.src[k.slice(2) as Field];return s?[s]:[]}
    if(k.startsWith("l:"))return h.layers[Number(k.slice(2))]?.src??[];
    return [];
  }
  function showPage(){
    const d=docs[view.doc];
    if(!d)return;
    view.page=Math.min(Math.max(1,view.page),d.pages);
    pageNo.textContent=`Page ${view.page} of ${d.pages}${docs.length>1?` · ${d.name}`:""}`;
    $<HTMLButtonElement>(".dr-prev").disabled=view.page<=1;
    $<HTMLButtonElement>(".dr-next").disabled=view.page>=d.pages;
    const size=sizes.get(key(view.doc,view.page))??{width:1275,height:1650};
    const fit=Math.max(240,scroller.clientWidth-24),css=Math.round(fit*(ZOOMS[view.zoom]??1));
    sheet.style.width=`${css}px`;
    sheet.style.aspectRatio=`${size.width} / ${size.height}`;
    const now=key(view.doc,view.page),canvas=document.createElement("canvas");
    // Another page clears at once; the same page, zoomed, stays until it is drawn again.
    if(now!==shown)sheet.querySelector("canvas")!.replaceWith(document.createElement("canvas"));
    shown=now;
    job?.cancel();
    const j=d.render(view.page,canvas,css);
    job=j;
    j.done.then(()=>{if(job===j&&!closed)sheet.querySelector("canvas")!.replaceWith(canvas)},err=>{if(job===j)pageNote.textContent=`This page could not be drawn: ${(err as Error).message}`});
    drawBoxes();
  }
  function drawBoxes(){
    const h=holes[current],size=sizes.get(key(view.doc,view.page));
    pageNote.textContent="";
    if(!h||!size||h.doc!==view.doc){boxes.innerHTML="";return}
    const out:string[]=[];
    const box=(l:TextLine,k:string,flag:boolean,title:string)=>{
      if(l.page!==view.page)return;
      out.push(`<div class="dr-box${flag?" flag":""}${k===active?" on":""}" data-key="${k}" title="${esc(title)}" style="left:${(l.x0/size.width*100).toFixed(3)}%;top:${(l.y0/size.height*100).toFixed(3)}%;width:${((l.x1-l.x0)/size.width*100).toFixed(3)}%;height:${((l.y1-l.y0)/size.height*100).toFixed(3)}%"></div>`);
    };
    for(const f of FIELDS){const s=h.src[f.key];if(s)box(s,`f:${f.key}`,!!h.flags[f.key],`${f.label}: ${h.values[f.key]}`)}
    h.layers.forEach((l,k)=>l.src.forEach(s=>box(s,`l:${k}`,!!l.flag,`Layer ${k+1}: ${l.from}–${l.to} m${l.unit?`, ${l.unit}`:""}`)));
    boxes.innerHTML=out.join("");
    if(!out.length)pageNote.textContent=h.pages.includes(view.page)?"":`Nothing of ${label(h)} was read on this page.`;
  }
  // Lights a value and its boxes; `turn` also brings its first box into view, turning the page where needed.
  function setActive(k:string,turn=false){
    active=k;
    for(const e of el.querySelectorAll<HTMLElement>("[data-key]"))e.classList.toggle("on",!!k&&e.dataset.key===k);
    if(!turn||!k)return;
    const h=holes[current],first=evidence(h,k).find(l=>l.page!==undefined);
    if(!first)return;
    if(view.doc!==h.doc||view.page!==first.page){view.doc=h.doc;view.page=first.page!;showPage()}
    const b=boxes.querySelector<HTMLElement>(`[data-key="${k}"]`);
    if(b){
      const s=scroller.getBoundingClientRect(),r=b.getBoundingClientRect();
      if(r.top<s.top+30||r.bottom>s.bottom-30)scroller.scrollBy({top:r.top-s.top-s.height/3,behavior:"smooth"});
      if(r.left<s.left||r.right>s.right)scroller.scrollBy({left:r.left-s.left-24,behavior:"smooth"});
    }
  }
  function select(i:number){
    current=i;active="";
    const h=holes[i];
    renderTabs();renderHole();
    if(h){view.doc=h.doc;view.page=h.pages[0];showPage();scroller.scrollTo({top:0})}
  }
  // Goes to a value: its borehole, its field or row (focused), and its box.
  function go(hole:number,k:string){
    if(hole!==current)select(hole);
    if(!k)return;
    const target=k.startsWith("f:")?panel.querySelector<HTMLElement>(`[data-field="${k.slice(2)}"]`):panel.querySelector<HTMLElement>(`tr[data-key="${k}"] input`);
    target?.focus();
    setActive(k,true);
  }
  new ResizeObserver(()=>{if(ready&&scroller.clientWidth)showPage()}).observe(scroller);

  // ---------- editing ----------

  function unflag(k:string){
    const h=holes[current];
    if(k.startsWith("f:"))delete h.flags[k.slice(2) as Field];
    else delete h.layers[Number(k.slice(2))].flag;
    for(const e of panel.querySelectorAll<HTMLElement>(`[data-key="${k}"]`)){e.classList.remove("flag");e.querySelector(".dr-flag")?.remove();if(e.classList.contains("dr-why"))e.remove()}
    for(const b of boxes.querySelectorAll(`[data-key="${k}"]`))b.classList.remove("flag");
  }
  function insertLayer(at:number){
    const h=holes[current],before=h.layers[at-1],after=h.layers[at];
    h.layers.splice(at,0,{from:before?.to??"0",to:after?.from&&after.from!==before?.to?after.from:"",unit:"",description:"",autoUnit:true,src:[]});
    edited=true;renderAll();
    panel.querySelector<HTMLInputElement>(`tr[data-key="l:${at}"] input[data-c="${before?"to":"from"}"]`)?.focus();
  }
  el.addEventListener("click",e=>{
    const t=e.target as HTMLElement,b=t.closest<HTMLButtonElement>("button");
    const boxEl=t.closest<HTMLElement>(".dr-box");
    if(boxEl){go(current,boxEl.dataset.key!);return}
    if(!b)return;
    if(b.classList.contains("dr-cancel")){cancel();return}
    if(b.classList.contains("dr-use")){use();return}
    if(b.dataset.go!==undefined){go(Number(b.dataset.hole),b.dataset.go);return}
    if(b.dataset.hole!==undefined){select(Number(b.dataset.hole));return}
    if(b.dataset.ok){unflag(b.dataset.ok);edited=true;recheck();return}
    if(b.dataset.page){view.doc=Number(b.dataset.doc);view.page=Number(b.dataset.page);showPage();scroller.scrollTo({top:0});return}
    if(b.classList.contains("dr-prev")||b.classList.contains("dr-next")){view.page+=b.classList.contains("dr-next")?1:-1;showPage();scroller.scrollTo({top:0});return}
    if(b.dataset.zoom!==undefined){const z=Number(b.dataset.zoom);view.zoom=z?Math.min(ZOOMS.length-1,Math.max(0,view.zoom+z)):0;showPage();return}
    if(b.classList.contains("dr-add")){insertLayer(holes[current].layers.length);return}
    if(b.classList.contains("dr-ins")){insertLayer(Number(b.dataset.layer)+1);return}
    if(b.classList.contains("dr-del")){holes[current].layers.splice(Number(b.dataset.layer),1);edited=true;active="";renderAll();drawBoxes();return}
  });
  el.addEventListener("change",e=>{
    const t=e.target as HTMLInputElement;
    if(t.dataset.use===undefined)return;
    holes[Number(t.dataset.use)].use=t.checked;edited=true;
    checks=checkDraft(holes);renderChecks();renderTabs();
  });
  el.addEventListener("input",e=>{
    const t=e.target as HTMLInputElement|HTMLTextAreaElement,h=holes[current];
    if(!h)return;
    if(t.dataset.field){
      const f=t.dataset.field as Field;
      h.values[f]=t.value;
      if(h.flags[f])unflag(`f:${f}`);
    }else if(t.dataset.layer!==undefined){
      const k=Number(t.dataset.layer),l=h.layers[k],c=t.dataset.c as "from"|"to"|"unit"|"description";
      l[c]=t.value;
      if(c==="unit")l.autoUnit=false;
      // A unit the rules gave follows its description.
      if(c==="description"&&l.autoUnit){l.unit=unitFor(t.value);const u=panel.querySelector<HTMLInputElement>(`input[data-layer="${k}"][data-c="unit"]`);if(u)u.value=l.unit}
      if(t instanceof HTMLTextAreaElement)fit(t);
      if(c==="to"&&l.flag)unflag(`l:${k}`);
    }else return;
    edited=true;
    recheck();
  });
  el.addEventListener("focusin",e=>{const k=(e.target as HTMLElement).closest<HTMLElement>(".dr-hole [data-key]")?.dataset.key;if(k&&k!==active)setActive(k,true)});
  el.addEventListener("pointerover",e=>{
    const k=(e.target as HTMLElement).closest<HTMLElement>(".dr-hole [data-key],.dr-box")?.dataset.key;
    if(k&&k!==active)setActive(k);
  });
  el.addEventListener("keydown",e=>{if(e.key==="Escape"&&!(e.target as Element).closest("input,textarea,select")){e.stopPropagation();cancel()}});

  // ---------- leaving ----------

  function cancel(){
    if(edited&&!confirm("Close the review? The corrections made in it are lost."))return;
    close();
  }
  function use(){
    checks=checkDraft(holes);
    renderChecks();renderTabs();
    const errors=checks.filter(c=>c.level==="error");
    if(errors.length){say(`Fix the ${plural(errors.length,"problem")} marked first.`);go(errors[0].hole,where(errors[0]));return}
    const used=holes.filter(h=>h.use),files=docs.map(d=>d.name);
    const notes=checks.filter(c=>c.level!=="error").map(c=>`${label(holes[c.hole])}: ${c.text}`);
    if(used.some(h=>Number.isFinite(num(h.values.x)??NaN)))notes.push("Positions read as eastings and northings are in a coordinate system the document does not name: give it under Project (an EPSG code or a name), or the model stays on a local grid");
    const names=[...new Set(used.map(h=>docs[h.doc].name))];
    host.onUse(draftTables(holes,files),`${plural(used.length,"borehole")} read from ${names.join(", ")}: check the tables, then build the model.`,notes);
    close();
  }
  function close(){
    if(closed)return;
    closed=true;
    clearTimeout(timer);job?.cancel();
    for(const f of closing)f();
    for(const d of docs)void d.close();
    el.remove();
    host.onClose();
  }

  return {
    element:el,
    get closed(){return closed},
    progress(text:string){sub.textContent=text},
    // What to stop when the review closes (the reading model in the middle of a page).
    onClose(f:()=>void){closing.push(f)},
    addDoc(d:Doc){docs.push(d);return docs.length-1},
    size(doc:number,page:number,width:number,height:number){sizes.set(key(doc,page),{width,height})},
    show(read:DraftHole[],notRead:Unread[],failed:string[]){
      holes=read;unread=notRead;problems=failed;ready=true;
      const pages=docs.reduce((s,d)=>s+d.pages,0);
      sub.textContent=docs.length?`${docs.map(d=>d.name).join(", ")} · ${plural(pages,"page")}`:"Nothing could be read";
      renderAll();
      if(holes.length)select(0);
      else if(docs.length){view.doc=0;view.page=1;showPage()}
      (el.querySelector<HTMLElement>(".dr-tab button")??$(".dr-cancel")).focus();
    }
  };
}
