// Lines of text with their boxes from a PDF's own text layer: the text items PDF.js gives (runs of text with a
// transform, in PDF user space) become words placed along their runs, then lines in page pixels (y down). Text drawn
// vertically (a depth written up a table column) stays one line with its true box. The result is what OCR gives for a
// page image, so both go through the same reconstruction.
import {TextLine,textLine} from "./reconstruct";

// A text item as PDF.js gives it: `transform` maps the glyph space of a font of size 1 to user space; `width` is the
// run's advance in user space and `height` its font size.
export interface PdfTextItem { str:string; transform:number[]; width:number; height:number }
type Matrix=[number,number,number,number,number,number];
const apply=(m:Matrix,x:number,y:number):[number,number]=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
const isNumber=(t:string)=>/^[−-]?\d+(?:[.,]\d+)?$/.test(t);

// `run`: the first word of a text item, where the producer started a new run of text.
interface Word { text:string; x0:number; y0:number; x1:number; y1:number; h:number; spaced:boolean; run:boolean }

// The box of the stretch [s0, s1] of a run (in user space along its baseline), from just below the baseline to the top
// of capitals, mapped into the page.
function stretch(it:PdfTextItem,view:Matrix,s0:number,s1:number){
  const [a,b,c,d,e,f]=it.transform,len=Math.hypot(a,b)||1,up=Math.hypot(c,d)||1,size=it.height||up;
  const ux=a/len,uy=b/len,vx=c/up,vy=d/up;
  const pts=[[s0,-0.22],[s1,-0.22],[s0,0.88],[s1,0.88]].map(([s,v])=>apply(view,e+ux*s+vx*v*size,f+uy*s+vy*v*size));
  const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
  return {x0:Math.min(...xs),y0:Math.min(...ys),x1:Math.max(...xs),y1:Math.max(...ys)};
}

type Box={x0:number;y0:number;x1:number;y1:number};
// `view` maps user space to page pixels (PDF.js viewport.transform).
export function linesFromItems(items:PdfTextItem[],view:number[]):TextLine[]{
  const m=view as Matrix,words:Word[]=[],out:TextLine[]=[];
  // Text printed twice over itself a fraction of a point aside (bold imitated by overprinting: "BOREHOLE NO.: BH-12"
  // would read "BOREHOLEBOREHOLE NO.: NO.: BH-12BH-12") is read once: the same text in nearly the same box.
  const drawn=new Map<string,Box[]>();
  const twice=(text:string,s:Box)=>{
    const tol=0.3*Math.max(Math.min(s.x1-s.x0,s.y1-s.y0),1),seen=drawn.get(text)??[];
    if(seen.some(p=>Math.abs(p.x0-s.x0)<tol&&Math.abs(p.x1-s.x1)<tol&&Math.abs(p.y0-s.y0)<tol&&Math.abs(p.y1-s.y1)<tol))return true;
    seen.push(s);drawn.set(text,seen);return false;
  };
  for(const it of items){
    if(!it.str||!it.str.trim()||it.transform.length<6)continue;
    const [a,b]=it.transform,len=Math.hypot(a,b)||1;
    // The direction of the run on the page: along x for ordinary text.
    const [p0x,p0y]=apply(m,it.transform[4],it.transform[5]),[p1x,p1y]=apply(m,it.transform[4]+a/len,it.transform[5]+b/len);
    const horizontal=Math.abs(p1x-p0x)>=Math.abs(p1y-p0y);
    if(!horizontal){
      const s=stretch(it,m,0,it.width);
      if(!twice(it.str.trim(),s))out.push(textLine(it.str.trim(),s.x0,s.y0,s.x1,s.y1));
      continue;
    }
    // Words placed along the run in proportion to their characters.
    const n=it.str.length,per=it.width/Math.max(n,1);
    let first=true;
    for(const w of it.str.matchAll(/\S+/g)){
      const s=stretch(it,m,w.index!*per,(w.index!+w[0].length)*per);
      if(!twice(w[0],s))words.push({text:w[0],...s,h:s.y1-s.y0,spaced:w.index!>0||/^\s/.test(it.str),run:first});
      first=false;
    }
  }
  // Rows: words within half a line height of the row's first word; then, left to right, a word joins the line before
  // it when the gap is under 0.8 line heights and the two are not both numbers (a scale's "7" beside a depth "6.86" are
  // two values, not one). Pieces of one word drawn as separate runs are joined without a space.
  words.sort((p,q)=>(p.y0+p.y1)/2-(q.y0+q.y1)/2);
  const rows:Word[][]=[];
  for(const w of words){
    const cy=(w.y0+w.y1)/2,row=rows.find(r=>Math.abs((r[0].y0+r[0].y1)/2-cy)<0.5*Math.min(r[0].h,w.h));
    if(row)row.push(w);else rows.push([w]);
  }
  for(const row of rows)row.sort((p,q)=>p.x0-q.x0);
  const join=(cur:Word,w:Word)=>{
    const gap=w.x0-cur.x1,h=Math.max(w.h,cur.h),last=cur.text.split(" ").pop()??"";
    return gap<0.8*h&&!(isNumber(last)&&isNumber(w.text)&&gap>0.05*h);
  };
  // Where lines start: a column's left edge has lines starting on three rows or more. A run of text that starts there
  // begins a line of its own, however close the text before it, so a description that reaches the next column of a
  // table is not joined to that column's text ("…medium dense," and "S-4 Stiff"). Text set word by word (justified
  // lines) has its words wherever their lengths put them, where lines seldom start.
  const starts:number[]=[];
  for(const row of rows)row.forEach((w,k)=>{if(!k||!join(row[k-1],w))starts.push(w.x0)});
  const edge=(w:Word)=>starts.filter(x=>Math.abs(x-w.x0)<0.3*w.h).length>=3;
  const flush=(l:Word)=>out.push(textLine(l.text,l.x0,l.y0,l.x1,l.y1));
  for(const row of rows){
    let cur:Word=row[0];
    for(const w of row.slice(1)){
      const gap:number=w.x0-cur.x1,h:number=Math.max(w.h,cur.h);
      if(join(cur,w)&&!(w.run&&gap>0.3*h&&edge(w))){
        const space:boolean=w.spaced||gap>0.12*h;
        cur={...cur,text:cur.text+(space?" ":"")+w.text,x1:Math.max(cur.x1,w.x1),y0:Math.min(cur.y0,w.y0),y1:Math.max(cur.y1,w.y1)};
      }else{flush(cur);cur=w}
    }
    flush(cur);
  }
  return out;
}
// The characters of a page's text layer: a page with almost none is a scanned image.
export const textChars=(items:PdfTextItem[])=>items.reduce((s,it)=>s+(it.str?.replace(/\s/g,"").length??0),0);

