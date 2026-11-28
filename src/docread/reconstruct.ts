import {DMS,SOIL_CODE,SOIL_NAME} from "./nativeLogFields";
import {Rule,isVertical,xAt,yAt} from "./ruling";
import {adjacentMetricStrips,checkMetricHead,metricStrip,recoverMetricStrips} from "./metricContinuation";
import {graphicRangeLog} from "./graphicLog";
// Borehole logs from the text of a page: lines of text with their boxes, from a PDF's own text layer or from OCR of a
// page image, become logs (header values and layers) with no template for any layout. Drawn logs are read by their
// depth scale, logs set out as tables by their From and To columns. Each layer keeps the lines it was read from, so the
// review can show where every value came from; values the page does not state outright are flagged.

// A line of text and its box, in page pixels (y down), and the page it is on once a document is read.
// `shown`: where the line is on the page as drawn, for a page read turned upright (see readDocument): the review and
// the evidence show the line there.
export interface TextLine { text:string; x0:number; y0:number; x1:number; y1:number; cx:number; cy:number; page?:number; shown?:{x0:number;y0:number;x1:number;y1:number} }
// A flagged layer says why its base depth needs checking. `gap`: the untested interval its base lies in, where the
// log describes samples (see sampleLayers). On forms with a soil-name column, soilName is its unambiguous
// label, or an empty string where only remarks or conflicting names were found.
export interface ReadLayer { from:number; to:number; description:string; soilName?:string; flagged?:boolean; why?:string; gap?:[number,number]; src:TextLine[] }
export type HeaderField="id"|"ground"|"final"|"water"|"x"|"y"|"lat"|"lon";
// `src` keeps the line each header value was read from.
export interface LogHeader {
  id?:string; sheet?:[number,number]; ground?:number; final?:number; water?:number; x?:number; y?:number; lat?:number; lon?:number;
  waterFlag?:string; xyFlag?:string; groundFlag?:string; src?:Partial<Record<HeaderField,TextLine>>;
}
// One log on one page: drawn ("scale") or a table. `error` says why a log could not be read; `texts` and `bounds` let a
// log over several pages be joined.
// `evidence`: the part has a log's title or column headings, so a part read without layers is a log that could not be
// read rather than a page of something else.
// `samples`: a drawn log read from the sample depths written at the start of its descriptions (see readSamples).
// `closing`: the text of a last sheet that holds only the end of a log, with no depth scale (see closingText).
// `top`: the depth where the page's log starts, so the sheets of one log follow one another downwards. `core`: the
// runs of a rock core log (see readCore).
// A Standard Penetration Test: the depth it started at, the blows counted and the distance driven (cm), as the log
// prints them. A complete test is driven 30 cm; one stopped short (50 blows) less; one that sank under its own weight
// more. `src`: the lines it was read from.
export interface SptTest { depth:number; blows:number; penetration?:number; src:TextLine[] }
export interface PageLog extends LogHeader {
  printedBeds?:boolean; // Continuation rows verified against the first sheet’s metric columns.
  rangeLabels?:boolean;
  depthInFeet?:boolean;
  spt?:SptTest[];
  kind:"scale"|"table"; layers:ReadLayer[]; used:Set<TextLine>; flagged:number[]; bounds:number[];
  texts:Array<{depth:number;text:string;src:TextLine;isSoilName?:boolean}>; error?:string; evidence?:boolean; samples?:Sample[];
  closing?:{description:string;src:TextLine[]}; top?:number; core?:CoreSheet;
}
// `core`: the rock core logs of the borehole, by their pages: runs and the rock described, kept for the review.
export interface ReadLog extends LogHeader {
  rangeLabels?:boolean;
  kind:"scale"|"table"; pages:number[]; layers:ReadLayer[]; flagged:number[]; samples?:boolean; spt?:SptTest[];
  core?:CoreSheet&{pages:number[]};
}

// NFKC: full-width brackets and digits (common in Japanese documents) become plain ones, and Kangxi radicals that some
// PDF producers put in the text layer for kanji ("⼝" for 口, "⾼" for 高) become the kanji. The radicals supplement has
// no such mapping, so the ones that stand for whole kanji as written in Japanese ("⻑" for 長: 掘進長; "⻇" for 角: 角礫;
// 青 and 黄 in colours) are mapped here.
const RADICALS:Record<string,string>={"⺠":"民","⻄":"西","⻇":"角","⻑":"長","⻒":"長","⻘":"青","⻝":"食","⻣":"骨","⻤":"鬼","⻨":"麦","⻩":"黄","⻫":"斉","⻭":"歯","⻯":"竜","⻲":"亀"};
export const textLine=(text:string,x0:number,y0:number,x1:number,y1:number):TextLine=>
  ({text:text.normalize("NFKC").replace(/[⺀-⻿]/g,c=>RADICALS[c]??c),x0,y0,x1,y1,cx:(x0+x1)/2,cy:(y0+y1)/2});

// A number, also when read together with a tick mark drawn after it ("6-", "14 —"); a leading minus stays a minus,
// for elevation scales.
export const num=(t:string)=>{const s=t.trim().replace("−","-").replace(/[\s\-–—_~=]+$/,"");return /^-?\d+(?:[.,]\d+)?$/.test(s)?Number(s.replace(",",".")):NaN};
// The first number in a value; "GL-9.80m" (Japanese for 9.80 m below ground level) is a depth of 9.80.
const firstNum=(t:string|undefined)=>{if(!t)return undefined;const s=t.replace(/[−ー]/g,"-").replace(/GL\s*-\s*/i,"");const m=/-?\d+(?:[.,]\d+)?/.exec(s);return m?Number(m[0].replace(",",".")):undefined};
const letters=(t:string)=>(t.match(/\p{L}/gu)??[]).length;
const isDecimal=(e:TextLine)=>/[.,]\d/.test(e.text)&&Number.isFinite(num(e.text));
interface Column { x0:number; x1:number; els:TextLine[] }
// Text grouped into columns by horizontal overlap, never across a ruled line drawn down between them: the lines that
// run down most of the text's height (the borders of a form's columns) part it into cells first.
function columns(els:TextLine[],rules:Rule[]=[]):Column[]{
  const cols:Column[]=[],cell=cells(els,rules);
  for(const e of [...els].sort((p,q)=>p.x0-q.x0)){
    const c=cols.find(c=>e.x0<c.x1&&e.x1>c.x0&&cell(c.els[0])===cell(e));
    if(c){c.els.push(e);c.x0=Math.min(c.x0,e.x0);c.x1=Math.max(c.x1,e.x1)}else cols.push({x0:e.x0,x1:e.x1,els:[e]});
  }
  return cols;
}

// The cell each line is in, between the ruled lines that run down at least half of the lines' height.
function cells(els:TextLine[],rules:Rule[]){
  if(!rules.length||!els.length)return (_:TextLine)=>0;
  const top=Math.min(...els.map(e=>e.cy)),bottom=Math.max(...els.map(e=>e.cy)),tall=Math.max(bottom-top,1);
  const downs=rules.filter(r=>isVertical(r)&&Math.min(r.y1,bottom)-Math.max(r.y0,top)>=0.5*tall);
  return (e:TextLine)=>downs.filter(r=>xAt(r,e.cy)<e.cx).length;
}

// ---------- the depth scale ----------

// Whole numbers stacked in one narrow column at even spacing: y = a + b·d fitted to the largest consistent set, ignoring
// stray numbers. Other columns of evenly spaced whole numbers (sample numbers 1, 2, 3…) also fit a line, so each
// candidate scores its labels plus five times the decimals elsewhere on the page that sit where it puts their values: a
// real depth scale explains the boundary depths written on the log. Where too few whole-metre labels were read, the
// column of boundary depths written as decimals is the scale itself; labels sit just above or below their lines, so
// whole-metre labels win when both fit. A tick drawn just before a label is often read with it ("-2"): such labels are
// also tried as ticks where that is the likelier reading (the column mixes labels with and without the mark, or the
// ticked scale explains the depths written on the log). A true elevation scale below a datum (0, -1, -2…) has minus
// signs throughout and its depths don't match the boundaries, so it stays an elevation scale.
export interface DepthScale { a:number; b:number; kind:"labels"|"ticks"|"decimals"; labels:TextLine[]; depthAt(y:number):number; yAt(d:number):number }
const tickNum=(t:string)=>{const m=/^[-–—−]\s?(\d+)$/.exec(t.trim());return m?+m[1]:num(t)};
const ticked=(t:string)=>/^[-–—−]\s?\d+$/.test(t.trim());
export function depthScale(els:TextLine[],width:number):DepthScale|null{
  const ints=els.filter(e=>Number.isInteger(num(e.text))&&!/[.,]\d/.test(e.text)&&e.x1-e.x0<0.06*width);
  const decs=els.filter(isDecimal);
  let best:{inl:TextLine[];val:(t:string)=>number;kind:DepthScale["kind"];score:number}|null=null;
  const passes:Array<[TextLine[],(t:string)=>number,DepthScale["kind"]]>=[[ints,num,"labels"],[ints,tickNum,"ticks"],[decs.filter(e=>e.x1-e.x0<0.08*width),num,"decimals"]];
  for(const [pool,val,kind] of passes)
    for(let i=0;i<pool.length;i++)for(let j=i+1;j<pool.length;j++){
      const p=pool[i],q=pool[j],dd=val(q.text)-val(p.text);
      if(!dd||Math.abs(p.cx-q.cx)>0.02*width)continue;
      const b=(q.cy-p.cy)/dd;if(b<=0)continue;
      const a=p.cy-b*val(p.text),tol=kind==="decimals"?0.35*b:0.25*b;
      const inl=pool.filter(e=>Math.abs(e.cx-p.cx)<0.02*width&&Math.abs(a+b*val(e.text)-e.cy)<tol);
      const vals=inl.map(e=>val(e.text));
      // At least three different values over a metre or more: a column of repeated readings is not a scale.
      if(new Set(vals).size<3||Math.max(...vals)-Math.min(...vals)<1)continue;
      const explained=decs.filter(e=>(kind==="decimals"||!inl.includes(e))&&Math.abs((e.cy-a)/b-num(e.text))<0.6).length;
      if(kind==="ticks"){const marks=inl.filter(e=>ticked(e.text)).length;if(!marks||(marks===inl.length&&explained<2))continue}
      const score=(kind==="decimals"?0:inl.length)+5*explained-{labels:0,ticks:0.25,decimals:0.5}[kind];
      if(!best||score>best.score)best={inl,val,kind,score};
    }
  if(!best)return null;
  const xs=best.inl.map(e=>best!.val(e.text)),ys=best.inl.map(e=>e.cy),n=xs.length;
  const mx=xs.reduce((s,v)=>s+v)/n,my=ys.reduce((s,v)=>s+v)/n;
  const b=xs.reduce((s,v,k)=>s+(v-mx)*(ys[k]-my),0)/xs.reduce((s,v)=>s+(v-mx)**2,0),a=my-b*mx;
  return {a,b,kind:best.kind,labels:best.inl,depthAt:y=>(y-a)/b,yAt:d=>a+b*d};
}

// A log too short for its scale to show more than its top (a hand-auger hole to 0.9 m) may still print, at each
// boundary, its elevation over its depth ("48.3" over "0.4"): pairs that add up to one ground level are depths, and
// their places with the ground surface's give the scale. Only for a titled log whose numbers give no scale otherwise.
export function pairScale(els:TextLine[],width:number):DepthScale|null{
  const decs=els.filter(isDecimal),h=decs.map(e=>e.y1-e.y0).sort((a,b)=>a-b)[decs.length>>1]||12;
  const pairs:Array<{depth:TextLine;sum:number}>=[];
  for(const d of decs){
    const e=decs.filter(e=>e!==d&&Math.abs(e.cx-d.cx)<0.05*width&&d.cy-e.cy>0.4*h&&d.cy-e.cy<2.5*h).sort((p,q)=>q.cy-p.cy)[0];
    if(e&&num(d.text)<num(e.text))pairs.push({depth:d,sum:num(e.text)+num(d.text)});
  }
  let best:typeof pairs=[];
  for(const p of pairs){const near=pairs.filter(q=>Math.abs(q.sum-p.sum)<=0.05);if(near.length>best.length)best=near}
  if(best.length<2)return null;
  const ground=best[0].sum,top=Math.min(...best.map(p=>p.depth.cy));
  // The ground surface: its words, or its elevation alone above the first boundary.
  const surface=els.find(e=>/^(?:ground surface|ground level|existing grade|top of (?:ground|hole))$/i.test(e.text.trim())&&e.cy<top)??
    decs.find(e=>Math.abs(num(e.text)-ground)<=0.05&&e.cy<top);
  if(!surface)return null;
  const xs=[0,...best.map(p=>num(p.depth.text))],ys=[surface.cy,...best.map(p=>p.depth.cy)],n=xs.length;
  if(new Set(xs).size<3)return null;
  const mx=xs.reduce((s,v)=>s+v)/n,my=ys.reduce((s,v)=>s+v)/n;
  const b=xs.reduce((s,v,k)=>s+(v-mx)*(ys[k]-my),0)/xs.reduce((s,v)=>s+(v-mx)**2,0),a=my-b*mx;
  if(!(b>0)||xs.some((v,k)=>Math.abs(a+b*v-ys[k])>Math.max(1.5*h,0.15*b)))return null;
  return {a,b,kind:"decimals",labels:best.map(p=>p.depth),depthAt:y=>(y-a)/b,yAt:d=>a+b*d};
}

// ---------- header values ----------

