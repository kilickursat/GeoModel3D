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
  writeFileSync(stateFile,JSON.stringify({remoteCommit:builtCommit,latest:"v0.20.0",mutations:[],uploadAttempts:[],...initial}));
  writeFileSync(join(bin,"git"),`#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(["rev-parse","HEAD"]))process.exit(90);console.log(${JSON.stringify(builtCommit)});\n`,{mode:0o755});
  writeFileSync(join(bin,"gh"),`#!${process.execPath}
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const stateFile=process.env.GH_TEST_STATE,state=JSON.parse(fs.readFileSync(stateFile,"utf8")),args=process.argv.slice(2);
function finish(value,error){fs.writeFileSync(stateFile,JSON.stringify(state));if(error){console.error(error);process.exit(1)}if(value!==undefined)console.log(JSON.stringify(value));process.exit(0)}
if(args[0]==="api"){
  const endpoint=args[1];
  if(endpoint.includes("/git/ref/tags/"))finish({object:{type:"tag",sha:"annotated-tag"}});
  if(endpoint.includes("/git/tags/"))finish({object:{type:"commit",sha:state.remoteCommit}});
  if(endpoint.endsWith("/releases/latest"))finish(state.latest?{tag_name:state.latest}:undefined,state.latest?undefined:"gh: Not Found (HTTP 404)");
  if(endpoint.includes("/releases/tags/"))finish(state.release,state.release?undefined:"gh: Not Found (HTTP 404)");
  finish(undefined,"Unexpected API endpoint");
}
if(args[0]!=="release")finish(undefined,"Unexpected command");
if(args[1]==="create"){
  state.mutations.push("create");
  state.release={draft:true,tag_name:args[2],assets:[],html_url:"https://example.invalid/draft",body:fs.readFileSync(args[args.indexOf("--notes-file")+1],"utf8")};finish();
}
if(args[1]==="upload"){
  const file=args[3],name=path.basename(file);state.uploadAttempts.push(name);
  if(name==="SHA256SUMS.txt"&&state.failChecksumOnce){state.failChecksumOnce=false;finish(undefined,"Interrupted checksum upload")}
  state.mutations.push("upload:"+name);
  state.release.assets.push({name,state:"uploaded",digest:"sha256:"+crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")});finish();
}
if(args[1]==="edit"){
  state.mutations.push("publish");state.release.draft=false;state.release.html_url="https://example.invalid/releases/tag/v0.21.0";state.markedLatest=args.includes("--latest");finish();
}
finish(undefined,"Unexpected release operation");
`,{mode:0o755});
  const env={PATH:`${bin}${process.platform==="win32"?";":":"}${process.env.PATH??""}`,GH_TOKEN:"test-only-no-network",GH_REPO:"test-owner/test-repo",GH_TEST_STATE:stateFile};
  return {dir,run:()=>run(dir,"publish","v0.21.0",env),state:()=>JSON.parse(readFileSync(stateFile,"utf8"))};
}
describe("release publication lifecycle",()=>{
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
      expect(JSON.parse(resumed.stdout)).toMatchObject({created:false,draft:false,url:done.release.html_url});
    }finally{rmSync(p.dir,{recursive:true,force:true})}
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
      const result=p.run();expect(result.status).toBe(1);expect(result.stderr).toContain("Existing SHA256SUMS.txt");
      expect(p.state().mutations).toEqual([]);expect(p.state().uploadAttempts).toEqual([]);
      expect(p.state().release).toEqual(existing);
    }finally{rmSync(p.dir,{recursive:true,force:true})}
  });
});
