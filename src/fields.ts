// Fields over the model: vertical total stress, pore pressure and vertical effective stress from the unit weights and
// the water table, and measured properties interpolated within their units. They are evaluated on sections.
import {GeoModel} from "./model";
import {Section} from "./section";
import {boreholeTests,testDepth,unitAt,propertyDef,unitStatistics,measuredProperties,formatValue} from "./properties";

export const GAMMA_W=9.81;
// Used, and reported, for units given no unit weight and with none measured: typical values for soils, which overstate
// light soils such as peat or volcanic ash and understate rock.
export const ASSUMED_WEIGHT={above:18,below:20};

export const STRESS_FIELDS=[
  {key:"sv",name:"Vertical total stress",symbol:"σv",unit:"kPa"},
  {key:"u",name:"Pore water pressure",symbol:"u",unit:"kPa"},
  {key:"s",name:"Vertical effective stress",symbol:"σ′v",unit:"kPa"},
  {key:"sh",name:"Horizontal effective stress",symbol:"σ′h",unit:"kPa"}
] as const;
export type StressKey=typeof STRESS_FIELDS[number]["key"];
export const isStressField=(key:string):key is StressKey=>STRESS_FIELDS.some(f=>f.key===key);
export function fieldName(key:string){
  const f=STRESS_FIELDS.find(q=>q.key===key);
  if(f)return {name:f.name,symbol:f.symbol,unit:f.unit,log:false};
  const p=propertyDef(key);
  return {name:p.name,symbol:p.symbol,unit:p.unit,log:!!p.log};
}

// ---------- stresses ----------

export interface UnitWeight { above:number; below:number; source:"declared"|"measured"|"assumed"; n?:number }
// Unit weights above and below the water table: the unit's own (one of the two standing for both if only one is
// given), else the mean measured bulk unit weight, else the assumed values.
export function unitWeights(model:GeoModel):UnitWeight[]{
  const stats=unitStatistics(model.boreholes,model.units);
  return model.units.map(u=>{
    if(u.gamma!==undefined||u.gammaSat!==undefined)return {above:u.gamma??u.gammaSat!,below:u.gammaSat??u.gamma!,source:"declared"};
    const g=stats.get(u.id)?.get("gamma");
    if(g)return {above:g.mean,below:g.mean,source:"measured",n:g.n};
    return {...ASSUMED_WEIGHT,source:"assumed"};
  });
}
export interface Stress { sv:number; u:number; s:number }
// Stresses at elevation z on a vertical where the horizons (ground first, model base last) and the water table lie at
// the given elevations. Where the water table is at the ground, as under open water, the water above is not counted.
export function stressAt(horizons:ArrayLike<number>,water:number|undefined,weights:UnitWeight[],z:number):Stress|null{
  const K=weights.length;
  if(!(z<=horizons[0]+1e-9&&z>=horizons[K]-1e-9))return null;
  const zw=water!==undefined&&Number.isFinite(water)?water:-Infinity;
  let sv=0;
  for(let k=0;k<K;k++){
    const top=horizons[k],bottom=Math.max(horizons[k+1],z);
    if(top<=bottom)continue;
    const dry=Math.max(0,top-Math.max(bottom,zw)),wet=top-bottom-dry;
    sv+=weights[k].above*dry+weights[k].below*wet;
    if(horizons[k+1]<=z)break;
  }
  const u=z<zw?GAMMA_W*(zw-z):0;
  return {sv,u,s:sv-u};
}

// ---------- earth pressures ----------

