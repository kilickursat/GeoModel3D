// What the review edits: the boreholes read from the documents as text, like the Input data tables, each value with the
// line of the page it was read from and, where the reader is unsure of it, why. The draft is checked as it is edited,
// and becomes the Input data tables, where it is checked again as typed data. Nothing is fixed silently: problems are
// reported, and the engineer decides.
import type {ReadLog,TextLine,HeaderField} from "./reconstruct";
import {applyUnitRules,lithologyRules,japaneseLithologyRules} from "../rules";
import {inferUnitOrder} from "../io";
import {COLUMNS,EditorTables,emptyTables} from "../tables";
import type {Borehole} from "../schema";
import {newEvidenceId,changeEvidenceField,EvidenceCollection,EvidenceRecord,EvidenceSource,EvidenceField,EvidenceBox} from "../evidence";

export type Field=HeaderField;
export const FIELDS:Array<{key:Field;label:string;numeric:boolean}>=[
  {key:"id",label:"Borehole",numeric:false},{key:"x",label:"Easting (m)",numeric:true},{key:"y",label:"Northing (m)",numeric:true},
  {key:"lat",label:"Latitude",numeric:true},{key:"lon",label:"Longitude",numeric:true},{key:"ground",label:"Ground level (m)",numeric:true},
  {key:"final",label:"Final depth (m)",numeric:true},{key:"water",label:"Water depth (m)",numeric:true}
];
// `flag` says why the reader is unsure of the layer's base depth; `autoUnit` is set while the unit is the rules' choice,
// so it follows an edited description.
export interface DraftLayer { from:string; to:string; unit:string; description:string; flag?:string; autoUnit:boolean; src:TextLine[]; evidence?:EvidenceRecord }
// `ocr`: read by the reading model from a scanned page or an image, not from the document's own text.
export interface DraftHole {
  use:boolean; doc:number; file:string; pages:number[]; kind:"scale"|"table"; ocr:boolean;
  values:Record<Field,string>; flags:Partial<Record<Field,string>>; src:Partial<Record<Field,TextLine>>;
  layers:DraftLayer[]; evidence?:EvidenceRecord; waterEvidence?:EvidenceRecord; ocrPages?:number[];
}

const text=(v:number|undefined)=>v===undefined||!Number.isFinite(v)?"":String(v);
export const num=(s:string)=>{const t=s.trim().replace(/^−/,"-").replace(",",".");return t===""?undefined:/^-?\d+(?:\.\d*)?$|^-?\.\d+$/.test(t)?Number(t):NaN};
const CJK=/[぀-ヿ㐀-鿿]/;
const fmt=(v:number)=>String(+v.toFixed(3));

// A unit for a description, by the app's first grouping of soil and rock names (Japanese names by their own rules).
// A description no rule assigns stays its own unit, as in imports, and is reported.
export function unitFor(description:string){
  const d=description.trim();
  if(!d)return "";
  const rules=CJK.test(d)?japaneseLithologyRules:lithologyRules;
  return applyUnitRules([{id:"",x:0,y:0,z:0,intervals:[{from:0,to:1,unit:"",name:d}]}],rules).boreholes[0].intervals[0].unit;
}

// The logs of one document as drafts. A log whose ID was not read is named after its first page, and flagged.
// `scanned` lists the pages read by the reading model.
export function draftHoles(doc:number,file:string,logs:ReadLog[],scanned:ReadonlySet<number>=new Set()):DraftHole[]{
  return logs.map(log=>{
    const flags:Partial<Record<Field,string>>={};
    if(!log.src?.id)flags.id="no borehole ID read: type its name";
    if(log.groundFlag)flags.ground=log.groundFlag;
    if(log.waterFlag)flags.water=log.waterFlag;
    if(log.xyFlag){flags.x=log.xyFlag;flags.y=log.xyFlag}
    return {use:true,doc,file,pages:log.pages,kind:log.kind,ocr:log.pages.some(p=>scanned.has(p)),ocrPages:[...scanned],
      values:{id:log.src?.id?log.id??"":`Page ${log.pages[0]}`,x:text(log.x),y:text(log.y),lat:text(log.lat),lon:text(log.lon),
        ground:text(log.ground),final:text(log.final),water:text(log.water)},
      flags,src:{...log.src},
      layers:log.layers.map(l=>({from:text(l.from),to:text(l.to),unit:unitFor(l.description),description:l.description,
        ...(l.flagged?{flag:l.why??"check this depth against the page"}:{}),autoUnit:true,src:l.src}))};
  });
}

