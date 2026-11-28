// Invented records in two generations of the Japanese electronic-delivery format.
function boringXml(version:string,datum:string,id:string,seconds:number,z:number){
  const modern=version==="4.00";
  const layers=modern?"工学的地質区分名現場土質名":"土質岩種区分";
  const name=modern?layers:"土質岩種区分1";
  const beds:Array<[number,string]>=[[1.25,"埋土"],[3.75,"中砂"],[5,"シルト"],[7.5,"砂礫"]];
  const layer=(base:number,soil:string)=>`<${layers}><${layers}_下端深度>${base}</${layers}_下端深度><${layers}_${name}>${soil}</${layers}_${name}></${layers}>`;
  const spt=(depth:number,blows:number,mm:number)=>`<標準貫入試験><標準貫入試験_開始深度>${depth}</標準貫入試験_開始深度><標準貫入試験_合計打撃回数>${blows}</標準貫入試験_合計打撃回数><標準貫入試験_合計貫入量>${modern?mm:mm/10}</標準貫入試験_合計貫入量></標準貫入試験>`;
  return `<ボーリング情報 DTD_version="${version}"><ボーリング名>${id}</ボーリング名><測地系>${datum}</測地系>
    <経度緯度情報><経度_度>139</経度_度><経度_分>50</経度_分><経度_秒>${seconds}</経度_秒><緯度_度>36</緯度_度><緯度_分>0</緯度_分><緯度_秒>${seconds}</緯度_秒></経度緯度情報>
    <孔口標高>${z}</孔口標高><総掘進長>7</総掘進長><角度>0</角度>
    ${beds.map(([to,soil])=>layer(to,soil)).join("")}${spt(2,11,300)}${spt(6,50,80)}
    <孔内水位><孔内水位_孔内水位>2.25</孔内水位_孔内水位></孔内水位><孔内水位><孔内水位_孔内水位>2.6</孔内水位_孔内水位></孔内水位></ボーリング情報>`;
}
export const japaneseXml=[
  {name:"synthetic-v4.xml",text:boringXml("4.00","02","FICTION-4",0,37)},
  {name:"synthetic-v4-older-datum.xml",text:boringXml("4.00","01","FICTION-4B",15,41)},
  {name:"synthetic-v2.xml",text:boringXml("2.10","1","",30,33)}
];
