/// <reference types="node" />
import {describe,it,expect} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"geomodel-release-"));
  writeFileSync(join(dir,"package.json"),JSON.stringify({version:"0.21.0"}));
  writeFileSync(join(dir,"package-lock.json"),JSON.stringify({version:"0.21.0",packages:{"":{version:"0.21.0"}}}));
  writeFileSync(join(dir,"CITATION.cff"),"version: 0.21.0\n");
  writeFileSync(join(dir,"CHANGELOG.md"),"# Changelog\n\n## Unreleased\n\n## 0.21.0 — 2026-11-14\n\n### Added\n- Selected interpretations.\n\n## 0.20.0 — 2026-11-14\n\nOlder notes.\n");
  return dir;
}
const run=(dir:string,mode:string,tag="v0.21.0",extraEnv:NodeJS.ProcessEnv={})=>{
  const result=spawnSync(process.execPath,[resolve("scripts/release-assets.mjs"),mode,dir],{encoding:"utf8",env:{...process.env,RELEASE_TAG:tag,...extraEnv}});
  if(result.error)throw result.error;
  return result;
};
describe("release artifact preparation",()=>{
  it("checks matching source metadata and creates the checksum and only that version's release notes",()=>{
    const dir=fixture();
    try{
      mkdirSync(join(dir,"dist"));const html="<!doctype html><title>GeoModel3D 0.21.0</title>";
      writeFileSync(join(dir,"dist/geomodel3d-offline.html"),html);
      const result=run(dir,"prepare");expect(result.status,result.stderr).toBe(0);
      const expected=createHash("sha256").update(html).digest("hex");
      expect(readFileSync(join(dir,".cache/SHA256SUMS.txt"),"utf8")).toBe(`${expected}  geomodel3d-offline.html\n`);
      const notes=readFileSync(join(dir,".cache/release-notes.md"),"utf8");
      expect(notes).toContain("Selected interpretations.");expect(notes).toContain(expected);expect(notes).not.toContain("Older notes");
    }finally{rmSync(dir,{recursive:true,force:true})}
  });
  it("rejects arbitrary refs, version mismatches and a missing standalone file before publishing",()=>{
    const dir=fixture();
    try{
      for(const tag of ["main","v0.21.0; echo nope","v01.21.0","v0.21.0-beta"])expect(run(dir,"validate",tag).status).not.toBe(0);
      expect(run(dir,"validate","v0.20.0").stderr).toContain("must match");
      writeFileSync(join(dir,"CITATION.cff"),"version: 0.20.0\n");
      expect(run(dir,"validate").stderr).toContain("Citation");
      writeFileSync(join(dir,"CITATION.cff"),"version: 0.21.0\n");
      expect(run(dir,"prepare").stderr).toContain("Build the standalone HTML");
      writeFileSync(join(dir,"CHANGELOG.md"),"## Unreleased\nNo version entry.\n");
      expect(run(dir,"validate").stderr).toContain("dated changelog");
    }finally{rmSync(dir,{recursive:true,force:true})}
  });
});

