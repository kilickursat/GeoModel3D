// Units from logged descriptions: the first rule whose pattern matches an interval's description, and whose ranges
// (if any) contain the median SPT N-value inside the interval and the elevation of its top, gives its unit. An
// interval that no rule matches keeps its description as its unit, so nothing is dropped silently; such
// descriptions are counted.
import {Borehole,UnitRule,sptN} from "./geology";

const median=(v:number[])=>{const s=[...v].sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2};
const literal=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
// An invalid regular expression is matched as plain text.
export function rulePattern(match:string){try{return new RegExp(match,"iu")}catch{return new RegExp(literal(match),"iu")}}

export function intervalN(b:Borehole,from:number,to:number){
  const n=(b.spt??[]).filter(t=>t.depth>=from&&t.depth<to).map(sptN);
  return n.length?median(n):NaN;
}

export function applyUnitRules(boreholes:Borehole[],rules:UnitRule[]){
  const compiled=rules.map(r=>({...r,re:rulePattern(r.match)}));
  const unmatched=new Map<string,number>();
  const out=boreholes.map(b=>({...b,intervals:b.intervals.map(i=>{
    if(i.name===undefined)return i;
    const n=intervalN(b,i.from,i.to),top=b.z-i.from;
    const rule=compiled.find(r=>r.re.test(i.name!)&&(r.minN===undefined||n>=r.minN)&&(r.maxN===undefined||n<r.maxN)
      &&(r.minZ===undefined||top>=r.minZ)&&(r.maxZ===undefined||top<r.maxZ));
    if(!rule)unmatched.set(i.name,(unmatched.get(i.name)??0)+1);
    return {...i,unit:rule?rule.unit:i.name};
  })}));
  return {boreholes:out,unmatched};
}

// A first grouping of soil and rock descriptions in English (BS 5930, ASTM D2488 and the like) or Dutch by their
// principal material, to start from when no stratigraphy is defined: the first soil noun of the description, so
// "Firm grey slightly sandy CLAY with gravel" is Clay and "Sand, silty, with gravel" is Sand; adjectives (sandy,
// clayey…) do not count. Like the Japanese rules below, it describes lithology, not formations.
const SOILS={clay:"clay|klei",silt:"silt|leem",sand:"sand|zand",gravel:"gravel|cobbles|boulders|grind|keien",peat:"peat|veen"};
const firstNoun=(soil:keyof typeof SOILS)=>{
  const others=(Object.keys(SOILS) as Array<keyof typeof SOILS>).filter(k=>k!==soil).map(k=>SOILS[k]).join("|");
  return `^(?:(?!\\b(?:${others})\\b).)*\\b(?:${SOILS[soil]})\\b`;
};
export const lithologyRules:UnitRule[]=[
  {match:"made ground|\\b(?:back)?fill\\b|topsoil|concrete|asphalt|tarmac|rubble|hardcore|\\bbrick|\\bslag\\b|antropogeen|ophoging|\\bpuin\\b|\\bbeton\\b",unit:"Made ground"},
  {match:firstNoun("peat"),unit:"Peat"},
  {match:"mudstone|siltstone|claystone|shale|\\bmarl",unit:"Mudstone and siltstone"},
  {match:"sandstone|conglomerate|breccia",unit:"Sandstone"},
  {match:"limestone|chalk|dolomite|kalksteen|\\bkrijt\\b",unit:"Limestone and chalk"},
  {match:"granite|basalt|andesite|rhyolite|diorite|gabbro|gneiss|schist|quartzite|slate|\\btuff\\b|\\brock\\b|bedrock",unit:"Rock"},
  {match:firstNoun("gravel"),unit:"Gravel"},
  {match:firstNoun("sand"),unit:"Sand"},
  {match:firstNoun("silt"),unit:"Silt"},
  {match:firstNoun("clay"),unit:"Clay"}
];

// A first grouping of Japanese soil and rock names by their principal material (the last word of the name), to
// start from when no stratigraphy is defined. It describes lithology, not formations: edit the rules to model those.
export const japaneseLithologyRules:UnitRule[]=[
  {match:"盛土|埋土|表土|客土|コンクリート|アスファルト|舗装|砕石|廃棄物",unit:"Fill and topsoil"},
  {match:"腐植|泥炭|ピート|有機質",unit:"Organic soil"},
  {match:"ローム|火山灰|黒ボク|軽石",unit:"Volcanic ash soil"},
  {match:"岩|固結",unit:"Rock and cemented soil"},
  {match:"(礫|玉石|転石|礫質土)$",unit:"Gravel"},
  {match:"(砂|砂質土)$",unit:"Sand"},
  {match:"(シルト|粘土|粘性土)$",unit:"Clay and silt"}
];
