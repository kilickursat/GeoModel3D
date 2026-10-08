// Geotechnical borehole research (BHR-GT) from the Dutch Key Register of the Subsurface (BRO, Basisregistratie
// Ondergrond), as IMBRO XML from the BRO web service or BROloket: position, surface level, the described layers, the
// groundwater level and laboratory determinations.
import {parseXml,withoutPrefixes,XmlNode,descendants,childNodes,textOf} from "./xml";
import {TestResult} from "./geology";

export interface BroLog {
  id:string; file:string;
  x:number; y:number; srs:string; lat:number; lon:number;
  z:number; reference:string; datum:string;
  depth:number; water?:number;
  intervals:Array<{from:number;to:number;name:string}>;
  tests:TestResult[]; notes:string[];
}

export const isBroXml=(text:string)=>/broservices\.nl\/xsd\/(?:dsbhr-gt|bhrgtcommon)/.test(text.slice(0,4000));

const num=(s:string)=>s===""?NaN:Number(s);
// Soil names are Dutch compounds ("zwakSiltigZandMetGrind"); they are written English first, principal soil leading,
// with the Dutch after: "Sand, slightly silty, with gravel (zwak siltig zand met grind)".
const WORDS:Record<string,string>={
  zand:"sand",klei:"clay",silt:"silt",veen:"peat",grind:"gravel",leem:"loam",keien:"cobbles",stenen:"boulders",
  siltig:"silty",siltige:"silty",kleiig:"clayey",kleiige:"clayey",zandig:"sandy",zandige:"sandy",grindig:"gravelly",grindige:"gravelly",
  humeus:"humic",humeuze:"humic",venig:"peaty",venige:"peaty",lemig:"loamy",lemige:"loamy",organisch:"organic",organische:"organic",
  zwak:"slightly",matig:"moderately",sterk:"strongly",uiterst:"extremely",met:"with",schelpen:"shells",schelphoudend:"shelly"
};
const NOUNS=new Set(["zand","klei","silt","veen","grind","leem","keien","stenen"]);
const SPECIAL:Record<string,string>={
  betonOngebroken:"Concrete",betonGebroken:"Broken concrete",puin:"Rubble",baksteen:"Brick",asfalt:"Asphalt",slakken:"Slag",
  schelpmateriaal:"Shells",houtGebruikt:"Wood",hout:"Wood",metaal:"Metal",kunststof:"Plastic",glas:"Glass",bodemas:"Ash",
  steenkool:"Coal",grondwater:"Water",water:"Water",luchtOfLeegte:"Void"
};
export function soilName(code:string){
  const words=code.replace(/([a-z])([A-Z])/g,"$1 $2").toLowerCase().split(/\s+/).filter(Boolean);
  const at=words.findIndex(w=>NOUNS.has(w));
  if(at<0)return words.join(" ");
  const tr=(w:string)=>WORDS[w]??w;
  const modifiers=words.slice(0,at).map(tr).join(" "),rest=words.slice(at+1);
  const after=rest.length?(rest[0]==="met"?`, with ${rest.slice(1).map(tr).join(" ")}`:` ${rest.map(tr).join(" ")}`):"";
  const noun=tr(words[at]);
  return `${noun[0].toUpperCase()}${noun.slice(1)}${modifiers?`, ${modifiers}`:""}${after} (${words.join(" ")})`;
}
const special=(code:string)=>`${SPECIAL[code]??code.replace(/([a-z])([A-Z])/g,"$1 $2").toLowerCase()} (${code})`;

