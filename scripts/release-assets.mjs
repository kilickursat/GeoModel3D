// Build-tag metadata and artifact checks run before an ephemeral Actions token can publish release assets.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {resolve,join} from "node:path";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";

const [mode,directory="."]=process.argv.slice(2),source=resolve(directory),tag=process.env.RELEASE_TAG??"";
const stable=/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function check(condition,message){if(!condition)throw new Error(message)}
function hash(path){return createHash("sha256").update(readFileSync(path)).digest("hex")}
function metadata(){
  check(stable.test(tag),"Release tag must be a stable vMAJOR.MINOR.PATCH tag.");
  const version=tag.slice(1),pkg=JSON.parse(readFileSync(join(source,"package.json"),"utf8")),lock=JSON.parse(readFileSync(join(source,"package-lock.json"),"utf8"));
  check(pkg.version===version&&lock.version===version&&lock.packages?.[""]?.version===version,"Tag, package and lockfile versions must match.");
  const citation=readFileSync(join(source,"CITATION.cff"),"utf8");
  check(citation.split(/\r?\n/).some(line=>line===`version: ${version}`),"Citation version must match the tag.");
  const changelog=readFileSync(join(source,"CHANGELOG.md"),"utf8"),sections=changelog.split(/^## /m),section=sections.find(part=>part.startsWith(`${version} — `));
  check(section,"A dated changelog entry is required for this tag.");
  return {version,notes:section.split(/\r?\n/).slice(1).join("\n").trim()};
}
function prepare(){
  const meta=metadata(),artifact=join(source,"dist/geomodel3d-offline.html");
  check(existsSync(artifact),"Build the standalone HTML before preparing a release.");
  const sha256=hash(artifact),cache=join(source,".cache");mkdirSync(cache,{recursive:true});
  const checksum=join(cache,"SHA256SUMS.txt"),notes=join(cache,"release-notes.md");
  writeFileSync(checksum,`${sha256}  geomodel3d-offline.html\n`);
  writeFileSync(notes,`${meta.notes}\n\nThe attached standalone HTML was built and tested from ${tag}. SHA-256: \`${sha256}\`.\n`);
  return {...meta,artifact,checksum,notes,sha256};
}
function command(program,args){
  const result=spawnSync(program,args,{cwd:source,encoding:"utf8"});
  if(result.error)throw result.error;
  check(result.status===0,`${program} failed: ${result.stderr?.trim()||result.stdout?.trim()||result.status}`);
  return result.stdout.trim();
}
function api(path,optional=false){
  const result=spawnSync("gh",["api",path],{cwd:source,encoding:"utf8"});
  if(optional&&result.status!==0&&result.stderr?.includes("HTTP 404"))return undefined;
  check(result.status===0,`GitHub API failed: ${result.stderr?.trim()||result.error?.message||result.status}`);
  return JSON.parse(result.stdout);
}
function publish(){
  const prepared=prepare(),repo=process.env.GH_REPO??"";
  check(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo),"GH_REPO must name the release repository.");
  check(process.env.GH_TOKEN,"An ephemeral GitHub Actions token is required.");
  const commit=command("git",["rev-parse","HEAD"]),root=`repos/${repo}`;
  function verifyTag(){
    let object=api(`${root}/git/ref/tags/${tag}`).object;
    for(let i=0;object.type==="tag"&&i<8;i++)object=api(`${root}/git/tags/${object.sha}`).object;
    check(object.type==="commit"&&object.sha===commit,"The remote tag moved or does not match the built commit.");
  }
  verifyTag();
  const ownership=`<!-- geomodel3d-release-assets:${tag}:${commit} -->`;
  let release=api(`${root}/releases/tags/${tag}`,true),created=false;
  if(!release){
    writeFileSync(prepared.notes,`${readFileSync(prepared.notes,"utf8")}\n${ownership}\n`);
    command("gh",["release","create",tag,"--repo",repo,"--verify-tag","--target",commit,"--title",`GeoModel3D ${prepared.version}`,"--notes-file",prepared.notes,"--draft"]);
    release=api(`${root}/releases/tags/${tag}`);created=true;
  }
  // Published files are immutable here. Retrying an upload skips an identical asset, and refuses replacement.
  const assets=[["geomodel3d-offline.html",prepared.artifact],["SHA256SUMS.txt",prepared.checksum]].map(([name,path])=>({name,path,expected:`sha256:${hash(path)}`}));
  // Check every existing file before adding any missing one; a known checksum conflict must cause no uploads.
  for(const {name,expected} of assets){
    const existing=release.assets.find(asset=>asset.name===name);
    if(existing)check(existing.state==="uploaded"&&existing.digest===expected,`Existing ${name} cannot be verified as identical; it was not replaced.`);
  }
  for(const {name,path,expected} of assets){
    const existing=release.assets.find(asset=>asset.name===name);
    if(existing){check(existing.state==="uploaded"&&existing.digest===expected,`Existing ${name} cannot be verified as identical; it was not replaced.`);continue}
    verifyTag();command("gh",["release","upload",tag,path,"--repo",repo]);
    release=api(`${root}/releases/tags/${tag}`);
    const uploaded=release.assets.find(asset=>asset.name===name);
    check(uploaded?.state==="uploaded"&&uploaded.digest===expected,`Uploaded ${name} did not match its checksum.`);
  }
  const ownedDraft=release.draft&&release.body?.includes(ownership);
  if(ownedDraft){
    verifyTag();
    const latest=api(`${root}/releases/latest`,true);
    const current=latest&&stable.test(latest.tag_name)?latest.tag_name.slice(1).split(".").map(Number):undefined;
    const next=prepared.version.split(".").map(Number);
    const newer=!latest||!!current&&next.some((n,i)=>n>current[i]&&next.slice(0,i).every((v,k)=>v===current[k]));
    command("gh",["release","edit",tag,"--repo",repo,"--draft=false",newer?"--latest":"--latest=false"]);
    release=api(`${root}/releases/tags/${tag}`);
  }
  console.log(JSON.stringify({tag,commit,url:release.html_url,draft:release.draft,created,existingReleaseStatePreserved:!created&&!ownedDraft,sha256:prepared.sha256}));
}
try{
  if(mode==="validate")console.log(JSON.stringify(metadata()));
  else if(mode==="prepare")console.log(JSON.stringify(prepare()));
  else if(mode==="publish")publish();
  else throw new Error("Use validate, prepare or publish and a source directory.");
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1}
