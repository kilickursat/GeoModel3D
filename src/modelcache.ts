// The reading model for scanned pages (src/docread/ocr.worker.ts) is kept in the browser's cache storage under one
// name, so that Help can say how much is kept and remove it. Where the browser has no cache storage (a private window,
// blocked site data), nothing is kept and the model downloads each time it is needed.
export const MODEL_CACHE="geomodel3d-reading-model";

// The bytes kept, or 0.
export async function modelCacheSize(){
  try{
    if(!(await caches.has(MODEL_CACHE)))return 0;
    const cache=await caches.open(MODEL_CACHE);
    let n=0;
    for(const req of await cache.keys())n+=(await (await cache.match(req))?.blob())?.size??0;
    return n;
  }catch{return 0}
}
export async function removeModelCache(){
  try{return await caches.delete(MODEL_CACHE)}catch{return false}
}
