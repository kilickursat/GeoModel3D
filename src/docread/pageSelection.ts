import type {openPdf,Drawing} from "./pdftext";
import type {createReview} from "./review";
import type {ReportPageRole,ReportQwenGoal} from "./reportQwen";
import {reportQuestionPassages} from "./reportQwenExcerpt";
import {likelyEvidencePages} from "./reportEvidencePlan";
import {indexReportPage,initialPageSelection,needsPageSelection,pageRoleLabel,recordPageAssessment,type IndexedReportPage,type PageAssessment} from "./pageSelectionIndex";
import "./pageSelection.css";

type Pdf=Awaited<ReturnType<typeof openPdf>>;
type Host=Pick<ReturnType<typeof createReview>,"element"|"closed"|"onClose"|"progress">;

// The first pass requests only native text. Images, vector graphics, geometry extraction and OCR belong to selected pages.
async function indexPage(pdf:Pdf,n:number){
  const page=await pdf.doc.getPage(n);
  try{
    const {items}=await page.getTextContent();
    const lines:string[]=[];
    let words:string[]=[];
    for(const item of items){
      if(!("str" in item))continue;
      if(item.str.trim())words.push(item.str);
      if(item.hasEOL&&words.length){lines.push(words.join(" "));words=[]}
    }
    if(words.length)lines.push(words.join(" "));
    return indexReportPage(n,lines);
  }finally{page.cleanup()}
}

export async function selectReportPages(pdf:Pdf,review:Host):Promise<Set<number>|null>{
  if(review.closed)return null;
  if(pdf.pages===1)return new Set([1]);
  const pages:IndexedReportPage[]=[];
  for(let n=1;n<=pdf.pages;n++){
    if(review.closed)return null;
    review.progress(`Indexing ${pdf.name} · page ${n} of ${pdf.pages}`);
    try{pages.push(await indexPage(pdf,n))}
    catch{pages.push({page:n,role:"unknown",lines:[],excerpt:"Text could not be indexed. Preview this page."})}
  }
  if(review.closed)return null;
  if(!needsPageSelection(pages))return new Set(pages.map(p=>p.page));
  return pickPages(pdf,pages,review);
}

