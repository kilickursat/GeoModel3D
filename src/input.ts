// The input tab: a workspace where a case is typed in, or pasted from a spreadsheet, table by table (the project and
// its coordinate system, boreholes, logs, water levels, SPT, laboratory and in-situ tests, and the units with their unit
// weights and design values) and then built into the model. A preview follows every change: where the boreholes are,
// the log of one borehole with the stresses down it, and what the importer and the model report. The tables become CSV
// and go through the importer, so typed data are checked exactly as imported files are.
import {GeoProject} from "./geology";
import {ImportResult,toProjectJson} from "./io";
import {properties} from "./properties";
import {buildGeologicalModel,GeoModel} from "./model";
import {stressAt,unitWeights,UnitWeight,ASSUMED_WEIGHT} from "./fields";
import {convexHull} from "./terrain";
import {COLUMNS,TABLE_NAMES,TableName,EditorTables,tablesFromProject,projectFromTables,emptyTables,exampleTables,fillUnits,tableCsv} from "./tables";

type Step="start"|"project"|TableName;
const STEPS:Step[]=["start","project","boreholes","logs","water","spt","tests","units"];
const PER_HOLE:TableName[]=["logs","water","spt","tests"];
const MAX_ROWS=400;
const STORE="geomodel3d.input.v1";
const esc=(s:string)=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]!));
const fmt=(v:number,d=0)=>v.toLocaleString("en-US",{maximumFractionDigits:d,minimumFractionDigits:d});
const copy=(t:EditorTables):EditorTables=>JSON.parse(JSON.stringify(t));
const slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"case";
const niceCeil=(v:number)=>{const p=10**Math.floor(Math.log10(v)),f=v/p;return (f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*p};

// The stress profile's series in legend order. The colours were validated as a set on the panel surface; u is also
// dashed, as the water table is, and every line is labelled at its end.
const SERIES=[
  {key:"sv",label:"σv",name:"Vertical total stress",color:"#199e70",dash:""},
  {key:"u",label:"u",name:"Pore water pressure",color:"#3987e5",dash:"5 3"},
  {key:"s",label:"σ′v",name:"Vertical effective stress",color:"#d95926",dash:""},
  {key:"sh",label:"σ′h",name:"Horizontal effective stress, K0 · σ′v",color:"#9085e9",dash:""}
] as const;
type SeriesKey=typeof SERIES[number]["key"];

const HELP:Record<TableName,string>={
  boreholes:"One row per borehole: an easting and northing, or a latitude and longitude, and the ground level of the collar. The final depth is needed only where the hole went deeper than its log.",
  logs:"Depths in metres below the collar. A unit not yet in the Units table is added at the bottom of the column.",
  water:"Depths to water below the collar; the shallowest reading of each borehole sets the water table there.",
  spt:"N-values: the blows for 300 mm, or the blows and the penetration where the test stopped short.",
  tests:"One value per row, from the laboratory or in situ. Property: a key from the list (w, gamma, su, qu, c, phi, E, k, qc…) or any other name, in the units the list gives. Depths in metres.",
  units:"Top to bottom in stratigraphic order (▲ ▼ reorder). γ and γsat give the stresses, or else the mean measured unit weight, or else 18 and 20 kN/m³ are assumed; K0 gives the horizontal effective stress; the other values are design parameters, kept with the model and reported."
};

interface Saved { tables:EditorTables; savedAt:string }
// The case being typed is kept in this browser, so a reload does not lose it; storage may be unavailable (private
// windows, blocked site data), and the workspace then works for as long as the page is open.
function readSaved():Saved|null{
  try{
    const s=JSON.parse(localStorage.getItem(STORE)??"null");
    if(!s?.tables?.rows||!s.tables.project)return null;
    for(const name of Object.keys(COLUMNS) as TableName[]){
      const rows=Array.isArray(s.tables.rows[name])?s.tables.rows[name]:[];
      s.tables.rows[name]=rows.map((r:unknown[])=>COLUMNS[name].map((_,c)=>String((Array.isArray(r)?r[c]:"")??"")));
    }
    s.tables.project={...emptyTables().project,...s.tables.project};
    return s as Saved;
  }catch{return null}
}
function writeSaved(t:EditorTables){try{localStorage.setItem(STORE,JSON.stringify({tables:t,savedAt:new Date().toISOString()}))}catch{/* not kept */}}

export interface InputOptions {
  // The dataset shown in the model tab.
  current():GeoProject;
  onBuild(result:ImportResult):void;
  // Opens the file picker; imported files come back through edit().
  onImport():void;
  download(name:string,text:string,type:string):void;
}
export interface InputWorkspace { element:HTMLElement; show():void; edit(project:GeoProject,message:string):void }

export function createInputWorkspace(o:InputOptions):InputWorkspace{
  let t:EditorTables|null=null,origin:EditorTables|null=null,base:GeoProject|undefined;
  let step:Step="start",filter="",selected="",message="";
  let preview:{result?:ImportResult;model?:GeoModel;error?:string}={};
  let timer:ReturnType<typeof setTimeout>|undefined;
  let profile:{z:number[];water?:number;weights:UnitWeight[];k0:Array<number|undefined>;top:number;depth:number;max:number;frame:number[];units:string[]}|null=null;

  const el=document.createElement("section");
  el.className="workspace";
  el.hidden=true;
  el.setAttribute("aria-label","Input data");
  el.innerHTML=`<div class="ws-main">
<nav class="ws-steps" aria-label="Input steps"></nav>
<div class="ws-body"></div>
<aside class="ws-preview" aria-label="Preview">
  <div class="ws-card"><div class="ws-card-head"><span>Boreholes in plan</span></div><div class="ws-plan"></div></div>
  <div class="ws-card"><div class="ws-card-head"><span>Log and stresses</span><select class="ws-hole" aria-label="Borehole shown"></select></div><div class="ws-column"></div></div>
  <div class="ws-card"><div class="ws-card-head"><span>Checks</span></div><div class="ws-checks" aria-live="polite"></div></div>
</aside></div>
<footer class="ws-foot"><span class="ws-status" aria-live="polite"></span><button class="ws-csv">Download table (CSV)</button><button class="ws-json" title="A project file you can import again">Save case (JSON)</button><button class="ws-discard">Discard edits</button><button class="ws-build">Build model</button></footer>
<datalist id="ws-properties">${properties.map(p=>`<option value="${p.key}">${esc(p.name)}${p.unit?` (${esc(p.unit)})`:""}</option>`).join("")}</datalist>
<datalist id="ws-holes"></datalist><datalist id="ws-units"></datalist>`;
  const nav=el.querySelector<HTMLElement>(".ws-steps")!,body=el.querySelector<HTMLDivElement>(".ws-body")!;
  const plan=el.querySelector<HTMLDivElement>(".ws-plan")!,column=el.querySelector<HTMLDivElement>(".ws-column")!,checks=el.querySelector<HTMLDivElement>(".ws-checks")!;
  const holeSelect=el.querySelector<HTMLSelectElement>(".ws-hole")!,status=el.querySelector<HTMLSpanElement>(".ws-status")!;

  const holes=()=>t?[...new Set(t.rows.boreholes.map(r=>r[0].trim()).filter(Boolean))]:[];
  const count=(name:TableName)=>t?t.rows[name].filter(r=>r.some(c=>c.trim())).length:0;
  const edited=()=>!!t&&!!origin&&JSON.stringify(t)!==JSON.stringify(origin);

  function begin(tables:EditorTables,from:GeoProject|undefined,first:Step,text:string){
    t=tables;origin=copy(tables);base=from;step=first;filter="";selected="";message=text;
    render();refresh(true);
  }

  // ---------- views ----------

  function renderNav(){
    nav.innerHTML=STEPS.map((s,i)=>{
      const label=s==="start"?"Start":s==="project"?"Project":TABLE_NAMES[s];
      const n=s==="start"||s==="project"?"":`<span>${count(s)}</span>`;
      return `<button data-step="${s}"${s===step?' aria-current="step"':""}${!t&&s!=="start"?" disabled":""}><i>${i||""}</i>${label}${n}</button>`;
    }).join("");
  }
  function render(){
    body.innerHTML=step==="start"?startView():step==="project"?projectView():tableView(step);
    el.querySelector<HTMLButtonElement>(".ws-csv")!.hidden=step==="start"||step==="project";
    for(const b of el.querySelectorAll<HTMLButtonElement>(".ws-json,.ws-discard,.ws-build"))b.disabled=!t;
    renderLists();
    status.textContent=message;
  }
  // The step counts and the lists of boreholes and units offered while typing, without redrawing the table being typed
  // in (that would take the cursor out of it).
  function renderLists(){
    renderNav();
    el.querySelector("#ws-holes")!.innerHTML=holes().map(h=>`<option value="${esc(h)}">`).join("");
    el.querySelector("#ws-units")!.innerHTML=(t?.rows.units??[]).map(r=>r[0].trim()).filter(Boolean).map(u=>`<option value="${esc(u)}">`).join("");
    const pick=body.querySelector<HTMLSelectElement>(".ed-filter");
    if(pick)pick.innerHTML=`<option value="">All</option>${holes().map(h=>`<option${h===filter?" selected":""}>${esc(h)}</option>`).join("")}`;
  }
  function startView(){
    const saved=readSaved(),current=o.current();
    const choice=(key:string,title:string,text:string)=>`<button class="ws-choice" data-start="${key}"><b>${title}</b><span>${text}</span></button>`;
    return `<div class="ws-start"><h2>Enter your own data</h2>
<p>Type in, or paste from a spreadsheet, the boreholes of your case with their positions and logs, the groundwater, field and laboratory tests, and the units with their unit weights and design values. <b>Build model</b> turns them into the 3-D model, sections and stresses. Everything stays in this browser: nothing is uploaded.</p>
<div class="ws-choices">${[
      choice("new","New case","Empty tables to fill in. One borehole is enough: the model then extends around it."),
      choice("example","Worked example","Four boreholes with water levels, SPT, laboratory tests and unit parameters: the format, ready to change."),
      choice("current","Edit the dataset shown",`${esc(current.name)}: its tables, to change or add to.`),
      choice("import","Import files…","CSV, AGS4, borehole XML or project JSON, to review here before building."),
      ...(saved?[choice("saved","Continue the saved case",`${esc(saved.tables.project.name)}, kept in this browser since ${esc(new Date(saved.savedAt).toLocaleString())}.`)]:[])
    ].join("")}</div>
<p class="ws-note">${t?`Open now: <b>${esc(t.project.name)}</b>; starting another case replaces it. `:""}What you type is kept in this browser, so a reload does not lose it, until you type in another case. Save case (JSON) keeps a copy you can import again.</p></div>`;
  }
  function projectView(){
    const f=t!.project,field=(key:keyof typeof f,label:string,hint:string,attrs="")=>
      `<label><span>${label}</span><input data-field="${key}" value="${esc(f[key])}" ${attrs}><small>${hint}</small></label>`;
    return `<div class="ed-form">
${field("name","Name","Shown in the dataset list and on reports")}
<label><span>Description</span><textarea data-field="description" rows="3">${esc(f.description)}</textarea><small>What the data are and where they come from</small></label>
${field("source","Data source","Credited at the bottom of the view and on reports")}
${field("crs","Coordinate system","An EPSG code (such as 32654), a system's name, or a PROJ definition. Eastings and northings are in it, and latitudes and longitudes are converted to it. Leave it empty, or type any other name, for a local grid that is not placed on a map",'list="crs-options" spellcheck="false" autocomplete="off"')}
${field("groundwaterDepth","Assumed groundwater depth (m)","Below ground, used where no borehole has a water level; leave it empty when unknown, and pore pressures are then zero",'inputmode="decimal"')}
${field("base","Model base (m)","Elevation of the flat base of the model; empty for the deepest end of hole",'inputmode="decimal"')}
${field("margin","Model extent beyond the boreholes (m)","The model reaches this far beyond the outermost boreholes, its layers carried on from them; empty to end at the boreholes. One or two boreholes, or boreholes in a line, always get an extent",'inputmode="decimal"')}
</div>`;
  }
  // The rows of a table that are shown: those of the chosen borehole, at most MAX_ROWS.
  function shownRows(name:TableName){
    const rows=t!.rows[name].map((r,i)=>({r,i}));
    const match=PER_HOLE.includes(name)&&filter?rows.filter(q=>q.r[0]===filter):rows;
    return {all:match.length,rows:match.slice(0,MAX_ROWS)};
  }
  function cell(name:TableName,r:number,c:number,v:string){
    const col=COLUMNS[name][c],attrs=`data-r="${r}" data-c="${c}" aria-label="${esc(col.label)}"`;
    if(name==="units"&&col.csv==="colour")return `<input type="color" ${attrs} value="${/^#[0-9a-f]{6}$/i.test(v)?v:"#999999"}"${v?"":` class="ed-blank"`} title="${v?esc(v):"Automatic colour"}">`;
    if(name==="units"&&col.csv==="erosive")return `<input type="checkbox" ${attrs}${/^(y|yes|true|1|x)$/i.test(v.trim())?" checked":""}>`;
    const list=c===0&&name!=="boreholes"&&name!=="units"?' list="ws-holes"':col.csv==="unit"&&name==="logs"?' list="ws-units"':col.csv==="property"?' list="ws-properties"':"";
    const wide=["name","description","source"].includes(col.csv)?' class="wide"':"";
    return `<input ${attrs} value="${esc(v)}"${list}${wide}${col.numeric?' inputmode="decimal"':""} spellcheck="false">`;
  }
  function tableView(name:TableName){
    const {all,rows}=shownRows(name),cols=COLUMNS[name];
    const hole=PER_HOLE.includes(name)?`<label>Borehole <select class="ed-filter"><option value="">All</option>${holes().map(h=>`<option${h===filter?" selected":""}>${esc(h)}</option>`).join("")}</select></label>`:"";
    return `<div class="ed-tools">${hole}<button class="ed-add">Add row</button>${name==="logs"?'<button class="ed-fill" title="By the unit rules of the project, or by the principal soil of the description">Fill units from descriptions</button>':""}
<span class="ed-help">${HELP[name]} Paste cells copied from a spreadsheet into any cell.</span></div>
<div class="ed-table-wrap"><table class="ed-table"><thead><tr><th></th>${cols.map(c=>`<th${c.hint?` title="${esc(c.hint)}"`:""}>${esc(c.label)}</th>`).join("")}<th></th></tr></thead><tbody>${
      rows.map(({r,i},k)=>`<tr data-r="${i}"><td class="ed-n">${name==="units"?`<button class="ed-up" aria-label="Move up"${i===0?" disabled":""}>▲</button><button class="ed-down" aria-label="Move down"${i===t!.rows.units.length-1?" disabled":""}>▼</button>`:k+1}</td>${
        r.map((v,c)=>`<td>${cell(name,i,c,v)}</td>`).join("")}<td><button class="ed-del" aria-label="Delete row">×</button></td></tr>`).join("")
    }</tbody></table>${all>rows.length?`<p class="ed-more">Showing ${rows.length} of ${all} rows: choose a borehole above to see its rows.</p>`:""}${!all?'<p class="ed-more">No rows yet: add one, or paste cells.</p>':""}</div>`;
  }

  // ---------- preview ----------

  function refresh(now=false){
    clearTimeout(timer);
    const run=()=>{
      if(t){
        try{
          const result=projectFromTables(t,base);
          // The preview leaves out the terrain grid: it shows the logs, and stays quick to rebuild.
          const p:GeoProject={...result.project,terrain:undefined};
          preview={result,...(p.boreholes.length?{model:buildGeologicalModel(p)}:{})};
        }catch(e){preview={error:(e as Error).message}}
        // Kept once something has been typed: opening a dataset only to look at it leaves the saved case alone.
        if(edited())writeSaved(t);
      }else preview={};
      renderNav();
      renderPreview();
    };
    if(now)run();else timer=setTimeout(run,300);
  }
  function renderPreview(){
    const m=preview.model,ids=m?.boreholes.map(b=>b.id)??[];
    if(!ids.includes(selected))selected=ids.includes(filter)?filter:ids[0]??"";
    plan.innerHTML=planSvg(m,selected);
    holeSelect.innerHTML=ids.map(id=>`<option${id===selected?" selected":""}>${esc(id)}</option>`).join("");
    holeSelect.disabled=!ids.length;
    column.innerHTML=m&&selected?columnView(m,ids.indexOf(selected)):`<p class="ws-empty">${t?"No borehole placed yet.":"Start a case to see its boreholes here."}</p>`;
    checks.innerHTML=checksView();
  }
  function checksView(){
    if(!t)return `<p class="ws-empty">Start a case: the importer and the model check it here as you type.</p>`;
    if(preview.error)return `<p class="ws-error">${esc(preview.error)}</p>`;
    const m=preview.model,notes=[...new Set([...(preview.result?.warnings??[]),...(m?.warnings??[])])];
    const summary=m?`${m.boreholes.length} borehole${m.boreholes.length===1?"":"s"} and ${m.units.length} unit${m.units.length===1?"":"s"} modelled${m.water?", with a water table":""}.`:"No borehole placed yet.";
    if(!notes.length)return `<p class="ws-ok"><span aria-hidden="true">✓</span> ${summary} No problems found.</p>`;
    const list=(a:string[])=>`<ul>${a.map(w=>`<li>${esc(w)}</li>`).join("")}</ul>`;
    return `<p>${summary} ${notes.length} note${notes.length===1?"":"s"}:</p>${list(notes.slice(0,6))}${notes.length>6?`<details><summary>${notes.length-6} more</summary>${list(notes.slice(6))}</details>`:""}`;
  }

  // The boreholes in plan, north up, with the outline of the model and a scale bar.
  function planSvg(m:GeoModel|undefined,sel:string){
    const holes=m?.boreholes??[];
    if(!holes.length)return `<p class="ws-empty">${t?"No borehole placed yet: give each a position and a ground level (a single borehole needs neither).":"Start a case to see its boreholes here."}</p>`;
    const W=316,H=196,pad=18,pts=m!.triangles.length?m!.nodes:holes;
    const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
    const span=Math.max(x1-x0,y1-y0,1),s=Math.min((W-2*pad)/Math.max(x1-x0,span*0.02),(H-2*pad)/Math.max(y1-y0,span*0.02));
    const X=(x:number)=>W/2+(x-(x0+x1)/2)*s,Y=(y:number)=>H/2-(y-(y0+y1)/2)*s;
    const hull=m!.triangles.length?convexHull(m!.nodes):[];
    const bar=niceCeil(span/5),len=bar*s;
    const names=holes.length<=24;
    return `<svg class="ws-plan-svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Plan of ${holes.length} boreholes, north up">
${hull.length?`<polygon points="${hull.map(p=>`${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ")}" fill="#78c9df" fill-opacity=".08" stroke="#78c9df" stroke-opacity=".45" stroke-width="1"/>`:""}
${holes.map(b=>{const on=b.id===sel,x=X(b.x),y=Y(b.y);return `<g class="ws-pt" data-hole="${esc(b.id)}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="transparent"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${on?5:3.5}" fill="${on?"#e8f2f7":"#9bb1bd"}" stroke="#0a1620" stroke-width="2"/>${names||on?`<text x="${(x+7).toFixed(1)}" y="${(y-6).toFixed(1)}" fill="${on?"#e8f2f7":"#9bb1bd"}" font-size="10">${esc(b.id)}</text>`:""}<title>${esc(b.id)}</title></g>`}).join("")}
<g fill="#8aa2ae" font-size="9.5"><line x1="${pad}" x2="${(pad+len).toFixed(1)}" y1="${H-7}" y2="${H-7}" stroke="#8aa2ae" stroke-width="1.5"/><text x="${(pad+len+5).toFixed(1)}" y="${H-4}">${fmt(bar)} m</text>
<text x="${W-12}" y="13" text-anchor="middle">N</text><path d="M${W-12} 16 l-3.5 8 h7 z" fill="#8aa2ae"/></g></svg>`;
  }

  // The log of one borehole as the model has it there, and the stresses down it.
  function columnView(m:GeoModel,i:number){
    const K=m.units.length,z=m.horizons.map(h=>h.z[i]),top=z[0],bottom=z[K],depth=Math.max(top-bottom,1e-6);
    const w=m.water?.z[i],water=w!==undefined&&Number.isFinite(w)?w:undefined;
    const weights=unitWeights(m),k0=m.units.map(u=>u.params?.K0),withH=k0.some(v=>v!==undefined);
    const series=SERIES.filter(s=>s.key!=="sh"||withH);
    const value=(k:number,e:number):Record<SeriesKey,number>=>{
      const r=stressAt(z,water,weights,e)!;
      return {sv:r.sv,u:r.u,s:r.s,sh:k0[k]!==undefined?k0[k]!*r.s:NaN};
    };
    // Each unit from its top to its base, through the water table where it lies in the unit.
    const segments:Array<{k:number;points:Array<{e:number;v:Record<SeriesKey,number>}>}>=[];
    for(let k=0;k<K;k++){
      const a=z[k],b=z[k+1];
      if(a-b<1e-9)continue;
      const es=[a,...(water!==undefined&&water<a&&water>b?[water]:[]),b];
      segments.push({k,points:es.map(e=>({e,v:value(k,e)}))});
    }
    const all=segments.flatMap(s=>s.points.flatMap(p=>series.map(q=>p.v[q.key]))).filter(Number.isFinite);
    const max=niceCeil(Math.max(10,...all));
    const W=316,H=296,band=12,l=34,r=14,tp=34,bt=22,px0=l+band+8,pw=W-px0-r,ph=H-tp-bt;
    const X=(v:number)=>px0+v/max*pw,Y=(e:number)=>tp+(top-e)/depth*ph;
    profile={z,water,weights,k0,top,depth,max,frame:[px0,tp,pw,ph],units:m.units.map(u=>u.name)};
    const dStep=niceCeil(depth/5),ticks:number[]=[];
    for(let d=0;d<=depth+1e-9;d+=dStep)ticks.push(d);
    const lines=series.map(q=>{
      let path="";
      if(q.key==="sh")for(const s of segments){const pts=s.points.filter(p=>Number.isFinite(p.v.sh));if(pts.length)path+=pts.map((p,j)=>`${j?"L":"M"}${X(p.v.sh).toFixed(1)} ${Y(p.e).toFixed(1)}`).join("")}
      else path=segments.flatMap(s=>s.points).map((p,j)=>`${j?"L":"M"}${X(p.v[q.key]).toFixed(1)} ${Y(p.e).toFixed(1)}`).join("");
      return path?`<path d="${path}" fill="none" stroke="${q.color}" stroke-width="2" stroke-linejoin="round"${q.dash?` stroke-dasharray="${q.dash}"`:""}/>`:"";
    }).join("");
    // The values at the base of the log, in one row under the plot: each label starts under the end of its line, then
    // labels that would touch are pushed apart, and a leader joins each to its line.
    const ends=series.map(q=>{
      const last=[...segments].reverse().flatMap(s=>[...s.points].reverse()).find(p=>Number.isFinite(p.v[q.key]));
      return last?{q,text:`${q.label} ${fmt(last.v[q.key])}`,x:X(last.v[q.key])}:null;
    }).filter((e):e is NonNullable<typeof e>=>!!e).sort((a,b)=>a.x-b.x);
    const widths=ends.map(e=>e.text.length*5.4+6),lo=l,hi=W-2,at=ends.map((e,j)=>Math.min(Math.max(e.x,lo+widths[j]/2),hi-widths[j]/2));
    for(let j=1;j<at.length;j++)at[j]=Math.max(at[j],at[j-1]+(widths[j-1]+widths[j])/2);
    for(let j=at.length-1;j>=0;j--)at[j]=Math.min(at[j],j===at.length-1?hi-widths[j]/2:at[j+1]-(widths[j]+widths[j+1])/2);
    const labels=ends.map((e,j)=>`<path d="M${e.x.toFixed(1)} ${tp+ph}L${at[j].toFixed(1)} ${tp+ph+6}" fill="none" stroke="${e.q.color}"/><text x="${at[j].toFixed(1)}" y="${tp+ph+16}" text-anchor="middle">${e.text}</text>`).join("");
    const assumed=m.units.filter((_,k)=>weights[k].source==="assumed").map(u=>u.name);
    const rows=segments.flatMap(s=>[s.points[0],s.points[s.points.length-1]].map((p,j)=>({k:s.k,e:p.e,v:p.v,base:j===1})));
    return `<svg class="ws-column-svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Log of ${esc(m.boreholes[i].id)} with the stresses down it">
<g font-size="10" fill="#c4d2d9">${series.map((q,j)=>`<g transform="translate(${px0+j*62},12)"><line x1="0" x2="14" y1="-3" y2="-3" stroke="${q.color}" stroke-width="2"${q.dash?` stroke-dasharray="4 2"`:""}/><text x="18" y="0">${q.label}</text><title>${q.name}</title></g>`).join("")}</g>
<g font-size="9" fill="#8aa2ae">${[0,max/2,max].map(v=>`<line x1="${X(v).toFixed(1)}" x2="${X(v).toFixed(1)}" y1="${tp}" y2="${tp+ph}" stroke="#8aa2ae" stroke-opacity=".18"/><text x="${X(v).toFixed(1)}" y="${tp-5}" text-anchor="${v===max?"end":v?"middle":"start"}">${fmt(v)}${v===max?" kPa":""}</text>`).join("")}
${ticks.map(d=>`<text x="${l-4}" y="${(Y(top-d)+3).toFixed(1)}" text-anchor="end">${fmt(d,1).replace(/\.0$/,"")}</text>`).join("")}<text x="${l-4}" y="${tp-5}" text-anchor="end">m</text></g>
${segments.map(s=>`<rect x="${l}" y="${Y(z[s.k]).toFixed(1)}" width="${band}" height="${Math.max(Y(z[s.k+1])-Y(z[s.k])-1,0.5).toFixed(1)}" fill="${m.units[s.k].color}"><title>${esc(m.units[s.k].name)}: ${fmt(top-z[s.k],2)}–${fmt(top-z[s.k+1],2)} m</title></rect>`).join("")}
${water!==undefined?`<line x1="${l}" x2="${px0+pw}" y1="${Y(water).toFixed(1)}" y2="${Y(water).toFixed(1)}" stroke="#3987e5" stroke-opacity=".7" stroke-dasharray="2 3"/><text x="${px0+pw}" y="${(Y(water)-3).toFixed(1)}" fill="#9bb1bd" font-size="9" text-anchor="end">▽ water ${fmt(top-water,2)} m</text>`:""}
${lines}<g font-size="9.5" fill="#d9edf5">${labels}</g>
<line class="ws-cross" x1="${l}" x2="${px0+pw}" y1="0" y2="0" stroke="#e8f2f7" stroke-opacity=".5" visibility="hidden"/>
<rect class="ws-hit" x="${l}" y="${tp}" width="${px0+pw-l}" height="${ph}" fill="transparent"/></svg>
<div class="ws-readout" hidden></div>
<p class="ws-note">${water===undefined?"No water table here: pore pressure is zero. ":""}${assumed.length?`Unit weights assumed (${ASSUMED_WEIGHT.above} and ${ASSUMED_WEIGHT.below} kN/m³) for ${esc(assumed.join(", "))}. `:""}${withH?"":"Give K0 in the Units table for the horizontal stress."}</p>
<details class="ws-values"><summary>Values at the contacts</summary><table><thead><tr><th>Unit</th><th>Depth (m)</th>${series.map(q=>`<th>${q.label}</th>`).join("")}</tr></thead><tbody>${
      rows.map(q=>`<tr><td>${q.base?"":esc(m.units[q.k].name)}</td><td>${fmt(top-q.e,2)}</td>${series.map(s=>`<td>${Number.isFinite(q.v[s.key])?fmt(q.v[s.key]):"–"}</td>`).join("")}</tr>`).join("")
    }</tbody></table><p class="ws-note">kPa, at the top and base of each unit.</p></details>`;
  }
  // A crosshair and the values at the depth under the pointer.
  column.addEventListener("pointermove",e=>{
    const svg=column.querySelector<SVGSVGElement>("svg"),cross=column.querySelector<SVGLineElement>(".ws-cross"),out=column.querySelector<HTMLDivElement>(".ws-readout");
    if(!svg||!cross||!out||!profile)return;
    const b=svg.getBoundingClientRect(),k=316/b.width,[,ty,,th]=profile.frame,y=(e.clientY-b.top)*k;
    if(y<ty||y>ty+th){cross.setAttribute("visibility","hidden");out.hidden=true;return}
    const d=(y-ty)/th*profile.depth,elevation=profile.top-d,r=stressAt(profile.z,profile.water,profile.weights,elevation);
    let u=-1;
    for(let j=0;j<profile.units.length;j++)if(elevation<=profile.z[j]+1e-9&&elevation>=profile.z[j+1]-1e-9&&profile.z[j]-profile.z[j+1]>1e-9){u=j;break}
    if(!r||u<0){cross.setAttribute("visibility","hidden");out.hidden=true;return}
    cross.setAttribute("y1",y.toFixed(1));cross.setAttribute("y2",y.toFixed(1));cross.setAttribute("visibility","visible");
    const K0=profile.k0[u];
    out.innerHTML=`<b>${fmt(d,2)} m</b> · ${esc(profile.units[u])}<br>σv ${fmt(r.sv)} · u ${fmt(r.u)} · σ′v ${fmt(r.s)}${K0!==undefined?` · σ′h ${fmt(K0*r.s)}`:""} kPa`;
    out.hidden=false;
    out.style.top=`${Math.min(y/k+8,b.height-out.offsetHeight)}px`;
  });
  column.addEventListener("pointerleave",()=>{column.querySelector(".ws-cross")?.setAttribute("visibility","hidden");const out=column.querySelector<HTMLDivElement>(".ws-readout");if(out)out.hidden=true});

  // ---------- events ----------

  const blankRow=(name:TableName)=>{const r=COLUMNS[name].map(()=>"");if(PER_HOLE.includes(name)&&filter)r[0]=filter;return r};
  function choose(key:string){
    if(key==="import"){o.onImport();return}
    if(edited()&&!confirm("Replace the open case? Its edits are lost unless you saved them (Save case)."))return;
    const current=o.current(),saved=readSaved();
    if(key==="new")begin(emptyTables(),undefined,"project","A new case: name it and say where it is, then fill in the tables.");
    else if(key==="example")begin(exampleTables(),undefined,"boreholes","The worked example: change any cell and the preview follows; Build model shows it in 3-D.");
    else if(key==="current")begin(tablesFromProject(current),current,"boreholes",`The tables of ${current.name}: change or add to them, then build the model.`);
    else if(key==="saved"&&saved)begin(saved.tables,undefined,"boreholes","Your saved case.");
  }
  el.addEventListener("click",e=>{
    const target=e.target as Element,b=target.closest("button"),pt=target.closest<SVGGElement>(".ws-pt");
    if(pt){selected=pt.dataset.hole!;if(PER_HOLE.includes(step as TableName)){filter=selected;render()}renderPreview();return}
    if(!b)return;
    if(b.dataset.start){choose(b.dataset.start);return}
    if(b.dataset.step){
      step=b.dataset.step as Step;
      // A large table opens on the first borehole that has rows in it.
      filter=t&&PER_HOLE.includes(step as TableName)&&t.rows[step as TableName].length>MAX_ROWS?t.rows[step as TableName].find(r=>r[0].trim())?.[0]??"":PER_HOLE.includes(step as TableName)?filter:"";
      render();return;
    }
    if(!t)return;
    if(b.classList.contains("ws-build")){
      try{o.onBuild(projectFromTables(t,base));message=""}catch(err){message=(err as Error).message;status.textContent=message}
      return;
    }
    if(b.classList.contains("ws-json")){
      try{o.download(`${slug(t.project.name)}.geomodel3d.json`,toProjectJson(projectFromTables(t,base).project),"application/json")}catch(err){message=(err as Error).message;status.textContent=message}
      return;
    }
    if(b.classList.contains("ws-discard")){if(origin&&confirm("Discard the edits made since this case was opened?")){t=copy(origin);message="Edits discarded";render();refresh(true)}return}
    if(step==="start"||step==="project")return;
    const name=step,row=Number(b.closest("tr")?.dataset.r);
    if(b.classList.contains("ws-csv"))o.download(`${slug(t.project.name)}-${name}.csv`,tableCsv(t,name),"text/csv");
    else if(b.classList.contains("ed-add")){t.rows[name].push(blankRow(name));render();refresh();body.querySelector<HTMLInputElement>("tbody tr:last-child input")?.focus()}
    else if(b.classList.contains("ed-del")){t.rows[name].splice(row,1);render();refresh()}
    else if(b.classList.contains("ed-up")||b.classList.contains("ed-down")){
      const to=row+(b.classList.contains("ed-up")?-1:1),u=t.rows.units;
      [u[row],u[to]]=[u[to],u[row]];render();refresh();
    }else if(b.classList.contains("ed-fill")){const n=fillUnits(t,base?.rules);message=`${n} unit${n===1?"":"s"} filled from the descriptions`;render();refresh()}
  });
  el.addEventListener("input",e=>{
    const f=e.target as HTMLInputElement|HTMLTextAreaElement;
    if(!t)return;
    if(f.dataset.field){t.project[f.dataset.field as keyof EditorTables["project"]]=f.value;refresh();return}
    if(f.dataset.r===undefined||step==="start"||step==="project")return;
    const v=f instanceof HTMLInputElement&&f.type==="checkbox"?(f.checked?"yes":""):f.value;
    t.rows[step][Number(f.dataset.r)][Number(f.dataset.c)]=v;
    if(f instanceof HTMLInputElement&&f.type==="color"){f.classList.remove("ed-blank");f.title=v}
    refresh();
  });
  el.addEventListener("change",e=>{
    const f=e.target as HTMLSelectElement;
    if(f===holeSelect){selected=f.value;renderPreview();return}
    if(f.classList.contains("ed-filter")){filter=f.value;if(filter)selected=filter;render();renderPreview()}
    else if((f as HTMLElement).dataset?.c==="0")renderLists();
  });
  // The preview follows the row being edited.
  el.addEventListener("focusin",e=>{
    const f=e.target as HTMLInputElement;
    if(!t||f.dataset.r===undefined||step==="start"||step==="project"||step==="units")return;
    const id=t.rows[step][Number(f.dataset.r)]?.[0]?.trim();
    if(id&&id!==selected&&preview.model?.boreholes.some(b=>b.id===id)){selected=id;renderPreview()}
  });
  // Cells pasted from a spreadsheet (tab-separated, one row per line) fill the table from the cell pasted into, adding
  // rows where needed.
  el.addEventListener("paste",e=>{
    const f=e.target as HTMLInputElement,text=e.clipboardData?.getData("text/plain")??"";
    if(!t||f.dataset.r===undefined||step==="start"||step==="project"||!/[\t\n]/.test(text.trim()))return;
    e.preventDefault();
    const name=step,lines=text.replace(/\r/g,"").replace(/\n+$/,"").split("\n").map(l=>l.split("\t"));
    const shown=shownRows(name).rows.map(q=>q.i),c0=Number(f.dataset.c),p0=shown.indexOf(Number(f.dataset.r));
    lines.forEach((cells,k)=>{
      let r=shown[p0+k];
      if(r===undefined){t!.rows[name].push(blankRow(name));r=t!.rows[name].length-1}
      cells.forEach((v,j)=>{if(c0+j<COLUMNS[name].length)t!.rows[name][r][c0+j]=v.trim()});
    });
    message=`${lines.length} row${lines.length===1?"":"s"} pasted`;
    render();refresh();
  });

  return {
    element:el,
    show(){if(!t&&step!=="start")step="start";render();refresh(true)},
    edit(project,text){begin(tablesFromProject(project),project,"boreholes",text)}
  };
}
