// The ruled lines of a page: the long straight lines a form is drawn with (the borders of a log's columns, the lines
// between its layers). They say where one column ends and the next begins, which the text alone cannot: on a Japanese
// log the colour of a layer is printed right after its soil name, and a description runs close to the next column.
// From a PDF's own drawing (its operator list), exactly; or from a page image (a scan), by long runs of dark pixels.
// Lines are in page pixels (y down), the same as the text lines read from the page.

// A ruled line: horizontal or vertical, possibly a little sloped on a scan.
export interface Rule { x0:number; y0:number; x1:number; y1:number }
export const isVertical=(r:Rule)=>Math.abs(r.y1-r.y0)>Math.abs(r.x1-r.x0);
// Where a vertical line is at height y, or a horizontal line at x.
export const xAt=(r:Rule,y:number)=>r.y1===r.y0?r.x0:r.x0+(r.x1-r.x0)*(y-r.y0)/(r.y1-r.y0);
export const yAt=(r:Rule,x:number)=>r.x1===r.x0?r.y0:r.y0+(r.y1-r.y0)*(x-r.x0)/(r.x1-r.x0);

// Pieces of one line (a form drawn cell by cell, a scanned line broken by skew) joined: pieces in line with one another
// (within `tol` across) that meet or nearly meet (within `gap` along).
export function joinRules(rules:Rule[],tol=2,gap=3):Rule[]{
  const out:Rule[]=[];
  for(const vertical of [false,true]){
    // Along and across, as if the line were horizontal.
    const along=(r:Rule)=>vertical?[Math.min(r.y0,r.y1),Math.max(r.y0,r.y1)]:[Math.min(r.x0,r.x1),Math.max(r.x0,r.x1)];
    const pieces=rules.filter(r=>isVertical(r)===vertical).map(r=>{
      const [a,b]=along(r),s=vertical?[r.y0<=r.y1?r.x0:r.x1,r.y0<=r.y1?r.x1:r.x0]:[r.x0<=r.x1?r.y0:r.y1,r.x0<=r.x1?r.y1:r.y0];
      return {a,b,ca:s[0],cb:s[1]};
    }).sort((p,q)=>p.a-q.a);
    const lines:Array<{a:number;b:number;ca:number;cb:number}>=[];
    for(const p of pieces){
      const l=lines.find(l=>p.a<=l.b+gap&&Math.abs(l.cb+(l.cb-l.ca)/Math.max(l.b-l.a,1)*(p.a-l.b)-p.ca)<=tol);
      if(l){if(p.b>l.b){l.b=p.b;l.cb=p.cb}}else lines.push({...p});
    }
    for(const l of lines)out.push(vertical?{x0:l.ca,y0:l.a,x1:l.cb,y1:l.b}:{x0:l.a,y0:l.ca,x1:l.b,y1:l.cb});
  }
  return out;
}

// ---------- from a PDF's drawing ----------

type Matrix=[number,number,number,number,number,number];
const times=(m:number[],n:number[]):Matrix=>[m[0]*n[0]+m[2]*n[1],m[1]*n[0]+m[3]*n[1],m[0]*n[2]+m[2]*n[3],m[1]*n[2]+m[3]*n[3],m[0]*n[4]+m[2]*n[5]+m[4],m[1]*n[4]+m[3]*n[5]+m[5]];
const point=(m:number[],x:number,y:number)=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]] as const;
// The operator codes this reads, as PDF.js names them (pdfjs.OPS).
export interface Ops { save:number; restore:number; transform:number; constructPath:number; paintFormXObjectBegin:number; paintFormXObjectEnd:number;
  stroke:number; closeStroke:number; fill:number; eoFill:number; fillStroke:number; eoFillStroke:number; closeFillStroke:number; closeEOFillStroke:number }
// The path commands of PDF.js 6 (DrawOPS): moveTo x y, lineTo x y, curveTo 6 numbers, quadraticCurveTo 4, closePath.
const MOVE=0,LINE=1,CURVE=2,QUAD=3,CLOSE=4;

