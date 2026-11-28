import {describe,expect,it,vi} from "vitest";
import {startRenderer} from "../src/renderBackend";

const queue=()=>({onSubmittedWorkDone:vi.fn(async()=>{})});

function renderer(device?:{adapterInfo?:{isFallbackAdapter:boolean};queue:ReturnType<typeof queue>}){
  return {
    backend:{device},
    init:vi.fn(async()=>{}),
    dispose:vi.fn(async()=>{})
  };
}

describe("renderer selection",()=>{
  it.each([
    ["hardware adapter",{adapterInfo:{isFallbackAdapter:false},queue:queue()}],
    ["adapter without fallback information",{queue:queue()}],
    ["browser without a WebGPU device",undefined]
  ] as const)("keeps the default renderer on a %s",async(_name,device)=>{
    const primary=renderer(device),create=vi.fn(()=>primary);
    const result=await startRenderer(null,create);
    expect(create.mock.calls).toEqual([[false]]);
    expect(primary.init).toHaveBeenCalledOnce();
    expect(result.renderer).toBe(primary);
    expect(result.softwareWebGPU).toBe(false);
    expect(result.softwareQueue).toBeUndefined();
    expect(primary.dispose).not.toHaveBeenCalled();
  });

  it("retains an explicit WebGPU request and monitors that software device's queue",async()=>{
    const device={adapterInfo:{isFallbackAdapter:true},queue:queue()};
    const primary=renderer(device),create=vi.fn(()=>primary);
    const result=await startRenderer("webgpu",create);
    expect(create.mock.calls).toEqual([[false]]);
    expect(primary.init).toHaveBeenCalledOnce();
    expect(result.renderer).toBe(primary);
    expect(result.softwareWebGPU).toBe(true);
    expect(result.softwareQueue).toBe(device.queue);
    expect(primary.dispose).not.toHaveBeenCalled();
  });

  it("initializes only WebGL when requested explicitly",async()=>{
    const webgl=renderer(),create=vi.fn(()=>webgl);
    const result=await startRenderer("webgl",create);
    expect(create.mock.calls).toEqual([[true]]);
    expect(webgl.init).toHaveBeenCalledOnce();
    expect(result.renderer).toBe(webgl);
    expect(result.softwareQueue).toBeUndefined();
  });

  it("switches a software WebGPU default only after WebGL has initialized",async()=>{
    const primary=renderer({adapterInfo:{isFallbackAdapter:true},queue:queue()}),webgl=renderer();
    let finishWebGL!:()=>void;
    const ready=new Promise<void>(resolve=>{finishWebGL=resolve});
    webgl.init.mockReturnValue(ready);
    const create=vi.fn((forceWebGL:boolean)=>forceWebGL?webgl:primary);
    const startup=startRenderer(null,create);
    await vi.waitFor(()=>expect(webgl.init).toHaveBeenCalledOnce());
    expect(primary.init).toHaveBeenCalledOnce();
    expect(primary.dispose).not.toHaveBeenCalled();
    finishWebGL();
    const result=await startup;
    expect(create.mock.calls).toEqual([[false],[true]]);
    expect(result.renderer).toBe(webgl);
    expect(result.softwareWebGPU).toBe(true);
    expect(result.softwareQueue).toBeUndefined();
    expect(primary.dispose).toHaveBeenCalledOnce();
    expect(webgl.dispose).not.toHaveBeenCalled();
  });

  it("keeps the working WebGL context if the software WebGPU renderer rejects disposal",async()=>{
    const primary=renderer({adapterInfo:{isFallbackAdapter:true},queue:queue()}),webgl=renderer();
    primary.dispose.mockRejectedValueOnce(new Error("WebGPU device lost"));
    const result=await startRenderer(null,forceWebGL=>forceWebGL?webgl:primary);
    expect(webgl.init).toHaveBeenCalledOnce();
    expect(primary.dispose).toHaveBeenCalledOnce();
    expect(result.renderer).toBe(webgl);
    expect(result.softwareQueue).toBeUndefined();
    expect(webgl.dispose).not.toHaveBeenCalled();
  });

  it("keeps the initialized software renderer and its queue if WebGL fails",async()=>{
    const device={adapterInfo:{isFallbackAdapter:true},queue:queue()};
    const primary=renderer(device),webgl=renderer();
    webgl.init.mockRejectedValueOnce(new Error("WebGL context unavailable"));
    const create=vi.fn((forceWebGL:boolean)=>forceWebGL?webgl:primary);
    const result=await startRenderer(null,create);
    expect(create.mock.calls).toEqual([[false],[true]]);
    expect(primary.init).toHaveBeenCalledOnce();
    expect(result.renderer).toBe(primary);
    expect(result.softwareWebGPU).toBe(true);
    expect(result.softwareQueue).toBe(device.queue);
    expect(primary.dispose).not.toHaveBeenCalled();
  });
});
