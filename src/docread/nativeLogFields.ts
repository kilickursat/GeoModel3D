// Latitude or longitude in degrees, minutes and seconds ("36° 20’ 27.6574”", "40°12′52.9″", "140度21分49.38秒"); the
// degree sign may be read as "゚" or "゜". Minutes and seconds under 60.
export const DMS=String.raw`(\d{1,3})\s*[°゚゜º度]\s*(\d{1,2})\s*['’′‘分]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:["”″“]|''|′′|’’|秒)?`;

export const SOIL_NAME=/砂|礫|粘土|粘性土|シルト|ローム|火山灰|岩|盛土|埋土|表土|腐植|泥炭|玉石|有機質|チャート|互層|[(（][A-Z][A-Za-z\-\/]*[)）]/;

export const SOIL_CODE=/^[(（][A-Z][A-Za-z\-\/]*[)）]$/;
const NUMERIC_COLUMNS=/^[-+]?\d+(?:[.,]\d+)?(?:\s+[-+]?\d+(?:[.,]\d+)?){1,2}(?:\s|$)/;
const JAPANESE=/[ぁ-ヿ㐀-鿿]/;
const NAME_FRAGMENT=/^[ぁ-ヿ㐀-鿿・、ー（）()A-Z/-]+$/;

// Native text order can put all coordinate labels in the header and their values many lines later.
// Track the original rows to quote; never assign a value to a borehole or construct an interval here.
export function nativeReportFieldRows(lines:readonly string[]){
  const location=new Set<number>(),layers=new Set<number>();
  const text=lines.join("\n");
  // Include every original row spanned by a label: a vertical column title may be one character per row.
  const mark=(match:RegExpExecArray|null,target:Set<number>)=>{
    if(!match)return;
    const first=text.slice(0,match.index).split("\n").length-1;
    const count=match[0].split("\n").length;
    for(let i=0;i<count;i++)target.add(first+i);
  };

  if(/Lambert/i.test(text)){
    // A naked X/Y pair may be an unrelated numerical table. Require the frame printed beside each axis.
    const axis=(key:string)=>new RegExp(String.raw`\b${key}[ \t]*\([^()\n]{0,24}Lambert[^()\n]{0,16}\)[ \t]*[:=]?[ \t]*(?:\n[ \t]*)?[-+]?\d+(?:[.,]\d+)?`,"i").exec(text);
    const x=axis("x"),y=axis("y");
    if(x&&y){
      mark(x,location);mark(y,location);
      mark(/\bproefnummer\s*:\s*[^\s]+/i.exec(text),location);
    }
  }

  if(!JAPANESE.test(text))return {location,layers};
  const lat=/(?:北\s*緯|南\s*緯|緯\s*度)/.exec(text),lon=/(?:東\s*経|西\s*経|経\s*度)/.exec(text);
  if(lat&&lon){
    const degrees=[...text.matchAll(new RegExp(DMS,"g"))].filter(m=>+m[1]<=180&&+m[2]<60&&Number(m[3].replace(",","."))<60);
    if(degrees.length>=2&&degrees.slice(0,2).some(m=>+m[1]<=90)){
      mark(lat,location);mark(lon,location);
      for(const dms of degrees.slice(0,2))mark(dms,location);
      mark(/ボーリング\s*(?:名|番号)|孔\s*番\s*号/.exec(text),location);
    }
  }

  const soil=/(?:土\s*質(?:\s*区\s*分)?|地\s*層\s*名)/.exec(text);
  const depth=/深\s*度\s*(?:[（(]\s*m\s*[)）])?/i.exec(text);
  if(!soil||!depth)return {location,layers};
  let records=0;
  for(let i=0;i<lines.length&&records<3;i++){
    const line=lines[i];
    if(!NUMERIC_COLUMNS.test(line))continue;
    const material=SOIL_NAME.test(line)?i:i+1;
    if(!JAPANESE.test(lines[material]??"")||!SOIL_NAME.test(lines[material]))continue;
    records++;layers.add(i);layers.add(material);
    // Short wrapped fragments complete the native material name. Stop before another number or header.
    for(let j=material+1;j<=material+3&&lines[j]?.length<=12&&NAME_FRAGMENT.test(lines[j]);j++){
      layers.add(j);
      if(SOIL_CODE.test(lines[j]))break;
    }
  }
  if(records){
    mark(soil,layers);mark(depth,layers);
    mark(/層\s*厚\s*(?:[（(]\s*m\s*[)）])?/i.exec(text),layers);
    mark(/(?:ボーリング)?柱\s*状\s*図/.exec(text),layers);
  }
  return {location,layers};
}
