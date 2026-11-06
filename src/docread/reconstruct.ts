// Borehole logs from the text of a page: lines of text with their boxes, from a PDF's own text layer or from OCR of a
// page image, become logs (header values and layers) with no template for any layout. Drawn logs are read by their
// depth scale, logs set out as tables by their From and To columns. Each layer keeps the lines it was read from, so the
// review can show where every value came from; values the page does not state outright are flagged.

// A line of text and its box, in page pixels (y down), and the page it is on once a document is read.
export interface TextLine { text:string; x0:number; y0:number; x1:number; y1:number; cx:number; cy:number; page?:number }
// A flagged layer says why its base depth needs checking.
export interface ReadLayer { from:number; to:number; description:string; flagged?:boolean; why?:string; src:TextLine[] }
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
export interface PageLog extends LogHeader {
  kind:"scale"|"table"; layers:ReadLayer[]; used:Set<TextLine>; flagged:number[]; bounds:number[];
  texts:Array<{depth:number;text:string;src:TextLine}>; error?:string; evidence?:boolean;
}
export interface ReadLog extends LogHeader { kind:"scale"|"table"; pages:number[]; layers:ReadLayer[]; flagged:number[] }

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
// Text grouped into columns by horizontal overlap.
function columns(els:TextLine[]):Column[]{
  const cols:Column[]=[];
  for(const e of [...els].sort((p,q)=>p.x0-q.x0)){
    const c=cols.find(c=>e.x0<c.x1&&e.x1>c.x0);
    if(c){c.els.push(e);c.x0=Math.min(c.x0,e.x0);c.x1=Math.max(c.x1,e.x1)}else cols.push({x0:e.x0,x1:e.x1,els:[e]});
  }
  return cols;
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
  }
  return undefined;
}
// Values: an ID ("1", "BH3", "BH-01", "401"); a number first ("3.64 m NAP", "GL-9.80m"), but not a date; a decimal
// number, so a sample number "1" beside a heading is not taken for a water depth.
const DATE=/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/;
const isId=(t:string)=>/^[A-Za-z.#\-]{0,6}\s?\d[\w.\-/]{0,12}$/.test(t.trim());
const isNum=(t:string)=>/^\D{0,3}\d/.test(t)&&!DATE.test(t);
const isDec=(t:string)=>/^\D{0,3}\d+[.,]\d/.test(t)&&!DATE.test(t);

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
  const els=pageOrder(lines),all=els.map(e=>e.text).join("\n");
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
    if(value!==undefined)src[key]=v!.src;
    return value;
  };
  // A title "LOG OF BOREHOLE BH3 … 1 OF 3" gives the ID and the sheet, so the pages of one log can be joined.
  const title=match(/(?:log|record) of\s+(?:bore ?hole|boring|test ?pit|drill ?hole)\s+([A-Za-z0-9][\w./-]*)/i);
  const sheet=/\b(\d+)\s+of\s+(\d+)\b/i.exec(all);
  // A table of readings ("Water Depth (m)" over a column of values) gives the first reading.
  let reading:{text:string;src:TextLine}|undefined;
  const wcol=els.find(e=>/^(?:water depth|depth to water|depth of water|groundwater depth)\b/i.test(e.text.trim()));
  if(wcol){
    const h=Math.max(wcol.y1-wcol.y0,1);
    const v=els.filter(e=>e.cy>wcol.cy+0.4*h&&e.cy-wcol.cy<6*h&&Math.abs(e.cx-wcol.cx)<Math.max((wcol.x1-wcol.x0)/2,2*h)&&isDec(e.text)).sort((p,q)=>p.cy-q.cy)[0];
    if(v)reading={text:v.text,src:v};
  }
  const gwl=match(/GWL\s*([\d.,]+)/i);
  const head:LogHeader&{mark?:number}={
    id:take("id",title??fieldAt(els,/^(?:bore\s*hole|boring|forage|sondage|bohrung)\s*(?:no\.?|id|nr\.?|number)?\s*[:.]?(?![a-z])|^ボーリング(?:名|番号|No\.?)|^孔番号/i,isId),t=>t.replace(/\s+/g,"")),
    sheet:sheet?[+sheet[1],+sheet[2]]:undefined,
    // The ground level may stand before its words ("12.30 Ground Surface").
    ground:take("ground",fieldAt(els,/(?:ground (?:level|surface)|(?:ground|surface|collar) elev(?:ation)?\.?|maaiveld(?:hoogte)?|cote du terrain|niveau du sol|gel[äa]ndeh[öo]he|ansatzh[öo]he)(?![a-z])|^孔口標高|^地盤高/i,isNum),firstNum),
    // The depth the hole was taken to ("TERMINATION DEPTH (M) : 10.00", "END OF BOREHOLE AT 6.50 mbgs", 総掘進長).
    final:take("final",fieldAt(els,/^(?:termination(?:\s*depth)?|final depth|total depth|depth of (?:bore ?hole|hole)|hole depth|end of (?:bore ?hole|hole)(?: at)?)(?![a-z])|^総掘進長|^掘進長/i,isDec),firstNum),
    // A table of readings first, then a labelled value, then the water mark on the log.
    water:take("water",reading??fieldAt(els,/^(?:groundwater|ground water|grondwater(?:stand)?|nappe|grundwasser|water level|w\.\s*l\.|gwl|swl|swt|static water(?: level| table)?)(?![a-z])|^孔内水位|^地下水位/i,isDec)??gwl,firstNum),
    // "×" is a common reading of "X".
    x:take("x",match(/(?:^|[^A-Za-z])[X×]\s*[=:]?\s*(-?[\d.,]{4,})/m),firstNum),y:take("y",match(/(?:^|[^A-Za-z])Y\s*[=:]?\s*(-?[\d.,]{4,})/m),firstNum)};
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
    src.lat=lat.src;src.lon=lon.src;
  }
  head.mark=firstNum(gwl?.text);
  if(head.water!==undefined&&head.mark!==undefined&&Math.abs(head.mark-head.water)>0.05)head.waterFlag=`the log's mark reads ${head.mark}`;
  head.src=src;
  return head;
}

