import {describe,expect,it,vi} from "vitest";
import {requestDocumentGpuAdapter} from "../src/webgpuAdapter";

describe("OCR and report Qwen adapter selection",()=>{
  it.each([
    {info:{vendor:"google",architecture:"swiftshader",isFallbackAdapter:true}}, // Chromium reading SARFIIP K7
    {info:{vendor:"google",architecture:"swiftshader"}},
    {info:{description:"",isFallbackAdapter:true}},
    {isFallbackAdapter:true,info:{vendor:"NVIDIA"}},
    {info:{description:"Mesa llvmpipe",isFallbackAdapter:false}},
    {info:{vendor:"google"}},
    {info:{}},
    null
  ])("uses WebAssembly for a software, unknown or missing adapter (%j)",async adapter=>{
    await expect(requestDocumentGpuAdapter({requestAdapter:async()=>adapter})).resolves.toBeNull();
  });

  it.each([{info:{vendor:"NVIDIA"}},{info:{description:"",isFallbackAdapter:false}}])(
    "hands the same high-performance hardware adapter to ONNX (%j)",async adapter=>{
      const requestAdapter=vi.fn(async()=>adapter);
      await expect(requestDocumentGpuAdapter({requestAdapter})).resolves.toBe(adapter);
      expect(requestAdapter).toHaveBeenCalledWith({powerPreference:"high-performance"});
    });

  it("uses WebAssembly if the browser rejects the adapter request",async()=>{
    await expect(requestDocumentGpuAdapter({requestAdapter:async()=>{throw new Error("unavailable")}})).resolves.toBeNull();
  });
});
