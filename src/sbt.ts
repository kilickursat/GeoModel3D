// Soil behaviour type from cone penetration tests (CPT), by Robertson's normalised chart: the cone resistance and the
// friction ratio, normalised by the stresses in the ground, give the soil behaviour type index Ic (Robertson & Wride
// 1998, with the stress exponent of Robertson 2009, "Interpretation of cone penetration tests - a unified approach",
// Canadian Geotechnical Journal 46: 1337-1355), whose bands are zones 2 to 7 of Robertson's chart (1990). The unit
// weight the stresses need comes from the CPT itself (Robertson & Cabal 2010, "Estimating soil unit weight from CPT").
// From the classified readings come a CPT's layers: the log it gives.
import {Cpt,GeoProject,Interval,UnitRule} from "./schema";
import {rulePattern} from "./rules";

// Atmospheric pressure, the reference stress of the normalisation, and the unit weight of water (as for the stresses
// on sections), in kPa and kN/m³.
const PA=100,GAMMA_W=9.81;
const finite=(v:number|undefined):v is number=>v!==undefined&&Number.isFinite(v);

// The zones of Robertson's chart that Ic tells apart, from organic soils to dense sand, with the name of the soil each
// is, its principal soil first so that the unit rules can read it. Zones 1, 8 and 9 (sensitive fine-grained soils, and
// very stiff soils, overconsolidated or cemented) lie off the Ic bands and are not told apart by Ic.
export interface SbtZone { zone:number; name:string; soil:string; color:string; upper:number }
export const SBT_ZONES:SbtZone[]=[
  {zone:7,name:"Gravelly sand to dense sand",soil:"Sand: gravelly sand to dense sand (SBTn 7)",color:"#a39d6b",upper:1.31},
  {zone:6,name:"Sands: clean sand to silty sand",soil:"Sand: clean sand to silty sand (SBTn 6)",color:"#efe08a",upper:2.05},
  {zone:5,name:"Sand mixtures: silty sand to sandy silt",soil:"Sand mixture: silty sand to sandy silt (SBTn 5)",color:"#ddc15a",upper:2.6},
  {zone:4,name:"Silt mixtures: clayey silt to silty clay",soil:"Silt mixture: clayey silt to silty clay (SBTn 4)",color:"#c4943a",upper:2.95},
  {zone:3,name:"Clays: silty clay to clay",soil:"Clay: silty clay to clay (SBTn 3)",color:"#a0632a",upper:3.6},
  {zone:2,name:"Organic soils: peat",soil:"Peat: organic soil (SBTn 2)",color:"#7b4a3a",upper:Infinity}
];
export const zoneOf=(ic:number)=>Number.isFinite(ic)?SBT_ZONES.find(z=>ic<z.upper)!.zone:NaN;
export const sbtZone=(zone:number)=>SBT_ZONES.find(z=>z.zone===zone);

export interface SoilBehaviour {
  // Per reading: the corrected cone resistance (MPa), the unit weight (kN/m³), the total and effective vertical stress
  // and the pore pressure in place (kPa), the stress exponent, the normalised cone resistance and friction ratio (%), Ic
  // and its zone; NaN where a reading cannot be classified.
  qt:number[]; gamma:number[]; sv:number[]; u0:number[]; s:number[]; n:number[]; Qtn:number[]; Fr:number[]; ic:number[]; zone:number[];
  // Where qt comes from, how many readings could not be classified, and what was assumed.
  qtFrom:"given"|"corrected"|"qc"; unclassified:number; notes:string[];
}

