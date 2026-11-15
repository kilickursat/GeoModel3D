// A derived inspection view: selecting or exporting an interval never edits the photo or borehole log.
import type {Interval,UnitDef} from "./schema";
import type {CoreBox,CoreRun} from "./corePhoto";
import type {EvidenceSource} from "./evidence";
import {buildCoreDepthLog,coreDepthLogCsv} from "./coreDepthLog";
import type {CoreDepthLog,CoreDepthLogSegment} from "./coreDepthLog";
import "./coreDepthLog.css";

export interface CoreDepthLogSelection {rowId:string;pieceId?:string;from:number;to:number;box:CoreBox}
export interface CoreDepthLogViewState {from:number;to:number;selectedFrom?:number;selectedTo?:number}
export type CoreDepthLogHandle=(()=>void)&{refresh():void};
export interface CoreDepthLogViewOptions {
  run:CoreRun;intervals:readonly Interval[];units:readonly UnitDef[];source?:EvidenceSource;selectedPieceId?:string;
  state?:CoreDepthLogViewState;onStateChange?(state:CoreDepthLogViewState):void;
  onSelect(selection:CoreDepthLogSelection,reveal?:boolean):void;onClearSelection?():void;
}

const MAX_VISIBLE_SEGMENTS=1000;
const fmt=(value:number)=>value.toLocaleString("en-US",{maximumFractionDigits:6});
function element<K extends keyof HTMLElementTagNameMap>(tag:K,className:string,text?:string):HTMLElementTagNameMap[K]{
  const node=document.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;return node;
}
function button(className:string,text:string){const node=element("button",className,text);node.type="button";return node}
const comparisonLabels:Record<string,string>={
  "same-unit":"Same unit label", "different-unit":"Different unit labels", "photo-unassigned":"Photo unit not assigned",
  "no-photo":"No photo annotation to compare", "no-current-log":"No current log interval", "current-unassigned":"Current log unit not assigned",
  "ambiguous-current-log":"Overlapping current log intervals", "photo-unit-missing":"Photo unit missing from the unit list",
  "current-unit-missing":"Current log unit missing from the unit list"
};
const soundLabels={unknown:"Not reviewed",sound:"Sound",unsound:"Unsound"};
const breakLabels={unknown:"Not reviewed",natural:"Natural fracture",mechanical:"Matched mechanical break",continuous:"No break · logging boundary",end:"Run end or gap"};