// Lines drawn on a PDF page: straight strokes along the axes, and rectangles filled thin (many producers draw a
// line as a filled bar). `view` maps the page's user space to page pixels (PDF.js viewport.transform). Lines shorter
// than `min` pixels are left out: they are the strokes of letters drawn as paths, ticks and hatching.
export function pdfRules(fnArray:ArrayLike<number>,argsArray:ArrayLike<unknown>,OPS:Ops,view:number[],min=12):Rule[]{
  const rules:Rule[]=[],stack:Matrix[]=[];
  let ctm:Matrix=[1,0,0,1,0,0];
  const stroked=new Set([OPS.stroke,OPS.closeStroke,OPS.fillStroke,OPS.eoFillStroke,OPS.closeFillStroke,OPS.closeEOFillStroke]);
  const filled=new Set([OPS.fill,OPS.eoFill,OPS.fillStroke,OPS.eoFillStroke,OPS.closeFillStroke,OPS.closeEOFillStroke]);
  const add=(x0:number,y0:number,x1:number,y1:number)=>{
    const dx=Math.abs(x1-x0),dy=Math.abs(y1-y0);
    if(Math.max(dx,dy)<min||Math.min(dx,dy)>Math.max(1.5,0.02*Math.max(dx,dy)))return;
    rules.push(dx>=dy?{x0:Math.min(x0,x1),y0:(y0+y1)/2,x1:Math.max(x0,x1),y1:(y0+y1)/2}:{x0:(x0+x1)/2,y0:Math.min(y0,y1),x1:(x0+x1)/2,y1:Math.max(y0,y1)});
  };
  for(let i=0;i<fnArray.length;i++){
    const fn=fnArray[i],args=argsArray[i] as unknown[];
    if(fn===OPS.save)stack.push(ctm);
    else if(fn===OPS.restore)ctm=stack.pop()??ctm;
    else if(fn===OPS.transform)ctm=times(ctm,args as number[]);
    else if(fn===OPS.paintFormXObjectBegin){stack.push(ctm);const m=args?.[0] as number[]|undefined;if(m&&m.length===6)ctm=times(ctm,m)}
    else if(fn===OPS.paintFormXObjectEnd)ctm=stack.pop()??ctm;
    else if(fn===OPS.constructPath){
      const op=args[0] as number,data=(args[1] as unknown[]|undefined)?.[0] as ArrayLike<number>|undefined;
      if(!data||typeof (data as ArrayLike<number>).length!=="number"||(!stroked.has(op)&&!filled.has(op)))continue;
      const m=times(view,ctm);
      // Subpaths as lists of points (curves end them: no line is drawn with a curve).
      const subs:Array<Array<readonly [number,number]>>=[];
      let cur:Array<readonly [number,number]>=[];
      for(let k=0;k<data.length;){
        const c=data[k++];
        if(c===MOVE){if(cur.length)subs.push(cur);cur=[point(m,data[k++],data[k++])]}
        else if(c===LINE)cur.push(point(m,data[k++],data[k++]));
        else if(c===CURVE){k+=6;if(cur.length)subs.push(cur);cur=[]}
        else if(c===QUAD){k+=4;if(cur.length)subs.push(cur);cur=[]}
        else if(c===CLOSE){if(cur.length>2)cur.push(cur[0]);subs.push(cur);cur=[]}
        else break;
      }
      if(cur.length)subs.push(cur);
      for(const s of subs){
        if(stroked.has(op))for(let k=1;k<s.length;k++)add(s[k-1][0],s[k-1][1],s[k][0],s[k][1]);
        // A filled thin bar is a line: its bounds, if they are all the subpath's corners.
        if(filled.has(op)&&s.length>=4){
          const xs=s.map(p=>p[0]),ys=s.map(p=>p[1]),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
          const box=s.every(p=>(Math.abs(p[0]-x0)<0.5||Math.abs(p[0]-x1)<0.5)&&(Math.abs(p[1]-y0)<0.5||Math.abs(p[1]-y1)<0.5));
          if(box&&Math.min(x1-x0,y1-y0)<=3)x1-x0>=y1-y0?add(x0,(y0+y1)/2,x1,(y0+y1)/2):add((x0+x1)/2,y0,(x0+x1)/2,y1);
        }
      }
    }
  }
  return joinRules(rules);
}

// ---------- from a page image ----------

// Lines on a page image: runs of dark pixels much longer than any letter, along rows and along columns. A pixel is
// dark below a threshold set between the paper and the ink of the page (Otsu's), and a run may step a pixel up or
// down (a scan is seldom quite straight) and over a gap of two pixels (a broken line). Runs of neighbouring rows are
// one line, as thick as it is drawn; pieces of a line are joined.
export function imageRules(img:{width:number;height:number;data:ArrayLike<number>},min=Math.max(40,Math.round(0.035*Math.min(img.width,img.height)))):Rule[]{
  const {width:W,height:H,data}=img,gray=new Uint8Array(W*H),hist=new Array(256).fill(0);
  for(let i=0;i<W*H;i++){const v=(data[4*i]*299+data[4*i+1]*587+data[4*i+2]*114)/1000|0;gray[i]=v;hist[v]++}
  // Otsu's threshold, kept between 90 and 210 (a page of text has little ink).
  let sum=0;for(let v=0;v<256;v++)sum+=v*hist[v];
  let sumB=0,wB=0,best=0,threshold=160;
  for(let v=0;v<256;v++){
    wB+=hist[v];if(!wB)continue;const wF=W*H-wB;if(!wF)break;
    sumB+=v*hist[v];const mB=sumB/wB,mF=(sum-sumB)/wF,between=wB*wF*(mB-mF)**2;
    if(between>best){best=between;threshold=v}
  }
  threshold=Math.min(210,Math.max(90,threshold));
  const dark=new Uint8Array(W*H);for(let i=0;i<W*H;i++)dark[i]=gray[i]<threshold?1:0;
  const found:Rule[]=[];
  // Runs along one direction: `n` lines of `len` pixels; at(line, pos) is the pixel.
  const runs=(n:number,len:number,at:(line:number,pos:number)=>number,vertical:boolean)=>{
    for(let line=0;line<n;line++){
      let start=-1,lastDark=-10;
      for(let pos=0;pos<=len;pos++){
        const d=pos<len&&(dark[at(line,pos)]||(line>0&&dark[at(line-1,pos)])||(line<n-1&&dark[at(line+1,pos)]));
        if(d){if(start<0)start=pos;lastDark=pos}
        else if(start>=0&&pos-lastDark>2){
          if(lastDark-start+1>=min)found.push(vertical?{x0:line,y0:start,x1:line,y1:lastDark}:{x0:start,y0:line,x1:lastDark,y1:line});
          start=-1;
        }
      }
    }
  };
  runs(H,W,(y,x)=>y*W+x,false);
  runs(W,H,(x,y)=>y*W+x,true);
  // Neighbouring rows of one thick line, and the pieces of a skewed line, become one.
  return joinRules(found,3,4).filter(r=>Math.hypot(r.x1-r.x0,r.y1-r.y0)>=min);
}

// Rules read at another scale (an image of another size than the page's text), brought to the page's pixels.
export const scaleRules=(rules:Rule[],k:number)=>k===1?rules:rules.map(r=>({x0:r.x0*k,y0:r.y0*k,x1:r.x1*k,y1:r.y1*k}));
