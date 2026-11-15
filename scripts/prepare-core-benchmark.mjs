// Verify the published crop pixels in memory. This fixed baseline is never overwritten.
import {readFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {build} from "esbuild";
import {chromium} from "@playwright/test";

const root=resolve(import.meta.dirname,".."),folder=resolve(root,"docs/benchmarks/0.25.0-core-ai");
const source=JSON.parse(await readFile(resolve(folder,"dataset-manifest.json"),"utf8"));
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
const guidance="Restore the frozen 0.25.0 files from version control. A changed baseline needs a new benchmark directory and protocol; this verifier has no refresh mode.";
let frozen;
try{frozen=JSON.parse(await readFile(resolve(folder,"inputs.json"),"utf8"))}
catch(error){throw new Error(`Cannot read the frozen input manifest. ${guidance}`,{cause:error})}
if(!Array.isArray(source.samples)||source.samples.length!==8||!Array.isArray(frozen.inputs)||frozen.inputs.length!==8)
  throw new Error(`The frozen pilot requires exactly eight source and input cases. ${guidance}`);
const existing=[];
for(let i=0;i<source.samples.length;i++){
  const sample=source.samples[i],input=frozen.inputs[i],id=`sample-${String(i+1).padStart(2,"0")}`;
  if(sample.id!==id||sample.path!==`images/${id}.jpeg`||input.id!==id||input.path!==`images/${id}.png`||input.sourceSha256!==sample.sha256)
    throw new Error(`The ordered source/input manifest link differs for ${id}. ${guidance}`);
  let bytes;
  try{bytes=await readFile(resolve(folder,input.path))}
  catch(error){throw new Error(`Missing frozen PNG for ${id}. ${guidance}`,{cause:error})}
  if(bytes.length!==input.bytes||digest(bytes)!==input.sha256)throw new Error(`Frozen PNG integrity mismatch: ${id}. ${guidance}`);
  existing.push(bytes);
}
const bundled=await build({entryPoints:[resolve(root,"src/coreAiCrop.ts")],bundle:true,platform:"node",format:"esm",write:false,logLevel:"silent"});
const {coreAiCropPlan}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??(existsSync("/usr/bin/chromium")?"/usr/bin/chromium":undefined);
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-swiftshader"]});
const inputs=[],prepared=[];
try{
  const page=await browser.newPage();await page.goto("about:blank");
  for(const sample of source.samples){
    const bytes=await readFile(resolve(root,source.rawCacheRoot??".cache/v025-core-benchmark",sample.path));
    if(digest(bytes)!==sample.sha256||bytes.length!==sample.bytes)throw new Error(`Source integrity mismatch: ${sample.id}`);
    const plan=coreAiCropPlan({box:{x0:0,y0:0,x1:1,y1:1}},sample.width,sample.height);
    const encoded=await page.evaluate(async({image,plan})=>{
      const photo=new Image();await new Promise((done,fail)=>{photo.onload=done;photo.onerror=()=>fail(new Error("Image decode failed"));photo.src=image});
      if(photo.naturalWidth!==plan.sourceWidth||photo.naturalHeight!==plan.sourceHeight)throw new Error("Source dimensions mismatch");
      const canvas=document.createElement("canvas");canvas.width=plan.width;canvas.height=plan.height;
      const c=canvas.getContext("2d"),p=plan.preprocessing,r=plan.pixels;
      if(!c)throw new Error("Canvas is unavailable");
      c.fillStyle=p.background;c.fillRect(0,0,canvas.width,canvas.height);
      c.imageSmoothingEnabled=true;c.imageSmoothingQuality="low";
      c.drawImage(photo,r.x,r.y,r.width,r.height,p.padding.left,p.padding.top,p.scaledWidth,p.scaledHeight);
      return canvas.toDataURL("image/png").split(",")[1];
    },{image:`data:image/jpeg;base64,${bytes.toString("base64")}`,plan});
    const png=Buffer.from(encoded,"base64"),path=`images/${sample.id}.png`;
    prepared.push(png);
    inputs.push({id:sample.id,path,sha256:digest(png),bytes:png.length,sourceSha256:sample.sha256,plan});
  }
  const reproduced={version:1,sourceManifest:"dataset-manifest.json",inputLicense:"CC BY-SA 4.0; see NOTICE.md",
    preparation:"Local Chromium Canvas2D using the app's coreAiCropPlan and drawImage defaults. Whole published patches fill a 512-square frame without stretching. Upscaling adds no observed detail; metadata is not embedded.",
    browserVersion:browser.version(),cropHelperSha256:digest(await readFile(resolve(root,"src/coreAiCrop.ts"))),inputs};
  const changed=inputs.filter((input,i)=>!prepared[i].equals(existing[i])).map(input=>input.id);
  if(changed.length)throw new Error(`Reproduced PNGs differ for ${changed.join(", ")}. Frozen Chromium: ${frozen.browserVersion}; current: ${browser.version()}. ${guidance}`);
  if(!isDeepStrictEqual(reproduced,frozen))throw new Error(`Preparation metadata differs from the frozen baseline (Chromium ${frozen.browserVersion}, crop helper ${frozen.cropHelperSha256}). ${guidance}`);
  console.log(JSON.stringify({verified:inputs.length,mode:"compare-only",browserVersion:browser.version(),folder}));
}finally{await browser.close()}