function pickPages(pdf:Pdf,pages:IndexedReportPage[],review:Host):Promise<Set<number>|null>{
  return new Promise(resolve=>{
    const panel=document.createElement("section");
    panel.className="dr-picker";
    panel.setAttribute("aria-label","Report page selection");
    panel.innerHTML=`<section class="dr-picker-list"><h2>Choose pages to read</h2>
<p>Include the logs and any pages that identify borehole locations. Uncertain pages and scans start selected.</p>
<div class="dr-picker-actions"><button type="button" class="dr-select-focused">Select log and location pages</button><button type="button" class="dr-select-all">Select all</button><button type="button" class="dr-clear-pages">Clear selection</button></div>
<details class="dr-qwen"><summary>Local Qwen page suggestions</summary>
<p>Qwen can suggest logs and location schedules from text excerpts. The first use downloads about 620 MiB of model weights from Hugging Face, plus the tokenizer and runtime. Report text stays in this browser.</p>
<label class="dr-qwen-goal">Find evidence for <select><option value="both">Completed collar locations and measured layers</option><option value="schedule">Completed collar locations</option><option value="log">Measured layers</option></select></label>
<label class="dr-qwen-scope">Analyze <select><option value="likely">Likely evidence pages</option><option value="all">All indexed pages</option><option value="checked">Checked pages only</option></select></label>
<p class="dr-qwen-scope-note"></p>
<button type="button" class="dr-run-qwen">Get Qwen suggestions</button> <button type="button" class="dr-stop-qwen" hidden>Stop Qwen</button>
<p class="dr-qwen-status" role="status"></p>
<p class="dr-qwen-missing" role="status"></p>
<button type="button" class="dr-include-qwen" hidden></button></details>
<ul class="dr-picker-pages"></ul>
<div class="dr-picker-submit"><span class="dr-picker-count" role="status"></span><button type="button" class="dr-read-pages">Read selected pages</button>
<button type="button" class="dr-skip-file">Skip document</button></div></section>
<section class="dr-picker-source" aria-label="Source page"><h3 class="dr-preview-heading"></h3><div class="dr-preview-scroll"><section class="dr-qwen-source" aria-label="Text Qwen evaluated" hidden><h4>Text Qwen evaluated</h4><div></div></section><div class="dr-preview-sheet"></div></div><p class="dr-preview-error" role="status"></p></section>`;
    // The enclosing review retains its Cancel control while page selection is open.
    review.element.classList.add("dr-picking");
    review.element.appendChild(panel);
    review.progress(pdf.name);
    const get=<T extends HTMLElement>(selector:string)=>panel.querySelector<T>(selector)!;
    const list=get<HTMLUListElement>(".dr-picker-pages"),read=get<HTMLButtonElement>(".dr-read-pages");
    const count=get(".dr-picker-count"),qStatus=get(".dr-qwen-status");
    const focusSelection=get<HTMLButtonElement>(".dr-select-focused");
    const runQwen=get<HTMLButtonElement>(".dr-run-qwen"),stopQwen=get<HTMLButtonElement>(".dr-stop-qwen");
    const qScope=get<HTMLSelectElement>(".dr-qwen-scope select"),qGoal=get<HTMLSelectElement>(".dr-qwen-goal select");
    const goal=()=>qGoal.value as ReportQwenGoal;
    const includeQwen=get<HTMLButtonElement>(".dr-include-qwen"),assessments=new Map<number,PageAssessment>();
    const previewError=get(".dr-preview-error");
    const chosen=initialPageSelection(pages);
    const logOrLocation=pages.filter(p=>p.role==="log"||p.role==="schedule").map(p=>p.page);
    const inputs=new Map<number,HTMLInputElement>(),annotations=new Map<number,HTMLElement>(),inspectButtons=new Map<number,HTMLButtonElement>();
    const sourceText=get(".dr-qwen-source"),sourcePassages=get(".dr-qwen-source div");
    const pagesByNumber=new Map(pages.map(p=>[p.page,p]));
    let inspected:number|undefined,attempted=false;
    let drawing:Drawing|undefined,controller:AbortController|undefined,closed=false;
    const lifetime=new AbortController();
    const cancelled=()=>finish(null);
    const finish=(selection:Set<number>|null)=>{
      if(closed)return;
      closed=true;lifetime.signal.removeEventListener("abort",cancelled);
      drawing?.cancel();controller?.abort();
      panel.remove();review.element.classList.remove("dr-picking");resolve(selection);
    };
    // The review can stay open across many PDFs. Release the index, controls and preview canvas after each choice.
    lifetime.signal.addEventListener("abort",cancelled,{once:true});
    review.onClose(lifetime.abort.bind(lifetime));
    const shortlist=new Map<ReportQwenGoal,IndexedReportPage[]>();
    const pagesInScope=()=>{
      if(qScope.value==="all")return pages;
      if(qScope.value==="checked")return pages.filter(p=>chosen.has(p.page));
      const target=goal();
      if(!shortlist.has(target))shortlist.set(target,likelyEvidencePages(pages,target));
      return shortlist.get(target)!;
    };
    const suggested=(target:ReportQwenGoal)=>{
      const result:number[]=[];
      for(const [n,a] of assessments)if(target!=="log"&&a.schedule||target!=="schedule"&&a.log)result.push(n);
      return result;
    };
    const refreshSuggestions=()=>{
      focusSelection.disabled=!logOrLocation.length&&!suggested("both").length;
      const additional=suggested(goal()).filter(n=>!chosen.has(n)).length;
      includeQwen.hidden=!additional;
      includeQwen.textContent=`Include ${additional} suggested ${additional===1?"page":"pages"}`;
      const missing:string[]=[];
      if(goal()!=="log"&&!suggested("schedule").some(n=>chosen.has(n)))missing.push("completed collar locations");
      if(goal()!=="schedule"&&!suggested("log").some(n=>chosen.has(n)))missing.push("measured layers");
      get(".dr-qwen-missing").textContent=attempted&&missing.length?`Qwen has yet to suggest a checked page for ${missing.join(" or ")}. Preview pages or widen the search.`:"";
    };
    const refresh=()=>{
      const skippedScans=pages.filter(p=>!p.lines.length&&!chosen.has(p.page)).length;
      count.textContent=`${chosen.size} of ${pages.length} pages selected${skippedScans?` · ${skippedScans} excluded ${skippedScans===1?"page has":"pages have"} no usable indexed text`:""}`;
      read.disabled=!chosen.size;
      const scope=pagesInScope(),readable=scope.filter(p=>p.lines.length).length;
      const candidates=`${readable} of ${pages.length} ${pages.length===1?"page":"pages"} will be searched.`;
      get(".dr-qwen-scope-note").textContent=qScope.value==="likely"
        ?`${candidates} Image-only pages are skipped. Choose All indexed pages for a wider search.`
        :`${candidates}${scope.length>readable?" Image-only pages are skipped.":""}`;
      runQwen.disabled=!!controller||!readable;
      qScope.disabled=!!controller;qGoal.disabled=!!controller;
      for(const [n,input] of inputs)input.checked=chosen.has(n);
      refreshSuggestions();
    };
    const showPassages=(page:number)=>{
      const result=assessments.get(page),source=pagesByNumber.get(page);
      if(!result||!source)return;
      sourcePassages.replaceChildren();
      const passages=reportQuestionPassages(source.lines);
      for(const key of ["schedule","log"] as const){
        if(result[key]===undefined)continue;
        const title=document.createElement("h5"),quote=document.createElement("pre");
        title.textContent=key==="log"?"Measured layers":"Completed collar locations";
        quote.textContent=passages[key];
        sourcePassages.append(title,quote);
      }
      sourceText.hidden=false;
    };
    const preview=(page:number,inspect=false)=>{
      drawing?.cancel();previewError.textContent="";
      inspected=inspect?page:undefined;
      if(inspect)showPassages(page);else sourceText.hidden=true;
      get(".dr-preview-heading").textContent=`Source · page ${page}`;
      for(const button of list.querySelectorAll<HTMLButtonElement>("[data-preview]"))button.setAttribute("aria-pressed",String(Number(button.dataset.preview)===page));
      // Each render has its own canvas. A cancelled PDF.js job may still be releasing the old one.
      const next=document.createElement("canvas");
      next.setAttribute("aria-label",`Preview of page ${page}`);
      const scroll=get(".dr-preview-scroll");get(".dr-preview-sheet").replaceChildren(next);scroll.scrollTop=0;
      const job=pdf.render(page,next,Math.max(260,scroll.clientWidth-24));
      drawing=job;
      job.done.catch(()=>{if(drawing===job&&!closed)previewError.textContent="This page could not be previewed."});
    };
    for(const p of pages){
      const item=document.createElement("li"),label=document.createElement("label"),check=document.createElement("input");
      check.type="checkbox";check.setAttribute("aria-label",`Read page ${p.page}`);
      check.onchange=()=>{if(check.checked)chosen.add(p.page);else chosen.delete(p.page);refresh()};
      inputs.set(p.page,check);
      const text=document.createElement("span"),title=document.createElement("strong"),snippet=document.createElement("small");
      title.textContent=`Page ${p.page} · ${pageRoleLabel(p.role)}`;snippet.textContent=p.excerpt;
      const recommendation=document.createElement("small");recommendation.className="dr-qwen-suggestion";
      annotations.set(p.page,recommendation);text.append(title,snippet,recommendation);label.append(check,text);
      const source=document.createElement("button");source.type="button";source.textContent="Preview";source.dataset.preview=String(p.page);
      source.setAttribute("aria-label",`Preview page ${p.page}`);source.onclick=()=>preview(p.page);
      const inspect=document.createElement("button");inspect.type="button";inspect.textContent="Inspect Qwen text";
      inspect.setAttribute("aria-label",`Inspect Qwen text for page ${p.page}`);
      inspect.hidden=true;inspect.onclick=()=>preview(p.page,true);inspectButtons.set(p.page,inspect);
      const actions=document.createElement("span");actions.className="dr-source-actions";actions.append(source,inspect);
      item.append(label,actions);list.append(item);
    }
    get(".dr-select-all").onclick=()=>{for(const p of pages)chosen.add(p.page);refresh()};
    get(".dr-clear-pages").onclick=()=>{chosen.clear();refresh()};
    focusSelection.onclick=()=>{
      chosen.clear();
      for(const n of [...logOrLocation,...suggested("both")])chosen.add(n);
      refresh();
    };
    includeQwen.onclick=()=>{for(const n of suggested(goal()))chosen.add(n);refresh()};
    qScope.onchange=refresh;
    qGoal.onchange=refresh;
    read.onclick=()=>finish(chosen);
    get(".dr-skip-file").onclick=()=>finish(new Set());
    runQwen.onclick=async()=>{
      if(controller)return;
      const task=new AbortController();
      const scope=pagesInScope(),target=goal();
      const readable=new Set(scope.filter(p=>p.lines.length).map(p=>p.page)),completed=new Set<number>();
      const unreadable=scope.length-readable.size;
      let recommended=0;
      const summary=()=>`${completed.size} of ${readable.size} readable ${readable.size===1?"page":"pages"} classified · ${recommended} suggested${unreadable?` · ${unreadable} without usable text`:""}.`;
      const active=()=>controller===task&&!task.signal.aborted;
      const onPage=(n:number,role:ReportPageRole)=>{
        if(!active()||!readable.has(n)||completed.has(n))return;
        const annotation=annotations.get(n)!;
        if(role!=="other"&&role!=="log"&&role!=="schedule"&&role!=="both")return;
        const result=recordPageAssessment(assessments.get(n),target,role);
        assessments.set(n,result);
        if(target!=="log"&&result.schedule||target!=="schedule"&&result.log)recommended++;
        if(result.log||result.schedule){
          const label=result.log&&result.schedule?"borehole log and location schedule":result.log?"borehole log":"location schedule";
          annotation.textContent=`Qwen suggests ${label}`;
        }else annotation.textContent=result.log===undefined?"No completed collar location suggested":result.schedule===undefined?"No measured layers suggested":"Qwen did not suggest this page";
        inspectButtons.get(n)!.hidden=false;
        if(inspected===n)showPassages(n);
        completed.add(n);qStatus.textContent=summary();refreshSuggestions();
      };
      controller=task;stopQwen.hidden=false;attempted=true;
      refresh();qStatus.textContent="Starting local Qwen…";
      stopQwen.onclick=()=>{
        task.abort();controller=undefined;stopQwen.hidden=true;
        qStatus.textContent=`Qwen stopped. ${summary()}`;refresh();
      };
      try{
        const {suggestReportPages}=await import("./reportQwen");
        if(!active())return;
        await suggestReportPages(scope,{signal:task.signal,goal:target,onPage,onProgress:message=>{
          if(active())qStatus.textContent=`${message}${completed.size?` ${summary()}`:""}`;
        }});
        if(active())qStatus.textContent=summary();
      }catch(error){
        if(active())qStatus.textContent=`Qwen could not finish. ${summary()} ${error instanceof Error?error.message:String(error)}`;
      }finally{
        if(controller===task){controller=undefined;stopQwen.hidden=true;refresh()}
      }
    };
    refresh();preview(pages[0].page);
    inputs.get(pages[0].page)?.focus();
  });
}
