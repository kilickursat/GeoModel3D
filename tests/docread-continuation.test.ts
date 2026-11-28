import {expect,it} from "vitest";
import {readDocument,textLine,type PageLines} from "../src/docread/reconstruct";

// An invented teaching log, drawn in memory. The geometry, materials and
// measurements are defined here so each test can change one printed fact.
const axis={ruler:48,elevation:142,thickness:210,base:282,graphic:370,soil:464,colour:556,tests:764};
const collar=92.47,filename="teaching-column.pdf";
type Bed={to:number;soil:string;wrapAt?:number};
const fragments=(bed:Bed)=>bed.wrapAt===undefined?[bed.soil]:[bed.soil.slice(0,bed.wrapAt),bed.soil.slice(bed.wrapAt)];
const upper:Bed[]=[{to:2.35,soil:"腐植土"},{to:4.8,soil:"細砂"},{to:6.65,soil:"砂岩"}];
const lower:Bed[]=[{to:7.42,soil:"火山灰質粘土",wrapAt:3},{to:8.68,soil:"粗砂"},{to:9.55,soil:"玄武岩"}];
const label=(text:string,x:number,y:number,width=Math.max(12,text.length*7))=>
  textLine(text,x-width/2,y-5,x+width/2,y+5);
const banner=(from:number,to:number,file=filename)=>`${file} (${from} - ${to} m)`;
function header(final:number){
  const headings: Array<[string,number]>=[["標高",axis.elevation],["層厚",axis.thickness],["深度",axis.base],
    ["柱状図",axis.graphic],["土質区分",axis.soil],["色調",axis.colour]];
  return [
    label("ボーリング柱状図",435,53),label("ボーリング名",78,79),label("LAB-K9",190,79),
    label("孔口標高",78,103),label(collar.toFixed(2)+" m",190,103),
    label("総掘進長",78,127),label(final.toFixed(2)+" m",190,127),
    ...headings.flatMap(([word,x])=>Array.from(word,(char,i)=>label(char,x,157+16*i))),
    ...[axis.elevation,axis.thickness,axis.base].map(x=>label("(m)",x,224))
  ];
}

interface Sheet {page:number;count:number;start:number;end:number;prior:number;beds:Bed[];final:number;longRuler:boolean}
function sheet(s:Sheet):PageLines{
  const head=s.page===1,body=head?260:62,scale=50;
  const yAt=(depth:number)=>body+(depth-s.start)*scale;
  const lines=[label(banner(s.start,s.end),188,18),label(`${s.page}/${s.count} ページ`,774,18)];
  if(head)lines.push(...header(s.final));
  if(s.longRuler){
    for(let depth=s.start;depth<=s.end;depth++)lines.push(label(String(depth),axis.ruler,yAt(depth)));
  }else{
    // The clipped strip has fewer than four ruler ticks, alongside a column
    // of plausible numeric penetration-test depths.
    lines.push(label(String(s.start+1),axis.ruler,yAt(s.start+1)));
    for(const offset of [0.12,0.42,1.12,1.42,2.12,2.42]){
      lines.push(label((s.start+offset).toFixed(2),axis.tests,yAt(s.start+offset)));
    }
  }
  let prior=s.prior;
  for(const bed of s.beds){
    const y=yAt(bed.to),materialY=(yAt(Math.max(s.start,prior))+y)/2;
    const pieces=fragments(bed);
    lines.push(label((collar-bed.to).toFixed(2),axis.elevation,y),
      label((bed.to-prior).toFixed(2),axis.thickness,y),label(bed.to.toFixed(2),axis.base,y),
      ...pieces.map((text,i)=>label(text,axis.soil,materialY+9*(i-(pieces.length-1)/2))));
    prior=bed.to;
  }
  return {page:s.page,width:880,height:760,lines};
}

function pair(){
  const final=lower[2].to;
  return [sheet({page:1,count:2,start:0,end:7,prior:0,beds:upper,final,longRuler:true}),
    sheet({page:2,count:2,start:7,end:10,prior:upper[2].to,beds:lower,final,longRuler:false})] as const;
}
const bases=(beds:Bed[])=>beds.map(b=>b.to);
const replaceText=(page:PageLines,before:string,after:string):PageLines=>({...page,
  lines:page.lines.map(l=>l.text===before?{...l,text:after}:l)});

it("recovers the short strip from its printed triples and retains each bed's source boxes",()=>{
  const [head,tail]=pair(),{logs,parts,unread}=readDocument([head,tail]);
  expect(unread).toEqual([]);
  expect(parts[1].printedBeds).toBe(true);
  expect(logs).toHaveLength(1);
  const [log]=logs;
  expect(log.pages).toEqual([1,2]);
  expect(log.layers.map(l=>l.to)).toEqual(bases([...upper,...lower]));
  let prior=upper[2].to;
  for(const [k,bed] of lower.entries()){
    const layer=log.layers[upper.length+k];
    expect([layer.from,layer.soilName]).toEqual([prior,bed.soil]);
    expect(layer.src.map(l=>l.text)).toEqual([bed.to.toFixed(2),(collar-bed.to).toFixed(2),(bed.to-prior).toFixed(2),...fragments(bed)]);
    for(const {page,...box} of layer.src){
      expect(page).toBe(2);
      expect(tail.lines).toContainEqual(box);
    }
    prior=bed.to;
  }
});

