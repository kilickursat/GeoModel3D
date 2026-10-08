// The data editor: a project's settings, boreholes, logs, water levels, SPT and test results, and units as editable
// tables. Cells copied from a spreadsheet can be pasted into them. Apply rebuilds the model from the tables through the
// importer, so typed data are checked as imported files are; edits not yet applied are kept while the page is open.
import {GeoProject} from "./geology";
import {ImportResult} from "./io";
import {properties} from "./properties";
import {COLUMNS,TABLE_NAMES,TableName,EditorTables,tablesFromProject,projectFromTables,emptyTables,fillUnits,tableCsv} from "./tables";

type Tab="project"|TableName;
const TABS:Tab[]=["project","boreholes","logs","water","spt","tests","units"];
const PER_HOLE:TableName[]=["logs","water","spt","tests"];
const MAX_ROWS=400;
const esc=(s:string)=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]!));
const drafts=new WeakMap<GeoProject,EditorTables>();

export interface EditorOptions { onApply(result:ImportResult):void; download(name:string,text:string,type:string):void }

export function openEditor(project:GeoProject,o:EditorOptions){
  let t=drafts.get(project)??tablesFromProject(project),tab:Tab="boreholes",filter="",message="";
  let base:GeoProject|undefined=project,applied=false;
  const dialog=document.createElement("dialog");
  dialog.className="editor";
  dialog.setAttribute("aria-label","Data editor");
  dialog.innerHTML=`<div class="ed-head"><b>Data</b><span class="ed-title"></span><button class="ed-close" aria-label="Close">×</button></div>
<nav class="ed-tabs" role="tablist"></nav><div class="ed-body"></div>
<div class="ed-foot"><span class="ed-status" aria-live="polite"></span><button class="ed-new">New empty project</button><button class="ed-discard">Discard edits</button><button class="ed-csv">Download table (CSV)</button><button class="ed-apply">Apply</button></div>
<datalist id="ed-properties">${properties.map(p=>`<option value="${p.key}">${esc(p.name)}${p.unit?` (${esc(p.unit)})`:""}</option>`).join("")}</datalist>
<datalist id="ed-holes"></datalist><datalist id="ed-units"></datalist>`;
  document.body.appendChild(dialog);
  const body=dialog.querySelector<HTMLDivElement>(".ed-body")!;
  const keep=()=>{if(base&&!applied)drafts.set(base,t)};

  function holes(){return [...new Set(t.rows.boreholes.map(r=>r[0].trim()).filter(Boolean))]}
  function renderTabs(){
    dialog.querySelector(".ed-title")!.textContent=t.project.name;
    dialog.querySelector(".ed-tabs")!.innerHTML=TABS.map(k=>{
      const n=k==="project"?"":` <span>${t.rows[k as TableName].filter(r=>r.some(c=>c.trim())).length}</span>`;
      return `<button role="tab" data-tab="${k}" aria-selected="${k===tab}">${k==="project"?"Project":TABLE_NAMES[k as TableName]}${n}</button>`;
    }).join("");
    dialog.querySelector<HTMLButtonElement>(".ed-csv")!.hidden=tab==="project";
    dialog.querySelector("#ed-holes")!.innerHTML=holes().map(h=>`<option value="${esc(h)}">`).join("");
    dialog.querySelector("#ed-units")!.innerHTML=t.rows.units.map(r=>r[0].trim()).filter(Boolean).map(u=>`<option value="${esc(u)}">`).join("");
    dialog.querySelector(".ed-status")!.textContent=message;
  }

  function renderProject(){
    const f=t.project,field=(key:keyof typeof f,label:string,hint:string,attrs="")=>
      `<label><span>${label}</span><input data-field="${key}" value="${esc(f[key])}" ${attrs}><small>${hint}</small></label>`;
    body.innerHTML=`<div class="ed-form">
${field("name","Name","Shown in the dataset list and on reports")}
<label><span>Description</span><textarea data-field="description" rows="3">${esc(f.description)}</textarea><small>What the data are and where they come from</small></label>
${field("source","Data source","Credited at the bottom of the view and on reports")}
${field("crs","Coordinate system","An EPSG code (such as 32654), a system's name, or a PROJ definition. Eastings and northings are in it; latitudes and longitudes are converted to it. Any other text names a local grid, which is not georeferenced",'list="crs-options" spellcheck="false" autocomplete="off"')}
${field("groundwaterDepth","Assumed groundwater depth (m)","Below ground, used where no borehole has a water level; leave empty when unknown",'inputmode="decimal"')}
${field("base","Model base (m)","Elevation of the flat model base; empty for the deepest end of hole",'inputmode="decimal"')}
</div>`;
  }

  // The rows of the table that are shown: those of the chosen borehole, at most MAX_ROWS.
  function shownRows(name:TableName){
    const rows=t.rows[name].map((r,i)=>({r,i}));
    const match=PER_HOLE.includes(name)&&filter?rows.filter(q=>q.r[0]===filter):rows;
    return {all:match.length,rows:match.slice(0,MAX_ROWS)};
  }
  function cell(name:TableName,r:number,c:number,v:string){
    const col=COLUMNS[name][c],attrs=`data-r="${r}" data-c="${c}" aria-label="${esc(col.label)}"`;
    if(name==="units"&&col.csv==="colour")return `<input type="color" ${attrs} value="${/^#[0-9a-f]{6}$/i.test(v)?v:"#999999"}"${v?"":` class="ed-blank"`} title="${v?esc(v):"Automatic colour"}">`;
    if(name==="units"&&col.csv==="erosive")return `<input type="checkbox" ${attrs}${/^(y|yes|true|1|x)$/i.test(v.trim())?" checked":""}>`;
    const list=c===0&&name!=="boreholes"&&name!=="units"?' list="ed-holes"':col.csv==="unit"&&name==="logs"?' list="ed-units"':col.csv==="property"?' list="ed-properties"':"";
    const wide=["name","description","source"].includes(col.csv)?' class="wide"':"";
    return `<input ${attrs} value="${esc(v)}"${list}${wide}${col.numeric?' inputmode="decimal"':""} spellcheck="false">`;
  }
  function renderTable(name:TableName){
    const {all,rows}=shownRows(name),cols=COLUMNS[name];
    const hole=PER_HOLE.includes(name)?`<label>Borehole <select class="ed-filter"><option value="">All</option>${holes().map(h=>`<option${h===filter?" selected":""}>${esc(h)}</option>`).join("")}</select></label>`:"";
    const help={boreholes:"Give either an easting and northing or a latitude and longitude, and the ground level of the collar.",
      logs:"Depths in metres below the collar. A unit not in the Units table is added at the bottom of the column.",
      water:"Depths to water below the collar; the shallowest of each borehole sets the water table there.",
      spt:"N-values: the blows for 300 mm, or the blows and the penetration where the test stopped short.",
      tests:"One value per row. Property: a key from the list (w, gamma, su…) or any other name. Depths in metres.",
      units:"Top to bottom in stratigraphic order; ▲ ▼ reorder. Unit weights are used for stresses; the other values are design parameters."}[name];
    body.innerHTML=`<div class="ed-tools">${hole}<button class="ed-add">Add row</button>${name==="logs"?'<button class="ed-fill" title="By the unit rules of the project, or by the principal soil of the description">Fill units from descriptions</button>':""}
<span class="ed-help">${help} Paste cells copied from a spreadsheet into any cell.</span></div>
<div class="ed-table-wrap"><table class="ed-table"><thead><tr><th></th>${cols.map(c=>`<th${c.hint?` title="${esc(c.hint)}"`:""}>${esc(c.label)}</th>`).join("")}<th></th></tr></thead><tbody>${
      rows.map(({r,i},k)=>`<tr data-r="${i}"><td class="ed-n">${name==="units"?`<button class="ed-up" aria-label="Move up"${i===0?" disabled":""}>▲</button><button class="ed-down" aria-label="Move down"${i===t.rows.units.length-1?" disabled":""}>▼</button>`:k+1}</td>${
        r.map((v,c)=>`<td>${cell(name,i,c,v)}</td>`).join("")}<td><button class="ed-del" aria-label="Delete row">×</button></td></tr>`).join("")
    }</tbody></table>${all>rows.length?`<p class="ed-more">Showing ${rows.length} of ${all} rows: choose a borehole above to see its rows.</p>`:""}${!all?'<p class="ed-more">No rows yet: add one, or paste cells.</p>':""}</div>`;
  }
  function render(){
    renderTabs();
    if(tab==="project")renderProject();else renderTable(tab);
  }
  const blankRow=(name:TableName)=>{const r=COLUMNS[name].map(()=>"");if(PER_HOLE.includes(name)&&filter)r[0]=filter;return r};

  dialog.addEventListener("click",e=>{
    const el=e.target as HTMLElement,b=el.closest("button");
    if(!b)return;
    const row=Number(b.closest("tr")?.dataset.r);
    // A large table opens on the first borehole that has rows in it.
    if(b.dataset.tab){tab=b.dataset.tab as Tab;filter=PER_HOLE.includes(tab as TableName)&&t.rows[tab as TableName].length>MAX_ROWS?t.rows[tab as TableName].find(r=>r[0].trim())?.[0]??"":"";render();return}
    if(b.classList.contains("ed-close")){keep();dialog.close();return}
    if(tab==="project")return finish(b);
    const name=tab;
    if(b.classList.contains("ed-add")){t.rows[name].push(blankRow(name));render();body.querySelector<HTMLInputElement>("tbody tr:last-child input")?.focus()}
    else if(b.classList.contains("ed-del")){t.rows[name].splice(row,1);render()}
    else if(b.classList.contains("ed-up")||b.classList.contains("ed-down")){
      const to=row+(b.classList.contains("ed-up")?-1:1),u=t.rows.units;
      [u[row],u[to]]=[u[to],u[row]];render();
    }else if(b.classList.contains("ed-fill")){const n=fillUnits(t,base?.rules);message=`${n} unit${n===1?"":"s"} filled from the descriptions`;render()}
    else finish(b);
  });
  function finish(b:HTMLButtonElement){
    if(b.classList.contains("ed-csv")&&tab!=="project"){
      const slug=t.project.name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"project";
      o.download(`${slug}-${tab}.csv`,tableCsv(t,tab),"text/csv");
    }else if(b.classList.contains("ed-new")){
      if(!confirm("Start an empty project? The tables are cleared; the model stays as it is until you apply."))return;
      t=emptyTables();base=undefined;tab="project";filter="";message="An empty project: fill in the tables, then apply";render();
    }else if(b.classList.contains("ed-discard")){
      t=base?tablesFromProject(base):emptyTables();message="Edits discarded";if(base)drafts.delete(base);render();
    }else if(b.classList.contains("ed-apply")){
      try{
        const result=projectFromTables(t,base);
        applied=true;
        if(base)drafts.delete(base);
        dialog.close();
        o.onApply(result);
      }catch(err){message=(err as Error).message;renderTabs()}
    }
  }
  dialog.addEventListener("input",e=>{
    const el=e.target as HTMLInputElement|HTMLTextAreaElement;
    if(el.dataset.field){t.project[el.dataset.field as keyof EditorTables["project"]]=el.value;if(el.dataset.field==="name")dialog.querySelector(".ed-title")!.textContent=el.value;return}
    if(el.dataset.r===undefined||tab==="project")return;
    const v=el instanceof HTMLInputElement&&el.type==="checkbox"?(el.checked?"yes":""):el.value;
    t.rows[tab][Number(el.dataset.r)][Number(el.dataset.c)]=v;
    if(el instanceof HTMLInputElement&&el.type==="color"){el.classList.remove("ed-blank");el.title=v}
  });
  dialog.addEventListener("change",e=>{
    const el=e.target as HTMLSelectElement;
    if(el.classList.contains("ed-filter")){filter=el.value;render()}
    else if((el as HTMLElement).dataset?.c==="0"&&tab==="boreholes")renderTabs();
  });
  // Cells pasted from a spreadsheet (tab-separated, one row per line) fill the table from the cell pasted into, adding
  // rows where needed.
  dialog.addEventListener("paste",e=>{
    const el=e.target as HTMLInputElement,text=e.clipboardData?.getData("text/plain")??"";
    if(el.dataset.r===undefined||tab==="project"||!/[\t\n]/.test(text.trim()))return;
    e.preventDefault();
    const name=tab,lines=text.replace(/\r/g,"").replace(/\n+$/,"").split("\n").map(l=>l.split("\t"));
    const shown=shownRows(name).rows.map(q=>q.i),c0=Number(el.dataset.c),p0=shown.indexOf(Number(el.dataset.r));
    lines.forEach((cells,k)=>{
      let r=shown[p0+k];
      if(r===undefined){t.rows[name].push(blankRow(name));r=t.rows[name].length-1}
      cells.forEach((v,j)=>{if(c0+j<COLUMNS[name].length)t.rows[name][r][c0+j]=v.trim()});
    });
    message=`${lines.length} row${lines.length===1?"":"s"} pasted`;
    render();
  });
  dialog.addEventListener("close",()=>{keep();dialog.remove()});
  render();
  dialog.showModal();
}
