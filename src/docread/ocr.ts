// Reading the text of a page image, the steps around the two models of PP-OCRv6 small (PaddlePaddle): the detection
// input (the page at its own size, rounded to multiples of 32, BGR, normalised), the boxes from the detection map (DB
// post-process), each box cut out and turned upright, the recognition input (48 px high, normalised to [-1, 1], padded),
// and the decoding of the recognition output (greedy CTC). The settings come from the models' inference.yml
// (scripts/fetch-ocr-models.mjs). The models themselves run in ocr.worker.ts; these steps are plain functions, so they
// are tested without them.

// An image as RGBA bytes, row by row (canvas ImageData).
export interface Img { data:Uint8ClampedArray|Uint8Array; width:number; height:number }
export interface Box { x0:number; y0:number; x1:number; y1:number }
export interface DetSettings { thresh:number; boxThresh:number; unclipRatio:number; mean:number[]; std:number[] }
export interface Reading { text:string; conf:number }
export interface OcrLine extends Box { text:string; conf:number }

// The image at w × h, its RGB channels sampled bilinearly at the pixels' centres.
export function resizeRgb(img:Img,w:number,h:number):Uint8Array{
  const {data,width:W,height:H}=img,out=new Uint8Array(w*h*3),sx=W/w,sy=H/h;
  for(let y=0;y<h;y++){
    const fy=Math.min(Math.max((y+0.5)*sy-0.5,0),H-1),y0=Math.floor(fy),y1=Math.min(y0+1,H-1),ty=fy-y0;
    for(let x=0;x<w;x++){
      const fx=Math.min(Math.max((x+0.5)*sx-0.5,0),W-1),x0=Math.floor(fx),x1=Math.min(x0+1,W-1),tx=fx-x0;
      const a=(y0*W+x0)*4,b=(y0*W+x1)*4,c=(y1*W+x0)*4,d=(y1*W+x1)*4,o=(y*w+x)*3;
      for(let k=0;k<3;k++){
        const top=data[a+k]+(data[b+k]-data[a+k])*tx,bottom=data[c+k]+(data[d+k]-data[c+k])*tx;
        out[o+k]=Math.round(top+(bottom-top)*ty);
      }
    }
  }
  return out;
}

// The detection input: the image at its own size, both sides rounded to multiples of 32; channels in BGR order (as
// PaddleOCR reads images), each normalised by the model's mean and standard deviation.
export function detInput(img:Img,s:DetSettings){
  const w=Math.max(32,Math.round(img.width/32)*32),h=Math.max(32,Math.round(img.height/32)*32);
  const px=resizeRgb(img,w,h),x=new Float32Array(3*w*h),n=w*h;
  for(let i=0;i<n;i++)for(let c=0;c<3;c++)x[c*n+i]=(px[i*3+(2-c)]/255-s.mean[c])/s.std[c];
  return {data:x,width:w,height:h};
}

// Boxes from the detection map (w × h): pixels above `thresh`, joined into regions; a region's mean probability must
// reach `boxThresh`; its box grows by area · unclipRatio / perimeter on every side, and is scaled to the image.
export function dbBoxes(prob:ArrayLike<number>,w:number,h:number,W:number,H:number,s:Pick<DetSettings,"thresh"|"boxThresh"|"unclipRatio">):Box[]{
  const seen=new Uint8Array(w*h),boxes:Box[]=[];
  for(let start=0;start<w*h;start++){
    if(seen[start]||prob[start]<=s.thresh)continue;
    const stack=[start];seen[start]=1;
    let x0=w,y0=h,x1=0,y1=0,sum=0,n=0;
    while(stack.length){
      const p=stack.pop()!,px=p%w,py=(p-px)/w;
      x0=Math.min(x0,px);x1=Math.max(x1,px);y0=Math.min(y0,py);y1=Math.max(y1,py);sum+=prob[p];n++;
      for(const q of [p-1,p+1,p-w,p+w]){
        if(q<0||q>=w*h||seen[q]||prob[q]<=s.thresh)continue;
        if((q===p-1||q===p+1)&&Math.floor(q/w)!==py)continue;
        seen[q]=1;stack.push(q);
      }
    }
    const bw=x1-x0+1,bh=y1-y0+1;
    if(Math.min(bw,bh)<3||sum/n<s.boxThresh)continue;
    const d=bw*bh*s.unclipRatio/(2*(bw+bh));
    boxes.push({x0:Math.max(0,(x0-d)/w*W),y0:Math.max(0,(y0-d)/h*H),x1:Math.min(W,(x1+1+d)/w*W),y1:Math.min(H,(y1+1+d)/h*H)});
  }
  return boxes;
}

