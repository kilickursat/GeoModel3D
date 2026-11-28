import type {PageLines,PageLog,ReadLayer,TextLine} from "./reconstruct";
import {SOIL_NAME} from "./nativeLogFields";

type Part=PageLog&{page:number};
interface Strip { filename:string; from:number; to:number; number:number; total:number; bottom:number }
interface Axes { elevation:number; thickness:number; depth:number; radius:number; soilLeft:number; soilRight:number }

// Short terminal strips can have one ruler mark and many SPT numbers. Identify the
// series by its own printed filename, sheet count and metric depth windows.
function strip(page:PageLines):Strip|undefined{
  const labels=page.lines.flatMap(line=>{
    const match=/^(.+\.pdf)\s*\(\s*(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*m\s*\)$/i.exec(line.text.trim());
    return match?[{line,match}]:[];
  });
  if(labels.length!==1)return;
  const {line,match}=labels[0];
  const numbers=page.lines.filter(l=>Math.abs(l.cy-line.cy)<=line.y1-line.y0)
    .flatMap(l=>/^\s*(\d+)\s*\/\s*(\d+)\s*ページ\s*$/.exec(l.text)?.slice(1).map(Number)??[]);
  if(numbers.length!==2||numbers[0]<1||numbers[0]>numbers[1]||+match[2]>=+match[3])return;
  return {filename:match[1],from:+match[2],to:+match[3],number:numbers[0],total:numbers[1],bottom:line.y1};
}

// Read the Japanese vertical column labels in one heading band. Adjacent unit
// marks establish the numeric columns. The graphic and colour headers bound the soil names.
function axes(page:PageLines):Axes|undefined{
  const units=page.lines.filter(l=>/^\(\s*m\s*\)$/i.test(l.text.trim()));
  for(const unit of units){
    const h=unit.y1-unit.y0;
    const band=page.lines.filter(l=>l.cy<unit.y0&&unit.cy-l.cy<=13*h).sort((a,b)=>a.cy-b.cy);
    const title=(word:string)=>{
      const starts=band.filter(l=>l.text.trim()===word[0]);
      return starts.filter(l=>band.filter(e=>e.cy>=l.cy&&Math.abs(e.cx-l.cx)<h/2)
        .map(e=>e.text.trim()).join("")===word);
    };
    const soilTitles=title("土質区分");
    if(soilTitles.length!==1)continue;
    const headings=["標高","層厚","深度","柱状図","土質区分","色調"].map(word=>
      title(word).filter(l=>Math.abs(l.cy-soilTitles[0].cy)<h/2));
    if(headings.some(group=>group.length!==1))continue;
    const [z,t,d,graphic,soil,colour]=headings.map(([line])=>line.cx);
    if(!(z<t&&t<d&&d<graphic&&graphic<soil&&soil<colour))continue;
    const radius=Math.min(t-z,d-t)/2;
    if(![z,t,d].every(x=>units.some(e=>Math.abs(e.cy-unit.cy)<h/2&&Math.abs(e.cx-x)<radius)))continue;
    return {elevation:z,thickness:t,depth:d,radius,soilLeft:(graphic+soil)/2,soilRight:(soil+colour)/2};
  }
}

const printedValue=(e:TextLine)=>/^[-−]?\d+(?:[.,]\d+)?$/.test(e.text.trim())?
  Number(e.text.trim().replace("−","-").replace(",",".")):NaN;
// Independent printed decimals must agree; tolerate only floating point roundoff.
const agrees=(a:number,b:number)=>Math.abs(a-b)<1e-6;
function column(lines:TextLine[],x:number,radius:number){
  return lines.filter(e=>Math.abs(e.cx-x)<radius&&Number.isFinite(printedValue(e)));
}
function atRow(lines:TextLine[],base:TextLine){
  const row=lines.filter(e=>Math.abs(e.cy-base.cy)<(base.y1-base.y0)/2);
  return row.length===1?row[0]:undefined;
}

function measuredColumns(lines:TextLine[],cols:Axes){
  return {elevations:column(lines,cols.elevation,cols.radius),thicknesses:column(lines,cols.thickness,cols.radius),
    bases:column(lines,cols.depth,cols.radius).sort((a,b)=>a.cy-b.cy)};
}
function measuredRow(base:TextLine,columns:ReturnType<typeof measuredColumns>,ground:number,from:number){
  const elevation=atRow(columns.elevations,base),thickness=atRow(columns.thicknesses,base),to=printedValue(base);
  if(!elevation||!thickness||!agrees(ground-printedValue(elevation),to)||!agrees(from+printedValue(thickness),to))return;
  return [base,elevation,thickness];
}

function beds(page:PageLines,meta:Strip,cols:Axes,ground:number,final:number,from:number):ReadLayer[]|undefined{
  const body=page.lines.filter(e=>e.cy>meta.bottom);
  const columns=measuredColumns(body,cols),{bases}=columns;
  if(!bases.length||bases.length!==columns.elevations.length||bases.length!==columns.thicknesses.length)return;
  const names=body.filter(e=>e.cx>cols.soilLeft&&e.cx<cols.soilRight).sort((a,b)=>a.cy-b.cy);
  const layers:ReadLayer[]=[];
  let above=meta.bottom;
  for(const base of bases){
    const to=printedValue(base),row=measuredRow(base,columns,ground,from);
    if(!row||to<=from||to<meta.from||to>meta.to||to>final)return;
    const material=names.filter(l=>l.cy>above&&l.cy<=base.cy);
    const soilName=material.map(e=>e.text.replace(/\s/g,"")).join("");
    if(!/[ぁ-ヿ㐀-鿿]/.test(soilName)||!SOIL_NAME.test(soilName)||/\).+/.test(soilName))return;
    layers.push({from,to,description:soilName,soilName,src:[...row,...material]});
    from=to;
    above=base.cy;
  }
  // Every row must agree, including the reported end on the last sheet. A
  // final-depth header alone never supplies a missing contact or a material.
  if(meta.number===meta.total&&!agrees(from,final))return;
  return layers;
}