// A header value. Every text matching the label is tried in turn until one gives a value that passes `ok`: the rest of
// the label's own text; else the nearest text below the label (overlapping it horizontally), to its right on its
// line, or just to its left ("12.30 Ground Surface" read as two lines, about one line height apart); else the next
// cell to the right on its line, however far. A value further left belongs to the cell before ("Y 441938.05 Water
// level 3.40 m" in a table row). A label followed by words that are no value ("Borehole was open…", "WATER LEVEL READINGS") is a
// sentence or a heading, not a label. Boxes are compared by their centres: OCR pads its boxes, so a label's box and its
// value's box below can overlap.
export const field=(els:TextLine[],label:RegExp,ok:(t:string)=>boolean=()=>true)=>fieldAt(els,label,ok)?.text;
// The value and the line it was read from.
function fieldAt(els:TextLine[],label:RegExp,ok:(t:string)=>boolean=()=>true):{text:string;src:TextLine}|undefined{
  for(const l of els.filter(e=>label.test(e.text))){
    // A unit in brackets after the label ("Termination depth (m)") is part of it.
    const rest=l.text.replace(label,"").replace(/^\s*[([]\s*(?:m|mm|cm|ft|m\s*bgl|mbgl|mbgs|m\s*bgs)\s*[)\]]/i,"").replace(/^[\s:：.\-–=]+/,"").trim();
    if(rest){if(ok(rest))return {text:rest,src:l};continue}
    const h=Math.max(l.y1-l.y0,1),line=(e:TextLine)=>Math.abs(e.cy-l.cy)<0.6*h;
    const cands=els.filter(e=>e!==l&&ok(e.text)&&(
      (e.cy>l.cy+0.4*h&&e.cy-l.cy<3*h&&e.x0<l.x1&&e.x1>l.x0)||
      (line(e)&&e.x0>=l.x1-2&&e.x0-l.x1<8*h)||
      (line(e)&&e.x1<=l.x0+2&&l.x0-e.x1<2*h)));
    cands.sort((p,q)=>Math.hypot(p.cx-l.cx,p.cy-l.cy)-Math.hypot(q.cx-l.cx,q.cy-l.cy));
    if(cands[0])return {text:cands[0].text,src:cands[0]};
    const next=els.filter(e=>e!==l&&line(e)&&e.x0>=l.x1-2).sort((p,q)=>p.x0-q.x0)[0];
    if(next&&ok(next.text))return {text:next.text,src:next};
    // A cell of two lines beside the label, its datum over its value ("T.P." over "3.18m"): the value just right of
    // the label, up to a line above or below it.
    const stacked=els.filter(e=>e!==l&&ok(e.text)&&e.x0>=l.x1-2&&e.x0-l.x1<3*h&&Math.abs(e.cy-l.cy)<1.2*h)
      .sort((p,q)=>Math.hypot(p.cx-l.cx,p.cy-l.cy)-Math.hypot(q.cx-l.cx,q.cy-l.cy))[0];
    if(stacked)return {text:stacked.text,src:stacked};
  }
  return undefined;
}
// Values: an ID ("1", "BH3", "BH-01", "401"); a number first ("3.64 m NAP", "GL-9.80m"), but not a date; a decimal
// number, so a sample number "1" beside a heading is not taken for a water depth.
const DATE=/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/;
// A note in brackets after an ID ("BR-2(6.25k+65m右岸)", "No.2(測点No.67 R5.0)") is part of the name as printed.
const ID_NOTE=/\s*[(（][^)）]*[)）]?\s*$/;
const isId=(t:string)=>/^[A-Za-z.#\-]{0,6}\s?\d[\w.\-/]{0,12}$/.test(t.trim());
const SHEET_MARK=/\b(?:sheet|page)\b|\d\s+of\s+\d/i;
const isNum=(t:string)=>/^\D{0,3}\d/.test(t)&&!DATE.test(t);
const isDec=(t:string)=>/^\D{0,3}\d+[.,]\d/.test(t)&&!DATE.test(t);
const REMARK=/^\s*\d+(?:[.,]\d+)?\s*m\s*:\s*\p{L}/u;
// A level is often given with its datum before it: "KBM2= -0.47m", "GH= 121.17m", "T.P.+3.18m", "KBM -0.862m". The
// datum's name (and a number in it, "KBM2") is no part of the value.
const DATUM=/^\s*(?:(?:T\.?\s*P\.?|K\.?\s*B\.?\s*M\.?|B\.?\s*M\.?|G\.?\s*H\.?|D\.?\s*L\.?|A\.?\s*P\.?|N\.?\s*A\.?\s*P\.?|H)\s*\d{0,2}\s*[=＝:：]?\s*)/i;
const stripDatum=(t:string)=>{const eq=/[=＝]\s*([+\-−]?\s*\d)/.exec(t);return eq?t.slice(eq.index+1).trim():t.replace(DATUM,"")};
const levelNum=(t:string|undefined)=>t===undefined?undefined:firstNum(stripDatum(t).replace(/^\+\s*/,""));
// A thickness ("80mm ASPHALT", under "GROUND SURFACE") is no level.
const isLevel=(t:string)=>{const s=stripDatum(t);return isNum(s)&&!/^\D{0,3}\d+(?:[.,]\d+)?\s?(?:mm|cm)\b/i.test(s)};
const dms=(m:RegExpExecArray|null|undefined,at:number)=>{
  if(!m)return undefined;
  const d=+m[at],mi=+m[at+1],s=+m[at+2].replace(",",".");
  return mi<60&&s<60?+(d+mi/60+s/3600).toFixed(7):undefined;
};
// Japanese labels set out with a space between their characters ("孔 口 標 高", "総 掘 進 長", "北 緯"), as table cells
// often are, are matched as written without the spaces.
// A dash drawn as "―" or "‐" in katakana ("ボ―リング") is the long-vowel mark.
const CJK_GAP=/([぀-ヿ㐀-鿿])[ \t　]+(?=[぀-ヿ㐀-鿿])/g;
const squeeze=(t:string)=>t.replace(/([ァ-ヿ])[―‐－−](?=[ァ-ヿ])/g,"$1ー").replace(CJK_GAP,"$1");
// Labels whose characters are cells of their own ("孔", "口", "標", "高" side by side) are closed up into one, as are
// "北" and "緯": short runs of kanji or kana only, close together on one line.
const KANA_KANJI=/^[぀-ヿ㐀-鿿ー]{1,6}$/;
function closeUp(els:TextLine[]){
  const out:TextLine[]=[],first=new Map<TextLine,TextLine>();
  for(const e of els){
    const p=out.at(-1),h=Math.max(e.y1-e.y0,1);
    if(p&&KANA_KANJI.test(p.text)&&KANA_KANJI.test(e.text)&&Math.abs(p.cy-e.cy)<0.6*h&&e.x0>=p.x1-2&&e.x0-p.x1<2.5*h){
      const m={...p,text:p.text+e.text,x1:Math.max(p.x1,e.x1),y0:Math.min(p.y0,e.y0),y1:Math.max(p.y1,e.y1)};
      m.cx=(m.x0+m.x1)/2;m.cy=(m.y0+m.y1)/2;
      first.set(m,first.get(p)??p);out[out.length-1]=m;
    }else out.push(e);
  }
  return {els:out,first};
}

// Page order: lines top to bottom, each left to right. Text within half a line height of a line's first item is on
// that line, so two headings side by side keep their order whatever their boxes' heights. (A PDF's own text comes in
// drawing order, which differs from one producer to another.)
function pageOrder(els:TextLine[]){
  const s=[...els].sort((p,q)=>p.cy-q.cy),hs=s.map(e=>e.y1-e.y0).sort((a,b)=>a-b),h=hs[hs.length>>1]||10;
  let line=0,top=-Infinity;
  return s.map(e=>{if(e.cy-top>0.5*h){line++;top=e.cy}return {e,line}}).sort((a,b)=>a.line-b.line||a.e.cx-b.e.cx).map(x=>x.e);
}

// The header of a log: ID, sheet of a log over several pages, ground level, final depth, water level and position.
// Labels in English, Dutch, French, German and Japanese.
export function header(lines:TextLine[]):LogHeader&{mark?:number}{
  // Labels are matched on the text with spaced-out kanji closed up; each value keeps the line it was read from.
  const original=new Map<TextLine,TextLine>();
  const squeezed=pageOrder(lines).map(e=>{const t=squeeze(e.text);if(t===e.text)return e;const c={...e,text:t};original.set(c,e);return c});
  const closed=closeUp(squeezed),els=closed.els;
  for(const [m,f] of closed.first)original.set(m,original.get(f)??f);
  const all=els.map(e=>e.text).join("\n");
  // A value found in the page's text, and the line it starts in.
  const starts:number[]=[];
  els.reduce((at,e)=>{starts.push(at);return at+e.text.length+1},0);
  const lineAt=(i:number)=>{let k=0;while(k+1<starts.length&&starts[k+1]<=i)k++;return els[k]};
  const match=(re:RegExp,group=1)=>{
    const m=new RegExp(re.source,re.flags+"d").exec(all);
    return m&&m[group]!==undefined?{m,text:m[group],src:lineAt(m.indices![group]![0])}:undefined;
  };
  const src:Partial<Record<HeaderField,TextLine>>={};
  const take=<T>(key:HeaderField,v:{text:string;src:TextLine}|undefined,parse:(t:string)=>T|undefined)=>{
    const value=v?parse(v.text):undefined;
    if(value!==undefined)src[key]=original.get(v!.src)??v!.src;
    return value;
  };
  // A title "LOG OF BOREHOLE BH3 … 1 OF 3" gives the ID and the sheet, so the pages of one log can be joined.
  // So does "BOREHOLE LOG 214" or "ROCK CORE LOG 214", the ID after the title on its line ("LOG" is no part of the ID).
  const named=match(/(?:bore ?hole|boring|drill ?hole|test ?pit|(?:rock )?core)[ \t]+log[ \t]+(?:no\.?[ \t]*)?([A-Za-z0-9][\w./-]*)/i);
  // A title stands on a line of its own: "…, log of boring WS-15." in a sentence names another record.
  const own=(m:ReturnType<typeof match>)=>m&&m.src.text.trim().split(/\s+/).length<=8?m:undefined;
  const title=own(match(/(?:log|record) of\s+(?:bore ?hole|boring|test ?pit|drill ?hole)\s+([A-Za-z0-9][\w./-]*)/i))??(named&&isId(named.text)?own(named):undefined);
  const sheet=/\b(\d+)\s+of\s+(\d+)\b/i.exec(all);
  // A table of readings ("Water Depth (m)" over a column of values) gives the first reading.
  let reading:{text:string;src:TextLine}|undefined;
  const wcol=els.find(e=>/^(?:water depth|depth to water|depth of water|groundwater depth)\b/i.test(e.text.trim()));
  if(wcol){
    const h=Math.max(wcol.y1-wcol.y0,1);
    const v=els.filter(e=>e.cy>wcol.cy+0.4*h&&e.cy-wcol.cy<6*h&&Math.abs(e.cx-wcol.cx)<Math.max((wcol.x1-wcol.x0)/2,2*h)&&isDec(e.text)).sort((p,q)=>p.cy-q.cy)[0];
    if(v)reading={text:v.text,src:v};
  }
  // A Japanese log also has a graphical water column. A separate bare number beside its
  // heading can be the first penetration test. A separate header value must give its datum or unit.
  const jpWater=match(/^(?:孔内水位|地下水位)[ \t]*(?:\(m\)[ \t]*)?[:=]?[ \t]*([+−-]?\d+(?:[.,]\d+)?)[ \t]*m?[ \t]*$/im)??
    fieldAt(els,/^(?:孔内水位|地下水位)/,t=>/^(?:GL\s*[-−]\s*\d+(?:[.,]\d+)?\s*m?|[+-]?\d+(?:[.,]\d+)?\s*m)$/i.test(t.trim()));
  const gwl=match(/GWL\s*([\d.,]+)/i);
  const head:LogHeader&{mark?:number}={
    // "BOREHOLE LOG" is a title, not the label of a name; and a sheet's number ("Sheet 1 of 2") beside the label is no name.
    id:take("id",title??fieldAt(els,/^(?:bore\s*hole|boring|forage|sondage|bohrung)(?!\s+log)\s*(?:no\.?|id|nr\.?|number)?\s*[:.]?(?![a-z])|^ボーリング(?:名|番号|No\.?)|^孔番号|^Proefnummer\s*:|^(?:hole\s*)?number\s*:/i,t=>!SHEET_MARK.test(t)&&isId(t.replace(ID_NOTE,"").replace(/\s+/g,""))),
      // A continuation sheet's "(cont.)" is no part of the ID.
      t=>t.replace(/\s*\((?:cont(?:inued|'d|\.)?|continuation)\)\s*$/i,"").replace(/\s+/g,"")),
    sheet:sheet?[+sheet[1],+sheet[2]]:undefined,
    // The ground level may stand before its words ("12.30 Ground Surface").
    // A header's "ELEVATION: 14.20 m" (with its colon, so not an elevation column's heading) is the ground level too.
    // Australian logs give it as a reduced level: "SURFACE RL 5.40m" (not a bare "R.L.", the heading of a column of levels).
    ground:take("ground",fieldAt(els,/(?:ground (?:level|surface)|(?:ground|surface|collar) elev(?:ation)?\.?|(?:ground|surface|collar)\s*r\.?\s*l\.?|r\.?\s*l\.?\s*(?:of\s*)?(?:ground|surface|collar)|maaiveld(?:hoogte)?|cote du terrain|niveau du sol|gel[äa]ndeh[öo]he|ansatzh[öo]he)(?![a-z])|^孔口標高|^地盤高/i,isLevel)??fieldAt(els,/^elev(?:ation)?\.?\s*[:=]/i,isDec),levelNum),
    // The depth the hole was taken to ("TERMINATION DEPTH (M) : 10.00", "END OF BOREHOLE AT 6.50 mbgs", 総掘進長).
    // A Japanese header's total depth may be a whole number of metres ("20 m"): its label leaves no doubt.
    final:take("final",fieldAt(els,/^(?:termination(?:\s*depth)?|final depth|total depth|depth of (?:bore ?hole|hole)|hole depth|end of (?:bore ?hole|hole)(?: at)?|(?:bore ?hole|hole|bh)\s+(?:completed|terminated|discontinued|abandoned)\s+at)(?![a-z])/i,isDec)??
      fieldAt(els,/^総掘進長|^総削孔長|^掘進長|^掘削深度|^掘さく深度/,t=>isNum(t.replace(/^GL\s*[-−]\s*/i,""))),firstNum),
    // A table of readings first, then a labelled value, then the water mark on the log.
    // A remark under a heading that names the water level ("0.6m: sample disturbed" in a comments column) is none.
    water:take("water",reading??fieldAt(els,/^(?:groundwater|ground water|grondwater(?:stand)?|nappe|grundwasser|water level|w\.\s*l\.|gwl|gwt|g\.\s*w\.\s*t\.|swl|swt|static water(?: level| table)?)(?![a-z])|water op/i,t=>isDec(t)&&!REMARK.test(t))??jpWater??gwl,firstNum),
    // "×" is a common reading of "X".
    // A unit in brackets may follow ("X (mLambert): 151269.0").
    x:take("x",match(/(?:^|[^A-Za-z])[X×]\s*(?:\([^)\n]{0,16}\))?\s*[=:]?\s*(-?[\d.,]{4,})/m),firstNum),y:take("y",match(/(?:^|[^A-Za-z])Y\s*(?:\([^)\n]{0,16}\))?\s*[=:]?\s*(-?[\d.,]{4,})/m),firstNum)};
  // Dutch and Flemish reports: "Z (mTAW): 1.42" is the ground level, "Diepte (m): 0.00 - 24.00" the depth logged.
  if(head.ground===undefined){const z=match(/(?:^|\n)Z\s*\((?:m\s*)?(?:TAW|NAP|NN|mTAW|mNAP)?[^)\n]{0,8}\)\s*:\s*(-?\d+(?:[.,]\d+)?)/i);if(z){head.ground=firstNum(z.text);src.ground=original.get(z.src)??z.src}}
  if(head.final===undefined){const r=match(/diepte\s*\(m\)\s*:\s*\d+(?:[.,]\d+)?\s*-\s*(\d+(?:[.,]\d+)?)/i)??match(/(?:^|\n)T\.\s*D\.\s*(\d+(?:[.,]\d+)?)/);if(r){head.final=firstNum(r.text);src.final=original.get(r.src)??r.src}}
  // Easting and northing with their letters after them ("COORDINATES 412345.0 E; 6801234.5 N", "412345mE 6801234mN").
  const en=match(/(?:^|[^\w.])(\d{5,7}(?:[.,]\d+)?)\s*m?E\b[\s;,/]*(\d{6,8}(?:[.,]\d+)?)\s*m?N\b/m);
  if(head.x===undefined&&head.y===undefined&&en){head.x=firstNum(en.m[1]);head.y=firstNum(en.m[2]);src.x=src.y=original.get(en.src)??en.src}
  // Northing and easting where there is no X and Y. In UTM the northing is the one in millions: labels the other way
  // round are swapped, and flagged.
  const north=match(/(?:^|[^A-Za-z])(?:N|Northing)\s*[=:]?\s*(-?\d{5,}(?:[.,]\d+)?)/m),east=match(/(?:^|[^A-Za-z])(?:E|Easting)\s*[=:]?\s*(-?\d{5,}(?:[.,]\d+)?)/m);
  const n=firstNum(north?.text),e=firstNum(east?.text);
  if(head.x===undefined&&head.y===undefined&&n!==undefined&&e!==undefined){
    if(e>=1e6&&n<1e6){head.x=n;head.y=e;src.x=north!.src;src.y=east!.src;head.xyFlag="N and E read the other way round (UTM)"}
    else{head.x=e;head.y=n;src.x=east!.src;src.y=north!.src}
  }
  // Latitude and longitude in decimal degrees ("Latitude (N) - 48.2082": the dash separates, it is no minus sign).
  const lat=match(/lat(?:itude)?\s*(?:\(\s*([NS])\s*\))?\s*[-:=]?\s*([NS])?\s*[:=]?\s*(\d{1,2}[.,]\d{3,})/i,3);
  const lon=match(/lon(?:g(?:itude)?)?\s*(?:\(\s*([EW])\s*\))?\s*[-:=]?\s*([EW])?\s*[:=]?\s*(\d{1,3}[.,]\d{3,})/i,3);
  if(lat&&lon){
    head.lat=+lat.text.replace(",",".")*(/S/i.test(lat.m[1]??lat.m[2]??"")?-1:1);
    head.lon=+lon.text.replace(",",".")*(/W/i.test(lon.m[1]??lon.m[2]??"")?-1:1);
    src.lat=original.get(lat.src)??lat.src;src.lon=original.get(lon.src)??lon.src;
  }else{
    // In degrees, minutes and seconds, after a label: 北緯 / 東経 (with or without 度), latitude / longitude, or N / E.
    // The label and its value may be cells of their own ("北", "緯", then the value).
    const dlat=match(new RegExp(String.raw`(?:北\s*緯|南\s*緯|緯\s*度|lat(?:itude)?\.?|\bN)[\s:：=]{0,6}${DMS}\s*([NS])?`,"i"),1);
    const dlon=match(new RegExp(String.raw`(?:東\s*経|西\s*経|経\s*度|lon(?:g(?:itude)?)?\.?|\bE)[\s:：=]{0,6}${DMS}\s*([EW])?`,"i"),1);
    const a=dms(dlat?.m,1),o=dms(dlon?.m,1);
    if(a!==undefined&&o!==undefined&&a<=90&&o<=180){
      const south=/南\s*緯/.test(dlat!.m[0])||dlat!.m[4]?.toUpperCase()==="S",west=/西\s*経/.test(dlon!.m[0])||dlon!.m[4]?.toUpperCase()==="W";
      head.lat=south?-a:a;head.lon=west?-o:o;
      src.lat=original.get(dlat!.src)??dlat!.src;src.lon=original.get(dlon!.src)??dlon!.src;
    }
  }
  // "GWT: Ground level": the water stands at the ground surface, a depth of 0 (flagged). Only as the label's own line:
  // a "Ground level" in the next cell of a row of headings is a label of its own.
  if(head.water===undefined){
    const at=els.find(e=>/^(?:groundwater(?: table| level)?|ground water(?: table| level)?|water (?:level|table)|w\.\s*l\.|gwl|gwt|g\.\s*w\.\s*t\.|swl|swt)\s*[:=]\s*(?:at\s+)?(?:the\s+)?(?:ground (?:level|surface)|surface)\.?$/i.test(e.text.trim()));
    if(at){head.water=0;src.water=at;head.waterFlag="read as “at ground level”: a depth of 0 m"}
  }
  head.mark=firstNum(gwl?.text);
  if(head.water!==undefined&&head.mark!==undefined&&Math.abs(head.mark-head.water)>0.05)head.waterFlag=`the log's mark reads ${head.mark}`;
  head.src=src;
  return head;
}

// ---------- descriptions ----------

// A column of Japanese soil names: short lines (a name is cut over two or three lines), most of them naming a soil or
// rock, or the code of one in brackets.
const median=(v:number[])=>{const s=[...v].sort((a,b)=>a-b);return s.length?s[s.length>>1]:0};
// Names set one character to a line, stacked ("盛" over "土"), are judged on the column's text read down it.
function soilNames(c:{els:TextLine[]}){
  const t=[...c.els].sort((p,q)=>p.cy-q.cy).map(e=>e.text.replace(/\s/g,"")),all=t.join(""),cjk=all.match(/[぀-ヿ㐀-鿿]/g)?.length??0;
  const found=all.match(new RegExp(SOIL_NAME.source,"g"))?.length??0,plain=all.replace(/[(（][^)）]*[)）]/g,"");
  return cjk>=2&&cjk>=0.6*plain.length&&median(t.map(x=>x.length))<=6&&found>=2&&found>=all.length/12;
}
// Tick labels can sit below their ticks. On a ruled log, the printed boundary depths beside
// the description cells give an independent check on that vertical offset. Use it only when
// several distinct depths touch long horizontal lines and agree on the displacement.
function ruledDescriptionOffset(labels:TextLine[],rules:Rule[],scale:DepthScale){
  if(labels.length<3||!rules.length)return 0;
  const offsets=new Map<number,number>();
  for(const e of labels){
    const h=e.y1-e.y0;
    const edges=rules.filter(r=>!isVertical(r)&&r.x0<=e.cx&&r.x1>=e.cx&&r.x1-r.x0>3*(e.x1-e.x0))
      .map(r=>yAt(r,e.cx)).filter(y=>y>=e.y0-h/4&&y<=e.y1+h/4);
    if(edges.length===1)offsets.set(num(e.text),edges[0]-scale.yAt(num(e.text)));
  }
  const values=[...offsets.values()],offset=median(values),height=median(labels.map(e=>e.y1-e.y0));
  if(Math.abs(offset)<height/2)return 0;
  const agree=values.filter(v=>Math.abs(v-offset)<=height/2);
  return agree.length>=3&&agree.length>labels.length/2?median(agree):0;
}
// The lines of a name column as names: a name ends with its code in brackets ("礫混じり粘性土(C-G)"), or where the next
// line starts below a boundary once the name is a whole word ("凝灰質粘土" before "粘土(CH)"). A code on a line of its
// own, below a boundary, still ends the name above it. `lines`: the boundaries' places on the page.
function groupNames(els:TextLine[],lines:number[]){
  const band=(y:number)=>lines.filter(v=>v<=y).length;
  const out:Array<{text:string;src:TextLine[]}>=[];
  let cur:{text:string;src:TextLine[]}|undefined;
  for(const e of els){
    const t=kanji(e.text).replace(/\s/g,"");
    if(!t)continue;
    if(!cur&&out.length&&/^[(（]/.test(t)&&!/[)）]$/.test(out[out.length-1].text)){out[out.length-1].text+=t;out[out.length-1].src.push(e);continue}
    if(cur&&band(e.cy)>band(cur.src[0].cy)&&/(?:土|砂|礫|ト|岩|層|石|ム|ク|炭)$/.test(cur.text)){out.push(cur);cur=undefined}
    if(!cur)cur={text:"",src:[]};
    cur.text+=t;cur.src.push(e);
    if(/[)）]$/.test(t)){out.push(cur);cur=undefined}
  }
  if(cur)out.push(cur);
  return out.filter(n=>/[぀-ヿ㐀-鿿]/.test(n.text));
}

// Digits OCR confuses, one at a time: "8.50" read for "0.50".
const CONFUSED:Record<string,string>={"0":"869","8":"0369","6":"580","5":"63","1":"74","7":"1","3":"85","9":"084","4":"19","2":"73"};
function variants(t:string){
  const s=t.trim().replace(/[\s\-–—_~=]+$/,"").replace(",","."),out:string[]=[];
  for(let i=0;i<s.length;i++)for(const c of CONFUSED[s[i]]??"")out.push(s.slice(0,i)+c+s.slice(i+1));
  return out.filter(v=>/^\d+(?:\.\d+)?$/.test(v));
}
// Simplified Chinese forms and look-alikes OCR returns for the kanji of Japanese soil names. In Japanese text a middle
// dot drawn as "·", "‧", "∙" or "⋅" (fonts and OCR give any of them) is the katakana one, "・".
const KANJI:Record<string,string>={"质":"質","风":"風","砾":"礫","软":"軟","层":"層","页":"頁","碟":"礫","王":"土"};
const kanji=(t:string)=>/[぀-ヿ一-鿿]/.test(t)?t.replace(/[质风砾软层页碟王]/g,c=>KANJI[c]).replace(/[·‧∙⋅]/g,"・"):t;
// Hatching read as text: short mixes of digits with D, b, p, q, O or U ("D0D", "bb0", "6DD"), runs of D, lone marks,
// and one or two kanji inside Latin text.
// A sheet's marks that a layer runs on ("(continued)", "Continued next page") are no description.
const CONTINUED_MARK=/\(\s*continued[^)]*\)|\bcontinued\s+(?:on\s+|to\s+|from\s+)?(?:the\s+)?(?:next|previous|last)\s+(?:page|sheet)\b|^\s*continued\s*$|\bcont['’]d\.?(?=\s|$)/gi;
// OCR reads some capitals as small letters of the same shape (c, o, s, v, w, x, z): "SILTY cLAY," is "SILTY CLAY,".
const capitals=(t:string)=>t.replace(/\b[cosvwxz](?=[A-Z]{2,}\b)/g,c=>c.toUpperCase()).replace(/\b([A-Z]+)([cosvwxz])(?=[A-Z]{2,}\b)/g,(_,a,c)=>a+c.toUpperCase())
  .replace(/\b([A-Z]{2,})([cosvwxz])(?=[A-Z]+\b)/g,(_,a,c)=>a+c.toUpperCase());
// Some PDFs map their font's "ti" and "ft" ligatures to "7" and "&" ("s7ff", "so&.", "Con7nued"): inside a word of small
// letters, they are put back.
export const ligatures=(t:string)=>t.replace(/(?<=[a-z])7(?=[a-z])/g,"ti").replace(/(?<=[a-z])&(?=[a-z.,;:)]|\s|$)/g,"ft");
function clean(t:string,latin=(t.match(/[A-Za-z]/g)??[]).length>=5){
  t=capitals(ligatures(t).replace(CONTINUED_MARK," "));
  return t.split(/\s+/).filter(w=>!(/^(?=.*\d)(?=.*[DdbpqOoUu])[0-9DdbpqOoUu]{2,4}$/.test(w)||/^[Dd]{2,}$/.test(w)||/^[?!)(\]\[}{|]+$/.test(w)||
    (latin&&/^[぀-ヿ一-鿿]{1,2}$/.test(w)))).join(" ").trim();
}