// ---------- descriptions ----------

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
function clean(t:string,latin=(t.match(/[A-Za-z]/g)??[]).length>=5){
  return t.split(/\s+/).filter(w=>!(/^(?=.*\d)(?=.*[DdbpqOoUu])[0-9DdbpqOoUu]{2,4}$/.test(w)||/^[Dd]{2,}$/.test(w)||/^[?!)(\]\[}{|]+$/.test(w)||
    (latin&&/^[぀-ヿ一-鿿]{1,2}$/.test(w)))).join(" ").trim();
}

// Layer titles: an UPPERCASE soil name and a colon, comma or bracket ("FILL:", "SANDY SILT,", "TOP SOIL (100 mm)"), or
// a thickness and a name ("200mm AGGREGATE"). Titles are found without overlapping ("SOIL" inside "TOP SOIL" is not one).
const UPPER_WORDS="[A-Z]{2,}(?:\\s+[A-Z]{2,}(?![A-Za-z]*\\s*[,:(]))*";
const TITLE_SRC=`(?:\\d+(?:[.,]\\d+)?\\s?mm\\s+${UPPER_WORDS}|[A-Z]{2,}(?:\\s+[A-Z]{2,})*\\s*(?:\\([^)]*\\)|:|,))`;
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
  layers.splice(0,1,...made);
  return made.map(l=>l.to).filter(v=>v!==first.to);
}
const THIN="from the thicknesses written in the descriptions";

// Each layer's evidence: the depth written at its base and the lines whose text is in its description.
function attach(layers:ReadLayer[],lines:TextLine[],labels:TextLine[]){
  const free=new Set(lines);
  for(const l of layers){
    const label=labels.find(e=>Math.abs(num(e.text)-l.to)<0.005);
    const words=l.description.toLowerCase();
    const src=[...free].filter(e=>{const t=clean(kanji(e.text)).toLowerCase();return t.length>1&&words.includes(t)});
    src.forEach(e=>free.delete(e));
    l.src=[...(label?[label]:[]),...src];
  }
}

// ---------- a drawn log ----------

// A log is titled ("LOG OF BOREHOLE BH3", "BORE / DRILL LOG", ボーリング柱状図) or has a heading over its descriptions
// ("SOIL DESCRIPTION", "Description of Strata", 土質区分). Headings and titles are short: a sentence of a report that
// mentions a borehole log or a description is neither, and nor is a numbered heading of a report ("2 Site
// description"). The columns of tables of results (the number of a stratum, the strata a well is screened in) are no
// description headings.
const HEADING=/descri|soil profile|stratigraph|litholog|omschrijving|beschrijving|beschreibung|土質|記事|地層/i;
const short=(t:string,words:number)=>!/^\s*\d+(?:\.\d+)*\.?\s/.test(t)&&
  (/[぀-ヿ一-鿿]/.test(t)?t.trim().length<=12:t.trim().split(/\s+/).length<=words&&t.trim().length<=60);