export function recoverMetricStrips(pages:PageLines[],parts:Part[][]){
  const strips=pages.map(strip);
  for(let i=0;i<pages.length;i++){
    const head=parts[i][0],first=strips[i];
    if(!first||first.number!==1||first.total<2||first.from!==0||parts[i].length!==1||
        head.kind!=="scale"||head.samples||head.core||head.depthInFeet||!head.id||head.ground===undefined||head.final===undefined||
        !head.src?.id||!head.src.ground||!head.src.final)continue;
    const last=head.layers.at(-1);
    if(!last||last.flagged||last.to>first.to||last.to>=head.final)continue;
    const cols=axes(pages[i]);
    if(!cols)continue;
    // Confirm the depth column on the first sheet with its last actual logged
    // contact. A missing or badly displaced column cannot be borrowed.
    const firstColumns=measuredColumns(pages[i].lines,cols);
    const anchor=firstColumns.bases.filter(e=>printedValue(e)===last.to);
    if(anchor.length!==1||!measuredRow(anchor[0],firstColumns,head.ground,last.from))continue;
    let previous=first,from=last.to;
    for(let j=i+1;j<pages.length&&previous.number<first.total;j++){
      const page=pages[j],meta=strips[j],part=parts[j][0];
      if(!meta||page.page!==pages[j-1].page+1||meta.filename!==first.filename||meta.total!==first.total||
          meta.number!==previous.number+1||meta.from!==previous.to||page.width!==pages[i].width||page.height!==pages[i].height||
          parts[j].length!==1||part.layers.length||part.id||part.depthInFeet||part.core)break;
      const layers=beds(page,meta,cols,head.ground,head.final,from);
      if(!layers)break;
      const sources=layers.flatMap(l=>l.src);
      parts[j]=[{kind:"scale",id:head.id,page:page.page,top:meta.from,printedBeds:true,evidence:true,
        layers,used:new Set(sources),flagged:[],bounds:layers.map(l=>l.to),texts:[]}];
      from=layers[layers.length-1].to;
      previous=meta;
    }
  }
  // A positively identified continuation that failed row or identity checks
  // stays visible for review. Its SPT scale must not become a lithology scale.
  for(let i=0;i<pages.length;i++){
    const meta=strips[i];
    if(!meta||meta.number<=1)continue;
    for(const part of parts[i])if(!part.layers.length&&!part.depthInFeet){
      part.error="printed continuation sheet: borehole, depth window or layer measurements could not be verified";
      part.evidence=true;
    }
  }
}