// Layer titles: an UPPERCASE soil name and a colon, comma or bracket ("FILL:", "SANDY SILT,", "TOP SOIL (100 mm)"), or
// a thickness and a name ("200mm AGGREGATE"). Titles are found without overlapping ("SOIL" inside "TOP SOIL" is not one).
const UPPER_WORDS="[A-Z]{2,}(?:\\s+[A-Z]{2,}(?![A-Za-z]*\\s*[,:(]))*";
// The soil may follow its qualifier, capitalised ("Silty CLAY (Topsoil)", "Clayey SAND"), as Australian logs write it.
const TITLE_SRC=`(?:\\d+(?:[.,]\\d+)?\\s?mm\\s+${UPPER_WORDS}|(?:[A-Z][a-z]*y\\s+)?[A-Z]{2,}(?:\\s+[A-Z]{2,})*\\s*(?:\\([^)]*\\)|:|,))`;
const TITLE=new RegExp("^"+TITLE_SRC);
const titleStarts=(d:string)=>[...d.matchAll(new RegExp("(^|\\s)"+TITLE_SRC,"g"))].map(m=>m.index!+m[1].length);
// Where the description boxes are not drawn to scale (thin layers pushing the text down, with leader lines to the true
// depths), the order of the titles still gives each layer its own: as many titles as layers, the k-th title and the
// lines after it describe the k-th layer. Otherwise a title left at the end of a layer (its text set a little high)
// moves to the next layer when that starts without one, and an empty layer (a thin one whose text sits below its base)
// takes the first of two titles.
function fixTitles(layers:ReadLayer[]){
  const text=layers.map(l=>l.description).join(" ").replace(/\s+/g," ").trim(),starts=titleStarts(text);
  if(starts.length>=2&&starts.length===layers.length){
    starts.forEach((s,k)=>{layers[k].description=text.slice(k?s:0,starts[k+1]??text.length).trim()});
    return;
  }
  for(let k=0;k<layers.length-1;k++){
    const d=layers[k].description,next=layers[k+1].description,s=titleStarts(d).at(-1);
    if(s!==undefined&&s>0&&d.slice(s).split(/\s+/).length<=6&&!TITLE.test(next)){layers[k].description=d.slice(0,s).trim();layers[k+1].description=(d.slice(s)+" "+next).trim()}
  }
  for(let k=0;k<layers.length-1;k++){
    if(layers[k].description)continue;
    const d=layers[k+1].description,s=titleStarts(d);
    if(s.length>=2){layers[k].description=d.slice(0,s[1]).trim();layers[k+1].description=d.slice(s[1]).trim()}
  }
}

// Thin layers at the top of a log given by their thicknesses ("50mm ASPHALT", "200mm AGGREGATE", "100mm
// TOPSOIL", "TOP SOIL (100 mm)", "GRANULAR BASE (250mm):"): logs often write only the depth below them, or none. Their
// depths are the running sum of the thicknesses. Where the sum fills the first interval to within 6 cm (depths are often
// written to 0.1 m), the written depth wins for the last of them; where it ends above it, the rest of the interval is a
// layer of its own. Returns the depths made so, to be flagged.
const THICK=new RegExp(`^\\s*(?:(\\d+(?:[.,]\\d+)?)\\s?mm\\s+${UPPER_WORDS}|[A-Z]{2,}(?:\\s+[A-Z]{2,})*\\s*\\(\\s*(\\d+(?:[.,]\\d+)?)\\s*mm\\s*\\)\\s*:?)`);
function thinStack(layers:ReadLayer[]):number[]{
  const first=layers[0];
  if(!first||first.from!==0)return [];
  let rest=layers.map(l=>l.description).join(" ").replace(/\s+/g," ").trim();
  const thin:Array<{to:number;description:string}>=[];let depth=0;
  for(let m;(m=THICK.exec(rest));){
    const t=+(m[1]??m[2]).replace(",",".")/1000;
    if(!(t>0&&t<2))break;
    depth+=t;thin.push({to:+depth.toFixed(3),description:m[0].trim().replace(/:$/,"")});
    rest=rest.slice(m[0].length).trim();
  }
  if(!thin.length||depth>first.to+0.06)return [];
  const fills=Math.abs(depth-first.to)<=0.06;
  if(fills)thin[thin.length-1].to=first.to;
  // The titles leave the descriptions they were read into.
  for(const t of thin)for(const l of layers){const i=l.description.indexOf(t.description);
    if(i>=0){l.description=(l.description.slice(0,i)+l.description.slice(i+t.description.length)).replace(/^[\s:]+/,"").replace(/\s+/g," ").trim();break}}
  const made:ReadLayer[]=thin.map((t,k)=>({from:k?thin[k-1].to:0,to:t.to,description:t.description,src:[]}));
  // What else the first interval held: the rest of the last thin layer's text ("GRANULAR BASE (250mm): gravelly
  // sand…"), unless it starts a title of its own, which begins the next layer.
  if(!fills)made.push({from:thin[thin.length-1].to,to:first.to,description:first.description,src:[]});
  else if(first.description&&layers[1]&&TITLE.test(first.description))layers[1].description=(first.description+" "+layers[1].description).trim();
  else if(first.description)made[made.length-1].description+=": "+first.description;
  for(const l of made.slice(0,thin.length))THIN_MADE.add(l);
  layers.splice(0,1,...made);
  return made.map(l=>l.to).filter(v=>v!==first.to);
}
const THIN="from the thicknesses written in the descriptions";
// The layers made from thicknesses. Where the rest of the first interval is still empty once the titles are dealt (see
// fixTitles), nothing else is described there: the last thin layer reaches the boundary written below it, flagged, as
// the log draws its base there though its thickness says less.
const THIN_MADE=new WeakSet<ReadLayer>();
function absorbRest(layers:ReadLayer[]){
  for(let k=1;k<layers.length;k++){
    const above=layers[k-1],rest=layers[k];
    if(!THIN_MADE.has(above)||rest.description.trim()||THIN_MADE.has(rest))continue;
    above.flagged=true;above.why=`its thickness as written ends at ${above.to} m; the boundary below it is written at ${rest.to} m`;
    above.to=rest.to;layers.splice(k,1);k--;
  }
}

// Each layer's evidence: the depth written at its base and the lines whose text is in its description, taken from the
// lines at the layer's depths (`depth` of a line, where known), so two layers with the same description keep their own;
// from any line with its text where the titles moved the text from elsewhere.
function attach(layers:ReadLayer[],lines:TextLine[],labels:TextLine[],depth:(e:TextLine)=>number|undefined=()=>undefined){
  const free=new Set(lines);
  for(const l of layers){
    const label=labels.find(e=>Math.abs(num(e.text)-l.to)<0.005);
    const words=l.description.toLowerCase(),margin=0.1+0.1*(l.to-l.from);
    const has=(e:TextLine)=>{const t=clean(kanji(e.text)).toLowerCase();return t.length>1&&words.includes(t)};
    const near=(e:TextLine)=>{const d=depth(e);return d===undefined||(d>=l.from-margin&&d<=l.to+margin)};
    let src=[...free].filter(e=>has(e)&&near(e));
    if(!src.length)src=[...free].filter(has);
    src.forEach(e=>free.delete(e));
    l.src=[...(label?[label]:[]),...src];
  }
}