// Rankine's coefficients of active and passive earth pressure for an effective friction angle φ′ in degrees:
// Ka = tan²(45° − φ′/2) and Kp = tan²(45° + φ′/2) = 1/Ka.
export function rankine(phi:number){const s=Math.sin(phi*Math.PI/180);return {Ka:(1-s)/(1+s),Kp:(1+s)/(1-s)}}
export type Drainage="drained"|"undrained";
// `pull`: how far the active pressure falls short of zero effective pressure, positive where the soil would pull on the
// wall. Pressures are NaN where the unit lacks the parameters they need.
export interface EarthPressure { active:number; rest:number; passive:number; pull:number }
// Earth pressures on a smooth vertical wall with level ground behind it (Rankine), where the stresses are r, in a unit
// with the parameters `params` (keys of src/properties.ts).
// - Drained (long term): effective pressures from c′ and φ′, σ′a = Ka·σ′v − 2c′√Ka and σ′p = Kp·σ′v + 2c′√Kp, with c′
//   taken as 0 where it is not given; the water pressure u acts on the wall besides them.
// - Undrained (short term): total pressures. A unit given an su: σa = σv − 2su and σp = σv + 2su. A unit without one
//   drains, and takes its effective pressures plus u.
// Where the soil would pull on the wall, it cracks: the effective pressure is taken as zero, and the total pressure as
// the water pressure. At rest, K0·σ′v where K0 is given (plus u when undrained).
export function earthPressure(params:Record<string,number>|undefined,r:Stress,drainage:Drainage):EarthPressure{
  const K0=params?.K0,su=params?.su,phi=params?.phi,c=params?.c??0;
  const water=drainage==="undrained"?r.u:0,rest=K0!==undefined?K0*r.s+water:NaN;
  if(drainage==="undrained"&&su!==undefined){
    const active=r.sv-2*su-r.u;
    return {active:Math.max(active,0)+r.u,rest,passive:r.sv+2*su,pull:-active};
  }
  if(phi===undefined)return {active:NaN,rest,passive:NaN,pull:NaN};
  const {Ka,Kp}=rankine(phi),active=Ka*r.s-2*c*Math.sqrt(Ka);
  return {active:Math.max(active,0)+water,rest,passive:Kp*r.s+2*c*Math.sqrt(Kp)+water,pull:-active};
}
export interface ProfilePoint { k:number; e:number; stress:Stress; pressure:EarthPressure }
// The stresses and earth pressures down a vertical where the horizons (ground first, model base last) and the water
// table lie at the given elevations: for each unit, points at its top, at the water table within it and at its base,
// between which all of them vary linearly, and where the soil starts or stops pulling on the wall, so that straight
// lines through the points are exact. `tension` lists the elevations between which the soil would pull on the wall.
export function pressureProfile(z:ArrayLike<number>,water:number|undefined,weights:UnitWeight[],params:Array<Record<string,number>|undefined>,drainage:Drainage){
  const segments:Array<{k:number;points:ProfilePoint[]}>=[],tension:Array<{top:number;bottom:number}>=[];
  for(let k=0;k<weights.length;k++){
    const a=z[k],b=z[k+1];
    if(a-b<1e-9)continue;
    const at=(e:number):ProfilePoint=>{const stress=stressAt(z,water,weights,e)!;return {k,e,stress,pressure:earthPressure(params[k],stress,drainage)}};
    const points=[at(a)];
    for(const e of [...(water!==undefined&&water<a&&water>b?[water]:[]),b]){
      const q=points[points.length-1],p=at(e),f=q.pressure.pull,g=p.pressure.pull;
      if(f*g<0)points.push(at(q.e+(p.e-q.e)*f/(f-g)));
      points.push(p);
    }
    segments.push({k,points});
  }
  // The pull keeps its sign between neighbouring points, so a stretch pulls where its ends add up to a pull; stretches
  // that meet, also across units, make one range.
  for(const s of segments)for(let j=1;j<s.points.length;j++){
    const p=s.points[j-1],q=s.points[j],last=tension[tension.length-1];
    if(!(p.pressure.pull+q.pressure.pull>1e-9))continue;
    if(last&&Math.abs(last.bottom-p.e)<1e-9)last.bottom=q.e;else tension.push({top:p.e,bottom:q.e});
  }
  return {segments,tension};
}
// What the earth pressures down a borehole rest on: the method, the units that lack the parameters they need, the c′
// taken as 0, and where the soil would pull on the wall. `names` are the model's unit names, `shown` the indices of the
// units in the borehole, and `tension` the depths below the ground between which the soil would pull.
export function earthPressureNotes(names:string[],shown:number[],params:Array<Record<string,number>|undefined>,drainage:Drainage,tension:Array<{from:number;to:number}>){
  const list=(f:(k:number)=>boolean)=>[...new Set(shown.filter(f).map(k=>names[k]))].join(", ");
  const bySu=(k:number)=>drainage==="undrained"&&params[k]?.su!==undefined;
  const byPhi=(k:number)=>!bySu(k)&&params[k]?.phi!==undefined;
  const su=list(bySu),phi=list(byPhi),none=list(k=>!bySu(k)&&!byPhi(k)),noC=list(k=>byPhi(k)&&params[k]?.c===undefined);
  const metres=(v:number)=>String(Math.round(v*100)/100);
  const notes=["Rankine, for a smooth vertical wall with level ground, from the ground surface down.",
    drainage==="drained"?"Drained: effective pressures from c′ and φ′; the water pressure u acts besides them."
      :`Undrained: total pressures, water included${su?`; σv ∓ 2su in ${su}`:""}${phi?`; ${phi} drained, from c′ and φ′, with u added`:""}.`];
  if(none)notes.push(`No ${drainage==="drained"?"φ′":"su or φ′"} for ${none}: no active or passive pressure there.`);
  if(noC)notes.push(`c′ not given for ${noC}: taken as 0.`);
  const ranges=tension.map(t=>`${metres(t.from)}–${metres(t.to)}`);
  if(ranges.length)notes.push(`The soil would pull on the wall at ${ranges.length>1?`${ranges.slice(0,-1).join(", ")} and ${ranges[ranges.length-1]}`:ranges[0]} m: the active pressure there is taken as ${drainage==="drained"?"zero":"the water pressure"}.`);
  return notes;
}