// How much of a page's text layer reads as words. A PDF whose fonts have no usable map to characters gives text that
// looks like text but is not ("$$':?')& ,,&:A:&)#:$'"59"): PDF.js returns the font's codes as characters, with no
// replacement marks to tell. A word here is a run of letters (any script) with ordinary punctuation around it, a
// number, or a code such as "BH-01"; bullets, dashes and leader dots are left out of the count. On the reports tested,
// garbled pages scored 0.00–0.31 and real text 0.53 or more (scanned pages have almost no text and are OCR'd anyway).
const WORD=/^[(\["'“‘]*(?:[\p{L}][\p{L}\p{M}'’.\-]*|\d+(?:[.,:/\-]\d+)*%?|[\p{L}\d]+(?:[-/][\p{L}\d]+)+)[)\]"'”’.,;:!?%]*$/u;
const DECOR=/^[•·▪■□●○◦‣⁃–—\-_.…|=~*]+$/u;
export function wordShare(texts:string[]):{tokens:number;share:number}{
  const tokens=texts.flatMap(t=>t.split(/\s+/)).filter(w=>w&&!DECOR.test(w));
  return {tokens:tokens.length,share:tokens.length?tokens.filter(w=>WORD.test(w)).length/tokens.length:1};
}
// Below GARBLED the text layer is not used: the page is read by OCR. From GARBLED to TRUSTED it is compared with OCR
// before it is used. A page with too few words to judge keeps its text layer.
export const GARBLED=0.35,TRUSTED=0.5,MIN_WORDS=8;
export type TextLayer="none"|"garbled"|"doubtful"|"good";
export function judgeText(texts:string[],chars:number,minChars:number):{layer:TextLayer;share:number}{
  if(chars<minChars)return {layer:"none",share:0};
  const {tokens,share}=wordShare(texts);
  if(tokens<MIN_WORDS)return {layer:"good",share};
  return {layer:share<GARBLED?"garbled":share<TRUSTED?"doubtful":"good",share};
}
// For a doubtful page: how many of the text layer's words (of three letters or more) OCR also read. Where most are
// there, the text layer is right and is kept, for its exact boxes.
export function agreement(text:string[],ocr:string[]){
  const words=(ts:string[])=>ts.flatMap(t=>t.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u)).filter(w=>w.length>=3&&/\p{L}/u.test(w));
  const own=words(text),seen=new Set(words(ocr));
  return own.length?own.filter(w=>seen.has(w)).length/own.length:1;
}
