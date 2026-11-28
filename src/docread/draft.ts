// What the review edits: the boreholes read from the documents as text, like the Input data tables, each value with the
// line of the page it was read from and, where the reader is unsure of it, why. The draft is checked as it is edited,
// and becomes the Input data tables, where it is checked again as typed data. Nothing is fixed silently: problems are
// reported, and the engineer decides.
import type {ReadLog,TextLine,HeaderField,CoreSheet} from "./reconstruct";
import type {CollarScheduleMatch,CollarScheduleRow} from "./collarSchedule";
import {acceptedGridRow,hasPendingSchedule,positionBasis,sourceBoxes,type DraftSchedule} from "./reviewSchedule";
import {applyUnitRules,lithologyRules,japaneseLithologyRules} from "../rules";
import {inferUnitOrder} from "../io";
import {COLUMNS,EditorTables,emptyTables} from "../tables";
import type {Borehole} from "../schema";
import {newEvidenceId,changeEvidenceField,EvidenceCollection,EvidenceRecord,EvidenceSource,EvidenceField} from "../evidence";

export type Field=HeaderField;
export const FIELDS:Array<{key:Field;label:string;numeric:boolean}>=[
  {key:"id",label:"Borehole",numeric:false},{key:"x",label:"Easting (m)",numeric:true},{key:"y",label:"Northing (m)",numeric:true},
  {key:"lat",label:"Latitude",numeric:true},{key:"lon",label:"Longitude",numeric:true},{key:"ground",label:"Ground level (m)",numeric:true},
  {key:"final",label:"Final depth (m)",numeric:true},{key:"water",label:"Water depth (m)",numeric:true}
];
// `flag` says why the reader is unsure of the layer's base depth; `autoUnit` is set while the unit is the rules' choice,
// so it follows an edited description.
// `gap`: where a log describes samples, the untested interval its base lies in.
export interface DraftLayer { from:string; to:string; unit:string; description:string; flag?:string; gap?:[number,number]; autoUnit:boolean; src:TextLine[]; evidence?:EvidenceRecord }
// `ocr`: read by the reading model, not from the document's own text, and `ocrWhy` why (a scanned page, unusable PDF
// text). `samples`: the layers were read from the sample depths that start the descriptions.
// `core`: the runs of the borehole's rock core logs, kept for the review and not used in the model.
// `spt`: its Standard Penetration Tests, as the SPT table of Input data takes them: depth (m), blows and penetration (mm).
export interface DraftSpt { depth:string; blows:string; penetration:string; src:TextLine[] }
export interface DraftHole {
  use:boolean; doc:number; file:string; pages:number[]; kind:"scale"|"table"; ocr:boolean; ocrWhy?:string; samples?:boolean; rangeLabels?:boolean;
  core?:CoreSheet&{pages:number[]};
  values:Record<Field,string>; flags:Partial<Record<Field,string>>; src:Partial<Record<Field,TextLine>>;
  schedule?:DraftSchedule;
  layers:DraftLayer[]; evidence?:EvidenceRecord; waterEvidence?:EvidenceRecord; ocrPages?:number[]; spt?:DraftSpt[];
}

const text=(v:number|undefined)=>v===undefined||!Number.isFinite(v)?"":String(v);
export const num=(s:string)=>{const t=s.trim().replace(/^−/,"-").replace(",",".");return t===""?undefined:/^-?\d+(?:\.\d*)?$|^-?\.\d+$/.test(t)?Number(t):NaN};
const CJK=/[぀-ヿ㐀-鿿]/;
const fmt=(v:number)=>String(+v.toFixed(3));

// A Japanese form has a separate soil-name column. An empty or unreadable name leaves the unit
// open for review. Remarks often name a rock in the matrix of a gravel layer.
export function unitFor(description:string,soilName?:string){
  const d=description.trim();
  // “Idem” refers back to a prior row; material mentioned afterwards can describe
  // inclusions or a transition. Keep the source text and ask for a reviewed unit.
  if(!d||/^idem\b/i.test(d))return "";
  const japanese=soilName!==undefined||CJK.test(d);
  let name=d;
  if(japanese){
    // Hand-edited descriptions and tables without a separate name column can start with a
    // soil name, followed by its bracketed classification code, a space, or a colon.
    const label=soilName??d.split(/[\s:：]/u,1)[0];
    name=label.normalize("NFKC").replace(/(?:\([^()]*\))+$/,"");
    if(!name)return "";
    if(soilName===undefined&&!/(?:土|砂|礫|石|岩|シルト|ローム|火山灰|黒ボク|コンクリート|アスファルト|舗装|廃棄物|ピート|チャート|ホルンフェルス)$/.test(name))return "";
  }
  const rules=japanese?japaneseLithologyRules:lithologyRules;
  const result=applyUnitRules([{id:"",x:0,y:0,z:0,intervals:[{from:0,to:1,unit:"",name}]}],rules);
  return japanese&&result.unmatched.size?"":result.boreholes[0].intervals[0].unit;
}