it("honours selected pages even when the heading gives the final depth",()=>{
  const [head,tail]=pair(),first=readDocument([head]),second=readDocument([tail]);
  expect(first.logs[0].pages).toEqual([1]);
  expect(first.logs[0].layers.map(l=>l.to)).toEqual(bases(upper));
  expect(second.logs).toEqual([]);
  expect(second.unread).toMatchObject([{page:2,log:true}]);
});

it.each([
  ["different printed filename",(p:PageLines)=>replaceText(p,banner(7,10),banner(7,10,"other-column.pdf"))],
  ["different sheet count",(p:PageLines)=>replaceText(p,"2/2 ページ","2/3 ページ")],
  ["nonadjacent physical page",(p:PageLines)=>({...p,page:3})],
  ["different depth window",(p:PageLines)=>replaceText(p,banner(7,10),banner(6,10))],
  ["different page geometry",(p:PageLines)=>({...p,width:p.width+8})],
  ["inconsistent thickness",(p:PageLines)=>replaceText(p,"0.77","0.92")],
  ["one-centimetre elevation discrepancy",(p:PageLines)=>replaceText(p,"83.79","83.80")],
  ["missing final measurement",(p:PageLines)=>({...p,lines:p.lines.filter(l=>l.text!=="82.92")})],
  ["penetration-test depths alone",(p:PageLines)=>({...p,lines:p.lines.filter(l=>l.cx!==axis.base)})],
  ["missing material",(p:PageLines)=>({...p,lines:p.lines.filter(l=>l.cx!==axis.soil)})]
] as const)("leaves the continuation with %s for review",(_reason,change)=>{
  const [head,tail]=pair(),next=change(tail),{logs,unread}=readDocument([head,next]);
  expect(logs[0].layers.map(l=>l.to)).toEqual(bases(upper));
  expect(unread).toMatchObject([{page:next.page,log:true}]);
});

it("checks the first sheet's last measured bed before borrowing its columns",()=>{
  const [head,tail]=pair(),wrongAnchor=replaceText(head,"85.82","85.81"),{logs,unread}=readDocument([wrongAnchor,tail]);
  expect(logs[0].layers.map(l=>l.to)).toEqual(bases(upper));
  expect(unread).toMatchObject([{page:2,log:true}]);
});

it("preserves long-ruler reading across three sheets and rejects an unrelated middle sheet",()=>{
  const middle=[{to:8.94,soil:"泥炭"},{to:11.71,soil:"粗砂"},{to:14.28,soil:"頁岩"}];
  const bottom=[{to:15.83,soil:"礫岩"},{to:18.76,soil:"粘土"},{to:20.64,soil:"砂岩"}];
  const common={count:3,final:bottom[2].to,longRuler:true};
  const head=sheet({...common,page:1,start:0,end:7,prior:0,beds:upper});
  const mid=sheet({...common,page:2,start:7,end:15,prior:upper[2].to,beds:middle});
  const end=sheet({...common,page:3,start:15,end:21,prior:middle[2].to,beds:bottom});
  const {logs,parts,unread}=readDocument([head,mid,end]);
  expect(unread).toEqual([]);
  expect(parts.every(part=>!part.printedBeds)).toBe(true);
  expect(logs[0].pages).toEqual([1,2,3]);
  expect(logs[0].layers.map(l=>l.to)).toEqual(bases([...upper,...middle,...bottom]));
  const different=replaceText(mid,banner(7,15),banner(7,15,"separate-column.pdf"));
  expect(readDocument([head,different,end]).logs[0].pages).toEqual([1]);
});

it("points to the corroborated printed rows when a separate graphical column contradicts them",()=>{
  const [head]=pair();
  const decoys=[0.64,1.63,3.7,5.14,6.65];
  // A second column fits the ruler but contains test depths. The three labelled
  // measurement columns agree independently on the actual contacts.
  head.lines.push(...decoys.map(d=>label(d.toFixed(2),axis.tests,260+50*d)));
  const {logs}=readDocument([head]),affected=logs[0].layers.filter(l=>l.why?.includes("matching printed row"));
  expect(affected.length).toBeGreaterThan(0);
  expect(affected[0].why).toContain("printed layer bases missing from this reading: 2.35, 4.8 m");
  expect(affected[0].src.some(l=>l.page===1&&l.cx===axis.base&&l.text==="2.35")).toBe(true);
});
