import {describe,it,expect} from "vitest";
import {pdfRules,imageRules,joinRules,isVertical,Ops} from "../src/docread/ruling";
import {linesFromItems} from "../src/docread/textlines";

// Operator codes as PDF.js numbers them; the values only need to differ from one another here.
const OPS:Ops={save:10,restore:11,transform:12,constructPath:91,paintFormXObjectBegin:74,paintFormXObjectEnd:75,
  stroke:20,closeStroke:21,fill:22,eoFill:23,fillStroke:24,eoFillStroke:25,closeFillStroke:26,closeEOFillStroke:27};
const MOVE=0,LINE=1,CLOSE=4;
const ident=[1,0,0,1,0,0];

describe("ruled lines from a PDF's drawing",()=>{
  it("reads stroked lines along the axes, through the transforms, and joins the pieces of one line",()=>{
    const fn=[OPS.save,OPS.transform,OPS.constructPath,OPS.constructPath,OPS.restore,OPS.constructPath];
    const args=[[],[2,0,0,2,10,0],[OPS.stroke,[new Float32Array([MOVE,10,0,LINE,10,40])]],[OPS.stroke,[new Float32Array([MOVE,10,40,LINE,10,80])]],[],
      [OPS.stroke,[new Float32Array([MOVE,0,50,LINE,300,50,MOVE,0,60,LINE,3,62])]]];
    const rules=pdfRules(fn,args,OPS,ident);
    // The vertical: x = 2·10 + 10 = 30, from y 0 to 160, one line from two strokes. The short slanted stroke is none.
    expect(rules.filter(isVertical)).toEqual([{x0:30,y0:0,x1:30,y1:160}]);
    expect(rules.filter(r=>!isVertical(r))).toEqual([{x0:0,y0:50,x1:300,y1:50}]);
  });
  it("reads a thin filled bar as a line, but not a filled cell",()=>{
    const bar=new Float32Array([MOVE,100,10,LINE,101,10,LINE,101,200,LINE,100,200,CLOSE]);
    const cell=new Float32Array([MOVE,0,0,LINE,80,0,LINE,80,40,LINE,0,40,CLOSE]);
    expect(pdfRules([OPS.constructPath,OPS.constructPath],[[OPS.fill,[bar]],[OPS.fill,[cell]]],OPS,ident)).toEqual([{x0:100.5,y0:10,x1:100.5,y1:200}]);
  });
});

describe("ruled lines from a page image",()=>{
  it("finds long lines, a little skewed, and leaves out short marks",()=>{
    const W=400,H=300,data=new Uint8ClampedArray(W*H*4).fill(255);
    const ink=(x:number,y:number)=>{const i=(y*W+x)*4;data[i]=data[i+1]=data[i+2]=0};
    for(let x=20;x<380;x++)ink(x,100+Math.floor(x/200));      // a horizontal line, one pixel lower after x = 200
    for(let y=20;y<280;y++){ink(150,y);ink(151,y)}              // a vertical line, two pixels thick
    for(let x=300;x<320;x++)ink(x,200);                          // a short mark: a letter's stroke
    const rules=imageRules({width:W,height:H,data});
    expect(rules.filter(isVertical)).toHaveLength(1);
    expect(rules.filter(r=>!isVertical(r))).toHaveLength(1);
    const h=rules.find(r=>!isVertical(r))!;
    expect(h.x0).toBeLessThanOrEqual(21);expect(h.x1).toBeGreaterThanOrEqual(378);
  });
  it("joins pieces in line with one another, not lines side by side",()=>{
    expect(joinRules([{x0:0,y0:10,x1:50,y1:10},{x0:52,y0:11,x1:90,y1:11},{x0:0,y0:30,x1:90,y1:30}])).toHaveLength(2);
  });
});

describe("text either side of a ruled line",()=>{
  it("keeps a soil name and the colour beside it apart where a line is drawn down between them",()=>{
    // Two runs of text 4 units apart on one baseline: one line without a ruled line between them, two with one.
    const items=[{str:"砂質シルト",transform:[10,0,0,10,100,500],width:50,height:10},{str:"暗灰",transform:[10,0,0,10,154,500],width:20,height:10}];
    expect(linesFromItems(items,ident).map(l=>l.text)).toEqual(["砂質シルト 暗灰"]);
    expect(linesFromItems(items,ident,[{x0:152,y0:480,x1:152,y1:520}]).map(l=>l.text)).toEqual(["砂質シルト","暗灰"]);
  });
});