// ---------- logs that describe their samples ----------

// Logs that describe each sample rather than each layer: every description starts with its sample's depths ("(1.5-1.95
// m) Brown clayey SAND, medium dense…"), a repeated material is written "- same materials -", and no boundary
// depths are written beside the log. A sample line is one whose depths sit at its place on the depth scale. The lines
// below it, to the next sample, a note ("Note: …") or the end of the log ("End of Borehole @ 9.45 m."), complete its
// description; a word broken over two lines ("fine-" / "grained") is joined again. Left out: a recovery note ("(Rec:
// 38/45 cm.)"), which is about the sample, not the ground; and marks and sample markers (lines of fewer than two
// letters). A sample that brought up nothing ("No Recovery", "No Penetration", a test refused at one depth: "(6.0-6.0
// m)") describes no ground. A driller's note of the depth where the ground changes ("Approx. change of stratum at
// 4.60 m.", "Bedrock at 12.20 m.") is kept with its depth (see sampleLayers).
export interface Sample { from:number; to:number; description:string; same:boolean; empty?:boolean; src:TextLine[]; changes?:Array<{depth:number;note:string}> }
// A sample marker drawn just left of the descriptions with a symbol font can be read into the line ("x (1.5-1.95 m)").
const SAMPLE=/^(?:[^\s\d(]{1,2}\s+)?\(?\s*(\d+(?:[.,]\d+)?)\s*(?:-|–|—|~|to)\s*(\d+(?:[.,]\d+)?)\s*(m\b\.?)?\s*\)?\s*[:.,]?\s*/i;
const SAME=/^[\s\-–—]*(?:same\s+(?:materials?|soil|as\s+(?:above|before|previous))|ditto|do\.)[\s\-–—]*[,;:.]?\s*/i;
const EMPTY=/^(?:no (?:recovery|penetration|sample)|refusal|core loss|lost core)\b/i;
// The note's brackets may be read apart from it ("Rec: 38/45 cm.)").
const RECOVERY=/\(?\s*\brec(?:overy)?\.?\s*[:=]\s*[\d\s.,/%-]*(?:cm|mm|m)?\.?\s*\)?/gi;
const LOG_END=/^(?:end of (?:bore ?hole|boring|hole|log)|bottom of (?:bore ?hole|hole)|termination of (?:bore ?hole|hole)|e\.?\s*o\.?\s*h\.?\b|(?:bore ?hole|hole|bh)\s+(?:completed|terminated|discontinued|abandoned)\b)/i;
const NOTE=/^(?:notes?|remarks?|legend)\s*:/i;
const CHANGE=/(?:approx(?:imate(?:ly)?|\.)?\s+)?(?:change (?:of |in )?(?:formation|stratum|strata|layer|material|soil)|(?:formation|stratum|layer) change|(?:encountered |top of )?bed ?rock|top of rock)\s*(?:@|at)\s*(\d+(?:[.,]\d+)?)\s*m\b\.?/gi;
const tidy=(t:string)=>t.replace(/\s+/g," ").replace(/\s+([.,;])/g,"$1").replace(/^[\s;,]+|[\s;,]+$/g,"").replace(/;\s*;/g,";");
function readSamples(lines:TextLine[],scale:DepthScale,latin:boolean):Sample[]{
  const out:Sample[]=[];let cur:Sample|undefined;
  for(const e of lines){
    const t=clean(kanji(e.text),latin);
    if(!t)continue;
    if(LOG_END.test(t))break;
    if(NOTE.test(t)){cur=undefined;continue}
    const m=SAMPLE.exec(t),from=m?num(m[1]):NaN,to=m?num(m[2]):NaN;
    // A bracket or a unit says these are depths, and their place on the scale says they are this log's.
    if(m&&(m[0].includes("(")||m[3])&&from>=0&&to>=from&&Math.abs(scale.depthAt(e.cy)-from)<1.5){
      cur={from,to,description:t.slice(m[0].length),same:false,src:[e]};out.push(cur);continue;
    }
    if(!cur||letters(t)<2)continue;
    const broken=/\p{L}-$/u.test(cur.description)&&/^\p{Ll}/u.test(t)&&!/^(?:to|and|or)\b/.test(t);
    cur.description=broken?cur.description+t:(cur.description+" "+t).trim();cur.src.push(e);
  }
  for(const x of out){
    x.description=tidy(x.description.replace(RECOVERY," "));
    const changes=[...x.description.matchAll(CHANGE)].map(m=>({depth:num(m[1]),note:m[0].trim()})).filter(c=>Number.isFinite(c.depth));
    if(changes.length)x.changes=changes;
    const m=SAME.exec(x.description);
    if(m){x.same=true;x.description=x.description.slice(m[0].length).trim()}
    if(x.to===x.from||EMPTY.test(x.description))x.empty=true;
  }
  return out;
}
// Layers from the samples that describe the ground, in depth order: a sample with a description of its own starts a
// layer at its top; one that is "the same" continues the layer above, adding any remark ("but with shell fragments"),
// and so does one described in the same words as the layer's first sample. Where the samples leave a gap (between test
// depths, or over a run that brought up nothing), the change lies somewhere in it: the boundary is put where the log
// notes the change in that gap ("change of stratum at 4.60 m"), else at the top of the sample with the new
// description; either way it is flagged. Continuous samples (core runs) give their boundaries outright. A note at a
// boundary leaves the descriptions: its depth is the boundary. The last layer reaches the final depth where it is given
// (the last sheet of a log); the log starts at its first sample, as nothing above it is described.
function sampleLayers(samples:Sample[],final?:number):{layers:ReadLayer[];flagged:number[]}{
  const sorted=samples.filter(x=>!x.empty).sort((p,q)=>p.from-q.from||p.to-q.to).filter((x,i,a)=>!i||x.from!==a[i-1].from||x.to!==a[i-1].to);
  const changes=sorted.flatMap(x=>x.changes??[]);
  const layers:ReadLayer[]=[],flagged:number[]=[],first:string[]=[];
  const words=(t:string)=>t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
  let reached=-Infinity;
  for(const x of sorted){
    const last=layers[layers.length-1];
    if(last&&(x.same||words(x.description)===first[first.length-1])){
      if(x.same&&x.description)last.description=`${last.description.replace(/[\s.,;]+$/,"")}; ${x.description}`;
      last.src.push(...x.src);
    }else{
      let from=x.from;
      if(last){
        if(x.from-reached>0.05){
          const noted=changes.find(c=>c.depth>=reached-0.005&&c.depth<=x.from+0.005);
          if(noted)from=noted.depth;
          last.flagged=true;last.gap=[+reached.toFixed(3),x.from];
          last.why=noted?`the log notes “${noted.note}”; the samples end at ${+reached.toFixed(3)} m and start again at ${x.from} m`
            :`the change lies between the samples ending at ${+reached.toFixed(3)} m and starting at ${x.from} m; placed where the new description starts`;
          flagged.push(from);
        }
        last.to=from;
      }
      layers.push({from,to:x.to,description:x.description,src:[...x.src]});first.push(words(x.description));
    }
    reached=Math.max(reached,x.to);
  }
  const last=layers[layers.length-1];
  if(last)last.to=final!==undefined&&final>=reached-0.005?final:reached;
  const bounds=layers.slice(0,-1).map(l=>l.to);
  for(const c of changes)if(bounds.some(b=>Math.abs(b-c.depth)<0.005))for(const l of layers)l.description=tidy(l.description.replace(c.note," "));
  return {layers,flagged};
}

// ---------- a drawn log ----------

// A log is titled ("LOG OF BOREHOLE BH3", "BORE / DRILL LOG", ボーリング柱状図) or has a heading over its descriptions
// ("SOIL DESCRIPTION", "Description of Strata", 土質区分). Headings and titles are short (a Japanese title's subtitle in
// brackets aside: "土質ボーリング柱状図(標準貫入試験)"): a sentence of a report that
// mentions a borehole log or a description is neither, and nor is a numbered heading of a report ("2 Site
// description"). The columns of tables of results (the number of a stratum, the strata a well is screened in) are no
// description headings.
const HEADING=/descri|soil profile|stratigraph|litholog|omschrijving|beschrijving|beschreibung|土質|記事|地層/i;
const short=(t:string,words:number)=>!/^\s*\d+(?:\.\d+)*\.?\s/.test(t)&&
  (/[぀-ヿ一-鿿]/.test(t)?t.replace(/[(（][^)）]*[)）]/g,"").trim().length<=12:t.trim().split(/\s+/).length<=words&&t.trim().length<=60);
const titled=(els:TextLine[])=>els.some(e=>LOG_TITLE.test(e.text)&&short(e.text,8));
export const logEvidence=(els:TextLine[])=>titled(els)||els.some(e=>HEADING.test(e.text)&&short(e.text,5));

// The last sheet of a log may hold only its end, too short a stretch for a depth scale ("SILTY CLAY: firm, grey,
// with sand seams (Continued)" over "8.30 END OF BOREHOLE"): its text under the description heading, down to the
// end of the log and without the "Continued" marks, is the end of the log on the sheet before (see joinPages).
const CONTINUED=/\(?\bcontinued(?: (?:from|on) (?:the )?(?:previous|last|next) (?:page|sheet))?\)?/gi;
function closingText(els:TextLine[]):{description:string;src:TextLine[]}|undefined{
  const end=els.filter(e=>LOG_END.test(e.text.trim())).sort((p,q)=>p.cy-q.cy)[0];
  const head=end&&els.filter(e=>HEADING.test(e.text)&&short(e.text,5)&&e.cy<end.cy).sort((p,q)=>q.cy-p.cy)[0];
  if(!head)return undefined;
  const text=els.filter(e=>e.cy>head.y1&&e.cy<end.y0&&!Number.isFinite(num(e.text))&&letters(e.text.replace(CONTINUED," "))>=2);
  const col=columns(text).find(c=>c.x0<head.x1&&c.x1>head.x0);
  const src=[...(col?.els??[])].sort((p,q)=>p.cy-q.cy);
  const description=src.map(e=>clean(kanji(e.text.replace(CONTINUED," ")))).join(" ").replace(/\s+/g," ").trim();
  return description?{description,src}:undefined;
}

// ---------- rock core logs ----------

