// What the browser tests are served: the production build in dist/, so they exercise the files that are published.
// Some fixtures also import source modules inside the page (/src/*.ts, e.g. to write a workspace file); only those
// requests go through Vite, which runs in-process in middleware mode (no second server, no hot reload).
// Used by scripts/ui-test-server.mjs (a server on 127.0.0.1) and, where local servers are not allowed, by the
// tests' own request routing (GEOMODEL3D_UI_ROUTE=1), so both answer every request in the same way.
import {readFile,stat} from "node:fs/promises";
import {extname,join,resolve,sep} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT=resolve(fileURLToPath(new URL("../..",import.meta.url))),DIST=join(ROOT,"dist");
const TYPES={".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".wasm":"application/wasm",
  ".json":"application/json",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".xml":"application/xml",".txt":"text/plain",
  ".glb":"model/gltf-binary",".usdz":"model/vnd.usdz+zip"};
const sourceRequest=(pathname,search)=>/^\/(src|node_modules|@vite|@id|@fs)\//.test(pathname)||pathname==="/package.json"&&/(^|[?&])import\b/.test(search);

export async function createUiResponder(){
  try{if(!(await stat(join(DIST,"index.html"))).isFile())throw new Error()}
  catch{throw new Error("The browser tests use the production build: run npm run build first.")}
  let vite;
  const dev=async()=>vite??=await (await import("vite")).createServer({root:ROOT,configFile:join(ROOT,"vite.config.ts"),logLevel:"error",
    server:{middlewareMode:true,hmr:false,ws:false},appType:"custom"});
  return async(pathname,search="")=>{
    if(sourceRequest(pathname,search)){
      const result=await (await dev()).transformRequest(pathname+search);
      return result?{status:200,type:"text/javascript",body:result.code}:{status:404,type:"text/plain",body:"not found"};
    }
    let path=decodeURIComponent(pathname).replace(/^\/+/,"");
    if(path===""||path.endsWith("/"))path+="index.html";
    const file=join(DIST,path);
    if(!file.startsWith(DIST+sep))return {status:404,type:"text/plain",body:"not found"};
    try{
      if(!(await stat(file)).isFile())throw new Error();
      return {status:200,type:TYPES[extname(file).toLowerCase()]??"application/octet-stream",body:await readFile(file)};
    }catch{return {status:404,type:"text/plain",body:"not found"}}
  };
}