// The logs of one document as drafts. A log whose ID was not read is named after its first page, and flagged.
// `scanned` lists the pages read by the reading model, and `why` why each was.
export function draftHoles(doc:number,file:string,logs:ReadLog[],scanned:ReadonlySet<number>=new Set(),why:ReadonlyMap<number,string>=new Map(),matches:readonly CollarScheduleMatch[]=[]):DraftHole[]{
  return logs.map((log,i)=>{
    const reasons=[...new Set(log.pages.filter(p=>scanned.has(p)).map(p=>why.get(p)).filter((w):w is string=>!!w))];
    const flags:Partial<Record<Field,string>>={};
    if(!log.src?.id)flags.id="no borehole ID read: type its name";
    if(log.groundFlag)flags.ground=log.groundFlag;
    if(log.waterFlag)flags.water=log.waterFlag;
    if(log.xyFlag){flags.x=log.xyFlag;flags.y=log.xyFlag}
    const hole:DraftHole={use:true,doc,file,pages:log.pages,kind:log.kind,...(log.samples?{samples:true}:{}),...(log.rangeLabels?{rangeLabels:true}:{}),ocr:log.pages.some(p=>scanned.has(p)),
      ...(reasons.length?{ocrWhy:reasons.join("; ")}:{}),...(log.core?{core:log.core}:{}),ocrPages:[...scanned],
      values:{id:log.src?.id?log.id??"":`Page ${log.pages[0]}`,x:text(log.x),y:text(log.y),lat:text(log.lat),lon:text(log.lon),
        ground:text(log.ground),final:text(log.final),water:text(log.water)},
      flags,src:{...log.src},
      layers:log.layers.map(l=>({from:text(l.from),to:text(l.to),unit:unitFor(l.description,l.soilName),description:l.description,
        ...(l.flagged?{flag:l.why??"check this depth against the page"}:{}),...(l.gap?{gap:l.gap}:{}),autoUnit:true,src:l.src})),
      // Penetration in mm, as the SPT table takes it; left empty where the log does not give it ("50+").
      ...(log.spt?.length?{spt:log.spt.map(t=>({depth:text(t.depth),blows:text(t.blows),penetration:t.penetration===undefined?"":text(Math.round(t.penetration*10)),src:t.src}))}:{})};
    const match=matches[i];
    if(match?.candidates.length)hole.schedule={match,sourceId:hole.values.id,originalBasis:positionBasis(hole)};
    return hole;
  });
}

// Stable evidence lives on the draft object, not its position in the editable list. Creating it before the review
// captures the extraction as it was; later edits can change current values without replacing that original.
export const evidenceField=(field:Field)=>field==="ground"?"z":field==="final"?"depth":field;
export type PageSize={width:number;height:number};
export function captureDraftEvidence(holes:DraftHole[],sources:EvidenceSource[],size:(doc:number,page:number)=>PageSize|undefined){
  const field=(h:DraftHole,value:string,lines:TextLine[],note?:string):EvidenceField=>({original:value,current:value,
    boxes:sourceBoxes(lines,h.pages[0],page=>size(h.doc,page)),status:"unreviewed",events:[],...(note?{note}:{})});
  const record=(h:DraftHole,fields:Record<string,EvidenceField>,lines:TextLine[]):EvidenceRecord=>({id:newEvidenceId(),sourceId:sources[h.doc].id,
    method:lines.some(l=>h.ocrPages?.includes(l.page??h.pages[0]))?"ocr":"pdf-text",fields});
  for(const h of holes){
    if(!sources[h.doc])continue;
    if(!h.evidence){
      const fields:Record<string,EvidenceField>={};
      for(const f of FIELDS)if(f.key!=="water")fields[evidenceField(f.key)]=field(h,h.values[f.key],h.src[f.key]?[h.src[f.key]!]:[],h.flags[f.key]);
      h.evidence=record(h,fields,Object.values(h.src).filter((line):line is TextLine=>!!line));
    }
    if(!h.waterEvidence)h.waterEvidence=record(h,{boreholeId:field(h,h.values.id,h.src.id?[h.src.id]:[]),depth:field(h,h.values.water,h.src.water?[h.src.water]:[],h.flags.water),date:field(h,"",[],"No measurement date was read.")},h.src.water?[h.src.water]:[]);
    for(const layer of h.layers)if(layer.src.length&&!layer.evidence){
      const boundaries=h.rangeLabels?layer.src.slice(0,1):layer.src,description=h.rangeLabels?layer.src.slice(1):layer.src;
      layer.evidence=record(h,{
        boreholeId:field(h,h.values.id,h.src.id?[h.src.id]:[]),
        from:field(h,layer.from,boundaries,h.rangeLabels?undefined:"Top depth reconstructed with this layer's log; compare it with the page."),
        to:field(h,layer.to,boundaries,layer.flag),
        unit:field(h,layer.unit,description,"Assigned by unit rules from the logged description."),
        description:field(h,layer.description,description)
      },layer.src);
    }
  }
}

