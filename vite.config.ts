import {defineConfig,Plugin} from "vite";
import {readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";

// PDF.js reads CMaps (for CJK text), standard fonts, its wasm image decoders and an ICC profile from URLs when a PDF is
// read (src/docread/pdftext.ts): they are served beside the app, in a folder named after the PDF.js version, and
// fetched only then. Its scripting engine (quickjs) is left out: scripts in PDFs never run.
function pdfjsAssets():Plugin{
  const root="node_modules/pdfjs-dist",version=JSON.parse(readFileSync(join(root,"package.json"),"utf8")).version as string;
  const folders:Record<string,(file:string)=>boolean>={cmaps:()=>true,standard_fonts:()=>true,wasm:f=>!f.startsWith("quickjs"),iccs:()=>true};
  const files=Object.entries(folders).flatMap(([dir,keep])=>readdirSync(join(root,dir)).filter(keep).map(f=>`${dir}/${f}`));
  const prefix=`pdfjs-${version}/`;
  return {
    name:"pdfjs-assets",
    generateBundle(){for(const f of files)this.emitFile({type:"asset",fileName:prefix+f,source:readFileSync(join(root,f))})},
    configureServer(server){
      server.middlewares.use((req,res,next)=>{
        const path=decodeURIComponent((req.url??"").split("?")[0]),at=path.indexOf("/"+prefix);
        const f=at<0?"":path.slice(at+prefix.length+1);
        if(!files.includes(f))return next();
        res.setHeader("Content-Type",f.endsWith(".wasm")?"application/wasm":f.endsWith(".js")?"text/javascript":"application/octet-stream");
        res.end(readFileSync(join(root,f)));
      });
    }
  };
}

// Relative asset URLs: the same build works on GitHub Pages (/GeoModel3D/), any static host or sub-path.
// Bare "three" resolves to the WebGPU build so the viewer and the three.js add-ons share one module.
export default defineConfig({
  base:"./",
  plugins:[pdfjsAssets()],
  resolve:{alias:[{find:/^three$/,replacement:"three/webgpu"}]},
  build:{target:"es2022",chunkSizeWarningLimit:1500},
  // The reading model's worker (src/docread/ocr.worker.ts) is a module: ONNX Runtime Web is one.
  worker:{format:"es"},
  // Geometry tests build full models; allow slower CI machines.
  test:{include:["tests/**/*.test.ts"],testTimeout:20000}
});