// ---------- measured properties ----------

export interface PropertySample { x:number; y:number; z:number; value:number }
// The values of a property measured in each unit, at their elevations.
export function propertySamples(model:GeoModel,key:string){
  const index=new Map(model.units.map((u,k)=>[u.id,k]));
  const byUnit:PropertySample[][]=model.units.map(()=>[]);
  const log=!!propertyDef(key).log;
  for(const b of model.boreholes)for(const t of boreholeTests(b)){
    if(t.property!==key||!Number.isFinite(t.value)||(log&&t.value<=0))continue;
    const d=testDepth(t),k=index.get(unitAt(b,d)??"");
    if(k!==undefined)byUnit[k].push({x:b.x,y:b.y,z:b.z-d,value:log?Math.log10(t.value):t.value});
  }
  return byUnit;
}
// Inverse-distance weighting within one unit, horizontal distances shrunk by `anisotropy`: properties vary much more
// with depth than across a site. Log-scaled properties are interpolated as logarithms.
export function interpolate(samples:PropertySample[],x:number,y:number,z:number,anisotropy=10){
  if(!samples.length)return NaN;
  let num=0,den=0;
  const a2=anisotropy*anisotropy;
  for(const p of samples){
    const d2=((p.x-x)**2+(p.y-y)**2)/a2+(p.z-z)**2;
    if(d2<1e-6)return p.value;
    const w=1/d2;
    num+=w*p.value;den+=w;
  }
  return num/den;
}

// ---------- fields on a section ----------