// ---------- checks ----------

// A check points at a value of a borehole: one of its fields, or one of its layers. Errors stop "Use these boreholes";
// warnings are values to look at; notes are for information.
export interface Check { hole:number; field?:Field; layer?:number; level:"error"|"warn"|"note"; text:string }

function completePair(h:DraftHole,a:Field,b:Field){
  return Number.isFinite(num(h.values[a]))&&Number.isFinite(num(h.values[b]));
}

// Without a named CRS, positions printed under the same pair of table headings can share a local model.
// Another coordinate table on the same page (or a visually identical table in another PDF) is a separate source.
function localScheduleTable(h:DraftHole,row:CollarScheduleRow){
  return JSON.stringify([h.doc,row.page,...[row.fields.x!.heading,row.fields.y!.heading].map(l=>[l.x0,l.y0,l.x1,l.y1])]);
}

function draftGrid(used:DraftHole[]):{code?:string;issue?:{hole:DraftHole;field:Field;text:string}}{
  if(!used.some(h=>h.schedule))return {};
  const projected=used.filter(h=>completePair(h,"x","y")),geographic=used.filter(h=>!completePair(h,"x","y")&&completePair(h,"lat","lon"));
  const stop=(hole:DraftHole,text:string,field:Field="x")=>({issue:{hole,text,field}});
  const candidates=(h:DraftHole)=>h.schedule?.match.candidates.filter(r=>r.id.trim()===h.values.id.trim())??[];
  for(const h of geographic){
    if(candidates(h).some(r=>r.projectedFromGeographic&&r.fields.lat?.value===num(h.values.lat)&&r.fields.lon?.value===num(h.values.lon)))
      return stop(h,`The schedule identifies a coordinate reference for the printed angles of ${h.values.id}. Choose its geographic row to convert those angles, or clear the position until its reference is verified.`,"lat");
  }
  const positions=projected.map(h=>{
    const row=acceptedGridRow(h);
    // Matching numbers also expose conflicting printed reference systems when the reviewer kept the original log.
    const matches=row?[row]:candidates(h).filter(r=>r.fields.x?.value===num(h.values.x)&&r.fields.y?.value===num(h.values.y));
    return {h,row,matches};
  });
  const codes=new Set(positions.flatMap(p=>p.matches.flatMap(r=>r.crsCode?[r.crsCode]:[])));
  const [code]=codes;
  if(codes.size>1)return stop(positions.find(p=>p.matches.some(r=>r.crsCode&&r.crsCode!==code))!.h,
    `The selected boreholes have different projected coordinate systems (${[...codes].join(", ")}). Choose a common grid, enter verified WGS84 positions with both projected fields cleared, or exclude incompatible boreholes.`);
  const unknown=positions.find(p=>!p.row?.crsCode);
  if(unknown&&code&&positions.length+geographic.length>1)return stop(unknown.h,
    `${unknown.h.values.id} has no accepted grid for its easting and northing. Other source evidence names ${code}. Choose a schedule row verified in that grid, enter a verified WGS84 position with both projected fields cleared, or exclude the borehole.`);
  if(positions.length>1&&positions.some(p=>p.matches.length)&&unknown){
    const tables=positions.map(p=>p.matches.length===1&&p.matches[0].fields.x&&p.matches[0].fields.y?localScheduleTable(p.h,p.matches[0]):undefined);
    const mismatch=tables.findIndex(t=>!t||t!==tables[0]);
    if(mismatch>=0)return stop(positions[mismatch].h,
      `The projected collar positions come from separate coordinate sources without a verified common grid. Use rows from one surveyed table, enter verified WGS84 positions with both projected fields cleared, or exclude incompatible boreholes.`);
  }
  return {code:unknown?undefined:code};
}

