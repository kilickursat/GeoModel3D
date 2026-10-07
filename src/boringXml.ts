// Borehole logs in the Japanese electronic-delivery format (地質・土質調査成果電子納品要領, ボーリング交換用データ),
// versions 2 to 4, as delivered with public-works site investigations and served by KuniJiban.
import {parseXml,XmlNode,descendants,textOf} from "./xml";
import {SptTest,WaterLevel} from "./geology";

export type Datum="JGD2011"|"JGD2000"|"Tokyo"|"unknown";
export interface BoringLog {
  id:string; survey:string; file:string; version:string;
  lon:number; lat:number; datum:Datum;
  z:number; depth:number; angle:number;
  intervals:Array<{from:number;to:number;name:string}>;
  spt:SptTest[]; water:WaterLevel[]; notes:string[];
}

export const isBoringXml=(text:string)=>/<ボーリング情報[\s>]/.test(text.slice(0,2000));

const num=(s:string)=>s===""?NaN:Number(s);
// 測地系: 0 Tokyo datum, 1 JGD2000, 2 JGD2011 (two digits from version 4).
function datum(code:string):Datum{
  const c=Number(code);
  return code===""||!Number.isFinite(c)?"unknown":c===0?"Tokyo":c===1?"JGD2000":c===2?"JGD2011":"unknown";
}
function dms(n:XmlNode,axis:"経度"|"緯度"){
  const d=num(textOf(n,axis+"_度")),m=num(textOf(n,axis+"_分")),s=num(textOf(n,axis+"_秒"));
  return d+(Number.isFinite(m)?m:0)/60+(Number.isFinite(s)?s:0)/3600;
}

export function readBoringXml(text:string,file:string):BoringLog{
  const root=parseXml(text).children.find(c=>c.tag==="ボーリング情報");
  if(!root)throw new Error(`${file}: not a borehole log (no ボーリング情報 element)`);
  const version=root.attrs.DTD_version??"";
  const major=Number.parseFloat(version)||0;
  const notes:string[]=[];
  const position=descendants(root,"経度緯度情報")[0];
  const lon=position?dms(position,"経度"):NaN,lat=position?dms(position,"緯度"):NaN;
  const z=num(textOf(root,"孔口標高"));
  // Intervals are given by their base depth; each starts where the one above ends. Version 4 names them
  // 工学的地質区分名現場土質名, version 3 岩石土区分 and version 2 土質岩種区分.
  const layers:Array<[string,string,string]>=[
    ["工学的地質区分名現場土質名","工学的地質区分名現場土質名_下端深度","工学的地質区分名現場土質名_工学的地質区分名現場土質名"],
    ["岩石土区分","岩石土区分_下端深度","岩石土区分_岩石土名"],
    ["土質岩種区分","土質岩種区分_下端深度","土質岩種区分_土質岩種区分1"]
  ];
  const intervals:BoringLog["intervals"]=[];
  for(const [block,base,name] of layers){
    const rows=descendants(root,block).map(b=>({to:num(textOf(b,base)),name:textOf(b,name)})).filter(r=>Number.isFinite(r.to));
    if(!rows.length)continue;
    let from=0;
    for(const r of rows.sort((a,b)=>a.to-b.to)){if(r.to>from)intervals.push({from,to:r.to,name:r.name||"(unnamed)"});from=Math.max(from,r.to)}
    break;
  }
  const logged=intervals.length?intervals[intervals.length-1].to:0;
  const total=num(textOf(root,"総削孔長")||textOf(root,"総掘進長"));
  const depth=Number.isFinite(total)?Math.max(total,logged):logged;
  if(Number.isFinite(total)&&logged>total+0.005)notes.push(`intervals reach ${logged} m, below the stated total depth of ${total} m`);
  // Penetration is recorded in millimetres from version 4 and in centimetres before.
  const scale=major>=4?1:10;
  const spt=descendants(root,"標準貫入試験").map(b=>({depth:num(textOf(b,"標準貫入試験_開始深度")),blows:num(textOf(b,"標準貫入試験_合計打撃回数")),penetration:num(textOf(b,"標準貫入試験_合計貫入量"))*scale}))
    .filter(t=>Number.isFinite(t.depth)&&Number.isFinite(t.blows)&&Number.isFinite(t.penetration));
  const water=descendants(root,"孔内水位").map(b=>({depth:num(textOf(b,"孔内水位_孔内水位")),date:textOf(b,"孔内水位_測定年月日")||undefined}))
    .filter(w=>Number.isFinite(w.depth));
  const angle=num(textOf(root,"角度")||textOf(root,"掘進角度"));
  if(Number.isFinite(angle)&&Math.abs(angle)>0.5)notes.push(`logged at ${angle}° from vertical; modelled as vertical`);
  const d=datum(textOf(root,"測地系"));
  if(d==="unknown")notes.push("geodetic datum not given; latitude and longitude taken as JGD2011");
  return {
    id:textOf(root,"ボーリング名")||file.replace(/\.[^.]+$/,""),survey:textOf(root,"調査名"),file,version,
    lon,lat,datum:d,z,depth,angle:Number.isFinite(angle)?angle:0,intervals,spt,water,notes
  };
}
