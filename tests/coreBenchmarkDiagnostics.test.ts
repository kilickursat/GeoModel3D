import {describe,expect,it} from "vitest";
import {benchmarkDiagnosticText,benchmarkResourceName,checkedCoreBenchmarkFailure,checkedCoreBenchmarkProgress,CoreBenchmarkError,coreBenchmarkFailure} from "../src/coreBenchmarkDiagnostics";

describe("benchmark diagnostic boundaries",()=>{
  it("preserves useful failure context without signed URLs, image bytes or arbitrary fields",()=>{
    const source={stage:"model-load",name:"TypeError",message:"Load failed: https://cdn.example.test/model?token=secret data:image/png;base64,AAAA",operation:"read-response",resource:"onnx/decoder_model_merged_q4.onnx_data",loadedBytes:42,httpStatus:200,stack:"private stack",image:"data:image/png;base64,AAAA"};
    const failure=checkedCoreBenchmarkFailure(source);
    expect(failure).toEqual({stage:"model-load",name:"TypeError",message:"Load failed: [URL omitted] [data omitted]",operation:"read-response",resource:source.resource,loadedBytes:42,httpStatus:200});
    expect(JSON.stringify(failure)).not.toMatch(/secret|data:image|private stack/);
    expect(coreBenchmarkFailure(new CoreBenchmarkError(failure),"generate")).toEqual(failure);
  });
  it("keeps legacy progress compatible and whitelists new observations",()=>{
    const progress={phase:"loading",message:"Loading file",stage:"processor-load",file:"tokenizer.json",loaded:1024,total:2048,elapsedMs:100,unwanted:{bytes:"private"}};
    expect(checkedCoreBenchmarkProgress(progress)).toEqual({phase:"loading",message:"Loading file",stage:"processor-load",file:"tokenizer.json",loaded:1024,total:2048,elapsedMs:100});
    expect(checkedCoreBenchmarkProgress({phase:"running",message:"Generating",firstTokenMs:null})).toEqual({phase:"running",message:"Generating",firstTokenMs:null});
    expect(checkedCoreBenchmarkProgress({...progress,file:"https://example.test/model?token=secret"}).file).toBeUndefined();
  });
  it("rejects invalid or oversized diagnostic fields and strips untrusted resource identities",()=>{
    const valid={stage:"model-load",name:"TypeError",message:"Load failed"};
    for(const change of [{stage:"finished"},{name:"x".repeat(129)},{message:"x".repeat(4097)},{operation:"execute"},{httpStatus:0},{httpStatus:200.5},{loadedBytes:-1},{totalBytes:Infinity}])expect(()=>checkedCoreBenchmarkFailure({...valid,...change})).toThrow();
    for(const change of [{phase:"done"},{stage:"finished"},{loaded:-1},{total:Infinity},{elapsedMs:NaN},{firstTokenMs:-1},{message:"x".repeat(4097)}])expect(()=>checkedCoreBenchmarkProgress({phase:"loading",message:"Loading",...change})).toThrow();
    for(const name of ["../tokenizer.json","onnx/../model","https://example.test/private","model?secret=x","model#secret","a".repeat(257),"data:image/png;base64,AAAA"])expect(benchmarkResourceName(name)).toBeUndefined();
    expect(checkedCoreBenchmarkFailure({...valid,resource:"model?secret=x"}).resource).toBeUndefined();
  });
  it("labels unknown failures without inventing a network or memory cause",()=>{
    const failure=coreBenchmarkFailure(new TypeError("Load failed"),"image-fetch");
    expect(failure).toEqual({stage:"image-fetch",name:"TypeError",message:"Load failed"});
    expect(coreBenchmarkFailure("Browser stopped","worker-start",{operation:"worker"})).toEqual({stage:"worker-start",name:"Error",message:"Browser stopped",operation:"worker"});
    expect(benchmarkDiagnosticText("x".repeat(4096))).toHaveLength(2048);
  });
});
