import {describe,expect,it} from "vitest";
import {coreAiCropPlan,selectCoreAiRegion} from "../src/coreAiCrop";
import type {CoreRow} from "../src/corePhoto";

function row(direction:"ltr"|"rtl"="ltr"):CoreRow{
  return {id:"row-1",from:10,to:12,direction,registrationReviewed:true,box:{x0:.1,y0:.2,x1:.9,y1:.4},
    pieces:[{id:"first",end:10.25},{id:"middle",end:11.5},{id:"last",end:12}].map(p=>({...p,sound:"unknown",breakAfter:"unknown",unit:"",description:""}))};
}
describe("registered core AI selections",()=>{
  it("retains the whole row and returns a detached registration snapshot",()=>{
    const original=row(),before=structuredClone(original),region=selectCoreAiRegion(original);
    expect(region).toEqual({kind:"row",rowId:"row-1",from:10,to:12,direction:"ltr",box:original.box});
    region.box.x0=0;expect(original).toEqual(before);
  });
  it("maps the first and last left-to-right pieces to their actual depth spans",()=>{
    const first=selectCoreAiRegion(row(),"first"),last=selectCoreAiRegion(row(),"last");
    expect(first).toMatchObject({kind:"piece",pieceId:"first",from:10,to:10.25});
    expect(first.box.x0).toBeCloseTo(.1,12);expect(first.box.x1).toBeCloseTo(.2,12);
    expect(last).toMatchObject({pieceId:"last",from:11.5,to:12});
    expect(last.box.x0).toBeCloseTo(.7,12);expect(last.box.x1).toBeCloseTo(.9,12);
    expect(first.box.y0).toBe(.2);expect(last.box.y1).toBe(.4);
  });
  it("reverses image positions for right-to-left pieces without reversing their depths",()=>{
    const first=selectCoreAiRegion(row("rtl"),"first"),last=selectCoreAiRegion(row("rtl"),"last");
    expect([first.from,first.to,last.from,last.to]).toEqual([10,10.25,11.5,12]);
    expect(first.box.x0).toBeCloseTo(.8,12);expect(first.box.x1).toBeCloseTo(.9,12);
    expect(last.box.x0).toBeCloseTo(.1,12);expect(last.box.x1).toBeCloseTo(.3,12);
  });
  it("does not mutate reviewed pieces or their annotations when selecting a closer crop",()=>{
    const original=row("rtl"),before=structuredClone(original);
    const region=selectCoreAiRegion(original,"middle");coreAiCropPlan(region,1600,800);region.box.x0=0;
    expect(original).toEqual(before);
  });
  it("rejects a missing or ambiguous piece instead of substituting another interval",()=>{
    expect(()=>selectCoreAiRegion(row(),"missing")).toThrow(/no longer/);
    expect(()=>selectCoreAiRegion(row(),"")).toThrow(/Choose a piece/);
    const duplicate=row();duplicate.pieces[2].id="first";
    expect(()=>selectCoreAiRegion(duplicate,"first")).toThrow(/identifiers/);
  });
  it("rejects malformed depth partitions and photo bounds",()=>{
    const reversed=row();reversed.pieces[1].end=10.1;
    expect(()=>selectCoreAiRegion(reversed,"first")).toThrow(/depths/);
    const incomplete=row();incomplete.pieces.pop();
    expect(()=>selectCoreAiRegion(incomplete,"first")).toThrow(/do not cover/);
    const invalid=row();invalid.box.x1=1.01;
    expect(()=>selectCoreAiRegion(invalid,"first")).toThrow(/valid photo region/);
    const noDepth=row();noDepth.to=noDepth.from;
    expect(()=>selectCoreAiRegion(noDepth)).toThrow(/invalid depth/);
  });
});
describe("aspect-preserving core AI crop plans",()=>{
  it("upscales a small piece to fill the long frame edge, without changing its source rectangle",()=>{
    const plan=coreAiCropPlan({box:{x0:.1,y0:.2,x1:.2,y1:.4}},400,200);
    expect(plan.pixels).toEqual({x:40,y:40,width:40,height:40});
    expect(plan.preprocessing).toMatchObject({scale:12.8,upscaled:true,scaledWidth:512,scaledHeight:512,padding:{left:0,top:0,right:0,bottom:0}});
    expect([plan.width,plan.height]).toEqual([512,512]);
  });
  it("fits an oversized narrow row without stretching its short dimension",()=>{
    const plan=coreAiCropPlan({box:{x0:0,y0:0,x1:1,y1:1}},4096,512);
    expect(plan.preprocessing).toMatchObject({scale:.125,upscaled:false,scaledWidth:512,scaledHeight:64,padding:{left:0,top:224,right:0,bottom:224}});
  });
  it("centres portrait crops with at most one pixel of asymmetric padding",()=>{
    const plan=coreAiCropPlan({box:{x0:0,y0:0,x1:1,y1:1}},17,30),p=plan.preprocessing;
    expect(p.scaledHeight).toBe(512);expect(p.scaledWidth).toBe(290);expect(p.scale).toBeCloseTo(512/30,12);
    expect(p.padding.left+p.scaledWidth+p.padding.right).toBe(512);
    expect(p.padding.top+p.scaledHeight+p.padding.bottom).toBe(512);
    expect(Math.abs(p.padding.left-p.padding.right)).toBeLessThanOrEqual(1);
  });
  it("covers fractional source pixels and clamps the image boundary",()=>{
    const plan=coreAiCropPlan({box:{x0:.101,y0:.201,x1:1,y1:1}},101,53);
    expect(plan.pixels).toEqual({x:10,y:10,width:91,height:43});
    const tiny=coreAiCropPlan({box:{x0:.999,y0:.999,x1:1,y1:1}},10,10);
    expect(tiny.pixels).toEqual({x:9,y:9,width:1,height:1});
    expect(tiny.preprocessing.scaledWidth).toBe(512);expect(tiny.preprocessing.scaledHeight).toBe(512);
  });
  it("rejects invalid image sizes, frame sizes and reversed rectangles",()=>{
    const region=selectCoreAiRegion(row());
    for(const size of [0,-1,NaN,Infinity,2.5])expect(()=>coreAiCropPlan(region,size,100)).toThrow(/dimensions/);
    for(const edge of [0,-1,4097,NaN,2.5])expect(()=>coreAiCropPlan(region,100,100,edge)).toThrow(/frame size/);
    expect(()=>coreAiCropPlan({box:{x0:.5,y0:0,x1:.4,y1:1}},100,100)).toThrow(/valid photo region/);
  });
});
