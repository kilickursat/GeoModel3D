import {describe,it,expect} from "vitest";
import {resizeRgb,rotate,detInput,dbBoxes,crop,recInput,ctcDecode,ctcClasses,readBox,Img} from "../src/docread/ocr";

// An image from a function of each pixel's position, as RGBA.
const image=(w:number,h:number,f:(x:number,y:number)=>[number,number,number]):Img=>{
  const data=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const [r,g,b]=f(x,y);data.set([r,g,b,255],(y*w+x)*4)}
  return {data,width:w,height:h};
};
const settings={thresh:0.2,boxThresh:0.45,unclipRatio:1.4,mean:[0.485,0.456,0.406],std:[0.229,0.224,0.225]};

describe("reading page images: the steps around the models",()=>{
  it("resizes bilinearly, sampling at the pixels' centres",()=>{
    const px=resizeRgb(image(2,1,x=>x?[255,255,255]:[0,0,0]),4,1);
    expect([...px].filter((_,i)=>i%3===0)).toEqual([0,64,191,255]);
  });
  it("turns an image by 90 and 270 degrees clockwise",()=>{
    // 3 × 2, each pixel's red is its index.
    const img=image(3,2,(x,y)=>[y*3+x,0,0]),red=(i:Img)=>[...i.data].filter((_,k)=>k%4===0);
    const r90=rotate(img,90);
    expect([r90.width,r90.height,...red(r90)]).toEqual([2,3, 3,0, 4,1, 5,2]);
    expect(red(rotate(r90,270))).toEqual(red(img));
  });
  it("makes the detection input: multiples of 32, BGR, normalised by the model's mean and spread",()=>{
    const x=detInput(image(40,20,()=>[255,0,0]),settings),n=x.width*x.height;
    expect([x.width,x.height]).toEqual([32,32]);
    expect(x.data[0]).toBeCloseTo((0-0.485)/0.229,5);       // blue first
    expect(x.data[2*n]).toBeCloseTo((1-0.406)/0.225,5);     // red last
  });
  it("finds the boxes of text in the detection map, grown and scaled to the image",()=>{
    const w=20,h=10,prob=new Float32Array(w*h),fill=(x0:number,y0:number,x1:number,y1:number,v:number)=>{for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)prob[y*w+x]=v};
    fill(2,3,7,5,0.9);      // a line of text
    fill(12,2,15,5,0.3);    // above the threshold, but too faint on average
    fill(17,7,18,8,0.9);    // too small
    const boxes=dbBoxes(prob,w,h,40,20,settings);
    expect(boxes).toHaveLength(1);
    const d=6*3*1.4/(2*9);  // area × unclip ratio / perimeter
    expect(boxes[0].x0).toBeCloseTo((2-d)*2,6);
    expect(boxes[0].y1).toBeCloseTo((5+1+d)*2,6);
  });
  it("crops a box inside the image, and none without area",()=>{
    const c=crop(image(10,10,(x,y)=>[x,y,0]),{x0:-3,y0:7.5,x1:4.2,y1:30})!;
    expect([c.width,c.height,c.data[0],c.data[1]]).toEqual([5,3,0,7]);
    expect(crop(image(10,10,()=>[0,0,0]),{x0:2,y0:2,x1:2.5,y1:8})).toBeNull();
  });
  it("makes the recognition input 48 px high, padded to 320 px with zeros",()=>{
    const x=recInput(image(10,10,()=>[255,255,255]));
    expect([x.width,x.data.length]).toEqual([320,3*48*320]);
    expect([x.data[47],x.data[48],x.data[47*320]]).toEqual([1,0,1]);
  });
  it("decodes the recognition output: blanks part repeated characters, and repeats collapse",()=>{
    const classes=ctcClasses(["a","b"]),C=classes.length,steps=[1,1,0,1,2,2,0,3];
    const out=new Float32Array(steps.length*C);
    steps.forEach((c,t)=>{out[t*C+c]=c===2?0.6:0.9});
    const r=ctcDecode(out,steps.length,C,classes);
    expect(r.text).toBe("aab");
    expect(r.conf).toBeCloseTo((0.9+0.9+0.6+0.9)/4,6);
  });
  it("reads a tall box turned both ways and keeps the more confident reading",async()=>{
    // A marker at the top left: turned 90° clockwise it is at the top right.
    const tall=image(10,30,(x,y)=>x===0&&y===0?[255,0,0]:[0,0,0]);
    const upright=async(i:Img)=>i.data[(i.width-1)*4]===255?{text:"up",conf:0.9}:{text:"down",conf:0.6};
    expect(await readBox(tall,upright)).toEqual({text:"up",conf:0.9});
    // A square box read with doubt is tried turned, and a clearly better reading wins; a slightly better one does not.
    const square=image(20,20,()=>[0,0,0]);
    const turnedBetter=async(i:Img)=>i===square?{text:"oT",conf:0.5}:{text:"To",conf:0.7};
    const turnedSame=async(i:Img)=>i===square?{text:"oT",conf:0.5}:{text:"To",conf:0.55};
    expect((await readBox(square,turnedBetter)).text).toBe("To");
    expect((await readBox(square,turnedSame)).text).toBe("oT");
  });
});