function layerName(layer:XmlNode){
  const soil=childNodes(layer,"soil")[0];
  const code=soil?textOf(soil,"geotechnicalSoilName")||textOf(soil,"soilNameNEN5104"):"";
  const material=textOf(layer,"specialMaterial");
  const name=code?soilName(code):material?special(material):"Not described";
  return textOf(layer,"anthropogenic")==="ja"&&!/^made ground/i.test(name)?`Made ground: ${name}`:name;
}
// The field description when there is one (the laboratory may describe only its samples), else the first log.
function boreholeLog(root:XmlNode){
  const logs=descendants(root,"descriptiveBoreholeLog");
  return logs.find(l=>textOf(l,"descriptionLocation")==="veld")??logs[0];
}
// Laboratory determinations on investigated intervals; densities become unit weights.
const G=9.80665;
const LAB:Array<[string,string,string,number]>=[
  ["waterContentDetermination","waterContent","w",1],["volumetricMassDensityDetermination","volumetricMassDensity","gamma",G],
  ["organicMatterContentDetermination","organicMatterContent","organic",1],["particleSizeDistributionDetermination","fractionSmaller63um","fines",1],
  ["consistencyLimitsDetermination","liquidLimit","LL",1],["consistencyLimitsDetermination","plasticLimit","PL",1],["consistencyLimitsDetermination","plasticityIndex","PI",1],
  ["maximumUndrainedShearStrengthDetermination","maximumUndrainedShearStrength","su",1]
];
function labTests(root:XmlNode){
  const tests:TestResult[]=[];
  for(const iv of descendants(root,"investigatedInterval")){
    const depth=num(textOf(iv,"beginDepth")),to=num(textOf(iv,"endDepth"));
    if(!Number.isFinite(depth))continue;
    for(const [determination,element,property,scale] of LAB)for(const d of childNodes(iv,determination)){
      // The water content of a determination is its own; water contents inside consistency limits are test points.
      const holder=determination==="waterContentDetermination"?childNodes(d,"determinationResult")[0]??d:d;
      const value=num(textOf(holder,element))*scale;
      if(Number.isFinite(value))tests.push({depth,...(Number.isFinite(to)&&to>depth?{to}:{}),property,value});
    }
  }
  return tests;
}

export function readBroXml(text:string,file:string):BroLog[]{
  const doc=withoutPrefixes(parseXml(text));
  const objects=descendants(doc,"BHR_GT_O");
  if(!objects.length)throw new Error(`${file}: no BRO geotechnical borehole (BHR_GT_O) in the file`);
  return objects.map(o=>{
    const notes:string[]=[];
    const delivered=descendants(childNodes(o,"deliveredLocation")[0]??o,"Point")[0];
    const srs=delivered?.attrs.srsName??"";
    const pos=(n?:XmlNode)=>n?textOf(n,"pos").split(/\s+/).map(Number):[NaN,NaN];
    const standard=pos(descendants(childNodes(o,"standardizedLocation")[0]??{tag:"",attrs:{},children:[],text:""},"location")[0]);
    let [x,y]=pos(delivered);
    if(!/28992$/.test(srs)){x=NaN;y=NaN}
    const vertical=childNodes(o,"deliveredVerticalPosition")[0];
    const reference=vertical?textOf(vertical,"localVerticalReferencePoint"):"",datum=vertical?textOf(vertical,"verticalDatum"):"";
    const z=vertical?num(textOf(vertical,"offset")):NaN;
    if(reference&&reference!=="maaiveld")notes.push(`levels are from the ${reference==="waterbodem"?"water bottom":reference}, not the ground surface`);
    if(datum&&datum!=="NAP")notes.push(`vertical datum ${datum}, not NAP`);
    const log=boreholeLog(o);
    const intervals=(log?childNodes(log,"layer"):[]).map(l=>({from:num(textOf(l,"upperBoundary")),to:num(textOf(l,"lowerBoundary")),name:layerName(l)}))
      .filter(i=>Number.isFinite(i.from)&&Number.isFinite(i.to)&&i.to>i.from);
    if(!intervals.length)notes.push("no described layers");
    const boring=childNodes(o,"boring")[0];
    const final=boring?num(textOf(boring,"finalDepthBoring")):NaN,water=boring?num(textOf(boring,"groundwaterLevel")):NaN;
    const logged=intervals.length?Math.max(...intervals.map(i=>i.to)):0;
    return {
      id:textOf(o,"broId")||file.replace(/\.[^.]+$/,""),file,x,y,srs,lat:standard[0],lon:standard[1],z,reference,datum,
      depth:Number.isFinite(final)?Math.max(final,logged):logged,...(Number.isFinite(water)?{water}:{}),
      intervals,tests:labTests(o),notes
    };
  });
}