// The pixels of a box, kept inside the image; null for a box without area.
export function crop(img:Img,b:Box):Img|null{
  if(![b.x0,b.y0,b.x1,b.y1].every(Number.isFinite)||b.x1-b.x0<1||b.y1-b.y0<1)return null;
  const W=img.width,H=img.height;
  const left=Math.min(W-1,Math.max(0,Math.floor(b.x0))),top=Math.min(H-1,Math.max(0,Math.floor(b.y0)));
  const w=Math.min(W-left,Math.max(1,Math.ceil(b.x1)-left)),h=Math.min(H-top,Math.max(1,Math.ceil(b.y1)-top));
  const data=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)data.set(img.data.subarray(((top+y)*W+left)*4,((top+y)*W+left+w)*4),y*w*4);
  return {data,width:w,height:h};
}

// The image turned clockwise by 90 or 270 degrees.
export function rotate(img:Img,deg:90|270):Img{
  const {width:w,height:h}=img,out=new Uint8ClampedArray(w*h*4);
  for(let ny=0;ny<w;ny++)for(let nx=0;nx<h;nx++){
    const x=deg===90?ny:w-1-ny,y=deg===90?h-1-nx:nx,o=(ny*h+nx)*4,i=(y*w+x)*4;
    out[o]=img.data[i];out[o+1]=img.data[i+1];out[o+2]=img.data[i+2];out[o+3]=img.data[i+3];
  }
  return {data:out,width:h,height:w};
}

// The recognition input: 48 px high, as wide as the box's proportions give (at most 3200 px), BGR, normalised to
// [-1, 1], padded with zeros to at least 320 px.
export function recInput(img:Img){
  const w=Math.max(1,Math.min(3200,Math.ceil(48*img.width/img.height))),width=Math.max(320,w);
  const px=resizeRgb(img,w,48),x=new Float32Array(3*48*width);
  for(let y=0;y<48;y++)for(let i=0;i<w;i++)for(let c=0;c<3;c++)x[c*48*width+y*width+i]=(px[(y*w+i)*3+(2-c)]/255-0.5)/0.5;
  return {data:x,width};
}

// Greedy CTC decoding of T steps over C classes: class 0 is the blank, then the model's characters, then a space.
// The confidence is the mean probability of the characters kept.
export function ctcDecode(out:ArrayLike<number>,T:number,C:number,classes:string[]):Reading{
  let text="",prev=0,conf=0,k=0;
  for(let t=0;t<T;t++){
    let best=0,p=-Infinity;
    for(let c=0;c<C;c++){const v=out[t*C+c];if(v>p){p=v;best=c}}
    if(best!==0&&best!==prev){text+=classes[best]??"";conf+=p;k++}
    prev=best;
  }
  return {text:text.trim(),conf:k?conf/k:0};
}
export const ctcClasses=(characters:string[])=>["",...characters," "];

// A box's text, turned upright. Vertical text may read upwards or downwards, so a tall box is read turned both ways and
// the more confident reading kept; a short vertical word ("To") has a box that is not tall, so a doubtful reading of a
// box that is not wide is tried turned both ways too, and a clearly more confident reading wins.
export async function readBox(img:Img,recognise:(img:Img)=>Promise<Reading>):Promise<Reading>{
  const both=async()=>{const a=await recognise(rotate(img,270)),b=await recognise(rotate(img,90));return b.conf>a.conf?b:a};
  const tall=img.height/img.width;
  let read=tall>=1.5?await both():await recognise(img);
  if(tall<1.5&&tall>0.8&&read.conf<0.8){const turned=await both();if(turned.text&&turned.conf>read.conf+0.1)read=turned}
  return read;
}