const titled=(els:TextLine[])=>els.some(e=>LOG_TITLE.test(e.text)&&short(e.text,8));
export const logEvidence=(els:TextLine[])=>titled(els)||els.some(e=>HEADING.test(e.text)&&short(e.text,5));

export function rebuild(els:TextLine[],width:number,height=Infinity):PageLog{
  const scale=depthScale(els,width),head=header(els),title=titled(els),evidence=logEvidence(els);
  const empty=(error:string,looks:boolean):PageLog=>({...head,kind:"scale",layers:[],used:new Set(),flagged:[],bounds:[],texts:[],error,evidence:looks});
  if(!scale)return empty("no depth scale found",evidence);
  // Numbers in a report's text or in a table of results can pass for a depth scale; a log page says it is one. Without
  // a title, its scale must be one too: four or more whole-metre labels (or ticks) down a fair part of the page, where
  // numbered headings of a report ("1.0", "1.1", "2.0") or a few rows of a table would otherwise do.
  if(!evidence)return empty("no log title or description heading",false);
  const ys=scale.labels.map(e=>e.cy),tall=Math.min(height,Math.max(...els.map(e=>e.y1))-Math.min(...els.map(e=>e.y0)));
  if(!title&&(scale.kind==="decimals"||ys.length<4||Math.max(...ys)-Math.min(...ys)<0.15*tall))return empty("no log title, and its numbers are no depth scale",false);
  const used=new Set(scale.labels);
  // Boundaries: the column of decimal numbers whose values agree with their positions on the scale (within 0.6 m).
  // Other columns of decimals (elevations, thicknesses) agree only by chance, so they lose to it.
  const agree=(e:TextLine)=>Math.abs(scale.depthAt(e.cy)-num(e.text))<0.6;
  const bcol=columns(els.filter(isDecimal)).sort((p,q)=>q.els.filter(agree).length-p.els.filter(agree).length)[0];
  const bels=(bcol?.els??[]).filter(agree),labels=[...bels];
  bels.forEach(e=>used.add(e));
  const values=bels.map(e=>num(e.text)),flagged:number[]=[],why=new Map<number,string>();
  // A label in that column that disagrees with its position: first the usual OCR digit confusions, then the depth its
  // position gives. Either way the boundary is flagged. Only where most of the column agrees: if most of it disagrees,
  // the scale is wrong, not a few readings.
  const disagree=(bcol?.els??[]).filter(e=>!agree(e));
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
  if(bcol)for(const e of els.filter(e=>/^\d{2,4}$/.test(e.text.trim())&&!scale.labels.includes(e)&&e.x0<bcol.x1&&e.x1>bcol.x0)){
    const at=scale.depthAt(e.cy),v=[num(e.text)/10,num(e.text)/100].find(v=>Math.abs(v-at)<0.3);
    if(v!==undefined&&!values.some(w=>Math.abs(w-v)<0.3)){
      values.push(v);flagged.push(v);used.add(e);labels.push({...e,text:String(v)});
      why.set(v,`read as “${e.text.trim()}”; the decimal point put back`);
    }
  }
  const bounds=[...new Set(values)].sort((p,q)=>p-q);
  const layers:ReadLayer[]=bounds.map((to,k)=>({from:k?bounds[k-1]:0,to,description:"",src:[]}));
  // Descriptions: the log's text (not numbers, not the water mark) grouped into columns; the column with the most
  // letters is the description column (a hatched legend reads as "000" or "C C T"). Each of its lines goes to the layer
  // at the depth of its centre. The body starts below the column headings ("DESCRIPTION", "土質区分"), which repeat on
  // continued pages; without them, at the depth 0.
  const bottom=bounds.at(-1)??Infinity,topY=Math.min(...scale.labels.map(e=>e.cy));
  const heads=els.filter(e=>/descri|soil profile|stratigraph|litholog|omschrijving|beschrijving|土質|記事|地層/i.test(e.text)&&e.cy<topY+0.5*scale.b);
  const startY=heads.length?Math.max(...heads.map(e=>e.y1)):scale.yAt(0);
  const body=els.filter(e=>!Number.isFinite(num(e.text))&&!/^GWL/i.test(e.text)&&e.cy>startY&&scale.depthAt(e.cy)>=0&&scale.depthAt(e.cy)<=bottom+0.5);
  const main=columns(body).sort((p,q)=>q.els.reduce((s,e)=>s+letters(e.text),0)-p.els.reduce((s,e)=>s+letters(e.text),0))[0];
  // Whether the column is Latin text, judged on the whole column: a lone kanji in it is a misread symbol.
  const joined=(main?.els??[]).map(e=>e.text).join("");
  const latin=(joined.match(/[A-Za-z]/g)??[]).length>0.5*letters(joined);
  const lines=[...(main?.els??[])].sort((p,q)=>p.cy-q.cy);
  // A line that a boundary runs through is above or below it by a pixel or two, which says nothing. Where the
  // descriptions start with titles ("SILTY CLAY: firm…"), such a line is below the boundary if it is a title, and
  // otherwise ends the description above ("…brown, moist").
  const titles=lines.filter(e=>TITLE.test(clean(kanji(e.text),latin))).length>=2;
  const depthOf=(e:TextLine)=>{
    const d=scale.depthAt(e.cy),b=titles?bounds.find(v=>scale.yAt(v)>=e.y0&&scale.yAt(v)<=e.y1):undefined;
    return b===undefined?d:TITLE.test(clean(kanji(e.text),latin))?Math.max(d,b):Math.min(d,b-1e-6);
  };
  for(const e of lines){
    const d=depthOf(e),l=layers.find(l=>d>=l.from&&d<l.to);
    if(l){const t=clean(kanji(e.text),latin);if(t){l.description=(l.description+" "+t).trim();used.add(e)}}
  }
  for(const v of thinStack(layers)){flagged.push(v);why.set(v,THIN)}
  fixTitles(layers);
  layers.forEach(l=>{if(flagged.includes(l.to)){l.flagged=true;l.why=why.get(l.to)}});
  attach(layers,lines,labels);
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
  // For logs over several pages: each description line with its depth.
  const texts=lines.map(e=>({depth:depthOf(e),text:clean(kanji(e.text),latin),src:e})).filter(t=>t.text);
  return {...head,kind:"scale",layers,used,flagged,texts,bounds,evidence};
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
const FROM=/^(?:from|top|van|von|de|depth from)(?:\s*\(m\))?$/i,TO=/^(?:to|bottom|base|tot|bis|à|depth to)(?:\s*\(m\))?$/i;
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
  for(const e of lines){
    const k=bands.findIndex(([y0,y1])=>e.cy>=y0&&e.cy<=y1);
    if(k>=0){const s=clean(e.text);if(s){layers[k].description=(layers[k].description+" "+s).trim();used.push(e)}}
  }
  return {layers,lines,used,described:layers.filter(l=>l.description).length/layers.length};
}
export function rebuildTable(els:TextLine[],width:number):PageLog{
  const decs=els.filter(e=>/^\d+[.,]\d+$/.test(e.text.trim()));
  const h0=decs.map(e=>Math.min(e.y1-e.y0,e.x1-e.x0)).sort((p,q)=>p-q)[decs.length>>1]||10;
  const head=header(els);
  type Candidate={score:number;chain:Row[];f:TextLine;t:TextLine;read:ReturnType<typeof describeRows>};
  let best:Candidate|null=null,error="no rows of depths under the From and To headings";
  for(const [f,t] of headingPairs(els,width)){
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
  const {chain,f,t,read:{layers,lines,used:described}}=best;
  const used=new Set<TextLine>([f,t,...chain.flatMap(r=>r.els),...described]);
  const flagged=thinStack(layers);
  fixTitles(layers);
  layers.forEach(l=>{if(flagged.includes(l.to)){l.flagged=true;l.why=THIN}});
  attach(layers,lines,chain.map(r=>r.els[1]));
  return {...head,kind:"table",layers,used,flagged,bounds:layers.map(l=>l.to),texts:[],evidence:true};
}

// ---------- pages and documents ----------

// A page may hold several logs, one below the other, each under its own title ("BORE / DRILL LOG"): each part is read on
// its own. A part set out as a table is read as one; any other by its depth scale.
const LOG_TITLE=/(?:bore|drill|boring|bore\s*hole)\s*[/&]?\s*(?:drill\s*)?log(?![a-z])|(?:log|record) of (?:bore ?hole|boring|test ?pit|drill ?hole)|^bor(?:ing|ehole) ?log|柱状図/i;
export function readPage(els:TextLine[],width:number,height:number):PageLog[]{
  const starts:number[]=[];
  for(const e of els.filter(e=>LOG_TITLE.test(e.text)).sort((p,q)=>p.cy-q.cy))if(!starts.length||e.cy-starts[starts.length-1]>0.3*height)starts.push(e.cy);
  const cuts=starts.length>1?starts.map((y,k)=>k?y-0.02*height:-Infinity):[-Infinity];
  return cuts.map((y0,k)=>{
    const y1=k<cuts.length-1?cuts[k+1]:Infinity,part=els.filter(e=>e.cy>=y0&&e.cy<y1);
    return headingPairs(part,width).length?rebuildTable(part,width):rebuild(part,width,height);
  });
}

// One log from its pages in order: every page's boundaries, and every description line placed by its depth. The header
// comes from the first page. A log read from a table keeps the layers of its rows.
export function joinPages(pages:Array<PageLog&{page:number}>):ReadLog{
  const first=pages[0],fin=pages.filter(p=>p.final!==undefined).at(-1);
  const head:LogHeader={id:first.id,ground:first.ground,water:first.water,x:first.x,y:first.y,lat:first.lat,lon:first.lon,
    final:fin?.final,waterFlag:first.waterFlag,xyFlag:first.xyFlag,groundFlag:first.groundFlag,
    src:{...first.src,final:fin?.src?.final}};
  const at=pages.map(p=>p.page);
  if(pages.length===1||pages.every(p=>p.kind==="table"))
    return {...head,kind:first.kind,pages:at,layers:pages.flatMap(p=>p.layers).sort((a,b)=>a.from-b.from),flagged:pages.flatMap(p=>p.flagged)};
  const bounds:number[]=[];
  for(const p of pages)for(const b of p.bounds)if(!bounds.some(v=>Math.abs(v-b)<0.03))bounds.push(b);
  bounds.sort((a,b)=>a-b);
  const layers:ReadLayer[]=bounds.map((to,k)=>({from:k?bounds[k-1]:0,to,description:"",src:[]}));
  for(const p of pages)for(const t of p.texts){
    const l=layers.find(l=>t.depth>=l.from&&t.depth<l.to);
    if(l)l.description=(l.description+" "+t.text).trim();
  }
  const flagged=pages.flatMap(p=>p.flagged),reasons=pages.flatMap(p=>p.layers).filter(l=>l.why),thin=thinStack(layers);
  for(const v of thin)if(!flagged.includes(v))flagged.push(v);
  fixTitles(layers);
  layers.forEach(l=>{if(flagged.includes(l.to)){l.flagged=true;l.why=thin.includes(l.to)?THIN:reasons.find(r=>Math.abs(r.to-l.to)<0.03)?.why}});
  attach(layers,pages.flatMap(p=>p.texts.map(t=>t.src)),pages.flatMap(p=>[...p.used].filter(e=>/[.,]\d/.test(e.text))));
  return {...head,kind:"scale",pages:at,layers,flagged};
}

// The logs of a document: each page's logs, and the pages of one borehole joined in order of their sheet numbers. The
// pages of a log follow one another: a page joins the log of the same ID on the page before (or the same page), and a
// page whose ID was not read joins the drawn log just before it. A log from a table is complete on its page, and a page
// part without layers joins no log. `unread` lists those parts, saying whether each looked like a log.
export function readDocument(pages:Array<{page:number;lines:TextLine[];width:number;height:number}>){
  const parts=pages.flatMap(p=>readPage(p.lines.map(l=>({...l,page:p.page})),p.width,p.height).map(log=>({...log,page:p.page})));
  const groups:Array<{id:string;pages:Array<PageLog&{page:number}>}>=[];
  const next=(g:{pages:Array<{page:number}>},page:number)=>page-g.pages[g.pages.length-1].page<=1;
  for(const part of parts){
    if(!part.layers.length)continue;
    const last=groups[groups.length-1];
    const g=part.id?groups.find(g=>g.id===part.id&&next(g,part.page))
      :part.kind==="scale"&&last&&last.pages[last.pages.length-1].kind==="scale"&&next(last,part.page)?last:undefined;
    if(g)g.pages.push(part);else groups.push({id:part.id??`page ${part.page}`,pages:[part]});
  }
  const logs=groups.map(g=>({...joinPages(g.pages.sort((p,q)=>(p.sheet?.[0]??0)-(q.sheet?.[0]??0))),id:g.id}));
  const unread=parts.filter(p=>!p.layers.length).map(p=>({page:p.page,id:p.id,error:p.error??"no layers found",log:!!p.evidence}));
  return {logs:logs.filter(l=>l.layers.length),unread,parts};
}
