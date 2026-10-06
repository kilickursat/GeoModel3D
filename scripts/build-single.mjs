// Inline the Vite bundle into one standalone HTML file that opens from disk (file://) without a web server.
import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";

const dist=process.argv[2]||"dist";
const out=join(dist,"geomodel3d-offline.html");
let html=readFileSync(join(dist,"index.html"),"utf8");
const read=(ref)=>readFileSync(join(dist,ref.replace(/^\.?\//,"")),"utf8");

let scripts=0,styles=0;
html=html.replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g,(_,src)=>{
  scripts++;
  return '<script type="module">'+read(src).replace(/<\/script/gi,"<\\/script")+"</script>";
});
html=html.replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/g,(_,href)=>{
  styles++;
  return "<style>"+read(href)+"</style>";
});
if(scripts!==1)throw new Error(`expected 1 module script in ${dist}/index.html, found ${scripts}`);
if(/<(script|link)[^>]+(src|href)="\.?\/?assets\//.test(html))throw new Error("unresolved asset reference left in offline build");

writeFileSync(out,html);
console.log(`${out}: ${(html.length/1024).toFixed(0)} kB (${scripts} script, ${styles} stylesheet inlined)`);