export function checkDraft(holes:DraftHole[]):Check[]{
  const out:Check[]=[],used=holes.filter(h=>h.use),many=used.length>1;
  const placed=(h:DraftHole)=>{const x=num(h.values.x),y=num(h.values.y),la=num(h.values.lat),lo=num(h.values.lon),ok=(v:number|undefined)=>v!==undefined&&Number.isFinite(v);return (ok(x)&&ok(y))||(ok(la)&&ok(lo))};
  // Where no borehole in use has a position, that is said once: the model cannot place any of them.
  const nowhere=many&&!used.some(placed);
  const {issue}=draftGrid(used);
  if(issue)out.push({hole:holes.indexOf(issue.hole),field:issue.field,level:"error",text:issue.text});
  if(nowhere)out.push({hole:holes.indexOf(used[0]),field:"x",level:"warn",text:`No borehole has a position: none of the ${used.length} boreholes in use gives an easting and northing, or a latitude and longitude, so the model cannot place them. Type them here, or under Input data.`});
  const named=new Map<string,number>();
  for(const h of used){const id=h.values.id.trim();if(id)named.set(id,(named.get(id)??0)+1)}
  holes.forEach((h,i)=>{
    if(!h.use)return;
    const add=(level:Check["level"],text:string,at:{field?:Field;layer?:number}={})=>out.push({hole:i,level,text,...at});
    const v=Object.fromEntries(FIELDS.map(f=>[f.key,f.numeric?num(h.values[f.key]):undefined])) as Record<Field,number|undefined>;
    const id=h.values.id.trim();
    if(hasPendingSchedule(h))add("error","Review the collar schedule. Choose a source row, keep the current fields, or exclude this borehole.",{field:"id"});
    if(h.schedule?.depthForId&&h.schedule.depthForId!==id)add("error",`Final depth was selected for ${h.schedule.depthForId}. Verify the borehole ID or enter the final depth for ${id}.`,{field:"final"});
    if(h.ocr)add("warn",`Read by OCR (${h.ocrWhy??"a scanned page"}): compare every value and description with the page.`);
    if(!id)add("error","No borehole ID: type its name.",{field:"id"});
    else if(named.get(id)!>1)add("error",`Another borehole is also named ${id}: rename one.`,{field:"id"});
    for(const f of FIELDS){
      if(f.numeric&&Number.isNaN(v[f.key]))add("error",`${f.label}: “${h.values[f.key].trim()}” is not a number.`,{field:f.key});
      else if(h.flags[f.key])add("warn",`${f.label}: ${h.flags[f.key]}.`,{field:f.key});
    }
    if(v.lat!==undefined&&Math.abs(v.lat)>90)add("error","Latitude: it lies between −90 and 90.",{field:"lat"});
    if(v.lon!==undefined&&Math.abs(v.lon)>180)add("error","Longitude: it lies between −180 and 180.",{field:"lon"});
    const has=(k:Field)=>v[k]!==undefined&&Number.isFinite(v[k]);
    // One borehole on its own needs neither a position nor a ground level (Input data places it at 0, 0 and 0 m).
    if(many&&!nowhere&&!(has("x")&&has("y"))&&!(has("lat")&&has("lon")))add("warn","No position: type an easting and northing, or a latitude and longitude, or this borehole is not placed with the others.",{field:"x"});
    if(many&&!has("ground")&&!Number.isNaN(v.ground))add("warn","No ground level: type it, or this borehole is not placed.",{field:"ground"});
    if(!many&&h.schedule&&!has("ground")&&!Number.isNaN(v.ground))add("warn","Ground elevation is missing. The single-hole preview will use 0 m as a local reference for depths.",{field:"ground"});
    const valid:Array<{l:DraftLayer;k:number;from:number;to:number}>=[];
    h.layers.forEach((l,k)=>{
      const from=num(l.from),to=num(l.to);
      if(from===undefined||to===undefined||!Number.isFinite(from)||!Number.isFinite(to))add("error",`Layer ${k+1}: its depths are not both numbers.`,{layer:k});
      else if(from<0||to<=from)add("error",`Layer ${k+1}: its base (${fmt(to)} m) is not below its top (${fmt(from)} m).`,{layer:k});
      else valid.push({l,k,from,to});
    });
    valid.sort((p,q)=>p.from-q.from);
    if(!valid.length){add("error",h.layers.length?"No layer has depths that can be used: correct them, or leave this borehole out.":"No layers: add them, or leave this borehole out.");return}
    if(valid[0].from>0)add("note",`The log starts at ${fmt(valid[0].from)} m: nothing is logged above it.`,{layer:valid[0].k});
    // Boundaries between samples are one check per log: each keeps its own gap and reason on its layer. A gap much
    // wider than the log's usual one is a check of its own.
    const between=valid.filter(q=>q.l.flag&&q.l.gap),widths=between.map(q=>q.l.gap![1]-q.l.gap![0]).sort((a,b)=>a-b);
    const usual=widths[widths.length>>1]??0,wide=(q:typeof valid[number])=>q.l.gap![1]-q.l.gap![0]>Math.max(1,2*usual)+0.005;
    const grouped=between.length>=2?between.filter(q=>!wide(q)):[];
    if(grouped.length){
      const lo=Math.min(...grouped.map(q=>q.l.gap![1]-q.l.gap![0])),hi=Math.max(...grouped.map(q=>q.l.gap![1]-q.l.gap![0]));
      add("warn",`${grouped.length} layer boundaries lie between samples, in untested gaps of ${fmt(lo)}${hi>lo+0.005?`–${fmt(hi)}`:""} m: each is placed at the top of the sample with the new description, or where the log notes the change, and is marked on its layer.`,{layer:grouped[0].k});
    }
    valid.forEach((q,j)=>{
      const prev=valid[j-1];
      if(prev&&q.from>prev.to+0.005)add("warn",`A gap from ${fmt(prev.to)} to ${fmt(q.from)} m: no layer is there.`,{layer:q.k});
      if(prev&&q.from<prev.to-0.005)add("warn",`Layers overlap from ${fmt(q.from)} to ${fmt(Math.min(prev.to,q.to))} m.`,{layer:q.k});
      if(q.l.flag&&!grouped.includes(q))add("warn",`${fmt(q.to)} m: ${q.l.flag}${q.l.gap&&between.length>=2?`; a wider gap than this log's usual ${fmt(usual)} m`:""}.`,{layer:q.k});
      if(!q.l.unit.trim())add("error",`Layer ${fmt(q.from)}–${fmt(q.to)} m: no unit. Check the logged material and enter its unit.`,{layer:q.k});
      else if(q.l.autoUnit&&q.l.unit===q.l.description.trim()&&q.l.unit.length>24)add("note",`Layer ${fmt(q.from)}–${fmt(q.to)} m: no rule gives its description a unit, so the description is its unit. Type a shorter one.`,{layer:q.k});
    });
    const base=Math.max(...valid.map(q=>q.to));
    if(has("final")&&v.final!<base-0.005)add("warn",`The final depth (${fmt(v.final!)} m) is above the base of the log (${fmt(base)} m).`,{field:"final"});
    if(has("final")&&v.final!>base+0.005)add("warn",`No layer was read from ${fmt(base)} to ${fmt(v.final!)} m. Check for a continuation sheet or confirm that this section was unlogged.`,{field:"final"});
    if(has("water")&&v.water!>Math.max(base,v.final??0)+0.005)add("warn",`The water depth (${fmt(v.water!)} m) is below the bottom of the hole.`,{field:"water"});
    if(has("water")&&v.water!<0)add("note","The water depth is negative: water above the ground (artesian).",{field:"water"});
  });
  return out;
}

// ---------- the Input data tables ----------

// Pages as ranges: [4, 5, 6, 9] is "4–6, 9".
export function pageRanges(pages:number[]){
  const s=[...new Set(pages)].sort((a,b)=>a-b),out:string[]=[];
  for(let i=0;i<s.length;){let j=i;while(j+1<s.length&&s[j+1]===s[j]+1)j++;out.push(j>i?`${s[i]}–${s[j]}`:String(s[i]));i=j+1}
  return out.join(", ");
}
// A number as typed, with a decimal comma made a point; other text is left for the importer to report.
const cell=(s:string)=>{const n=num(s);return n!==undefined&&Number.isFinite(n)?String(n):s.trim()};

// The boreholes in use as Input data tables: the project named after the document, the boreholes, their logs and water
// levels, and the units in their order down the logs (as the importer infers it), ready for design values.
export function draftTables(holes:DraftHole[],files:string[],sources?:EvidenceSource[]):EditorTables{
  const used=holes.filter(h=>h.use),t=emptyTables();
  const grid=draftGrid(used);
  if(grid.issue)throw new Error(grid.issue.text);
  const docs=[...new Set(used.map(h=>h.doc))].map(d=>{
    const pages=used.filter(h=>h.doc===d).flatMap(h=>[...h.pages,...Object.values(h.evidence?.fields??{}).flatMap(f=>f.boxes.map(b=>b.page))]);
    return {file:files[d],pages:[...new Set(pages)]};
  });
  const name=docs.length===1?docs[0].file.replace(/\.pdf$/i,""):"Borehole logs from PDFs";
  t.project={...t.project,name,source:docs.map(d=>d.file).join(", "),
    description:`Borehole logs read from ${docs.map(d=>`${d.file} (page${d.pages.length>1?"s":""} ${pageRanges(d.pages)})`).join(" and ")} and checked in the review.`};
  if(grid.code)t.project.crs=grid.code;
  t.rows.boreholes=used.map(h=>[h.values.id.trim(),...(["x","y","lat","lon","ground","final"] as Field[]).map(k=>cell(h.values[k]))]);
  t.rows.logs=used.flatMap(h=>h.layers.map(l=>[h.values.id.trim(),cell(l.from),cell(l.to),l.unit.trim(),l.description.trim()]));
  t.rows.water=used.filter(h=>h.values.water.trim()).map(h=>[h.values.id.trim(),cell(h.values.water),""]);
  t.rows.spt=used.flatMap(h=>(h.spt??[]).filter(x=>x.depth.trim()&&x.blows.trim()).map(x=>[h.values.id.trim(),cell(x.depth),cell(x.blows),cell(x.penetration)]));
  const boreholes:Borehole[]=used.map(h=>({id:h.values.id.trim(),x:0,y:0,z:0,intervals:h.layers
    .map(l=>({from:num(l.from)??NaN,to:num(l.to)??NaN,unit:l.unit.trim()}))
    .filter(i=>i.unit&&Number.isFinite(i.from)&&Number.isFinite(i.to)&&i.to>i.from)}));
  t.rows.units=inferUnitOrder(boreholes).order.map(u=>COLUMNS.units.map(c=>c.csv==="unit"||c.csv==="name"?u:""));
  if(sources){
    const records=used.flatMap(h=>[h.evidence,h.values.water.trim()?h.waterEvidence:undefined,...h.layers.map(l=>l.evidence)]).filter((r):r is EvidenceRecord=>!!r);
    const ids=new Set(records.map(r=>r.sourceId));
    // Copy the evidence before attaching it to the workspace: closing or later editing the review cannot alter it.
    const evidence:EvidenceCollection={version:1,sources:structuredClone(sources.filter(s=>ids.has(s.id))),records:structuredClone(records)};
    t.evidence=evidence;
    t.evidenceRows={boreholes:used.map(h=>h.evidence?.id??null),logs:used.flatMap(h=>h.layers.map(l=>l.evidence?.id??null)),
      water:used.filter(h=>h.values.water.trim()).map(h=>h.waterEvidence?.id??null)};
    // The input tables normalise decimal commas and whitespace. Keep the original and the explicit conversion in
    // history, rather than falsely displaying the pre-normalised value as the value used by the model.
    const current=new Map(evidence.records.map(r=>[r.id,r]));
    const sync=(id:string|null,key:string,value:string)=>{const r=id?current.get(id):undefined;if(r)changeEvidenceField(r,key,value,"Normalised for input tables");};
    used.forEach((h,i)=>{
      const row=t.rows.boreholes[i],id=h.evidence?.id??null;
      ["id","x","y","lat","lon","z","depth"].forEach((key,c)=>sync(id,key,row[c]));
    });
    let log=0,water=0;
    for(const h of used){
      for(const l of h.layers){const row=t.rows.logs[log++];["boreholeId","from","to","unit","description"].forEach((key,c)=>sync(l.evidence?.id??null,key,row[c]));}
      if(h.values.water.trim()){const row=t.rows.water[water++];["boreholeId","depth","date"].forEach((key,c)=>sync(h.waterEvidence?.id??null,key,row[c]));}
    }
  }
  return t;
}
