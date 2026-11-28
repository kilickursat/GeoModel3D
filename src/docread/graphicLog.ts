import type {PageLog,ReadLayer,TextLine} from "./reconstruct";

// A caption names the hole and the figure prints each measured interval beside
// a paragraph of lithology. Depth labels inside a description are not boundaries.
export function graphicRangeLog(lines:TextLine[]):PageLog|undefined{
  const caption=/^(?:fig(?:ure)?\.?\s+[\dA-Z]+(?:[.-]\d+)*\s*[:.]?\s*)?(?:graphic|litholog(?:ic|ical)) log (?:of|for) (?:borehole\s+)?([\p{L}\p{N}][\p{L}\p{N} _/-]{0,54})\.?$/iu;
  const captions=lines.filter(l=>caption.test(l.text.trim()));
  if(captions.length!==1)return;
  const title=captions[0],id=title.text.trim().match(caption)![1].trim();
  if(!/\d/.test(id)||/\b(?:and|proposed|planned|predicted|expected|nearby)\b/i.test(id))return;

  const range=/^(\d+(?:[.,]\d+)?)\s*[-–—]\s*(\d+(?:[.,]\d+)?)\s*m\s*:?$/i;
  const labels=lines.flatMap(line=>{
    const m=line.text.trim().match(range);
    return m?[{line,from:Number(m[1].replace(",",".")),to:Number(m[2].replace(",","."))}]:[];
  }).sort((a,b)=>a.line.cy-b.line.cy);
  if(labels.length<2||labels.some((r,i)=>r.to<=r.from||i>0&&r.from!==labels[i-1].to))return;
  const first=labels[0].line,last=labels[labels.length-1].line,height=first.y1-first.y0;
  if(height<=0||labels.some(r=>Math.abs(r.line.x0-first.x0)>2*height))return;
  // Bound the figure by its depth axis and caption so narrative and page footers are excluded.
  const axis=lines.filter(l=>/^depth(?:\s*\(m\))?$/i.test(l.text.trim())&&l.x1<first.x0&&l.cy<first.cy)
    .sort((a,b)=>b.cy-a.cy)[0];
  if(!axis||title.cy<=last.cy)return;
  const right=Math.max(...labels.map(r=>r.line.x1));
  const content=lines.filter(l=>l.x0>right&&l.cy>axis.cy&&l.cy<title.y0&&/\p{L}/u.test(l.text)).sort((a,b)=>a.cy-b.cy);
  const paragraphs:TextLine[][]=[];
  for(const l of content){
    const paragraph=paragraphs.at(-1),previous=paragraph?.at(-1);
    if(paragraph&&previous&&l.cy-previous.cy<=1.6*Math.max(previous.y1-previous.y0,l.y1-l.y0)
      &&Math.abs(previous.x0-l.x0)<=height)paragraph.push(l);
    else paragraphs.push([l]);
  }
  if(paragraphs.length!==labels.length)return;
  const layers:ReadLayer[]=[];
  for(const [i,{from,to,line}] of labels.entries()){
    const p=paragraphs[i];
    if(line.cy<p[0].y0||line.cy>p[p.length-1].y1)return;
    layers.push({from,to,description:p.map(l=>l.text.trim()).join(" "),src:[line,...p]});
  }
  return {kind:"table",rangeLabels:true,id,src:{id:title},evidence:true,layers,
    used:new Set([title,...layers.flatMap(l=>l.src)]),bounds:layers.map(l=>l.to),flagged:[],texts:[]};
}
