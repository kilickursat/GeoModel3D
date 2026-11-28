interface InitializableRenderer {
  backend:object;
  init():Promise<unknown>;
  dispose():unknown;
}
interface SoftwareDevice {adapterInfo?:{isFallbackAdapter?:boolean};queue:{onSubmittedWorkDone():Promise<void>}}

export async function startRenderer<T extends InitializableRenderer>(requested:string|null,create:(forceWebGL:boolean)=>T){
  const primary=create(requested==="webgl");
  await primary.init();
  // Inspect the device Three.js opened. Some software WebGPU devices initialize but cannot present frames.
  const device=(primary.backend as {device?:SoftwareDevice}).device;
  const softwareWebGPU=device?.adapterInfo?.isFallbackAdapter===true;
  if(softwareWebGPU&&requested!=="webgpu"&&requested!=="webgl"){
    let alternate:T;
    try{
      alternate=create(true);
      await alternate.init();
    }catch(error){
      console.warn("WebGL 2 unavailable on this software adapter",error);
      return {renderer:primary,softwareWebGPU,softwareQueue:device.queue};
    }
    try{await primary.dispose()}catch(error){console.warn("Could not release the unused WebGPU renderer",error)}
    return {renderer:alternate,softwareWebGPU,softwareQueue:undefined};
  }
  return {renderer:primary,softwareWebGPU,softwareQueue:softwareWebGPU?device.queue:undefined};
}
