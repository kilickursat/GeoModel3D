interface AdapterIdentity {
  info?:{vendor?:string;architecture?:string;device?:string;description?:string;isFallbackAdapter?:boolean};
  isFallbackAdapter?:boolean;
}
interface AdapterProvider {
  requestAdapter(options:{powerPreference:"high-performance"}):Promise<AdapterIdentity|null>;
}

/** A browser can mask all identifying fields. Keep that case distinct from verified hardware. */
export function softwareWebgpuAdapter(adapter:unknown):boolean|null {
  const value=adapter as AdapterIdentity|null|undefined,info=value?.info;
  if(info?.isFallbackAdapter===true||value?.isFallbackAdapter===true)return true;
  const identity=[info?.vendor,info?.architecture,info?.device,info?.description]
    .filter((field):field is string=>typeof field==="string").join(" ").toLowerCase();
  if(/swiftshader|llvmpipe|software|lavapipe|microsoft basic render/.test(identity))return true;
  if(info?.isFallbackAdapter===false||value?.isFallbackAdapter===false||/apple|nvidia|intel|\bamd\b|qualcomm|adreno|mali/.test(identity))return false;
  return null;
}

/** Document inference on software WebGPU can stall for minutes. Only hand ORT a hardware adapter. */
export async function requestDocumentGpuAdapter(gpu:AdapterProvider|undefined=(navigator as Navigator&{gpu?:AdapterProvider}).gpu) {
  const adapter=await gpu?.requestAdapter({powerPreference:"high-performance"}).catch(()=>null);
  return adapter&&softwareWebgpuAdapter(adapter)===false?adapter:null;
}
