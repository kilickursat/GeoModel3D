// Units from logged descriptions: the first rule whose pattern matches an interval's description, and whose ranges
// (if any) contain the median SPT N-value inside the interval and the elevation of its top, gives its unit. An
// interval that no rule matches keeps its description as its unit, so nothing is dropped silently; such
// descriptions are counted.
import {Borehole,UnitRule,sptN} from "./schema";

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

// A first grouping of soil and rock descriptions in English (BS 5930, ASTM D2488 and the like), Dutch, French, German,
// Spanish, Portuguese or Italian by their principal material, to start from when no stratigraphy is defined: the
// first soil noun of the description, so "Firm grey slightly sandy CLAY with gravel" is Clay and "Sable argileux" is
// Sand; adjectives (sandy, argileux…) do not count. Like the Japanese rules below, it describes lithology, not
// formations.
const SOILS={
  clay:"clay|klei|argile|ton|arcilla|argila|argilla",
  silt:"silt|leem|limon|schluff|lehm|limo|loess|löss",
  sand:"sand|zand|sable|arena|areia|sabbia",
  gravel:"gravel|cobbles|boulders|grind|keien|gravier|galets|cailloux|pierres|kies|steine|grava|cascalho|ghiaia|ciottoli",
  peat:"peat|veen|tourbe|torf|turba|torba"
};
const firstNoun=(soil:keyof typeof SOILS)=>{
  const others=(Object.keys(SOILS) as Array<keyof typeof SOILS>).filter(k=>k!==soil).map(k=>SOILS[k]).join("|");
  return `^(?:(?!\\b(?:${others})\\b).)*\\b(?:${SOILS[soil]})\\b`;
};
// Rock names count where they come before any soil noun: "SAND, some silt, trace rock fragments" is sand, "fractured
// rock" and "MUDSTONE, weathered to clay" are rock. The names are those of the BGS Rock Classification Scheme (British
// Geological Survey, Open Government Licence v3.0), grouped by principal material: the sedimentary rocks by grain, the
// igneous and metamorphic rocks together as rock. A rock name gives a unit only: layers named alike stay layers.
const ALL_SOILS=Object.values(SOILS).join("|");
const rockFirst=(names:string)=>`^(?:(?!\\b(?:${ALL_SOILS})\\b).)*\\b(?:${names})`;
// Whole words, also in the plural: "shales" is shale, but "rockfill" and "chalky" are no rock.
const words=(names:string)=>`(?:${names})(?:e?s)?\\b`;
const IGNEOUS="granite|granodiorite|tonalite|monzonite|syenite|diorite|gabbro|norite|anorthosite|dolerite|diabase|"+
  "peridotite|dunite|harzburgite|lherzolite|wehrlite|pyroxenite|hornblendite|serpentinite|kimberlite|lamprophyre|"+
  "pegmatite|aplite|porphyry|felsite|basalt|andesite|dacite|rhyolite|trachyte|phonolite|latite|obsidian|pitchstone|"+
  "ignimbrite|agglomerate|pumice|scoria|tuff|lapillistone|hyaloclastite|volcanic breccia";
const METAMORPHIC="gneiss|schist|phyllite|slate|quartzite|marble|hornfels|amphibolite|eclogite|granulite|migmatite|"+
  "mylonite|cataclasite|greenstone|metabasalt|metagabbro|skarn|serpentinised peridotite";
export const lithologyRules:UnitRule[]=[
  // Road layers are made ground too: aggregate, granular base and subbase, base course.
  {match:"made ground|\\b(?:back)?fill\\b|top\\s?soil|concrete|asphalt|tarmac|rubble|hardcore|\\bbrick|\\bslag\\b|\\baggregate\\b|granular (?:base|sub-?base)|base course|\\bsub-?base\\b|antropogeen|ophoging|\\bpuin\\b|\\bbeton\\b|remblai|terrain rapporté|terre végétale|auff[üu]llung|mutterboden|relleno|aterro|riporto",unit:"Made ground"},
  {match:firstNoun("peat"),unit:"Peat"},
  {match:rockFirst(words("mudstone|siltstone|claystone|shale|marl|argillite|mudrock")),unit:"Mudstone and siltstone"},
  {match:rockFirst(words("sandstone|conglomerate|(?<!volcanic )breccia|greywacke|graywacke|arkose|wacke|arenite|gritstone")),unit:"Sandstone"},
  {match:rockFirst(`${words("limestone|chalk|dolomite|dolostone|travertine|tufa")}|kalksteen|krijt\\b`),unit:"Limestone and chalk"},
  {match:rockFirst(words(`${IGNEOUS}|${METAMORPHIC}|chert|ironstone|rock|bedrock`)),unit:"Rock"},
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