// The soil behaviour type down a CPT, where the water table lies at the elevation `water` (none known: no pore pressure).
// - qt = qc + u2 (1 − a) where the CPT gives u2 and its net area ratio a, or qt itself; else qt is taken as qc.
// - The unit weight: γ/γw = 0.27 log Rf + 0.36 log(qt/pa) + 1.236 (Robertson & Cabal 2010), Rf = fs/qt in percent; a
//   reading without it takes the one above (the first, the one below). σv0 sums it from the start, with any water
//   above the start; u0 is hydrostatic below the water table; σ′v0 = σv0 − u0.
// - Qtn = ((qt − σv0)/pa)(pa/σ′v0)^n, with (pa/σ′v0)^n at most 1.7 (Robertson & Wride 1998); Fr = fs/(qt − σv0) in
//   percent; Ic = √((3.47 − log Qtn)² + (log Fr + 1.22)²); n = 0.381 Ic + 0.05 σ′v0/pa − 0.15, at most 1, from n = 1
//   until it changes by less than 10⁻⁶.
export function soilBehaviour(c:Cpt,water?:number):SoilBehaviour{
  const N=c.depth.length,notes:string[]=[],a=c.a;
  const out:SoilBehaviour={qt:[],gamma:[],sv:[],u0:[],s:[],n:[],Qtn:[],Fr:[],ic:[],zone:[],qtFrom:"qc",unclassified:N,notes};
  let given=0,corrected=0;
  out.qt=c.qc.map((q,i)=>{
    const g=c.qt?.[i],u=c.u2?.[i];
    if(finite(g)){given++;return g}
    if(finite(q)&&finite(u)&&a!==undefined&&Number.isFinite(a)){corrected++;return q+u/1000*(1-a)}
    return q;
  });
  out.qtFrom=given?"given":corrected?"corrected":"qc";
  if(given)notes.push("qt as the file gives it");
  else if(corrected)notes.push(`qt = qc + u2 (1 − a), with the net area ratio a = ${a}`);
  else notes.push(c.u2?.some(Number.isFinite)?"qt taken as qc: the file gives no net area ratio":"qt taken as qc: no pore pressure u2 was measured");
  if(!c.fs?.some(Number.isFinite)){
    notes.push("no sleeve friction: the soil behaviour type cannot be found");
    for(const k of ["gamma","sv","u0","s","n","Qtn","Fr","ic","zone"] as const)out[k]=new Array(N).fill(NaN);
    return out;
  }
  // Unit weights, the gaps filled from the readings above (the first ones from the first reading that has one).
  const gamma=out.qt.map((q,i)=>{
    const f=c.fs?.[i];
    if(!(q>0)||!finite(f)||!(f>0))return NaN;
    const rf=f/(10*q);
    return rf<=20?GAMMA_W*(0.27*Math.log10(rf)+0.36*Math.log10(q*1000/PA)+1.236):NaN;
  });
  const first=gamma.find(Number.isFinite)??NaN;
  let last=first;
  out.gamma=gamma.map(g=>Number.isFinite(g)?(last=g):last);
  // Stresses down from the start, with the water above it where the water table is higher (as under open water).
  const z0=c.z,above=water!==undefined&&Number.isFinite(water)?Math.max(0,water-z0)*GAMMA_W:0;
  let sv=NaN;
  c.depth.forEach((d,i)=>{
    const g=out.gamma[i];
    sv=i===0||!Number.isFinite(sv)?above+g*d:sv+(out.gamma[i-1]+g)/2*(d-c.depth[i-1]);
    const u0=water!==undefined&&Number.isFinite(water)?Math.max(0,water-(z0-d))*GAMMA_W:0;
    out.sv.push(sv);out.u0.push(u0);out.s.push(sv-u0);
  });
  if(water===undefined||!Number.isFinite(water))notes.push("no water level is known: no pore pressure in place, so σ′v0 = σv0; set the groundwater depth of the project to give one");
  for(let i=0;i<N;i++){
    const r=behaviourIndex(out.qt[i],c.fs![i],out.sv[i],out.s[i]);
    out.n.push(r.n);out.Qtn.push(r.Qtn);out.Fr.push(r.Fr);out.ic.push(r.ic);out.zone.push(zoneOf(r.ic));
  }
  out.unclassified=out.ic.filter(v=>!Number.isFinite(v)).length;
  if(out.unclassified)notes.push(`${out.unclassified} of ${N} readings not classified (no sleeve friction, or qt not above σv0)`);
  return out;
}

// Ic of one reading, by the iteration on n: qt in MPa, fs, σv0 and σ′v0 in kPa; NaN where qt is not above σv0, or fs
// or σ′v0 is not above zero.
export function behaviourIndex(qt:number,fs:number,sv:number,s:number){
  const qn=qt*1000-sv;
  if(!(qt>0&&fs>0&&s>0&&qn>0))return {n:NaN,Qtn:NaN,Fr:NaN,ic:NaN};
  const Fr=fs/qn*100,at=(n:number)=>{const Qtn=qn/PA*Math.min(1.7,(PA/s)**n);return {Qtn,ic:Math.sqrt((3.47-Math.log10(Qtn))**2+(Math.log10(Fr)+1.22)**2)}};
  let n=1,r=at(n);
  for(let it=0;it<200;it++){
    const next=Math.min(1,0.381*r.ic+0.05*s/PA-0.15);
    if(Math.abs(next-n)<1e-6){n=next;r=at(n);break}
    n=next;r=at(n);
  }
  return {n,Qtn:r.Qtn,Fr,ic:r.ic};
}

