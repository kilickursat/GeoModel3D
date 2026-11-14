// Exact information for a finite set of interpretations under a stated, noiseless observation of an elevation
// bin. This is scenario discrimination; it is not a model of measurement noise or all possible geology.
export interface InformationOptions {
  resolution:number;origin?:number;priors?:number[];moneyBudget:number;fixedCost:number;costPerMetre:number;
  contactBuffer?:number;currency?:string;
}
export interface InformationSettings {
  resolution:number;origin:number;priors:number[];moneyBudget:number;fixedCost:number;costPerMetre:number;
  contactBuffer:number;currency:string;
}
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);

export function informationPriors(count:number,weights?:number[]):number[]{
  if(!Number.isInteger(count)||count<2||count>6)throw new Error("Information planning needs two to six selected interpretations.");
  const values=weights??Array(count).fill(1);
  if(!Array.isArray(values)||values.length!==count||values.some(p=>!finite(p)||p<0)||!values.some(p=>p>0))throw new Error("Information priors must give a nonnegative finite weight for every selected interpretation, with at least one positive weight.");
  const direct=values.reduce((s,p)=>s+p,0);
  if(Number.isFinite(direct)&&direct>0)return values.map(p=>p/direct);
  const max=Math.max(...values),scaled=values.map(p=>p/max),sum=scaled.reduce((s,p)=>s+p,0);
  return scaled.map(p=>p/sum);
}

export function informationSettings(options:InformationOptions,count:number):InformationSettings{
  if(!options||!finite(options.resolution)||options.resolution<=0)throw new Error("Observation resolution must be a positive finite number of metres.");
  const origin=options.origin??0,contactBuffer=options.contactBuffer??0;
  if(!finite(origin))throw new Error("Observation bin origin must be finite.");
  if(!finite(options.moneyBudget)||options.moneyBudget<=0)throw new Error("The monetary budget must be a positive finite number.");
  for(const key of ["fixedCost","costPerMetre"] as const)if(!finite(options[key])||options[key]<0)throw new Error("Fixed cost and drilling cost per metre must be finite and nonnegative.");
  if(options.fixedCost===0&&options.costPerMetre===0)throw new Error("Supply a positive fixed cost or drilling cost per metre.");
  if(!finite(contactBuffer)||contactBuffer<0)throw new Error("The contact depth buffer must be finite and nonnegative.");
  if(options.currency!==undefined&&(typeof options.currency!=="string"||!options.currency.trim()||options.currency.length>30))throw new Error("Name a currency or cost unit using at most 30 characters.");
  return {resolution:options.resolution,origin,priors:informationPriors(count,options.priors),moneyBudget:options.moneyBudget,
    fixedCost:options.fixedCost,costPerMetre:options.costPerMetre,contactBuffer,currency:options.currency?.trim()??"cost units"};
}

export function contactBins(elevations:number[],resolution:number,origin=0):number[]{
  if(!finite(resolution)||resolution<=0||!finite(origin))throw new Error("Contact bins need a positive finite resolution and a finite origin.");
  return elevations.map(value=>{
    const bin=Math.floor((value-origin)/resolution);
    if(!finite(value)||!Number.isSafeInteger(bin))throw new Error("Contact elevation cannot be represented safely at this bin resolution and origin.");
    return bin;
  });
}

// Observations contain one bin per interpretation. Equal signatures form a remaining hypothesis group.
export function conditionalCaseEntropy(priors:number[],observations:number[][]=[]):number{
  if(observations.some(row=>row.length!==priors.length||row.some(bin=>!Number.isSafeInteger(bin))))throw new Error("Every observation must give one finite safe integer bin for every interpretation.");
  const weights=informationPriors(priors.length,priors),groups=new Map<string,number[]>();
  weights.forEach((p,i)=>{const key=JSON.stringify(observations.map(row=>row[i]));if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(p)});
  let entropy=0;
  for(const values of groups.values()){
    const mass=values.reduce((s,p)=>s+p,0);
    for(const p of values)if(p>0)entropy-=p*Math.log2(p/mass);
  }
  return Math.max(0,entropy);
}

export function conditionalInformationGain(priors:number[],observations:number[][],candidate:number[]):number{
  const before=conditionalCaseEntropy(priors,observations),after=conditionalCaseEntropy(priors,[...observations,candidate]);
  return Math.max(0,Math.min(before,before-after));
}