// A rock core log ("ROCK CORE LOG 214") gives the runs cored in the rock: each run's depths, its recovery (TCR, SCR) and
// RQD, the make-up of the run ("Run 1: 60% sandstone 40% mudstone") and notes on its fractures ("5.2/ 46.8m: 40mm
// broken zone"). A run is a measurement over a drilled length, not a stratum: the runs are kept as records beside
// the borehole's layers, and the rock the sheet describes is kept with them as written (see readDocument).
export interface CoreRun { run:string; from?:number; to?:number; tcr?:number; scr?:number; rqd?:number; notes:string[]; src:TextLine[] }
export interface CoreSheet { runs:CoreRun[]; text:string; src:TextLine[] }
// The title is the whole line, perhaps with the borehole's ID: "(see Rock / Core Log 12) below 3.5m", a sentence
// wrapped on a log, is none.
const CORE_TITLE=/^(?:rock\s+)?(?:core|coring)\s+(?:log|record)(?:\s+(?:no\.?\s*)?[A-Za-z]{0,6}[-\s]?\d[\w./-]{0,12})?$/i;
const RUN_LABEL=/^(?:R|Run)\s*#?\s*(\d{1,3})$/i,RUN_MAKEUP=/^Run\s*#?\s*(\d{1,3})\s*:/i;
const RECOVERED=/\b(TCR|SCR|RQD)\s*[=:]\s*(\d{1,3}(?:[.,]\d)?)\s*%/i;
const FRACTURE=/^(\d+(?:[.,]\d+)?)\s*\/\s*\d+(?:[.,]\d+)?\s*m?\s*(?:-\s*\d+(?:[.,]\d+)?\s*\/\s*\d+(?:[.,]\d+)?\s*m?\s*)?:/;
export const coreTitled=(els:TextLine[])=>els.some(e=>CORE_TITLE.test(e.text.trim()));
function readCore(els:TextLine[],scale:DepthScale):CoreSheet{
  const h=els.map(e=>e.y1-e.y0).sort((a,b)=>a-b)[els.length>>1]||12;
  // The runs: labels "R1", "R2" in one column (under the "Run" heading where there is one: strength grades R0–R6
  // elsewhere on the sheet are no runs), between the depths of the runs' ends in the column beside them.
  const heading=els.find(e=>/^run(?:\s*(?:no\.?|#))?$/i.test(e.text.trim()));
  let labels=els.filter(e=>RUN_LABEL.test(e.text.trim()));
  if(heading)labels=labels.filter(e=>Math.abs(e.cx-heading.cx)<3*Math.max(heading.x1-heading.x0,h));
  else{const col=columns(labels).sort((p,q)=>q.els.length-p.els.length)[0];labels=col?col.els:[]}
  labels.sort((p,q)=>p.cy-q.cy);
  const cx=labels.length?labels.reduce((t,e)=>t+e.cx,0)/labels.length:NaN;
  const ends=els.filter(e=>isDecimal(e)&&Math.abs(scale.depthAt(e.cy)-num(e.text))<0.6&&(!labels.length||Math.abs(e.cx-cx)<6*h)).sort((p,q)=>p.cy-q.cy);
  const runs:CoreRun[]=labels.map(e=>{
    const above=ends.filter(d=>d.cy<e.cy).at(-1),below=ends.find(d=>d.cy>e.cy);
    return {run:`R${RUN_LABEL.exec(e.text.trim())![1]}`,...(above?{from:num(above.text)}:{}),...(below?{to:num(below.text)}:{}),notes:[],src:[e,...(above?[above]:[]),...(below?[below]:[])]};
  });
  // Recovery and RQD go to the nearest run label; fracture notes and a run's make-up to the run they name or lie in.
  const nearest=(y:number)=>{let k=-1,d=Infinity;labels.forEach((e,i)=>{const v=Math.abs(e.cy-y);if(v<d){d=v;k=i}});return k};
  for(const e of els){
    const m=RECOVERED.exec(e.text);
    if(m){const k=nearest(e.cy);if(k>=0){runs[k][m[1].toLowerCase() as "tcr"|"scr"|"rqd"]=num(m[2]);runs[k].src.push(e)}}
  }
  const used=new Set<TextLine>();
  for(const e of els.filter(e=>FRACTURE.test(e.text.trim())).sort((p,q)=>p.cy-q.cy)){
    const d=num(FRACTURE.exec(e.text.trim())![1]),r=runs.find(r=>r.from!==undefined&&r.to!==undefined&&d>=r.from-0.005&&d<r.to);
    if(!r)continue;
    // A note may wrap: a short line just below it, in its column, is the rest of it.
    const rest=els.filter(c=>c!==e&&!FRACTURE.test(c.text.trim())&&Math.abs(c.x0-e.x0)<h&&c.cy>e.cy&&c.cy-e.cy<1.6*h);
    r.notes.push([e,...rest].map(c=>c.text.trim()).join(" "));r.src.push(e,...rest);used.add(e);rest.forEach(c=>used.add(c));
  }
  const makeups=els.filter(e=>RUN_MAKEUP.test(e.text.trim()));
  for(const e of makeups){
    const n=RUN_MAKEUP.exec(e.text.trim())![1],r=runs.find(r=>r.run===`R${n}`);
    const parts=els.filter(c=>c!==e&&c.x0>=e.x1-2&&c.x0-e.x1<4*h&&c.cy>e.cy-0.6*h&&c.cy<e.cy+1.8*h).sort((p,q)=>p.cy-q.cy||p.x0-q.x0);
    const text=[e.text.replace(RUN_MAKEUP,"").trim(),...parts.map(c=>c.text.trim())].filter(Boolean).join(" ");
    used.add(e);parts.forEach(c=>used.add(c));
    if(r){r.notes.unshift(`Run ${n}: ${text}`);r.src.push(e,...parts)}
  }
  // The rock as the sheet describes it: its description column, under its heading, without the runs' make-up.
  const head=els.filter(e=>HEADING.test(e.text)&&short(e.text,5)).sort((p,q)=>p.cy-q.cy)[0];
  const body=els.filter(e=>!used.has(e)&&!Number.isFinite(num(e.text))&&letters(e.text)>=2&&(!head||e.cy>head.y1)&&scale.depthAt(e.cy)>=0);
  const col=head?columns(body).find(c=>c.x0<head.x1&&c.x1>head.x0):undefined;
  const src=[...(col?.els??[])].sort((p,q)=>p.cy-q.cy);
  return {runs,text:src.map(e=>clean(e.text)).join(" ").replace(/\s+/g," ").trim(),src};
}

// ---------- penetration tests ----------

// Tests from a column of their depths, where each test's start and end are printed (1.15 over 1.45; 4.00 over 4.05 for
// a test stopped short; 1.15 over 1.58 for one that sank under its own weight). The blows are the largest count in the
// test's row beside the depths (the counts per 10 cm, the total, the N value), leaving out the lower number of a
// fraction (blows over penetration). The penetration is the distance between the two depths. A test stopped short at
// 50 blows may print its N value scaled to 30 cm (50 blows over 25 cm: 60): such a count is 50 blows.
function testsByDepths(els:TextLine[],depths:TextLine[],width:number):SptTest[]{
  if(depths.length<2)return [];
  const h=median(els.map(e=>e.y1-e.y0))||12,x0=Math.min(...depths.map(e=>e.x0)),x1=Math.max(...depths.map(e=>e.x1));
  const counts=els.filter(e=>/^>?\s?\d{1,3}$/.test(e.text.trim())&&!depths.includes(e)&&e.cx>x0-0.08*width&&e.cx<x1+0.2*width);
  const ds=[...depths].sort((p,q)=>p.cy-q.cy),out:SptTest[]=[];
  for(let i=0;i+1<ds.length;i++){
    const a=num(ds[i].text),b=num(ds[i+1].text),next=i+2<ds.length?num(ds[i+2].text):Infinity;
    // A test stopped with no penetration prints one depth twice ("13.00" over "13.00"); one that sank under the rods'
    // weight may go further than 0.6 m, where the depth after it is no test's end.
    if(!(b>=a&&(b-a<=0.6+1e-6||b-a<=1+1e-6&&next-b>0.6)))continue;
    const row=counts.filter(e=>e.cy>=ds[i].cy-0.6*h&&e.cy<=ds[i+1].cy+0.6*h);
    const upper=row.filter(e=>!row.some(o=>o!==e&&Math.abs(o.cx-e.cx)<Math.max(e.x1-e.x0,o.x1-o.x0)&&e.cy-o.cy>0.3*h&&e.cy-o.cy<1.8*h));
    const value=(e:TextLine)=>+e.text.replace(/\D/g,""),pen=Math.round((b-a)*1000)/10;
    // A complete test: its blows are the sum of its counts per 10 cm, which make the test's first row (the rows below
    // give the distances driven, or the N value plotted): the number that is their sum (printed after them, or apart
    // as the N value), else the sum itself; a first row of one number is the total. No more than 100. A test stopped
    // short: its largest count (50, or its N scaled).
    let top:TextLine|undefined,m=NaN,src:TextLine[]=[];
    // (50 blows over p cm print N up to 1500/p: a larger number in the row is another column's, such as the distance.)
    if(pen<29.5){top=upper.filter(e=>value(e)<=Math.max(50,1.05*1500/Math.max(pen,1))).sort((p,q)=>value(q)-value(p))[0];if(top){m=value(top);src=[top]}}
    else{
      const fit=upper.filter(e=>value(e)<=100).sort((p,q)=>p.cy-q.cy),first=fit.length?fit.filter(o=>Math.abs(o.cy-fit[0].cy)<0.4*h):[];
      first.sort((p,q)=>p.cx-q.cx);
      const vals=first.map(value),sum=vals.reduce((t,v)=>t+v,0),last=first[first.length-1];
      // Three counts at an even spacing are the counts per 10 cm, with no total among them.
      const even=first.length===3&&Math.abs((first[1].cx-first[0].cx)-(first[2].cx-first[1].cx))<0.25*(first[2].cx-first[0].cx);
      const own=first.find(e=>2*value(e)===sum&&first.length>1),apart=first.length>1?fit.find(e=>!first.includes(e)&&value(e)===sum):undefined;
      if(first.length===1){m=vals[0];src=first}
      else if(own){m=value(own);src=[own]}
      else if(apart){m=sum;src=[apart]}
      else if(even&&vals.every(v=>v<=50)){m=sum;src=first}
      // Else the total is printed last, after a count left blank (none counted in that 10 cm).
      else if(last&&value(last)>=Math.max(...vals)){m=value(last);src=[last]}
    }
    i++;
    if(!Number.isFinite(m))continue;
    const blows=pen<29.5&&m>50&&Math.abs(m-1500/pen)<=Math.max(2,0.03*m)?50:m;
    out.push({depth:a,blows,penetration:pen,src:[ds[i-1],ds[i],...src]});
  }
  return out;
}
// Tests in a column of blow counts under its heading ("Blow Count (blows/ft)", "SPT N", "N-value"), each at the depth
// the scale gives its place: "12" is a complete test; "50/5\"" 50 blows over 5 inches (or cm, on a metric log); "50+"
// stopped short, its penetration not given; "3/18\"" 3 blows over 18 inches, sunk under the rods' weight.
function testsByColumn(els:TextLine[],scale:DepthScale):SptTest[]{
  const heading=/^(?:blow$|\(\s*blows?\s*\/\s*(?:ft|foot|0\.3\s*m)\s*\)$|(?:blow\s*count|blows|spt(?:\s*n)?|n[- ]?value)\b)/i;
  const head=els.find(e=>heading.test(e.text.trim())&&e.text.trim().length<=30);
  if(!head)return [];
  const w=Math.max(head.x1-head.x0,head.y1-head.y0),cx=head.cx;
  const feet=els.some(e=>Math.abs(e.cx-cx)<0.8*w&&/\bblows?\s*\/\s*(?:ft|foot)\b/i.test(e.text));
  const VALUE=/^(\d{1,3})(?:\s*(\+)|\s*\/\s*(\d{1,2}(?:\.\d)?)\s*("|”|''|in\.?|cm)?)?$/i;
  const out:SptTest[]=[];
  for(const e of els.filter(e=>e.cy>head.y1&&Math.abs(e.cx-cx)<0.8*w&&VALUE.test(e.text.trim())).sort((p,q)=>p.cy-q.cy)){
    const m=VALUE.exec(e.text.trim())!,d=scale.depthAt(e.cy);
    if(d<0)continue;
    const inches=m[4]?m[4].toLowerCase()!=="cm":feet;
    const full=feet?30.48:30,pen=m[3]!==undefined?+m[3]*(inches?2.54:1):m[2]?undefined:full;
    out.push({depth:+d.toFixed(2),blows:+m[1],...(pen!==undefined?{penetration:+pen.toFixed(1)}:{}),src:[e]});
  }
  return out.length>=2?out:[];
}

// `continuing`: the sheet follows a log on the sheet before, so it needs no title or headings of its own (a log's
// second sheet may carry its body only).
// Words set one character to a line, read down: stacked single kanji or kana close under one another.
function stacked(els:TextLine[]){
  const singles=els.filter(e=>/^[぀-ヿ㐀-鿿]$/.test(e.text.trim())).sort((p,q)=>p.cy-q.cy),words:TextLine[][]=[];
  for(const e of singles){
    const h=e.y1-e.y0,w=words.find(w=>{const l=w[w.length-1];return Math.abs(l.cx-e.cx)<0.5*h&&e.cy-l.cy>0&&e.cy-l.cy<1.8*h});
    if(w)w.push(e);else words.push([e]);
  }
  return words.map(w=>({text:w.map(e=>e.text.trim()).join(""),x0:Math.min(...w.map(e=>e.x0)),x1:Math.max(...w.map(e=>e.x1)),y1:w[w.length-1].y1}));
}
// A log may give its boundaries as reduced levels only: a column headed "R.L. (m)" (or "RL", "Elevation") with 5.25,
// 3.40… at the boundaries, beside a depth scale with no depth written, and the ground's level in the header ("SURFACE
// RL 5.40m"). Each level is the boundary at ground − level, where that agrees with its place on the scale (a level is
// written on or just above its line); most of the column must agree.
const LEVEL_HEAD=/^(?:r\.?\s?l\.?|reduced\s+levels?|elev(?:ation)?\.?)(?:\s*\(\s*m(?:\s*(?:AHD|asl|msl|OD))?\s*\))?$/i;
function levelBounds(els:TextLine[],scale:DepthScale,ground:number){
  for(const hd of els.filter(e=>LEVEL_HEAD.test(e.text.trim()))){
    const w=Math.max(hd.x1-hd.x0,hd.y1-hd.y0);
    const col=els.filter(e=>e.cy>hd.y1&&isDecimal(e)&&e.x1>hd.x0-w&&e.x0<hd.x1+w);
    const fit=col.map(e=>({e,d:+(ground-num(e.text)).toFixed(2)})).filter(x=>x.d>0&&Math.abs(scale.depthAt(x.e.cy)-x.d)<0.3);
    if(fit.length&&fit.length>=0.7*col.length)return fit;
  }
  return [];
}
// Tests written as their counts over their N value ("7, 9, 7" over "N=16"; "hw, hw, hw" over "N<1", where the sampler
// sank under the hammer's weight and no blow was counted), at the depth of the counts on the scale.
const N_VALUE=/^N\s*(?:=\s*(\d{1,3})|<\s*1)$/i,N_COUNTS=/^(?:(?:\d{1,3}|hw|hb|sw)\s*,\s*){1,3}(?:\d{1,3}|hw|hb|sw)$/i;
function testsByNValue(els:TextLine[],scale:DepthScale):SptTest[]{
  const out:SptTest[]=[];
  for(const e of els.filter(e=>N_VALUE.test(e.text.trim()))){
    const h=Math.max(e.y1-e.y0,1),c=els.find(k=>N_COUNTS.test(k.text.trim())&&e.cy-k.cy>0.3*h&&e.cy-k.cy<2.5*h&&Math.abs(k.cx-e.cx)<4*h);
    if(!c)continue;
    const m=N_VALUE.exec(e.text.trim())!,d=scale.depthAt(c.cy);
    if(d>=0)out.push({depth:+d.toFixed(2),blows:m[1]===undefined?0:+m[1],penetration:30,src:[c,e]});
  }
  return out;
}
function waterColumn(els:TextLine[],scale:DepthScale){
  const heads=[...els.filter(e=>/孔内水位|地下水位/.test(e.text.replace(/\s/g,""))).map(e=>({x0:e.x0,x1:e.x1,y1:e.y1})),...stacked(els).filter(w=>/孔内水位|地下水位|水位/.test(w.text))];
  const dates=els.filter(e=>/^(?:0?[1-9]|1[0-2])\s*(?:\/\s*(?:0?[1-9]|[12]\d|3[01])|月\s*(?:0?[1-9]|[12]\d|3[01])日)$/.test(e.text.trim()));
  for(const hd of heads){
    // The JACIC form prints the measuring date and its depth together in the water column.
    // SPT start and end depths in the next column agree just as well with the depth scale.
    const inColumn=(e:TextLine)=>e.cy>hd.y1&&e.x1>hd.x0&&e.x0<hd.x1;
    const columnDates=dates.filter(inColumn);
    const readings=els.filter(e=>inColumn(e)&&/^\d{1,2}[.,]\d{1,2}$/.test(e.text.trim())&&Math.abs(scale.depthAt(e.cy)-num(e.text))<0.6&&
      columnDates.some(d=>Math.abs(d.cy-e.cy)<=2*Math.max(d.y1-d.y0,e.y1-e.y0)&&d.x0<=e.cx&&e.cx<=d.x1));
    if(readings.length)return readings.sort((p,q)=>p.cy-q.cy)[0];
  }
  return undefined;
}

export function rebuild(els:TextLine[],width:number,height=Infinity,rules:Rule[]=[],continuing=false):PageLog{
  const title=titled(els),scale=depthScale(els,width)??(title?pairScale(els,width):null),head=header(els),evidence=logEvidence(els)||continuing;
  const empty=(error:string,looks:boolean):PageLog=>({...head,kind:"scale",layers:[],used:new Set(),flagged:[],bounds:[],texts:[],error,evidence:looks});
  if(!scale){const closing=evidence?closingText(els):undefined;return {...empty("no depth scale found",evidence),...(closing?{closing}:{})}}
  // A geological section through the holes has an elevation scale and soil names too: titled so, it is no log.
  // (A log title under the section's own, such as the label of a log drawn in it, does not make it a log.)
  const section=els.find(e=>/断面図|cross[- ]?section|geological section|longitudinal section|geologic(?:al)? profile/i.test(e.text)&&short(e.text,6));
  if(section&&!els.some(e=>LOG_TITLE.test(e.text)&&short(e.text,8)&&e.cy<section.cy))return empty("a geological section, not a log",false);
  // Numbers in a report's text or in a table of results can pass for a depth scale; a log page says it is one. Without
  // a title, its scale must be one too: four or more whole-metre labels (or ticks) down a fair part of the page, where
  // numbered headings of a report ("1.0", "1.1", "2.0") or a few rows of a table would otherwise do.
  if(!evidence)return empty("no log title or description heading",false);
  const ys=scale.labels.map(e=>e.cy),tall=Math.min(height,Math.max(...els.map(e=>e.y1))-Math.min(...els.map(e=>e.y0)));
  if(!title&&(scale.kind==="decimals"||ys.length<4||Math.max(...ys)-Math.min(...ys)<0.15*tall))return empty("no log title, and its numbers are no depth scale",false);
  // The water level in the borehole, on a Japanese form: a depth in the column headed 孔内水位 (its heading set one
  // character to a line), written where the water stood on the scale, beside the date it was measured.
  if(head.water===undefined){
    const w=waterColumn(els,scale);
    if(w){head.water=num(w.text);head.src={...head.src,water:w}}
  }
  const used=new Set(scale.labels);
  // Boundaries: the column of decimal numbers whose values agree with their positions on the scale (within 0.6 m).
  // Other columns of decimals (elevations, thicknesses) agree only by chance, so they lose to it.
  const agree=(e:TextLine)=>Math.abs(scale.depthAt(e.cy)-num(e.text))<0.6;
  // The depth written where the log ends ("12.40" at "END OF BOREHOLE", on its line or the line above, in the column of
  // depths that fit the scale) is the final depth where the header gives none.
  if(head.final===undefined){
    const end=els.filter(e=>LOG_END.test(e.text.trim())).sort((p,q)=>p.cy-q.cy)[0],h=end?Math.max(end.y1-end.y0,1):0;
    const at=end&&els.filter(e=>isDecimal(e)&&agree(e)&&e.cy<=end.cy+0.6*h&&end.cy-e.cy<=2.5*h).sort((p,q)=>Math.abs(end.cy-p.cy)-Math.abs(end.cy-q.cy))[0];
    if(at){head.final=num(at.text);head.src={...head.src,final:at}}
  }
  const core=coreTitled(els)?readCore(els,scale):undefined,extra={top:Math.max(0,+scale.depthAt(Math.min(...scale.labels.map(e=>e.cy))-0.5*scale.b).toFixed(2)),...(core?{core}:{})};
  // A column of test depths fits the scale too, often with more values than the boundaries: Standard Penetration Tests
  // print where each test started and ended ("1.15" over "1.45", "4.00" over "4.05" for a test stopped short), pair
  // after pair. A column where most values pair up so, at most 0.45 m apart, is no column of boundaries.
  // OCR misreads a few test depths ("1u", "0.45" for 8.45), so it is enough that most values have a partner. A log
  // with thin layers has close boundaries too: what tells the tests is the blows counted beside them, on the row of a
  // depth and to its right, which no boundary has.
  const rowH=median(els.map(e=>e.y1-e.y0))||12,counts=els.filter(e=>/^\d{1,3}$/.test(e.text.trim()));
  const testDepths=(c:Column)=>{
    const at=c.els.filter(agree),v=[...new Set(at.map(e=>num(e.text)))].sort((a,b)=>a-b);
    const paired=v.filter((x,i)=>(i>0&&x-v[i-1]<=0.45)||(i+1<v.length&&v[i+1]-x<=0.45)).length;
    if(paired<6||paired<0.6*v.length)return false;
    return at.filter(e=>counts.some(k=>k.x0>e.x1&&k.x0-e.x1<0.25*width&&Math.abs(k.cy-e.cy)<=1.5*rowH)).length>=0.5*at.length;
  };
  const dcols=columns(els.filter(isDecimal),rules);
  const tcol=dcols.filter(testDepths).sort((p,q)=>q.els.filter(agree).length-p.els.filter(agree).length)[0];
  // A column that repeats the tests' depths (where samples were taken, at each test) is no column of boundaries either.
  const tested=new Set((tcol?.els.filter(agree)??[]).map(e=>num(e.text).toFixed(2)));
  const repeats=(c:Column)=>{const v=c.els.filter(agree);return tested.size>0&&v.length>=4&&v.filter(e=>tested.has(num(e.text).toFixed(2))).length>=0.7*v.length};
  const bcol=dcols.filter(c=>!testDepths(c)&&!repeats(c)).sort((p,q)=>q.els.filter(agree).length-p.els.filter(agree).length)[0];
  // A column where most values do not fit their places (laboratory results, sample numbers) is no column of
  // boundaries: a value that fits by chance there ("2.68" beside 2.7 m) is no boundary either. Only values that could
  // be depths on the page count against it: an elevation printed under each depth ("48.25" over "1.20") is no misread
  // depth.
  const cys=els.map(e=>e.cy),top=scale.depthAt(Math.min(...cys))-0.6,base=scale.depthAt(Math.max(...cys))+0.6;
  const misfit=(e:TextLine)=>!agree(e)&&num(e.text)>=top&&num(e.text)<=base;
  const boundaries=!!bcol&&bcol.els.filter(agree).length>bcol.els.filter(misfit).length;
  const bels=boundaries?bcol.els.filter(agree):[];
  // No depths at the boundaries, but their reduced levels against the header's ground level (see levelBounds).
  const lev=bels.length<2&&head.ground!==undefined?levelBounds(els,scale,head.ground):[];
  // Descriptions: the log's text (not numbers, not the water mark) grouped into columns; the column with the most
  // letters is the description column (a hatched legend reads as "000" or "C C T"). The body starts below the column
  // headings ("DESCRIPTION", "土質区分"), which repeat on continued pages; without them, at the depth 0. The headings sit
  // above the scale's first label where any do: a line further down that names a description is a note under the log
  // ("* = field description").
  const japanese=els.some(e=>/[一-鿿]/.test(e.text));
  const offset=japanese?ruledDescriptionOffset(bels,rules,scale):0;
  const descriptionDepth=(y:number)=>scale.depthAt(y-offset);
  const descriptionY=(d:number)=>scale.yAt(d)+offset;
  const topY=Math.min(...scale.labels.map(e=>e.cy));
  const heads=els.filter(e=>/descri|soil profile|stratigraph|litholog|omschrijving|beschrijving|土質|記事|地層/i.test(e.text)&&e.cy<topY+0.5*scale.b);
  const above=heads.filter(e=>e.cy<topY),startY=heads.length?Math.max(...(above.length?above:heads).map(e=>e.y1)):descriptionY(0);
  // The body of the log stops at the line that ends the log ("Borehole completed at 8.00m"), and the notes under its
  // scale ("REMARKS: …", a line that runs under several columns and would join them) are no description. On a sheet
  // that carries a log on, the body starts a step of the scale above its first label (10 m on a sheet whose labels
  // start at 11): the smaller rows of the column headings above it ("REC %", "CASING") are no description either. (On a
  // first sheet the depth 0 is its top: OCR may miss the first labels of a scan.)
  const marks=scale.labels.map(e=>scale.depthAt(e.cy)).sort((a,b)=>a-b);
  const markStep=median(marks.slice(1).map((v,k)=>v-marks[k]).filter(g=>g>0.2))||1;
  const scaleEnd=marks[marks.length-1]+markStep,sheetTop=head.sheet&&head.sheet[0]>1?Math.max(0,marks[0]-markStep):0;
  const endLine=els.filter(e=>LOG_END.test(e.text.trim())&&e.cy>startY).sort((p,q)=>p.cy-q.cy)[0];
  const inBody=(e:TextLine)=>descriptionDepth(e.cy)>=sheetTop&&(!endLine||e.cy<endLine.y0)&&!(NOTE.test(e.text.trim())&&scale.depthAt(e.cy)>marks[marks.length-1]);
  // Text of fewer than two letters is no description (a page code "A2-17" under the log, which would join its columns,
  // or a mark), unless it is a Japanese name ("砂").
  // Japanese forms give each layer's soil name (土質区分: "礫混じり粘性土", "(C-G)") in a column of its own, beside the
  // remarks (記事), which have the most letters. The names are read too, and lead each layer's description; where the
  // names have more letters than the remarks (short remarks), the remarks are still the description column.
  // A soil's code in brackets on a line of its own ("(B)") is part of its name on a Japanese form.
  const describe=(bottom:number)=>{
    const body=els.filter(e=>!Number.isFinite(num(e.text))&&!/^GWL/i.test(e.text)&&(letters(e.text)>=2||/[぀-ヿ一-鿿]/.test(e.text)||japanese&&SOIL_CODE.test(e.text.trim()))&&
      e.cy>startY&&inBody(e)&&descriptionDepth(e.cy)<=bottom+0.5);
    const lettersOf=(c:Column)=>c.els.reduce((s,e)=>s+letters(e.text),0);
    const cols=columns(body,rules).sort((p,q)=>lettersOf(q)-lettersOf(p));
    let main:Column|undefined=cols[0],names:Column|undefined;
    // Under a "DESCRIPTION" heading, its column is the description column, even where another (test results) has
    // more letters: a sheet that carries a layer on may describe it in a line or two.
    const dh=japanese?undefined:heads.find(e=>/descri/i.test(e.text));
    const under=dh&&cols.filter(c=>c.x0<dh.x1&&c.x1>dh.x0).sort((p,q)=>lettersOf(q)-lettersOf(p))[0];
    if(under)main=under;
    if(main&&soilNames(main)){
      const remarks=cols.find(c=>c!==main&&!soilNames(c)&&median(c.els.map(e=>e.text.replace(/\s/g,"").length))>6&&lettersOf(c)>=0.25*lettersOf(main!));
      // No remarks column at all: the names are the descriptions.
      names=main;main=remarks;
    }else names=cols.filter(c=>c!==main&&soilNames(c)).sort((p,q)=>q.els.filter(e=>SOIL_NAME.test(e.text)).length-p.els.filter(e=>SOIL_NAME.test(e.text)).length)[0];
    // Whether the column is Latin text, judged on the whole column: a lone kanji in it is a misread symbol.
    const joined=(main?.els??[]).map(e=>e.text).join("");
    return {lines:[...(main?.els??[])].sort((p,q)=>p.cy-q.cy),latin:!!main&&(joined.match(/[A-Za-z]/g)??[]).length>0.5*letters(joined),
      names:[...(names?.els??[])].sort((p,q)=>p.cy-q.cy)};
  };
  // No boundary depths beside the log: the descriptions may give their samples' depths instead. A lone decimal that fits
  // its place beside such a log is a laboratory result ("Gs = 2.68" at 2.7 m), not a boundary, so the samples win where
  // they outnumber the boundaries. Only the last sheet of a log (or a log on one sheet) reaches its final depth; the
  // sheets of one log are joined by their samples.
  if(bels.length+lev.length<2){
    const {lines,latin}=describe(Infinity),samples=readSamples(lines,scale,latin);
    if(samples.filter(x=>!x.empty).length>bels.length){
      const last=!head.sheet||head.sheet[0]>=head.sheet[1],read=sampleLayers(samples,last?head.final:undefined);
      for(const x of samples)for(const e of x.src)used.add(e);
      const texts=samples.map(x=>({depth:x.from,text:x.description,src:x.src[0]}));
      return {...head,kind:"scale",layers:read.layers,used,flagged:read.flagged,texts,bounds:read.layers.map(l=>l.to),samples,evidence,...extra,top:samples[0].from};
    }
  }
  const labels=[...bels];
  bels.forEach(e=>used.add(e));
  const values=bels.map(e=>num(e.text)),flagged:number[]=[],why=new Map<number,string>();
  // A level printed at the bottom of a sheet the log carries on from ("-5.60" at 11.00 m on sheet 1 of 2) is where the
  // sheet ends, not a boundary.
  const carriesOn=!!head.sheet&&head.sheet[0]<head.sheet[1];
  for(const x of lev){
    if(carriesOn&&Math.abs(x.d-scaleEnd)<=0.05)continue;
    values.push(x.d);labels.push({...x.e,text:String(x.d)});used.add(x.e);
  }
  // No depths written at the boundaries: a log may draw them only, as lines across its descriptions (a scanned log in
  // feet with a depth scale every 2 ft). Each line that runs across most of the description column is a boundary, at
  // the depth the scale gives its place (to the nearest twentieth of a scale step), flagged.
  if(bels.length+lev.length<2&&rules.length){
    // Descriptions only: not the end of the log, nor a mark that the log carries on ("Continued on next sheet").
    const desc=describe(Infinity).lines.filter(e=>!LOG_END.test(e.text.trim())&&clean(e.text).length>0);
    if(desc.length>=2){
      const x0=Math.min(...desc.map(e=>e.x0)),x1=Math.max(...desc.map(e=>e.x1)),w=x1-x0,mid=(x0+x1)/2;
      const at=scale.labels.map(e=>scale.depthAt(e.cy)).sort((a,b)=>a-b),gaps=at.slice(1).map((v,k)=>v-at[k]).filter(g=>g>0.2);
      const step=Math.max(Math.round(median(gaps))||1,1)/20,last=at[at.length-1]+40*step;
      // A thick line scanned may be found as two, its edges: lines within 8 pixels are one, at their middle.
      const ys=rules.filter(r=>!isVertical(r)&&r.x0<=x0+0.25*w&&r.x1>=x1-0.25*w).map(r=>yAt(r,mid)).sort((a,b)=>a-b),groups:number[][]=[];
      for(const y of ys){const g=groups[groups.length-1];if(g&&y-g[g.length-1]<=8)g.push(y);else groups.push([y])}
      // Lines at an even spacing are a grid (a graph, a cross-hatching), not boundaries.
      const spacing=groups.slice(1).map((g,k)=>g[0]-groups[k][0]),even=median(spacing);
      const grid=groups.length>=6&&spacing.filter(d=>Math.abs(d-even)<=0.12*even).length>=0.7*spacing.length;
      // A line parts two layers where there are descriptions above and below it: the frame above the log, and the boxes
      // of the notes under it, part none. A line with descriptions only above it is the base of the log, unless it lies
      // below the scale or the final depth, or ends a sheet the log carries on from (the frame of that sheet).
      const drawn:number[]=[];
      for(const g of grid?[]:groups){
        const y=(g[0]+g[g.length-1])/2;
        if(!desc.some(e=>e.cy<y))continue;
        const v=+(Math.round(scale.depthAt(y)/step)*step).toFixed(3);
        if(!desc.some(e=>e.cy>y)&&(v>scaleEnd+0.05||carriesOn&&Math.abs(v-scaleEnd)<=0.05||head.final!==undefined&&v>head.final+0.05))continue;
        if(v>step&&v<=last&&!values.some(u=>Math.abs(u-v)<1.5*step)&&!drawn.some(u=>Math.abs(u-v)<1.5*step))drawn.push(v);
      }
      // Every layer the lines make must have a description of its own; if one would not, they are not its boundaries.
      const cuts=[...values,...drawn].sort((a,b)=>a-b),depths=desc.map(e=>scale.depthAt(e.cy));
      if(cuts.every((v,k)=>depths.some(d=>d>=(k?cuts[k-1]:-Infinity)&&d<v)))
        for(const v of drawn){values.push(v);flagged.push(v);why.set(v,"read from the line drawn across the descriptions, by its place on the depth scale")}
    }
  }
  // A label in that column that disagrees with its position: first the usual OCR digit confusions, then the depth its
  // position gives. Either way the boundary is flagged. Only where most of the column agrees: if most of it disagrees,
  // the scale is wrong, not a few readings.
  const disagree=boundaries?bcol.els.filter(e=>!agree(e)):[];
  for(const e of disagree.length<bels.length?disagree:[]){
    const at=scale.depthAt(e.cy);
    if(values.some(v=>Math.abs(v-at)<0.3))continue;
    const fix=variants(e.text).map(Number).filter(v=>Math.abs(v-at)<0.6).sort((p,q)=>Math.abs(p-at)-Math.abs(q-at))[0];
    const v=fix??Math.round(at*20)/20;
    values.push(v);flagged.push(v);used.add(e);labels.push({...e,text:String(v)});
    why.set(v,fix!==undefined?`read as “${e.text.trim()}”; taken as ${v}, which fits its place on the depth scale`
      :`read as “${e.text.trim()}”, which does not fit its place on the depth scale; ${v} m is the depth there`);
  }
  // A depth read without its decimal point ("137" for 13.7): a whole number in that column which, with the point put
  // back, is the depth at its position. Flagged too.
  if(boundaries)for(const e of els.filter(e=>/^\d{2,4}$/.test(e.text.trim())&&!scale.labels.includes(e)&&e.x0<bcol.x1&&e.x1>bcol.x0)){
    const at=scale.depthAt(e.cy),v=[num(e.text)/10,num(e.text)/100].find(v=>Math.abs(v-at)<0.3);
    if(v!==undefined&&!values.some(w=>Math.abs(w-v)<0.3)){
      values.push(v);flagged.push(v);used.add(e);labels.push({...e,text:String(v)});
      why.set(v,`read as “${e.text.trim()}”; the decimal point put back`);
    }
  }
  // A depth of 0 written beside the top of the log ("0.00") is its top, not a boundary.
  const bounds=[...new Set(values)].filter(v=>v>0).sort((p,q)=>p-q);
  const layers:ReadLayer[]=bounds.map((to,k)=>({from:k?bounds[k-1]:0,to,description:"",src:[]}));
  // Each line of the description column goes to the layer at the depth of its centre.
  const {lines,latin,names}=describe(bounds.at(-1)??Infinity);
  // A line that a boundary runs through is above or below it by a pixel or two, which says nothing. Where the
  // descriptions start with titles ("SILTY CLAY: firm…"), such a line is below the boundary if it is a title, and
  // otherwise ends the description above ("…brown, moist").
  const titles=lines.filter(e=>TITLE.test(clean(kanji(e.text),latin))).length>=2;
  const depthOf=(e:TextLine)=>{
    const d=descriptionDepth(e.cy),b=titles?bounds.find(v=>descriptionY(v)>=e.y0&&descriptionY(v)<=e.y1):undefined;
    return b===undefined?d:TITLE.test(clean(kanji(e.text),latin))?Math.max(d,b):Math.min(d,b-1e-6);
  };
  for(const e of lines){
    const d=depthOf(e),l=layers.find(l=>d>=l.from&&d<l.to);
    if(l){const t=clean(kanji(e.text),latin);if(t){l.description=(l.description+" "+t).trim();used.add(e)}}
  }
  // Soil names lead the descriptions of the layers they start in.
  const named=latin?[]:groupNames(names,bounds.map(descriptionY));
  const nameAt=new Map<ReadLayer,string[]>();
  for(const n of named){
    const d=descriptionDepth(n.src[0].cy),l=layers.find(l=>d>=l.from&&d<l.to);
    if(!l)continue;
    nameAt.set(l,[...(nameAt.get(l)??[]),n.text]);n.src.forEach(e=>used.add(e));l.src.push(...n.src);
  }
  // An empty name on a Japanese form is meaningful: only remarks were read in this band.
  const hasSoilColumn=names.length>0||heads.some(e=>/土質|記事/.test(e.text.replace(/\s/g,"")));
  if(hasSoilColumn)for(const l of layers){
    const ns=nameAt.get(l)??[];
    l.soilName=ns.length===1?ns[0]:"";
    l.description=[ns.join(""),l.description].filter(Boolean).join(" ");
  }
  for(const v of thinStack(layers)){flagged.push(v);why.set(v,THIN)}
  fixTitles(layers);
  absorbRest(layers);
  layers.forEach(l=>{if(flagged.includes(l.to)){l.flagged=true;l.why=why.get(l.to)}});
  attach(layers,lines,labels,depthOf);
  // Logs that print each boundary's elevation beside its depth give the ground level as elevation + depth, many times
  // over. Three or more pairs agreeing within 5 cm settle it where the header has none or disagrees (flagged).
  const others=els.filter(e=>isDecimal(e)&&!bels.includes(e)),sums:number[]=[];
  for(const d of bels){const h=Math.max(d.y1-d.y0,1);for(const e of others)if(Math.abs(e.cy-d.cy)<2.2*h&&Math.abs(e.cx-d.cx)<0.2*width)sums.push(num(e.text)+num(d.text))}
  let group:number[]=[];for(const g of sums){const near=sums.filter(v=>Math.abs(v-g)<=0.05);if(near.length>group.length)group=near}
  if(group.length>=3){
    const g=+group.sort((a,b)=>a-b)[group.length>>1].toFixed(2);
    if(head.ground===undefined){head.ground=g;head.groundFlag="from the elevations and depths at the boundaries"}
    else if(Math.abs(head.ground-g)>0.1){head.groundFlag=`the header reads ${head.ground}; the boundaries give ${g}`;head.ground=g}
  }
  // A water level far below the log's depths but near the ground level is an elevation: it becomes a depth, flagged.
  const deepest=Math.max(bounds.at(-1)??0,scale.depthAt(Math.max(...els.map(e=>e.cy))));
  if(head.water!==undefined&&head.ground!==undefined&&head.water>deepest+5&&Math.abs(head.ground-head.water)<deepest+5){
    head.waterFlag=`read as the elevation ${head.water}`;head.water=+(head.ground-head.water).toFixed(2);
  }
  // The penetration tests: from their column of depths, or from a column of blow counts under its heading.
  const byColumn=tcol?testsByDepths(els,tcol.els.filter(agree),width):testsByColumn(els,scale);
  const spt=byColumn.length?byColumn:testsByNValue(els,scale);
  // Names first, so that a layer joined over several sheets keeps its name before its remarks.
  const texts=[...named.map(n=>({depth:descriptionDepth(n.src[0].cy),text:n.text,src:n.src[0],isSoilName:true})),
    ...lines.map(e=>({depth:depthOf(e),text:clean(kanji(e.text),latin),src:e})).filter(t=>t.text)];
  return {...head,kind:"scale",layers,used,flagged,texts,bounds,evidence,...extra,...(spt.length?{spt}:{})};
}

// ---------- a log set out as a table ----------

// Each layer is a row with the depths of its top and base under headings "From" and "To" (in several languages), beside
// its description. A page part with a From and a To heading side by side is read as a table only: its other columns of
// numbers (core runs, sample numbers) would otherwise pass for a depth scale. Each From/To pair gives its longest run of
// rows without gaps; the run must reach the deepest depth in its columns, and the final depth where the log gives one,
// so sample depths that leave gaps are not taken for layers. Of several pairs (layers, core runs, samples), the log is
// the one whose rows most often have a description of their own (core runs, several to a layer, mostly have none),
// then the one that starts at 0 (a log may start lower, where its top was not logged). The table ends at the first line
// of text that runs across both columns ("Note: …", the next table's title).
// A narrow column's heading of one or two capitals beside the To column ("Tot(m) M") may be read with it.
const FROM=/^(?:from|top|van|von|de|depth from)(?:\s*\(m\))?$/i,TO=/^(?:to|bottom|base|tot|bis|à|depth to)(?:\s*\(m\))?$|^(?:to|bottom|base|tot|bis|depth to)\s*\(m\)\s+[a-z]{1,2}$/i;
const tall=(e:TextLine)=>Math.max(e.y1-e.y0,e.x1-e.x0);
function headingPairs(els:TextLine[],width:number){
  const pairs:Array<[TextLine,TextLine]>=[];
  for(const f of els.filter(e=>FROM.test(e.text.trim())))for(const t of els.filter(e=>TO.test(e.text.trim())))
    if(Math.abs(f.cy-t.cy)<=Math.max(tall(f),tall(t))&&t.cx>f.cx&&t.cx-f.cx<=0.15*width)pairs.push([f,t]);
  return pairs;
}
interface Row { from:number; to:number; cy:number; els:TextLine[] }
// The rows of a From/To pair with their descriptions: each row's band reaches halfway to its neighbours (the first and
// last as far on their open side), and each line of the description column goes to the band it falls in.
function describeRows(els:TextLine[],chain:Row[],f:TextLine,top:number,stop:number,h0:number){
  const bands=chain.map((r,k)=>{
    const up=k?(r.cy-chain[k-1].cy)/2:chain[1]?(chain[1].cy-r.cy)/2:6*h0;
    const down=k<chain.length-1?(chain[k+1].cy-r.cy)/2:k?(r.cy-chain[k-1].cy)/2:6*h0;
    return [r.cy-up,r.cy+down];
  });
  const inBands=(e:TextLine)=>e.cy>top&&e.cy<stop&&e.cy>=bands[0][0]&&e.cy<=bands[bands.length-1][1];
  const words=els.filter(e=>inBands(e)&&letters(e.text)>=2&&!Number.isFinite(num(e.text)));
  const heading=els.find(e=>e.cy<bands[0][0]&&/descri|strata|soil profile|litholog|omschrijving|beschrijving|beschreibung|土質|記事|地層/i.test(e.text));
  // The whole column of text under the heading: lines left-aligned in a wide cell ("Sand (zand)") may not reach under a
  // centred heading themselves, but the longer lines of their column do.
  let col=(heading?columns(words).find(c=>c.x0<heading.x1&&c.x1>heading.x0):undefined)?.els??[];
  if(!col.length)col=columns(words.filter(e=>e.cx<f.x0)).sort((p,q)=>q.els.reduce((s,e)=>s+letters(e.text),0)-p.els.reduce((s,e)=>s+letters(e.text),0))[0]?.els??[];
  const layers:ReadLayer[]=chain.map(r=>({from:r.from,to:r.to,description:"",src:[]}));
  const lines=[...col].sort((p,q)=>p.cy-q.cy),used:TextLine[]=[];
  const rowOf=(e:TextLine)=>bands.findIndex(([y0,y1])=>e.cy>=y0&&e.cy<=y1);
  for(const e of lines){
    const k=rowOf(e);
    if(k>=0){const s=clean(e.text);if(s){layers[k].description=(layers[k].description+" "+s).trim();used.push(e)}}
  }
  // A line's depth, for its evidence: the middle of its row.
  const depth=(e:TextLine)=>{const k=rowOf(e);return k>=0?(chain[k].from+chain[k].to)/2:undefined};
  return {layers,lines,used,depth,described:layers.filter(l=>l.description).length/layers.length};
}
export function rebuildTable(els:TextLine[],width:number):PageLog{
  const decs=els.filter(e=>/^\d+[.,]\d+$/.test(e.text.trim()));
  const h0=decs.map(e=>Math.min(e.y1-e.y0,e.x1-e.x0)).sort((p,q)=>p-q)[decs.length>>1]||10;
  const head=header(els);
  type Candidate={score:number;chain:Row[];f:TextLine;t:TextLine;read:ReturnType<typeof describeRows>};
  let best:Candidate|null=null,error="no rows of depths under the From and To headings";
  for(const [f,t] of headingPairs(els,width)){
    // A compiled stratigraphy from neighbouring wells can have the same TOP/BOTTOM columns.
    // Its caption belongs to this table; another measured log on the page can still be read.
    const caption=els.filter(l=>l.cy<f.cy&&f.cy-l.cy<8*(f.y1-f.y0)&&/^table\s+[\w.]+\s*[:.]/i.test(l.text.trim()))
      .sort((a,b)=>b.cy-a.cy)[0];
    if(caption&&/\b(?:local|neighbou?ring|nearby|regional)\b.*\bstratigraphy\b|\b(?:expected|pre[- ]drill(?:ing)?|predicted)\b/i.test(caption.text)){
      error="a reference or predicted stratigraphy table";
      continue;
    }
    const half=(t.cx-f.cx)/2,top=Math.max(f.y1,t.y1);
    const stop=Math.min(Infinity,...els.filter(e=>e.cy>top&&e.x0<=f.x0&&e.x1>=t.x1).map(e=>e.cy));
    const below=(e:TextLine)=>e.cy>top&&e.cy<stop;
    const fv=decs.filter(e=>below(e)&&Math.abs(e.cx-f.cx)<half),tv=decs.filter(e=>below(e)&&Math.abs(e.cx-t.cx)<half);
    const rows:Row[]=[];
    for(const a of fv){
      const b=tv.filter(e=>Math.abs(e.cy-a.cy)<0.75*Math.max(tall(a),tall(e))).sort((p,q)=>Math.abs(p.cy-a.cy)-Math.abs(q.cy-a.cy))[0];
      if(b&&num(b.text)>num(a.text))rows.push({from:num(a.text),to:num(b.text),cy:(a.cy+b.cy)/2,els:[a,b]});
    }
    rows.sort((p,q)=>p.from-q.from);
    let chain:Row[]=[],cur:Row[]=[];
    for(const r of rows){
      if(cur.length&&Math.abs(cur[cur.length-1].to-r.from)>0.05)cur=[];
      cur.push(r);
      if(cur.length>chain.length||(cur.length===chain.length&&cur[0].from<chain[0].from))chain=[...cur];
    }
    if(!chain.length)continue;
    const end=chain[chain.length-1].to,deepest=Math.max(...[...fv,...tv].map(e=>num(e.text)));
    if(end<deepest-0.05){error=`the rows of depths stop at ${end} m, short of ${deepest} m below them`;continue}
    if(head.final!==undefined&&end<head.final-0.1){error=`the rows of depths stop at ${end} m; the log gives a final depth of ${head.final} m`;continue}
    const read=describeRows(els,chain,f,top,stop,h0);
    if(read.described<0.5){error="most rows of depths have no description: they look like core runs or samples, not layers";continue}
    const score=read.described+(chain[0].from===0?0.25:0)+chain.length*1e-3;
    if(!best||score>best.score)best={score,chain,f,t,read};
  }
  if(!best)return {...head,kind:"table",layers:[],used:new Set(),flagged:[],bounds:[],texts:[],error,evidence:true};
  const {chain,f,t,read:{layers,lines,used:described,depth}}=best;
  const used=new Set<TextLine>([f,t,...chain.flatMap(r=>r.els),...described]);
  const flagged=thinStack(layers);
  fixTitles(layers);
  absorbRest(layers);
  layers.forEach(l=>{if(flagged.includes(l.to)){l.flagged=true;l.why=THIN}});
  attach(layers,lines,chain.map(r=>r.els[1]),depth);
  return {...head,kind:"table",layers,used,flagged,bounds:layers.map(l=>l.to),texts:[],evidence:true};
}

// ---------- pages and documents ----------

// A page may hold several logs, one below the other, each under its own title ("BORE / DRILL LOG"): each part is read on
// its own. A part set out as a table is read as one; any other by its depth scale.
const LOG_TITLE=/(?:bore|drill|boring|bore\s*hole)\s*[/&]?\s*(?:drill\s*)?log(?![a-z])|(?:log|record) of (?:bore ?hole|boring|test ?pit|drill ?hole)|^bor(?:ing|ehole) ?log|柱状図/i;
export const FEET_DEPTH_REASON="this borehole gives depths in feet. Convert its depths and levels to metres before entering it in Input data";

// An SPT drive may be reported in blows/ft on a metric log. Look specifically for units attached to a depth heading.
function hasFeetDepth(lines:TextLine[]){
  const heading=/^(?:(?:depths?|depth below (?:ground|land) surface|from|to|depth from|depth to)\s*[,:(\[]?\s*(?:in\s+)?(?:ft\.?|feet|foot)\b|(?:all\s+)?depths\s+(?:are\s+)?in\s+feet\b)/i;
  if(lines.some(l=>heading.test(l.text.trim())))return true;
  const labels=lines.filter(l=>/^(?:depths?|depth below (?:ground|land) surface|from|to)$/i.test(l.text.trim()));
  return lines.some(unit=>/^[(\[]?(?:in\s+)?(?:feet|ft\.?|foot)[)\]]?$/i.test(unit.text.trim())&&labels.some(label=>{
    const h=label.y1-label.y0;
    const below=unit.cy>=label.cy&&unit.y0-label.y1<=1.5*h&&unit.x0<label.x1&&unit.x1>label.x0;
    const beside=Math.abs(unit.cy-label.cy)<0.5*h&&unit.x0>=label.x1&&unit.x0-label.x1<h;
    return below||beside;
  }));
}

// DOV interpretation tables also use Van / Tot / Beschrijving for formations or geologic ages.
export function isDovInterpretationPage(lines:readonly string[]):boolean{
  return lines.some(s=>/^DOV Boorrapport$/i.test(s.trim()))&&
    lines.some(s=>/^(?:in)?formele stratigrafie\b/i.test(s.trim()))&&
    !lines.some(s=>/^(?:lithologische beschrijving\b|boring$|proefnummer\s*:)/i.test(s.trim()));
}
export function readPage(els:TextLine[],width:number,height:number,rules:Rule[]=[],continuing=false):PageLog[]{
  const starts:number[]=[];
  for(const e of els.filter(e=>LOG_TITLE.test(e.text)).sort((p,q)=>p.cy-q.cy))if(!starts.length||e.cy-starts[starts.length-1]>0.3*height)starts.push(e.cy);
  // Logs without a title, two to a page: the first label of a header ("NUMBER:", "BORING NO.:") repeated further down
  // at the same left edge starts each.
  if(starts.length<2){
    const LABEL=/^([A-Z][A-Z .]{2,24}):/,labelled=els.filter(e=>LABEL.test(e.text.trim())).sort((p,q)=>p.cy-q.cy);
    const first=labelled[0]&&LABEL.exec(labelled[0].text.trim())![1];
    const again=labelled.filter(e=>LABEL.exec(e.text.trim())![1]===first&&Math.abs(e.x0-labelled[0].x0)<0.05*width);
    if(again.length>=2&&again.every((e,k)=>!k||e.cy-again[k-1].cy>0.25*height)){starts.length=0;starts.push(...again.map(e=>e.cy))}
  }
  const cuts=starts.length>1?starts.map((y,k)=>k?y-0.02*height:-Infinity):[-Infinity];
  return cuts.map((y0,k)=>{
    const y1=k<cuts.length-1?cuts[k+1]:Infinity,part=els.filter(e=>e.cy>=y0&&e.cy<y1);
    // A DOV interpretation appendix also has Van/Tot/Beschrijving columns, but its rows are
    // formations or ages. They neither describe new samples nor warrant an OCR retry.
    if(isDovInterpretationPage(part.map(e=>e.text))){
      return {kind:"table",layers:[],used:new Set<TextLine>(),flagged:[],bounds:[],texts:[],error:"a stratigraphic interpretation",evidence:false};
    }
    const log=graphicRangeLog(part)??(headingPairs(part,width).length?rebuildTable(part,width):rebuild(part,width,height,rules,continuing&&k===0));
    return hasFeetDepth(part)?{...log,depthInFeet:true}:log;
  });
}

// One log from its pages in order: every page's boundaries, and every description line placed by its depth. Each header
// value comes from the first page that gives it (a sheet's header may be unreadable), the final depth from the last. A
// log read from a table keeps the layers of its rows. A last sheet that only closes the log adds its text as the last
// layer, from the deepest depth read before it to the final depth, flagged.
export function joinPages(pages:Array<PageLog&{page:number}>):ReadLog{
  const fin=pages.filter(p=>p.final!==undefined).at(-1);
  const gives=(...keys:HeaderField[])=>pages.find(p=>keys.every(k=>p[k]!==undefined));
  const id=gives("id"),ground=gives("ground"),water=gives("water"),xy=gives("x","y"),ll=gives("lat","lon");
  const src=Object.fromEntries(Object.entries({id:id?.src?.id,ground:ground?.src?.ground,water:water?.src?.water,x:xy?.src?.x,y:xy?.src?.y,
    lat:ll?.src?.lat,lon:ll?.src?.lon,final:fin?.src?.final}).filter(([,v])=>v)) as LogHeader["src"];
  const head:LogHeader={id:id?.id,ground:ground?.ground,water:water?.water,x:xy?.x,y:xy?.y,lat:ll?.lat,lon:ll?.lon,
    final:fin?.final,waterFlag:water?.waterFlag,xyFlag:xy?.xyFlag,groundFlag:ground?.groundFlag,src};
  const at=pages.map(p=>p.page),end=pages[pages.length-1],close=pages.length>1&&end.closing?end:undefined;
  const log=joinBody(close?pages.slice(0,-1):pages,head,at,fin?.final);
  const to=log.layers.at(-1)?.to;
  if(close&&!log.samples&&to!==undefined&&head.final!==undefined&&head.final>to+0.05){
    log.layers.push({from:to,to:head.final,description:close.closing!.description,flagged:true,src:close.closing!.src,
      why:`read from page ${close.page}, which ends the log with no depth scale: from ${to} m, the deepest depth read before it, to the final depth`});
    log.flagged.push(head.final);
  }
  return log;
}
// The tests of every sheet, in depth order; a test printed on two sheets (across the break) once.
function joinBody(pages:Array<PageLog&{page:number}>,head:LogHeader,at:number[],final:number|undefined):ReadLog{
  const log=joinLayers(pages,head,at,final);
  const spt=pages.flatMap(p=>p.spt??[]).sort((a,b)=>a.depth-b.depth).filter((t,i,a)=>!i||Math.abs(t.depth-a[i-1].depth)>0.02);
  return spt.length?{...log,spt}:log;
}
function joinLayers(pages:Array<PageLog&{page:number}>,head:LogHeader,at:number[],final:number|undefined):ReadLog{
  const first=pages[0];
  if(pages.length>1&&pages.every(p=>p.samples?.length)){
    const read=sampleLayers(pages.flatMap(p=>p.samples!),final);
    return {...head,kind:"scale",pages:at,layers:read.layers,flagged:read.flagged,samples:true};
  }
  if(pages.length===1&&first.samples?.length)return {...head,kind:"scale",pages:at,layers:first.layers,flagged:first.flagged,samples:true};
  const tail=pages.findIndex(p=>p.printedBeds);
  if(tail>0&&pages.slice(tail).every(p=>p.printedBeds)){
    const prefix=joinLayers(pages.slice(0,tail),head,at.slice(0,tail),final);
    return {...prefix,pages:at,layers:[...prefix.layers,...pages.slice(tail).flatMap(p=>p.layers)]};
  }
  if(pages.length===1||pages.every(p=>p.kind==="table"))
    return {...head,kind:first.kind,...(pages.every(p=>p.rangeLabels)?{rangeLabels:true}:{}),pages:at,
      layers:pages.flatMap(p=>p.layers).sort((a,b)=>a.from-b.from),flagged:pages.flatMap(p=>p.flagged)};
  const bounds:number[]=[];
  for(const p of pages)for(const b of p.bounds)if(!bounds.some(v=>Math.abs(v-b)<0.03))bounds.push(b);
  bounds.sort((a,b)=>a-b);
  const layers:ReadLayer[]=bounds.map((to,k)=>({from:k?bounds[k-1]:0,to,description:"",src:[]}));
  // A sheet repeats the layer it continues from the sheet before ("MUDSTONE (see the rock core
  // log)" again under "(continued)"): the repeat adds nothing to the layer, nor a title to deal (see fixTitles).
  const key=(t:string)=>t.normalize("NFKD").replace(/\p{M}/gu,"").toLowerCase().replace(/\s+/g," ").trim();
  const hasSoilColumn=pages.some(p=>p.layers.some(l=>l.soilName!==undefined));
  for(const p of pages)for(const t of p.texts){
    const l=layers.find(l=>t.depth>=l.from&&t.depth<l.to);
    if(!l||!t.text.trim())continue;
    if(t.isSoilName)l.soilName=l.soilName===undefined||l.soilName===t.text?t.text:"";
    if(p!==pages[0]&&key(l.description).includes(key(t.text)))continue;
    l.description=(l.description+" "+t.text).trim();
  }
  if(hasSoilColumn)for(const l of layers)l.soilName??="";
  const flagged=pages.flatMap(p=>p.flagged),reasons=pages.flatMap(p=>p.layers).filter(l=>l.why),thin=thinStack(layers);
  for(const v of thin)if(!flagged.includes(v))flagged.push(v);
  fixTitles(layers);
  absorbRest(layers);
  layers.forEach(l=>{if(flagged.includes(l.to)){l.flagged=true;l.why=thin.includes(l.to)?THIN:reasons.find(r=>Math.abs(r.to-l.to)<0.03)?.why}});
  const textDepth=new Map(pages.flatMap(p=>p.texts.map(t=>[t.src,t.depth] as const)));
  attach(layers,[...textDepth.keys()],pages.flatMap(p=>[...p.used].filter(e=>/[.,]\d/.test(e.text))),e=>textDepth.get(e));
  return {...head,kind:"scale",pages:at,layers,flagged};
}

// Borehole IDs as one borehole's: case, separators, leading zeros and the words of a label ("LOG", "BH", "Borehole",
// "No.") make no difference: "Log 31" is "LOG31" is "31", and "BH-01" is "BH1" is "1". Other prefixes stay ("TP-1" and
// "BH-1" are two holes).
export const sameId=(id:string|undefined)=>{
  if(id===undefined)return undefined;
  const s=id.normalize("NFKC").toUpperCase().trim();
  return s.replace(/^(?:BORE\s*HOLE|BORING|LOG|BH)(?:\s*(?:NO\.?|#))?[\s\-_.#:]*/,"").replace(/[\s\-_./#]/g,"").replace(/^([A-Z]*)0+(?=\d)/,"$1")||s;
};
// The runs of the rock core logs of one borehole, sheet after sheet: a run over two sheets is one run.
function joinCores(cores:Array<PageLog&{page:number}>):CoreSheet&{pages:number[]}{
  const runs:CoreRun[]=[];
  for(const c of cores)for(const r of c.core!.runs){
    const same=runs.find(q=>q.run===r.run);
    if(!same){runs.push({...r,notes:[...r.notes],src:[...r.src]});continue}
    if(r.from!==undefined)same.from=Math.min(same.from??r.from,r.from);
    if(r.to!==undefined)same.to=Math.max(same.to??r.to,r.to);
    same.tcr??=r.tcr;same.scr??=r.scr;same.rqd??=r.rqd;same.notes.push(...r.notes);same.src.push(...r.src);
  }
  runs.sort((p,q)=>(p.from??Infinity)-(q.from??Infinity));
  return {pages:cores.map(c=>c.page),runs,text:cores.map(c=>c.core!.text).filter(Boolean).join(" "),src:cores.flatMap(c=>c.core!.src)};
}
// The logs of a document: each page's logs, and the pages of one borehole joined in order of their sheet numbers (in
// document order where a page gives none). The pages of a log follow one another (only rock core logs may lie between
// them) and go deeper: a page joins the log of the same ID (see sameId) on the page before, or on the same page, where
// its log starts below the top of the page before; a page whose ID was not read joins the drawn log just before it in
// the same way. A log from a table is complete on its page, and a page part without layers joins no log, unless it
// closes the log of its ID. The rock core logs of a borehole whose log is read go with that log as records, never as
// its layers (see readCore); one with no log of its ID is read as a log itself. `unread` lists the parts that join
// none, saying whether each looked like a log.
// A page: its lines, size and ruled lines (see ruling.ts).
export interface PageLines { page:number; lines:TextLine[]; width:number; height:number; rules?:Rule[] }
// A log printed sideways (an A3 sheet turned on the page) is read by OCR line by line, each line turned upright, but
// the lines stand where they are, down the page. Where most lines of more than one character are tall, the page is
// read turned both ways, and the way that gives the more layers kept; each line keeps its place on the page as shown.
export function upright(p:PageLines):PageLines{
  const words=p.lines.filter(l=>l.text.replace(/\s/g,"").length>=2);
  if(words.length<10||words.filter(l=>l.y1-l.y0>=1.5*(l.x1-l.x0)).length<0.5*words.length)return p;
  const turn=(cw:boolean):PageLines=>{
    const f=(x:number,y:number)=>cw?[p.height-y,x]:[y,p.width-x];
    const lines=p.lines.map(l=>{
      const [ax,ay]=f(l.x0,l.y0),[bx,by]=f(l.x1,l.y1);
      return {...textLine(l.text,Math.min(ax,bx),Math.min(ay,by),Math.max(ax,bx),Math.max(ay,by)),page:l.page,shown:l.shown??{x0:l.x0,y0:l.y0,x1:l.x1,y1:l.y1}};
    });
    const rules=(p.rules??[]).map(r=>{
      const [ax,ay]=f(r.x0,r.y0),[bx,by]=f(r.x1,r.y1),t={x0:ax,y0:ay,x1:bx,y1:by};
      return (isVertical(t)?ay<=by:ax<=bx)?t:{x0:bx,y0:by,x1:ax,y1:ay};
    });
    return {...p,lines,rules,width:p.height,height:p.width};
  };
  // Layers read from written depths count; boundaries taken from drawn lines alone would favour a grid read turned.
  const layers=(q:PageLines)=>readPage(q.lines,q.width,q.height,q.rules).reduce((s,x)=>s+x.layers.filter(l=>!l.flagged).length,0);
  const cw=turn(true),ccw=turn(false),a=layers(cw),b=layers(ccw),own=layers(p);
  return a>=b?(a>own?cw:p):(b>own?ccw:p);
}
export function readDocument(pages:PageLines[]){
  const turned=pages.map(p=>upright({...p,lines:p.lines.map(l=>({...l,page:p.page}))}));
  const read=turned.map(p=>readPage(p.lines,p.width,p.height,p.rules).map(log=>({...log,page:p.page})));
  const strips=turned.map(metricStrip);
  // A sheet with a depth scale but no title or headings, after a sheet with a log, may be that log's next sheet: read
  // as one, it is kept where its scale carries on below the log before it.
  for(let i=1;i<turned.length;i++){
    const before=read[i-1].filter(x=>x.layers.length).at(-1),here=read[i];
    if(!before||turned[i].page!==turned[i-1].page+1||here.some(x=>x.layers.length)||!here.some(x=>x.error==="no log title or description heading"))continue;
    const strip=strips[i];
    if(strip&&strip.number>1&&!adjacentMetricStrips(turned[i-1],turned[i],strips[i-1],strip))continue;
    const again=readPage(turned[i].lines,turned[i].width,turned[i].height,turned[i].rules,true).map(log=>({...log,page:turned[i].page}));
    const last=Math.max(...before.layers.map(l=>l.to));
    if(again[0]?.layers.length&&again[0].top!==undefined&&again[0].top>=last-1)read[i]=again;
  }
  recoverMetricStrips(turned,read,strips);
  const parts=read.flat();
  const logIds=new Set(parts.filter(p=>!p.core&&p.layers.length&&p.id).map(p=>sameId(p.id)));
  const cores=parts.filter(p=>p.core&&p.id&&logIds.has(sameId(p.id))),corePages=new Set(cores.map(p=>p.page));
  const groups:Array<{id:string;pages:Array<PageLog&{page:number}>}>=[];
  const next=(g:{pages:Array<{page:number}>},page:number)=>{
    const last=g.pages[g.pages.length-1].page;
    for(let p=last+1;p<page;p++)if(!corePages.has(p))return false;
    return page>=last;
  };
  const deeper=(g:{pages:Array<PageLog&{page:number}>},part:PageLog)=>{
    const prev=g.pages[g.pages.length-1];
    return part.top===undefined||prev.top===undefined||part.top>prev.top+0.1;
  };
  const closed=new Set<PageLog>();
  for(const part of parts){
    if(cores.includes(part))continue;
    // A sheet that only closes a log goes with the log of its ID on the page before.
    if(!part.layers.length){
      const g=part.closing&&part.id?groups.find(g=>sameId(g.id)===sameId(part.id)&&next(g,part.page)):undefined;
      if(g){g.pages.push(part);closed.add(part)}
      continue;
    }
    const last=groups[groups.length-1];
    const g=part.id?groups.find(g=>sameId(g.id)===sameId(part.id)&&next(g,part.page)&&deeper(g,part))
      :part.kind==="scale"&&last&&last.pages[last.pages.length-1].kind==="scale"&&next(last,part.page)&&deeper(last,part)?last:undefined;
    if(g)g.pages.push(part);else groups.push({id:part.id??`page ${part.page}`,pages:[part]});
  }
  // Pages in order of their sheet numbers where every page gives one; else in their order in the document.
  const pageIndex=new Map(turned.map((p,i)=>[p.page,i]));
  const logs=groups.map(g=>{
    if(g.pages.every(p=>p.sheet))g.pages.sort((p,q)=>p.sheet![0]-q.sheet![0]);
    const log={...joinPages(g.pages),id:g.id},first=g.pages[0],i=pageIndex.get(first.page)!;
    if(read[i].length===1)checkMetricHead(turned[i],strips[i],first,log);
    return log;
  });
  // Each rock core log goes with the log of its ID nearest before it (or after it, where none is before).
  const withCore=new Map<number,Array<PageLog&{page:number}>>();
  for(const c of cores){
    const same=logs.map((l,i)=>({l,i})).filter(({l})=>sameId(l.id)===sameId(c.id)&&l.layers.length);
    const before=same.filter(({l})=>l.pages[0]<=c.page).at(-1)??same[0];
    if(before)withCore.set(before.i,[...(withCore.get(before.i)??[]),c]);
  }
  for(const [i,cs] of withCore)logs[i].core=joinCores(cs);
  // Keep all sheets together here. Rejecting just the imperial sheet could turn its unlabeled continuation into a
  // seemingly valid metric borehole. Other boreholes in the document can still be imported.
  const feetParts=parts.filter(p=>p.depthInFeet),withheld=new Set(feetParts);
  const usable=logs.filter((log,i)=>{
    if(!feetParts.length)return log.layers.length>0;
    const sheets=[...groups[i].pages,...(withCore.get(i)??[])];
    const first=Math.min(...sheets.map(p=>p.page)),last=Math.max(...sheets.map(p=>p.page));
    const start=groups[i].pages[0];
    const unreadSheet=feetParts.some(p=>!p.layers.length&&p.page>=first-1&&p.page<=last+1&&(
      p.id&&sameId(p.id)===sameId(log.id)||p.page===first-1&&(!start.id||(!p.id&&start.sheet&&start.sheet[0]>1))));
    if(!unreadSheet&&!sheets.some(p=>p.depthInFeet))return log.layers.length>0;
    for(const p of sheets)withheld.add(p);
    return false;
  });
  const unread=parts.filter(p=>withheld.has(p)||(!p.layers.length&&!closed.has(p)&&!cores.includes(p))).map(p=>({
    page:p.page,id:p.id,error:withheld.has(p)?FEET_DEPTH_REASON:p.error??"no layers found",log:withheld.has(p)||!!p.evidence}));
  return {logs:usable,unread,parts};
}
