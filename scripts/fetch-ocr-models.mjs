// The text-reading model for scanned pages: PP-OCRv6 small by PaddlePaddle (Apache-2.0), detection and recognition,
// fetched from Hugging Face at pinned revisions and checked against pinned SHA-256 sums, then served with the app from
// dist/ocr/pp-ocrv6-small/: det.onnx, rec.onnx, ocr.json (the detection settings and the recognition characters, from
// the models' inference.yml) and manifest.json (sizes and SHA-256 sums the browser checks). Downloads are kept in
// .cache/ocr-models/ between builds. A file that does not match its sum stops the build.
//   node scripts/fetch-ocr-models.mjs [dist]
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,statSync} from "node:fs";
import {join} from "node:path";
import {parse} from "yaml";

const dist=process.argv[2]||"dist",cache=".cache/ocr-models",out=join(dist,"ocr","pp-ocrv6-small");
const MODELS={
  det:{repo:"PaddlePaddle/PP-OCRv6_small_det_onnx",revision:"28fe5895c24fd108c19eb3e8479f4ab385fbfc62",
    onnx:"d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e",yml:"193f435274bf9f0b5f71a929bbfbcf148282df7e633b34e7c373e8f44741b516"},
  rec:{repo:"PaddlePaddle/PP-OCRv6_small_rec_onnx",revision:"b8f84f0b80c529de40b4fbb3544b84fa7233a513",
    onnx:"5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634",yml:"ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1"}
};
const sha256=b=>createHash("sha256").update(b).digest("hex");

async function fetchChecked(repo,revision,file,sum){
  const local=join(cache,`${repo.replace("/","--")}@${revision}--${file}`);
  if(existsSync(local)&&sha256(readFileSync(local))===sum)return readFileSync(local);
  const url=`https://huggingface.co/${repo}/resolve/${revision}/${file}`;
  const res=await fetch(url);
  if(!res.ok)throw new Error(`${url}: HTTP ${res.status}`);
  const bytes=Buffer.from(await res.arrayBuffer());
  if(sha256(bytes)!==sum)throw new Error(`${url}: SHA-256 ${sha256(bytes)}, expected ${sum}`);
  mkdirSync(cache,{recursive:true});
  writeFileSync(local,bytes);
  return bytes;
}

mkdirSync(out,{recursive:true});
const files={};
const settings={};
for(const [name,m] of Object.entries(MODELS)){
  const onnx=await fetchChecked(m.repo,m.revision,"inference.onnx",m.onnx);
  const yml=parse((await fetchChecked(m.repo,m.revision,"inference.yml",m.yml)).toString("utf8"));
  writeFileSync(join(out,`${name}.onnx`),onnx);
  files[`${name}.onnx`]={size:onnx.length,sha256:m.onnx};
  settings[name]={model:yml.Global.model_name,source:`https://huggingface.co/${m.repo}/tree/${m.revision}`};
  if(name==="det"){
    const post=yml.PostProcess,norm=yml.PreProcess.transform_ops.find(o=>o.NormalizeImage)?.NormalizeImage;
    Object.assign(settings.det,{thresh:post.thresh,boxThresh:post.box_thresh,unclipRatio:post.unclip_ratio,mean:norm.mean,std:norm.std});
  }else{
    // CTC classes: blank, the characters, then a space.
    Object.assign(settings.rec,{characters:yml.PostProcess.character_dict.map(String)});
  }
}
const json=Buffer.from(JSON.stringify({name:"PP-OCRv6 small",by:"PaddlePaddle",license:"Apache-2.0",...settings}));
writeFileSync(join(out,"ocr.json"),json);
files["ocr.json"]={size:json.length,sha256:sha256(json)};
// ONNX Runtime's WebAssembly, emitted by the app's build: listed too, so the browser checks and keeps it with the model.
// (Without a build, as for `npm run dev` with `node scripts/fetch-ocr-models.mjs public`, the worker fetches it plainly.)
const assets=join(dist,"assets"),wasm=existsSync(assets)?readdirSync(assets).find(f=>/^ort-wasm-simd-threaded\.asyncify-.*\.wasm$/.test(f)):undefined;
const runtime=wasm?{file:wasm,size:statSync(join(assets,wasm)).size,sha256:sha256(readFileSync(join(assets,wasm)))}:undefined;
writeFileSync(join(out,"manifest.json"),JSON.stringify({model:"pp-ocrv6-small",files,...(runtime?{runtime}:{})},null,1));
const mb=(Object.values(files).reduce((s,f)=>s+f.size,0)+(runtime?.size??0))/1e6;
console.log(`${out}: PP-OCRv6 small, ${mb.toFixed(1)} MB with ${runtime?"the runtime":"no runtime listed"} (${Object.keys(files).join(", ")}), ${settings.rec.characters.length} characters`);
