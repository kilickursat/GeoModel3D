// Verify all public v0.26 inputs against the frozen source/crop baseline; never overwrite evidence.
import {readFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {build} from "esbuild";
import {chromium} from "@playwright/test";

const root=resolve(import.meta.dirname,".."),folder=resolve(root,"public/core-benchmark-v026");
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
const expected={source:"301b53789551d3423730f56572762ab99cee8f59b1d1e7b3dfa30c6cf80141d2",manifest:"b61549c3de8714e2f015056276efc23dfb3c6f3e1206fbd6611b68af3712c391",inputs:"999992ee2d41ecd062133095c0f69562a263f597a722780ac029d6b446283ccd"};
const sourceBytes=await readFile(resolve(root,"docs/benchmarks/0.26.0-core-ai/dataset-manifest.json")),manifestBytes=await readFile(resolve(folder,"manifest.json")),inputsBytes=await readFile(resolve(folder,"inputs.json"));
if(digest(sourceBytes)!==expected.source||digest(manifestBytes)!==expected.manifest||digest(inputsBytes)!==expected.inputs)
  throw new Error("Frozen v0.26 manifest changed. Restore it from version control; a new study needs its own versioned baseline.");
const source=JSON.parse(sourceBytes),manifest=JSON.parse(manifestBytes),frozen=JSON.parse(inputsBytes);
if(source.samples.length!==40||manifest.cases.length!==40||frozen.inputs.length!==40||frozen.sourceManifestSha256!==expected.source)
  throw new Error("Expected forty ordered, source-linked frozen cases.");
const existing=[];
for(let i=0;i<40;i++){
  const sample=source.samples[i],input=frozen.inputs[i],entry=manifest.cases[i],id=`case-${String(i+1).padStart(2,"0")}`,image=`images/${id}.png`;
  if(sample.id!==id||sample.path!==`images/${id}.jpeg`||input.id!==id||input.image!==image||entry.id!==id||entry.image!==image||input.sourceSha256!==sample.sha256||entry.sourceSha256!==sample.sha256||entry.sha256!==input.sha256||entry.width!==512||entry.height!==512)
    throw new Error(`Frozen source/public input linkage differs: ${id}`);
  const bytes=await readFile(resolve(folder,image));
  if(bytes.length!==input.bytes||digest(bytes)!==input.sha256)throw new Error(`Frozen PNG integrity mismatch: ${id}`);
  existing.push(bytes);
}
const helperBytes=await readFile(resolve(root,"src/coreAiCrop.ts"));
if(digest(helperBytes)!==frozen.cropHelperSha256)throw new Error("The crop helper differs from this frozen baseline; do not refresh existing evidence.");
const bundled=await build({entryPoints:[resolve(root,"src/coreAiCrop.ts")],bundle:true,platform:"node",format:"esm",write:false,logLevel:"silent"});
const {coreAiCropPlan}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??(existsSync("/usr/bin/chromium")?"/usr/bin/chromium":undefined);
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-swiftshader"]});
try{
  if(browser.version()!==frozen.browserVersion)throw new Error(`Frozen Chromium is ${frozen.browserVersion}; current is ${browser.version()}. Use the recorded version or create a separate baseline.`);
  const page=await browser.newPage();await page.goto("about:blank");
  for(let i=0;i<40;i++){
    const sample=source.samples[i],bytes=await readFile(resolve(root,source.rawCacheRoot,sample.path));
    if(bytes.length!==sample.bytes||digest(bytes)!==sample.sha256)throw new Error(`Original JPEG integrity mismatch: ${sample.id}`);
    const plan=coreAiCropPlan({box:{x0:0,y0:0,x1:1,y1:1}},sample.width,sample.height);
    if(!isDeepStrictEqual(plan,frozen.inputs[i].plan))throw new Error(`Frozen crop geometry mismatch: ${sample.id}`);
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
    const reproduced=Buffer.from(encoded,"base64");
    if(!reproduced.equals(existing[i]))throw new Error(`Reproduced PNG differs: ${sample.id}. Existing evidence was not modified.`);
  }
  console.log(JSON.stringify({verified:40,mode:"compare-only",browserVersion:browser.version(),manifestSha256:expected.manifest}));
}finally{await browser.close()}
