// Boreholes and their interpretations from DOV (Databank Ondergrond Vlaanderen), the subsurface database of Flanders,
// as the XML that DOV serves for a borehole (data/boring/…) or an interpretation (data/interpretatie/…). Positions are
// in Belgian Lambert 72 with heights in metres TAW.
import {parseXml,withoutPrefixes,XmlNode,descendants,childNodes,textOf} from "./xml";
import stratigraphy from "./data/dov-stratigraphy.json";

export interface DovBoring { id:string; permkey:string; file:string; x:number; y:number; z:number; srs:string; depth:number; date?:string }
export interface DovInterpretation {
  kind:InterpretationKind; boring:string; permkey:string; file:string; date:string; reliability:string;
  layers:Array<{from:number;to:number;code:string;name:string}>;
}
// From the most to the least geological: formal lithostratigraphy, Quaternary and informal stratigraphy, then the
// logged descriptions and geotechnical coding.
export const interpretationKinds=["formelestratigrafie","quartairstratigrafie","informelestratigrafie","lithologischebeschrijving","geotechnischecodering","gecodeerdelithologie"] as const;
export type InterpretationKind=typeof interpretationKinds[number];
export const kindNames:Record<InterpretationKind,string>={
  formelestratigrafie:"formal stratigraphy",quartairstratigrafie:"Quaternary stratigraphy",informelestratigrafie:"informal stratigraphy",
  lithologischebeschrijving:"lithological description",geotechnischecodering:"geotechnical coding",gecodeerdelithologie:"coded lithology"
};

export const isDovXml=(text:string)=>/kern\.schemas\.dov\.vlaanderen\.be/.test(text.slice(0,3000));

const codes:Record<string,string>=stratigraphy.codes;
// Lithostratigraphic names in English: "Formatie van Boom" is the Boom Formation, "Lid van Antwerpen (Formatie van
// Berchem)" the Antwerpen Member of the Berchem Formation.
export function stratigraphicName(code:string){
  const nl=codes[code];
  if(code==="Q")return "Quaternary deposits";
  if(code==="A")return "Made ground (anthropogenic)";
  if(!nl)return code;
  return nl.replace(/^Formatie van (.+)$/,"$1 Formation").replace(/^Groep van (.+)$/,"$1 Group")
    .replace(/^Lid van ([^(]+?)\s*\(Formatie van ([^)]+)\)$/,"$1 Member ($2 Formation)");
}
const byName=new Map(Object.entries(codes).map(([c,n])=>[n,c]));
// The formation a member belongs to, by its name; formations and groups are their own.
export function formationOf(code:string){
  const parent=codes[code]?.match(/\((Formatie van [^)]+)\)$/)?.[1];
  return parent&&byName.has(parent)?byName.get(parent)!:code;
}

const num=(s:string)=>s===""?NaN:Number(s.replace(",","."));
function layerOf(kind:InterpretationKind,l:XmlNode){
  const from=num(textOf(l,"van")),to=num(textOf(l,"tot"));
  if(kind==="formelestratigrafie"||kind==="quartairstratigrafie"){
    const lid1=textOf(l,"lid1"),lid2=textOf(l,"lid2"),relation=textOf(l,"relatie_lid1_lid2");
    const name=stratigraphicName(lid1)+(lid2&&lid2!==lid1?` ${relation==="T"?"to":"or"} ${stratigraphicName(lid2)}`:"");
    return {from,to,code:lid1,name};
  }
  if(kind==="geotechnischecodering"||kind==="gecodeerdelithologie"){
    const main=childNodes(l,"hoofdnaam").map(h=>textOf(h,"grondsoort")).filter(Boolean).join("+");
    return {from,to,code:main,name:main};
  }
  const text=textOf(l,"beschrijving");
  return {from,to,code:"",name:text||"(not described)"};
}

export function readDovXml(text:string,file:string){
  const doc=withoutPrefixes(parseXml(text));
  const borings:DovBoring[]=descendants(doc,"boring").filter(b=>b.children.length).map(b=>{
    const point=descendants(childNodes(b,"ligging")[0]??b,"Point")[0];
    const [x,y,z]=(point?textOf(point,"pos"):"").split(/\s+/).map(Number);
    const ident=childNodes(b,"dataidentifier")[0];
    return {id:textOf(b,"identificatie"),permkey:ident?textOf(ident,"permkey"):"",file,x,y,z:Number.isFinite(z)?z:NaN,srs:point?.attrs.srsName??"",
      depth:num(textOf(b,"diepte_tot")),date:textOf(b,"datum_aanvang")||undefined};
  });
  const interpretations:DovInterpretation[]=[];
  for(const holder of descendants(doc,"interpretaties"))for(const n of holder.children){
    const kind=n.tag as InterpretationKind;
    if(!interpretationKinds.includes(kind))continue;
    const ident=childNodes(n,"dataidentifier")[0];
    interpretations.push({kind,boring:textOf(n,"boring")||textOf(n,"sondering"),permkey:ident?textOf(ident,"permkey"):"",file,
      date:textOf(n,"datum"),reliability:childNodes(n,"betrouwbaarheid")[0]?.text.trim()??"",
      layers:childNodes(n,"laag").map(l=>layerOf(kind,l)).filter(l=>Number.isFinite(l.from)&&Number.isFinite(l.to)&&l.to>l.from)});
  }
  if(!borings.length&&!interpretations.length)throw new Error(`${file}: no DOV borehole or interpretation in the file`);
  return {borings,interpretations};
}