const builtCommit="a".repeat(40);
// Exercise the real CLI orchestration against isolated fake executables, with no GitHub requests or real tokens.
function publication(initial:Record<string,unknown>={}){
  const dir=fixture(),bin=join(dir,"bin"),stateFile=join(dir,"github-state.json");
  mkdirSync(bin);mkdirSync(join(dir,"dist"));
  writeFileSync(join(dir,"dist/geomodel3d-offline.html"),"<!doctype html><title>GeoModel3D 0.21.0</title>");
  const state={remoteCommit:builtCommit,latest:"v0.20.0",mutations:[],uploadAttempts:[],apiCalls:[],requests:[],...initial} as Record<string,any>;
  if(state.release)state.release={id:1,tag_name:"v0.21.0",...state.release};
  writeFileSync(stateFile,JSON.stringify(state));
  writeFileSync(join(bin,"git"),`#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(["rev-parse","HEAD"]))process.exit(90);console.log(${JSON.stringify(builtCommit)});\n`,{mode:0o755});
  writeFileSync(join(bin,"gh"),`#!${process.execPath}
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const stateFile=process.env.GH_TEST_STATE,state=JSON.parse(fs.readFileSync(stateFile,"utf8")),args=process.argv.slice(2);
function finish(value,error){fs.writeFileSync(stateFile,JSON.stringify(state));if(error){console.error(error);process.exit(1)}if(value!==undefined)console.log(JSON.stringify(value));process.exit(0)}
if(args[0]==="api"){
  const endpoint=args[1],url=new URL(endpoint,"https://example.invalid/"),method=args.includes("--method")?args[args.indexOf("--method")+1]:"GET";
  const input=args.includes("--input")?args[args.indexOf("--input")+1]:undefined,header=args.includes("--header")?args[args.indexOf("--header")+1]:undefined;
  state.apiCalls.push(endpoint);state.requests.push({endpoint,method,header});
  if(method==="POST"&&url.pathname==="/repos/test-owner/test-repo/releases"){
    if(header!=="Content-Type: application/json"||!input)finish(undefined,"Expected JSON request file");
    const body=JSON.parse(fs.readFileSync(input,"utf8"));state.creationBody=body;state.mutations.push("create");
    state.release={id:state.createdId??1,draft:body.draft,tag_name:body.tag_name,target_commitish:body.target_commitish,assets:[],html_url:"https://example.invalid/draft",body:body.body};
    if(state.moveTagAfterCreate)state.remoteCommit="b".repeat(40);
    finish(state.createResponse===undefined?state.release:state.createResponse);
  }
  if(method==="POST"&&url.pathname.endsWith("/assets")){
    if(url.origin!=="https://uploads.github.com"||url.pathname!=="/repos/test-owner/test-repo/releases/"+state.release.id+"/assets"||header!=="Content-Type: application/octet-stream"||!input)finish(undefined,"Unexpected binary upload");
    const name=url.searchParams.get("name");
    if(name!==path.basename(input))finish(undefined,"Asset name must match raw file");state.uploadAttempts.push(name);
    if(name==="SHA256SUMS.txt"&&state.failChecksumOnce){state.failChecksumOnce=false;finish(undefined,"Interrupted checksum upload")}
    state.mutations.push("upload:"+name);
    const bytes=fs.readFileSync(input),asset={name,state:"uploaded",size:bytes.length,digest:"sha256:"+crypto.createHash("sha256").update(bytes).digest("hex")};
    state.release.assets.push(asset);finish(state.uploadResponse??asset);
  }
  if(method==="PATCH"){
    if(url.pathname!=="/repos/test-owner/test-repo/releases/"+state.release.id||header!=="Content-Type: application/json"||!input)finish(undefined,"Unexpected release update");
    const body=JSON.parse(fs.readFileSync(input,"utf8"));
    if(JSON.stringify(Object.keys(body).sort())!==JSON.stringify(["draft","make_latest"])||body.draft!==false||!["true","false"].includes(body.make_latest))finish(undefined,"Unexpected publication fields");
    state.mutations.push("publish");state.release.draft=false;state.release.html_url="https://example.invalid/releases/tag/v0.21.0";state.markedLatest=body.make_latest==="true";finish(state.publishResponse??state.release);
  }
  if(method!=="GET")finish(undefined,"Unexpected API mutation");
  if(endpoint.includes("/git/ref/tags/"))finish({object:{type:"tag",sha:"annotated-tag"}});
  if(endpoint.includes("/git/tags/"))finish({object:{type:"commit",sha:state.remoteCommit}});
  if(endpoint.endsWith("/releases/latest"))finish(state.latest?{tag_name:state.latest}:undefined,state.latest?undefined:"gh: Not Found (HTTP 404)");
  // GitHub's by-tag endpoint intentionally excludes draft releases, even for an authenticated owner.
  if(endpoint.includes("/releases/tags/")){
    const published=state.release&&!state.release.draft;finish(published?state.release:undefined,published?undefined:"gh: Not Found (HTTP 404)");
  }
  const listed=[...(state.listedReleases??[]),...(state.release?[state.release]:[])];
  if(url.pathname.endsWith("/releases")){
    const page=Number(url.searchParams.get("page")??1),perPage=Number(url.searchParams.get("per_page")??100);
    const visible=state.hideCreatedFromLists&&state.mutations.includes("create")?listed.filter(release=>release.id!==state.release.id):listed;
    finish(visible.slice((page-1)*perPage,page*perPage));
  }
  const id=Number(url.pathname.split("/").at(-1));
  if(url.pathname.includes("/releases/")&&Number.isInteger(id)){
    const release=listed.find(release=>release.id===id);finish(release,release?undefined:"gh: Not Found (HTTP 404)");
  }
  finish(undefined,"Unexpected API endpoint");
}
finish(undefined,"Publication must use the authoritative release ID, not a CLI tag lookup");
`,{mode:0o755});
  const env={PATH:`${bin}${process.platform==="win32"?";":":"}${process.env.PATH??""}`,GH_TOKEN:"test-only-no-network",GH_REPO:"test-owner/test-repo",GH_TEST_STATE:stateFile};
  return {dir,run:()=>run(dir,"publish","v0.21.0",env),state:()=>JSON.parse(readFileSync(stateFile,"utf8"))};
}
describe("release publication lifecycle",()=>{
  it("publishes using the returned release ID even while the new draft is absent from release listings",()=>{
    const p=publication({hideCreatedFromLists:true,createdId:446446692});
    try{
      const notes="## 0.21.0 — 2026-11-14\n\nKeep literal `$(echo untouched)` and $HOME.\n\nA second paragraph.\n";
      writeFileSync(join(p.dir,"CHANGELOG.md"),notes);
      const result=p.run();expect(result.status,result.stderr).toBe(0);
      const done=p.state();expect(done.release.id).toBe(446446692);expect(done.release.draft).toBe(false);
      expect(done.creationBody).toEqual({tag_name:"v0.21.0",target_commitish:builtCommit,name:"GeoModel3D 0.21.0",
        body:readFileSync(join(p.dir,".cache/release-notes.md"),"utf8"),draft:true,prerelease:false});
      expect(done.creationBody.body).toContain("Keep literal `$(echo untouched)` and $HOME.\n\nA second paragraph.");
      expect(done.apiCalls.filter((path:string)=>path.includes("/releases?per_page="))).toHaveLength(1);
      expect(done.apiCalls.filter((path:string)=>path.includes("/releases/tags/"))).toHaveLength(1);
      expect(done.requests.filter((request:{method:string})=>request.method==="POST").map((request:{endpoint:string})=>request.endpoint)).toEqual([
        "repos/test-owner/test-repo/releases",
        "https://uploads.github.com/repos/test-owner/test-repo/releases/446446692/assets?name=geomodel3d-offline.html",
        "https://uploads.github.com/repos/test-owner/test-repo/releases/446446692/assets?name=SHA256SUMS.txt"
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({created:true,draft:false});
    }finally{rmSync(p.dir,{recursive:true,force:true})}
  });

  it("resumes its own interrupted draft, skips the identical HTML and publishes only after both assets verify",()=>{
    const p=publication({failChecksumOnce:true});
    try{
      const interrupted=p.run();expect(interrupted.status).toBe(1);expect(interrupted.stderr).toContain("Interrupted checksum upload");
      const draft=p.state();expect(draft.release.draft).toBe(true);
      expect(draft.release.body).toContain(`<!-- geomodel3d-release-assets:v0.21.0:${builtCommit} -->`);
      expect(draft.release.assets.map((a:{name:string})=>a.name)).toEqual(["geomodel3d-offline.html"]);
      expect(draft.mutations).not.toContain("publish");
      const resumed=p.run();expect(resumed.status,resumed.stderr).toBe(0);
      const done=p.state();expect(done.release.draft).toBe(false);expect(done.markedLatest).toBe(true);
      expect(done.uploadAttempts).toEqual(["geomodel3d-offline.html","SHA256SUMS.txt","SHA256SUMS.txt"]);
      expect(done.mutations).toEqual(["create","upload:geomodel3d-offline.html","upload:SHA256SUMS.txt","publish"]);
      expect(done.apiCalls.some((path:string)=>path.includes("/releases?per_page=100&page=1"))).toBe(true);
      expect(done.apiCalls.filter((path:string)=>path.endsWith("/releases/1")).length).toBeGreaterThanOrEqual(3);
      expect(JSON.parse(resumed.stdout)).toMatchObject({created:false,draft:false,url:done.release.html_url});
      const repeated=p.run();expect(repeated.status,repeated.stderr).toBe(0);
      expect(p.state().mutations).toEqual(done.mutations);expect(p.state().uploadAttempts).toEqual(done.uploadAttempts);
    }finally{rmSync(p.dir,{recursive:true,force:true})}
  });
  it("stops before asset uploads when creation returns a malformed or mismatched release",()=>{
    const valid={id:1,tag_name:"v0.21.0",draft:true,assets:[],body:`<!-- geomodel3d-release-assets:v0.21.0:${builtCommit} -->`};
    for(const response of [{...valid,id:0},{...valid,id:"1"},{...valid,tag_name:"v0.22.0"},{...valid,draft:false},{...valid,assets:{}},{...valid,body:"Not owned"}]){
      const p=publication({createResponse:response});
      try{
        const result=p.run();expect(result.status).toBe(1);expect(result.stderr).toMatch(/invalid release|requested owned draft/);
        expect(p.state().mutations).toEqual(["create"]);expect(p.state().uploadAttempts).toEqual([]);
      }finally{rmSync(p.dir,{recursive:true,force:true})}
    }
  });
  it("checks the tag again before uploading and refuses an unverified upload response",()=>{
    for(const scenario of [
      {initial:{moveTagAfterCreate:true},error:"remote tag moved",mutations:["create"]},
      {initial:{uploadResponse:{name:"geomodel3d-offline.html",state:"uploaded",digest:"sha256:incorrect"}},error:"did not match its checksum",mutations:["create","upload:geomodel3d-offline.html"]}
    ]){
      const p=publication(scenario.initial);
      try{
        const result=p.run();expect(result.status).toBe(1);expect(result.stderr).toContain(scenario.error);
        expect(p.state().mutations).toEqual(scenario.mutations);expect(p.state().release.draft).toBe(true);
      }finally{rmSync(p.dir,{recursive:true,force:true})}
    }
  });
  it("requires the publication response to confirm the same release and both verified assets",()=>{
    for(const response of [
      {id:2,tag_name:"v0.21.0",draft:false,assets:[]},
      {id:1,tag_name:"v0.21.0",draft:true,assets:[]},
      {id:1,tag_name:"v0.21.0",draft:false,assets:[]}
    ]){
      const p=publication({publishResponse:response});
      try{
        const result=p.run();expect(result.status).toBe(1);expect(result.stderr).toMatch(/invalid release|did not publish|did not match/);
        expect(p.state().mutations).toEqual(["create","upload:geomodel3d-offline.html","upload:SHA256SUMS.txt","publish"]);
      }finally{rmSync(p.dir,{recursive:true,force:true})}
    }
  });
  it("adds missing assets without changing an existing manual draft or published release's notes/state",()=>{
    for(const draft of [true,false]){
      const p=publication({release:{draft,body:"Handwritten release notes",assets:[],html_url:"https://example.invalid/existing"}});
      try{
        const result=p.run();expect(result.status,result.stderr).toBe(0);
        expect(p.state().release).toMatchObject({draft,body:"Handwritten release notes"});
        expect(p.state().mutations).toEqual(["upload:geomodel3d-offline.html","upload:SHA256SUMS.txt"]);
        expect(JSON.parse(result.stdout).existingReleaseStatePreserved).toBe(true);
      }finally{rmSync(p.dir,{recursive:true,force:true})}
    }
  });
  it("refuses a moved tag or a different immutable asset before any publication mutation",()=>{
    const cases=[
      {initial:{remoteCommit:"b".repeat(40)},error:"remote tag moved"},
      {initial:{release:{draft:false,assets:[{name:"geomodel3d-offline.html",state:"uploaded",digest:"sha256:different"}]}},error:"not replaced"}
    ];
    for(const c of cases){
      const p=publication(c.initial);
      try{const result=p.run();expect(result.status).toBe(1);expect(result.stderr).toContain(c.error);expect(p.state().mutations).toEqual([])}
      finally{rmSync(p.dir,{recursive:true,force:true})}
    }
  });
  it("publishes an older repaired tag without replacing the newer Latest release",()=>{
    const p=publication({latest:"v0.22.0"});
    try{const result=p.run();expect(result.status,result.stderr).toBe(0);expect(p.state().release.draft).toBe(false);expect(p.state().markedLatest).toBe(false)}
    finally{rmSync(p.dir,{recursive:true,force:true})}
  });
  it("preflights a conflicting checksum asset before uploading a missing HTML asset",()=>{
    const existing={draft:false,body:"Published notes",assets:[{name:"SHA256SUMS.txt",state:"uploaded",digest:"sha256:conflicting"}]};
    const p=publication({release:existing});
    try{
      const before=p.state().release;
      const result=p.run();expect(result.status).toBe(1);expect(result.stderr).toContain("Existing SHA256SUMS.txt");
      expect(p.state().mutations).toEqual([]);expect(p.state().uploadAttempts).toEqual([]);
      expect(p.state().release).toEqual(before);
    }finally{rmSync(p.dir,{recursive:true,force:true})}
  });
  it("finds and resumes an owned draft on a second authenticated release-list page",()=>{
    const unrelated=Array.from({length:100},(_,i)=>({id:100+i,tag_name:`v0.1.${i}`,draft:false}));
    const p=publication({listedReleases:unrelated,release:{id:445261559,draft:true,assets:[],body:`Owned interrupted draft\n<!-- geomodel3d-release-assets:v0.21.0:${builtCommit} -->`}});
    try{
      const result=p.run();expect(result.status,result.stderr).toBe(0);
      const done=p.state();expect(done.release.id).toBe(445261559);expect(done.release.draft).toBe(false);
      expect(done.apiCalls.some((path:string)=>path.includes("/releases?per_page=100&page=2"))).toBe(true);
      expect(done.apiCalls.some((path:string)=>path.endsWith("/releases/445261559"))).toBe(true);
      expect(done.mutations).toEqual(["upload:geomodel3d-offline.html","upload:SHA256SUMS.txt","publish"]);
    }finally{rmSync(p.dir,{recursive:true,force:true})}
  });
  it("rejects multiple matching draft releases instead of creating or uploading to an ambiguous release",()=>{
    const p=publication({listedReleases:[{id:2,tag_name:"v0.21.0",draft:true,assets:[]}],release:{draft:true,assets:[],body:"An existing draft"}});
    try{
      const result=p.run();expect(result.status).toBe(1);expect(result.stderr).toMatch(/ambiguous|multiple|more than one|duplicate/i);
      expect(p.state().mutations).toEqual([]);expect(p.state().uploadAttempts).toEqual([]);
    }finally{rmSync(p.dir,{recursive:true,force:true})}
  });
});