export function renderCoreDepthLog(container:HTMLElement,options:CoreDepthLogViewOptions):CoreDepthLogHandle{
  let closed=false;
  const urls=new Set<string>(),timers=new Set<ReturnType<typeof setTimeout>>();
  const cleanup:CoreDepthLogHandle=Object.assign(()=>{closed=true;for(const timer of timers)clearTimeout(timer);for(const url of urls)URL.revokeObjectURL(url);timers.clear();urls.clear();container.replaceChildren()},{refresh:()=>{}});
  const root=element("section","core-depth-view"),heading=element("h3","core-depth-heading","Core depth log");
  root.append(heading);container.replaceChildren(root);
  let log:CoreDepthLog;
  try{log=buildCoreDepthLog(options.run,options.intervals,new Set(options.units.map(unit=>unit.id)))}
  catch(error){const note=element("p","core-depth-error",error instanceof Error?error.message:String(error));note.setAttribute("role","alert");root.append(note);return cleanup}
  const units=new Map(options.units.map(unit=>[unit.id,unit]));
  const unitLabel=(id:string)=>!id.trim()?"Not assigned":units.has(id)?units.get(id)!.name||id:`Missing unit: ${id}`;
  const unitColour=(id:string)=>{const value=units.get(id)?.color;return value&&/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)?value:"#8b9ba5"};
  const photoLabel=(segment:CoreDepthLogSegment)=>segment.photoState==="reviewed-missing"?"Reviewed missing core":segment.photoState==="unrepresented"?"Unrepresented depth":segment.photoState==="registered-unannotated"?"Registered · no pieces":unitLabel(segment.photo?.unit??"");
  const currentLabel=(segment:CoreDepthLogSegment)=>segment.currentLogCount>1?`Overlapping logs (${segment.currentLogCount})`:segment.currentLog?unitLabel(segment.currentLog.unit):"Not logged";
  const comparisonLabel=(segment:CoreDepthLogSegment)=>comparisonLabels[segment.comparison]??"Comparison unavailable";
  const intervalLabel=(segment:CoreDepthLogSegment)=>`${fmt(segment.from)}–${fmt(segment.to)} m · photo: ${photoLabel(segment)} · log: ${currentLabel(segment)} · ${comparisonLabel(segment)}`;
  const intro=element("p","core-depth-intro"),summary=element("p","core-depth-summary");root.append(intro,summary);
  const updateSummary=()=>{
    intro.textContent=`Photo annotations · ${log.status}. Compare them with the current borehole log on the same depth axis. Selecting an interval only inspects its source.`;
    summary.textContent=`${fmt(log.summary.registeredLength)} m registered · ${fmt(log.summary.unrepresentedLength)} m ${log.lossReviewed?"reviewed missing core":"unrepresented depth"} · ${fmt(log.summary.differentUnitLength)} m with different unit labels.`;
    const photoHeading=plot.querySelector(".core-depth-photo-heading");if(photoHeading)photoHeading.textContent=`Photo · ${log.status}`;
  };

  const requested=options.state;
  const validWindow=!!requested&&Number.isFinite(requested.from)&&Number.isFinite(requested.to)&&requested.from>=log.from&&requested.to<=log.to&&requested.to>requested.from;
  let from=validWindow?requested!.from:log.from,to=validWindow?requested!.to:log.to;
  let selected=log.segments.findIndex(segment=>segment.from===requested?.selectedFrom&&segment.to===requested?.selectedTo);
  if(selected<0&&options.selectedPieceId)selected=log.segments.findIndex(segment=>segment.photo?.pieceId===options.selectedPieceId);
  if(selected>=0&&(log.segments[selected].to<=from||log.segments[selected].from>=to))selected=-1;
  const publishState=()=>{const segment=log.segments[selected];options.onStateChange?.({from,to,...(segment?{selectedFrom:segment.from,selectedTo:segment.to}:{})})};

  const controls=element("div","core-depth-controls"),windowFields=element("div","core-depth-window-fields");
  const depthInput=(labelText:string,className:string,value:number)=>{
    const label=element("label","",labelText),input=element("input",className);input.type="number";input.step="any";input.min=String(log.from);input.max=String(log.to);input.value=String(value);label.append(input);windowFields.append(label);return input;
  };
  const fromInput=depthInput("Show from (m)","core-depth-window-from",from),toInput=depthInput("Show to (m)","core-depth-window-to",to);
  const apply=button("core-depth-apply","Apply depth window"),reset=button("core-depth-reset","Whole run"),exportButton=button("core-depth-export","Download interval CSV");
  const actions=element("div","core-depth-actions");actions.append(apply,reset,exportButton);controls.append(windowFields,actions);root.append(controls);
  const status=element("p","core-depth-status");status.setAttribute("role","status");root.append(status);
  const selectionLabel=element("label","core-depth-selection-label","Inspect depth interval"),select=element("select","core-depth-select");selectionLabel.append(select);root.append(selectionLabel);
  const plot=element("div","core-depth-plot");root.append(plot);
  const details=element("section","core-depth-details"),detailBody=element("div","core-depth-detail-body"),inspectButton=button("core-depth-inspect","Highlight source interval");
  details.setAttribute("aria-label","Selected depth interval");details.append(detailBody,inspectButton);root.append(details);
  root.append(element("p","core-depth-note","Depth increases downward. Gaps have no photo observation. Matching or differing unit labels do not decide which interpretation is correct; acceptance still uses the existing review controls. CSV covers the full drilled run, including intervals outside this window."));

  function sourceSelection(segment:CoreDepthLogSegment):CoreDepthLogSelection|undefined{
    const photo=segment.photo;if(!photo)return undefined;
    return {rowId:photo.rowId,...(photo.pieceId?{pieceId:photo.pieceId}:{}),from:segment.from,to:segment.to,box:{...photo.box}};
  }
  function showDetails(){
    detailBody.replaceChildren();const segment=log.segments[selected];inspectButton.hidden=!segment?.photo;
    if(!segment){detailBody.append(element("p","core-depth-empty","Choose an interval to inspect its depth, source and current log."));return}
    detailBody.append(element("h4","",`${fmt(segment.from)}–${fmt(segment.to)} m · ${fmt(segment.length)} m`));
    const comparison=element("p","core-depth-comparison",comparisonLabel(segment));comparison.dataset.comparison=segment.comparison;detailBody.append(comparison);
    const values=element("dl","core-depth-values");
    const row=(label:string,value:string)=>{const group=element("div","");group.append(element("dt","",label),element("dd","",value));values.append(group)};
    row("Photo coverage",segment.photoState==="piece"?"Registered piece":photoLabel(segment));
    row("Photo unit",segment.photo?unitLabel(segment.photo.unit):"No observation");
    row("Current log",currentLabel(segment));
    if(segment.currentLog?.name)row("Current log description",segment.currentLog.name);
    if(segment.photo){
      const photo=segment.photo;
      row("Registration",photo.registrationReviewed?"Reviewed":"Pending review");
      row("Source row",photo.rowId);if(photo.pieceId)row("Source piece",photo.pieceId);
      row("Depth direction",photo.direction==="rtl"?"Right to left":"Left to right");
      row("Photo description",photo.description||"Not entered");
      row("Soundness",soundLabels[photo.sound]);
      row("Annotated piece-end break",`${breakLabels[photo.breakAfter]}${photo.pieceTo!==undefined?` at ${fmt(photo.pieceTo)} m`:""}`);
      if(photo.pieceFrom!==undefined&&photo.pieceTo!==undefined&&(photo.pieceFrom!==segment.from||photo.pieceTo!==segment.to))row("Full annotated piece",`${fmt(photo.pieceFrom)}–${fmt(photo.pieceTo)} m`);
      if(photo.pieceId&&(photo.pieceFrom!==segment.from||photo.pieceTo!==segment.to))row("Comparison boundary","The current log splits this display interval; it does not create a physical break in the photograph.");
      row("Source photograph",options.source?.name??log.sourceId);
      row("Source bounds (%)",`Left ${fmt(photo.box.x0*100)} · top ${fmt(photo.box.y0*100)} · right ${fmt(photo.box.x1*100)} · bottom ${fmt(photo.box.y1*100)}`);
    }
    detailBody.append(values);
    inspectButton.onclick=()=>{const current=log.segments[selected];if(!closed&&current?.photo){publishState();options.onSelect(sourceSelection(current)!,true)}};
  }
  function choose(index:number,notify=true){
    if(closed)return;selected=index;select.value=selected<0?"":String(selected);
    for(const node of plot.querySelectorAll<HTMLElement>("[data-segment]")){const active=Number(node.dataset.segment)===selected;node.classList.toggle("selected",active);if(node instanceof HTMLButtonElement)node.setAttribute("aria-pressed",String(active))}
    showDetails();publishState();
    if(notify){const segment=log.segments[selected],selection=segment?sourceSelection(segment):undefined;if(selection)options.onSelect(selection);else options.onClearSelection?.()}
  }
  function renderPlot(){
    const visible=log.segments.map((segment,index)=>({segment,index})).filter(({segment})=>segment.to>from&&segment.from<to);
    plot.replaceChildren();select.replaceChildren(new Option("Select a depth interval", ""));
    if(visible.length>MAX_VISIBLE_SEGMENTS){
      select.disabled=true;status.textContent=`This window contains ${visible.length.toLocaleString("en-US")} intervals. Narrow the depth window to at most ${MAX_VISIBLE_SEGMENTS.toLocaleString("en-US")} intervals to inspect them. The CSV still includes the full run.`;
      plot.append(element("p","core-depth-empty","The chart is withheld rather than omitting intervals. Enter a smaller depth window above."));showDetails();return;
    }
    select.disabled=!visible.length;
    for(const {segment,index} of visible)select.add(new Option(intervalLabel(segment),String(index)));
    select.value=selected<0?"":String(selected);
    status.textContent=`Showing ${fmt(from)}–${fmt(to)} m · ${visible.length} aligned interval${visible.length===1?"":"s"}.`;
    const headers=element("div","core-depth-track-headings");headers.append(element("span","","Depth (m)"),element("span","core-depth-photo-heading",`Photo · ${log.status}`),element("span","","Current log"));plot.append(headers);
    const chart=element("div","core-depth-chart");chart.setAttribute("aria-label",`Depth log from ${fmt(from)} to ${fmt(to)} metres`);
    const axis=element("div","core-depth-axis"),photoTrack=element("div","core-depth-track core-depth-photo-track"),logTrack=element("div","core-depth-track core-depth-current-track");
    axis.setAttribute("aria-hidden","true");
    for(let i=0;i<=5;i++){const tick=element("span","core-depth-tick",fmt(from+(to-from)*i/5));tick.style.top=`${i*20}%`;tick.dataset.edge=i===0?"top":i===5?"bottom":"middle";axis.append(tick)}
    for(const {segment,index} of visible){
      const top=100*(Math.max(from,segment.from)-from)/(to-from),height=100*(Math.min(to,segment.to)-Math.max(from,segment.from))/(to-from);
      const photoNode=segment.photo?button("core-depth-photo-segment",""):element("div","core-depth-photo-segment");
      const currentNode=element("div","core-depth-log-segment");
      for(const [node,label] of [[photoNode,photoLabel(segment)],[currentNode,currentLabel(segment)]] as const){
        node.dataset.segment=String(index);node.dataset.comparison=segment.comparison;node.style.top=`${top}%`;node.style.height=`${height}%`;node.title=intervalLabel(segment);
        node.classList.toggle("selected",index===selected);const text=element("span","core-depth-segment-label",label);text.hidden=height<5;node.append(text);
      }
      photoNode.dataset.photoState=segment.photoState;
      if(segment.photo?.unit)photoNode.style.backgroundColor=unitColour(segment.photo.unit);
      if(photoNode instanceof HTMLButtonElement){photoNode.tabIndex=-1;photoNode.setAttribute("aria-label",`Inspect source: ${intervalLabel(segment)}`);photoNode.setAttribute("aria-pressed",String(index===selected));photoNode.onclick=()=>choose(index)}
      currentNode.dataset.logState=segment.currentLogCount>1?"ambiguous":segment.currentLog?"logged":"unlogged";
      if(segment.currentLog)currentNode.style.backgroundColor=unitColour(segment.currentLog.unit);
      photoTrack.append(photoNode);logTrack.append(currentNode);
    }
    chart.append(axis,photoTrack,logTrack);plot.append(chart);
    plot.append(element("p","core-depth-legend","Hatching marks absent or unannotated photo coverage; dots mark missing or overlapping current logs. An orange edge marks different unit labels. Use the interval selector to inspect thin intervals."));showDetails();
  }
  select.onchange=()=>choose(select.value===""?-1:Number(select.value));
  function applyWindow(a:number,b:number){
    if(closed)return;
    if(!Number.isFinite(a)||!Number.isFinite(b)||a<log.from||b>log.to||b<=a){status.textContent=`Enter increasing depths within ${fmt(log.from)}–${fmt(log.to)} m.`;return}
    from=a;to=b;fromInput.value=String(from);toInput.value=String(to);
    const previous=selected;if(selected>=0&&(log.segments[selected].to<=from||log.segments[selected].from>=to))selected=-1;
    publishState();renderPlot();if(previous>=0&&selected<0)options.onClearSelection?.();
  }
  apply.onclick=()=>{if(fromInput.value.trim()===""||toInput.value.trim()===""){status.textContent="Enter both depth-window limits.";return}applyWindow(Number(fromInput.value),Number(toInput.value))};
  reset.onclick=()=>applyWindow(log.from,log.to);
  exportButton.onclick=()=>{
    if(closed)return;
    try{
      const text=coreDepthLogCsv(log,{sourceId:log.sourceId,sourceName:options.source?.name??log.sourceId,...(options.source?.sha256?{sourceSha256:options.source.sha256}:{})});
      const url=URL.createObjectURL(new Blob([text],{type:"text/csv;charset=utf-8"}));urls.add(url);
      const link=document.createElement("a"),name=log.boreholeId.replace(/[^a-z0-9._-]+/gi,"-").slice(0,80)||"borehole";
      link.href=url;link.download=`${name}-core-depth-${log.from}-${log.to}.csv`;document.body.append(link);link.click();link.remove();
      const timer=setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url);timers.delete(timer)},60_000);timers.add(timer);
      status.textContent="Full-run interval CSV exported with source registration and current-log comparison. No project values changed.";
    }catch(error){status.textContent=`CSV could not be exported: ${error instanceof Error?error.message:String(error)}`}
  };
  // The annotation editor commits description changes on blur. Keep action nodes attached so an
  // export/inspect click that caused that blur remains valid, while the exported snapshot is refreshed.
  cleanup.refresh=()=>{
    if(closed)return;
    try{log=buildCoreDepthLog(options.run,options.intervals,new Set(options.units.map(unit=>unit.id)));exportButton.disabled=false;updateSummary();showDetails()}
    catch(error){exportButton.disabled=true;status.textContent=error instanceof Error?error.message:String(error)}
  };
  updateSummary();renderPlot();return cleanup;
}