export interface SectionField {
  key:string; name:string; symbol:string; unit:string; log:boolean;
  // Value at distance s along the section and elevation z (log10 for log-scaled properties); NaN without data.
  at(s:number,z:number):number;
  // The unit index at (s, z), or -1 outside the model.
  unitAt(s:number,z:number):number;
  scale:ColourScale;
  notes:string[];
}
// The horizons and water table at distance s, interpolated between the section's samples (exact: horizons are linear
// along the section between them).
export function columnAt(section:Section,s:number){
  const S=section.s;
  if(S.length<2||s<S[0]-1e-9||s>S[S.length-1]+1e-9)return null;
  let lo=0,hi=S.length-1;
  while(hi-lo>1){const m=(lo+hi)>>1;if(S[m]<=s)lo=m;else hi=m}
  const t=S[hi]>S[lo]?Math.min(1,Math.max(0,(s-S[lo])/(S[hi]-S[lo]))):0;
  const lerp=(a:number[])=>a[lo]+t*(a[hi]-a[lo]);
  return {z:section.z.map(lerp),water:section.water?lerp(section.water):undefined,x:lerp(section.x),y:lerp(section.y)};
}
export function sectionField(model:GeoModel,section:Section,key:string):SectionField|null{
  if(section.s.length<2)return null;
  const info=fieldName(key),K=model.units.length,notes:string[]=[];
  const unitOf=(z:number[],e:number)=>{for(let k=0;k<K;k++)if(e<=z[k]+1e-9&&e>=z[k+1]-1e-9&&z[k]-z[k+1]>1e-9)return k;return -1};
  const unitAtSZ=(s:number,e:number)=>{const c=columnAt(section,s);return c?unitOf(c.z,e):-1};
  if(isStressField(key)){
    const weights=unitWeights(model);
    const assumed=model.units.filter((_,k)=>weights[k].source==="assumed").map(u=>u.name);
    if(assumed.length)notes.push(`Unit weights assumed (${ASSUMED_WEIGHT.above} kN/m³ above and ${ASSUMED_WEIGHT.below} kN/m³ below the water table) for ${assumed.join(", ")}`);
    const measured=model.units.map((u,k)=>weights[k].source==="measured"?`${u.name} ${formatValue("gamma",weights[k].above)} kN/m³ (mean of ${weights[k].n})`:"").filter(Boolean);
    if(measured.length)notes.push(`Unit weights from tests: ${measured.join(", ")}`);
    notes.push(model.water?`Water table: ${model.water.source}`:"No water level in the data: pore pressure is zero and effective stress equals total stress");
    // σ′h only where the unit's earth pressure coefficient at rest is given.
    const k0=model.units.map(u=>u.params?.K0);
    if(key==="sh"){
      const without=model.units.filter((_,k)=>k0[k]===undefined).map(u=>u.name);
      notes.push(`σ′h = K0 · σ′v with each unit's K0${without.length?`; not given for ${without.join(", ")}, left uncoloured`:""}`);
    }
    const value=(z:number[],water:number|undefined,e:number)=>{
      const r=stressAt(z,water,weights,e);
      if(!r)return NaN;
      if(key!=="sh")return r[key];
      const k=unitOf(z,e),K=k<0?undefined:k0[k];
      return K===undefined?NaN:K*r.s;
    };
    const at=(s:number,e:number)=>{const c=columnAt(section,s);return c?value(c.z,c.water,e):NaN};
    // The range from the ground to the model base along the section: stresses grow with depth within a unit, so the
    // largest value of each unit is at its base.
    let max=0;
    for(let j=0;j<section.s.length;j++){
      const z=section.z.map(h=>h[j]);
      for(let k=0;k<K;k++)if(z[k]-z[k+1]>1e-9){const v=value(z,section.water?.[j],z[k+1]+1e-9*(1+Math.abs(z[k+1])));if(Number.isFinite(v))max=Math.max(max,v)}
    }
    return {key,...info,at,unitAt:unitAtSZ,scale:colourScale(0,max,false),notes};
  }
  const samples=propertySamples(model,key),values=samples.flat().map(p=>p.value);
  if(!values.length)return null;
  const without=model.units.filter((_,k)=>!samples[k].length).map(u=>u.name);
  if(without.length)notes.push(`Not measured in ${without.join(", ")}`);
  notes.push(`${values.length} values, interpolated within each unit by inverse distance, with horizontal distances shortened 10 times`);
  const at=(s:number,e:number)=>{
    const c=columnAt(section,s);
    if(!c)return NaN;
    const k=unitOf(c.z,e);
    return k<0?NaN:interpolate(samples[k],c.x,c.y,e);
  };
  // The colours span the 2nd to 98th percentiles; SPT N-values stop at 50, beyond which refusals converted to 300 mm
  // would take most of the scale.
  const sorted=[...values].sort((a,b)=>a-b),q=(f:number)=>sorted[Math.min(sorted.length-1,Math.max(0,Math.round(f*(sorted.length-1))))];
  const cap=key==="N"?50:Infinity,top=Math.min(q(0.98),cap),open=sorted[sorted.length-1]>top;
  const scale=colourScale(Math.min(q(0.02),top),top,info.log,false,open);
  if(open)notes.push(`Values above ${scaleLabel({...scale,open:false},scale.edges[scale.edges.length-1])} are in the top band`);
  return {key,...info,at,unitAt:unitAtSZ,scale,notes};
}