// The layers a CPT gives: runs of readings in one zone, each from its first reading to the first of the next run. A run
// thinner than `min` metres joins the neighbour whose mean Ic is nearest its own, the thinnest first: the cone senses
// the ground some ten diameters around it, so thinner layers are not resolved. The layers name their soil; their units
// are given by the rules (none here).
export function cptLayers(c:Cpt,b:SoilBehaviour,min=0.5):Interval[]{
  const runs:Array<{zone:number;from:number;to:number;sum:number;n:number}>=[];
  c.depth.forEach((d,i)=>{
    const z=b.zone[i];
    if(!Number.isFinite(z))return;
    const last=runs[runs.length-1];
    if(last&&last.zone===z){last.to=d;last.sum+=b.ic[i];last.n++}
    else{if(last)last.to=d;runs.push({zone:z,from:d,to:d,sum:b.ic[i],n:1})}
  });
  const mean=(r:typeof runs[number])=>r.sum/r.n;
  for(;;){
    let k=-1;
    runs.forEach((r,i)=>{if(r.to-r.from<min-1e-9&&runs.length>1&&(k<0||r.to-r.from<runs[k].to-runs[k].from))k=i});
    if(k<0)break;
    const r=runs[k],up=runs[k-1],down=runs[k+1];
    const into=!up?down:!down?up:Math.abs(mean(up)-mean(r))<=Math.abs(mean(down)-mean(r))?up:down;
    into.from=Math.min(into.from,r.from);into.to=Math.max(into.to,r.to);into.sum+=r.sum;into.n+=r.n;
    runs.splice(k,1);
    // Neighbours of one zone, now touching, are one layer.
    for(let i=1;i<runs.length;i++)if(runs[i].zone===runs[i-1].zone){runs[i-1].to=runs[i].to;runs[i-1].sum+=runs[i].sum;runs[i-1].n+=runs[i].n;runs.splice(i,1);i--}
  }
  return runs.filter(r=>r.to>r.from).map(r=>({from:round(r.from),to:round(r.to),unit:"",name:sbtZone(r.zone)!.soil}));
}
const round=(v:number)=>Math.round(v*1000)/1000;

// The units of a CPT's layers by the first of the rules that matches the layer's soil and the elevation of its top
// (rules on SPT N-values never match, as a CPT has none); a layer no rule matches has no unit. So that rules on
// elevation can tell one part of a thick layer from another, each layer is taken in pieces of at most `piece` metres;
// neighbouring pieces of one soil and unit are joined again.
export function layerUnits(layers:Interval[],z:number,rules:UnitRule[],piece=1):Interval[]{
  const compiled=rules.map(r=>({...r,re:rulePattern(r.match)}));
  const unitOf=(name:string|undefined,top:number)=>name===undefined?"":compiled.find(r=>r.re.test(name)&&r.minN===undefined&&r.maxN===undefined
    &&(r.minZ===undefined||top>=r.minZ)&&(r.maxZ===undefined||top<r.maxZ))?.unit??"";
  const pieces:Interval[]=[];
  for(const l of layers){
    const parts=Math.max(1,Math.ceil((l.to-l.from)/piece-1e-9)),h=(l.to-l.from)/parts;
    for(let p=0;p<parts;p++){
      const from=round(l.from+p*h),to=p===parts-1?l.to:round(l.from+(p+1)*h);
      pieces.push({...l,from,to,unit:unitOf(l.name,z-from)});
    }
  }
  return joinLayers(pieces);
}
// Neighbouring layers of one soil and unit, as one.
export function joinLayers(layers:Interval[]):Interval[]{
  const out:Interval[]=[];
  for(const l of layers){
    const last=out[out.length-1];
    if(last&&last.name===l.name&&last.unit===l.unit&&Math.abs(last.to-l.from)<1e-6)last.to=l.to;
    else out.push({...l});
  }
  return out;
}

// The water table at a point, as the model takes it: through the shallowest water level of each borehole, by inverse
// distance, kept at or below the ground there; else the project's assumed depth below the ground; else none.
export function waterTableAt(p:GeoProject,x:number,y:number,ground:number):number|undefined{
  let num=0,den=0,exact:number|undefined;
  for(const b of p.boreholes){
    if(!b.water?.length||![b.x,b.y,b.z].every(Number.isFinite))continue;
    const v=b.z-Math.min(...b.water.map(w=>w.depth)),d2=(b.x-x)**2+(b.y-y)**2;
    if(d2<1e-12){exact=v;break}
    num+=v/d2;den+=1/d2;
  }
  if(exact!==undefined||den>0)return Math.min(exact??num/den,ground);
  if(p.groundwaterDepth!==undefined&&Number.isFinite(p.groundwaterDepth))return ground-p.groundwaterDepth;
  return undefined;
}

// A CPT's soil behaviour type with the project's water table, kept for each project and CPT.
const kept=new WeakMap<GeoProject,WeakMap<Cpt,SoilBehaviour>>();
export function cptBehaviour(p:GeoProject,c:Cpt){
  let m=kept.get(p);
  if(!m){m=new WeakMap();kept.set(p,m)}
  let b=m.get(c);
  if(!b){b=soilBehaviour(c,Number.isFinite(c.z)?waterTableAt(p,c.x,c.y,c.z):undefined);m.set(c,b)}
  return b;
}
// A CPT's layers with their units, as the project's rules for CPT layers give them (else its unit rules).
export function classifiedLayers(p:GeoProject,c:Cpt){
  const b=soilBehaviour(c,Number.isFinite(c.z)?waterTableAt(p,c.x,c.y,c.z):undefined);
  const rules=p.cptRules??p.rules;
  return {behaviour:b,layers:rules?layerUnits(cptLayers(c,b),c.z,rules):cptLayers(c,b)};
}