// Stable evidence lives on the draft object, not its position in the editable list. Creating it before the review
// captures the extraction as it was; later edits can change current values without replacing that original.
export const evidenceField=(field:Field)=>field==="ground"?"z":field==="final"?"depth":field;
export type PageSize={width:number;height:number};
export function captureDraftEvidence(holes:DraftHole[],sources:EvidenceSource[],size:(doc:number,page:number)=>PageSize|undefined){
  const boxes=(h:DraftHole,lines:TextLine[]):EvidenceBox[]=>lines.flatMap(line=>{
    const page=line.page??h.pages[0],s=size(h.doc,page);
    if(!s||!(s.width>0&&s.height>0)||![line.x0,line.y0,line.x1,line.y1].every(Number.isFinite))return [];
    const clamp=(n:number)=>Math.max(0,Math.min(1,n));
    const x0=clamp(line.x0/s.width),x1=clamp(line.x1/s.width),y0=clamp(line.y0/s.height),y1=clamp(line.y1/s.height);
    return x1>x0&&y1>y0?[{page,x0,y0,x1,y1,text:line.text}]:[];
  });
  const field=(h:DraftHole,value:string,lines:TextLine[],note?:string):EvidenceField=>({original:value,current:value,
    boxes:boxes(h,lines),status:"unreviewed",events:[],...(note?{note}:{})});
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
      layer.evidence=record(h,{
        boreholeId:field(h,h.values.id,h.src.id?[h.src.id]:[]),
        from:field(h,layer.from,layer.src,"Top depth reconstructed with this layer's log; compare it with the page."),
        to:field(h,layer.to,layer.src,layer.flag),
        unit:field(h,layer.unit,layer.src,"Assigned by unit rules from the logged description."),
        description:field(h,layer.description,layer.src)
      },layer.src);
    }
  }
}

// ---------- checks ----------

// A check points at a value of a borehole: one of its fields, or one of its layers. Errors stop "Use these boreholes";
// warnings are values to look at; notes are for information.
export interface Check { hole:number; field?:Field; layer?:number; level:"error"|"warn"|"note"; text:string }
export function checkDraft(holes:DraftHole[]):Check[]{
  const out:Check[]=[],used=holes.filter(h=>h.use),many=used.length>1;
  const named=new Map<string,number>();
  for(const h of used){const id=h.values.id.trim();if(id)named.set(id,(named.get(id)??0)+1)}
  holes.forEach((h,i)=>{
    if(!h.use)return;
    const add=(level:Check["level"],text:string,at:{field?:Field;layer?:number}={})=>out.push({hole:i,level,text,...at});
    const v=Object.fromEntries(FIELDS.map(f=>[f.key,f.numeric?num(h.values[f.key]):undefined])) as Record<Field,number|undefined>;
    const id=h.values.id.trim();
    if(h.ocr)add("warn","Read by OCR from a scanned page: compare every value and description with the page.");
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
    if(many&&!(has("x")&&has("y"))&&!(has("lat")&&has("lon")))add("warn","No position: type an easting and northing, or a latitude and longitude, or this borehole is not placed with the others.",{field:"x"});
    if(many&&!has("ground")&&!Number.isNaN(v.ground))add("warn","No ground level: type it, or this borehole is not placed.",{field:"ground"});
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
    valid.forEach((q,j)=>{
      const prev=valid[j-1];
      if(prev&&q.from>prev.to+0.005)add("warn",`A gap from ${fmt(prev.to)} to ${fmt(q.from)} m: no layer is there.`,{layer:q.k});
      if(prev&&q.from<prev.to-0.005)add("warn",`Layers overlap from ${fmt(q.from)} to ${fmt(Math.min(prev.to,q.to))} m.`,{layer:q.k});
      if(q.l.flag)add("warn",`${fmt(q.to)} m: ${q.l.flag}.`,{layer:q.k});
      if(!q.l.unit.trim())add("error",`Layer ${fmt(q.from)}–${fmt(q.to)} m: no unit. Type one, or a description.`,{layer:q.k});
      else if(q.l.autoUnit&&q.l.unit===q.l.description.trim()&&q.l.unit.length>24)add("note",`Layer ${fmt(q.from)}–${fmt(q.to)} m: no rule gives its description a unit, so the description is its unit. Type a shorter one.`,{layer:q.k});
    });
    const base=Math.max(...valid.map(q=>q.to));
    if(has("final")&&v.final!<base-0.005)add("warn",`The final depth (${fmt(v.final!)} m) is above the base of the log (${fmt(base)} m).`,{field:"final"});
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
  const docs=[...new Set(used.map(h=>h.doc))].map(d=>({file:files[d],pages:used.filter(h=>h.doc===d).flatMap(h=>h.pages)}));
  const name=docs.length===1?docs[0].file.replace(/\.pdf$/i,""):"Borehole logs from PDFs";
  t.project={...t.project,name,source:docs.map(d=>d.file).join(", "),
    description:`Borehole logs read from ${docs.map(d=>`${d.file} (page${d.pages.length>1?"s":""} ${pageRanges(d.pages)})`).join(" and ")} and checked in the review.`};
  t.rows.boreholes=used.map(h=>[h.values.id.trim(),...(["x","y","lat","lon","ground","final"] as Field[]).map(k=>cell(h.values[k]))]);
  t.rows.logs=used.flatMap(h=>h.layers.map(l=>[h.values.id.trim(),cell(l.from),cell(l.to),l.unit.trim(),l.description.trim()]));
  t.rows.water=used.filter(h=>h.values.water.trim()).map(h=>[h.values.id.trim(),cell(h.values.water),""]);
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