// ---------- colour ----------

// `open`: values above the top edge fall in the top band.
export interface ColourScale { edges:number[]; colors:string[]; log:boolean; open?:boolean; colorOf(v:number):string|null }
function niceStep(range:number,count:number){
  const raw=range/Math.max(count,1),p=10**Math.floor(Math.log10(raw)),f=raw/p;
  return (f<1.5?1:f<3?2:f<7?5:10)*p;
}
// Banded single-hue scale, light to dark on light backgrounds; on dark backgrounds the ramp is reversed, so low values
// recede into the background.
export function colourScale(min:number,max:number,log:boolean,dark=false,open=false):ColourScale{
  if(!(max>min))max=min+(log?1:Math.max(Math.abs(min)*0.1,1));
  const step=log?1:niceStep(max-min,8);
  const lo=Math.floor(min/step)*step,n=Math.max(1,Math.min(12,Math.ceil((max-lo)/step-1e-9)));
  return bands(Array.from({length:n+1},(_,i)=>lo+i*step),dark,log,open);
}
export const withTheme=(c:ColourScale,dark:boolean)=>bands(c.edges,dark,c.log,c.open);
function bands(edges:number[],dark:boolean,log:boolean,open=false):ColourScale{
  const n=edges.length-1,lo=edges[0],step=edges[1]-edges[0],colors=sequentialRamp(n);
  if(dark)colors.reverse();
  return {edges,colors,log,open,colorOf(v:number){
    if(!Number.isFinite(v))return null;
    return colors[Math.min(n-1,Math.max(0,Math.floor((v-lo)/step)))];
  }};
}
// n steps of an orange ramp evenly spaced in OKLCH lightness (0.95 to 0.35), so equal value steps look equal; blue
// stays free for water.
export function sequentialRamp(n:number){
  return Array.from({length:n},(_,i)=>{
    const t=n===1?0.5:i/(n-1),L=0.95-0.6*t,C=0.05+0.12*Math.min(1,t*2.2),h=62-24*t;
    return oklchHex(L,C,h);
  });
}
function oklchHex(L:number,C:number,h:number){
  for(let c=C;c>=0;c-=0.002){
    const a=c*Math.cos(h*Math.PI/180),b=c*Math.sin(h*Math.PI/180);
    const l=(L+0.3963377774*a+0.2158037573*b)**3,m=(L-0.1055613458*a-0.0638541728*b)**3,s=(L-0.0894841775*a-1.2914855480*b)**3;
    const rgb=[4.0767416621*l-3.3077115913*m+0.2309699292*s,-1.2684380046*l+2.6097574011*m-0.3413193965*s,-0.0041960863*l-0.7034186147*m+1.7076147010*s];
    if(rgb.every(x=>x>=-1e-4&&x<=1+1e-4))
      return "#"+rgb.map(x=>{const v=Math.min(1,Math.max(0,x));return Math.round((v<=0.0031308?12.92*v:1.055*v**(1/2.4)-0.055)*255).toString(16).padStart(2,"0")}).join("");
  }
  return "#808080";
}
export const scaleLabel=(c:ColourScale,v:number)=>(c.log?`1e${Math.round(v)}`:String(Math.round(v*1000)/1000))+(c.open&&v===c.edges[c.edges.length-1]?"+":"");
// The fields that can be shown for a model: the stresses, then each measured property.
export function availableFields(model:GeoModel){
  const k0=model.units.some(u=>u.params?.K0!==undefined);
  return [...STRESS_FIELDS.filter(f=>f.key!=="sh"||k0).map(f=>({key:f.key as string,label:`${f.name} ${f.symbol} (${f.unit})`})),
    ...measuredProperties(model.boreholes).map(k=>{const p=propertyDef(k);return {key:k,label:`${p.name}${p.symbol!==p.name?" "+p.symbol:""}${p.unit?` (${p.unit})`:""}`}})];
}
