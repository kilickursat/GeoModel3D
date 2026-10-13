import {describe,it,expect} from "vitest";
import {viewShift,fitAngle,segmentDistance} from "../src/layout";

// Where camera.setViewOffset(width·k, height·k, x, y, width, height) draws a point of the full frame (u, v in 0–1).
const drawn=(s:{x:number;y:number;k:number},width:number,height:number,u:number,v:number)=>[u*width*s.k-s.x,v*height*s.k-s.y];

describe("compact layout",()=>{
  const W=390,H=844,room={x0:0,y0:56,x1:W,y1:H-58};
  it("leaves the view as it is when the room is the whole screen",()=>{
    const s=viewShift(W,H,{x0:0,y0:0,x1:W,y1:H},{x0:0,y0:0,x1:W,y1:H});
    expect(s.k).toBe(1);
    expect(s.x).toBeCloseTo(0,12);
    expect(s.y).toBeCloseTo(0,12);
  });
  it("centres the model in the room left between the title bar and the bar at the bottom",()=>{
    const s=viewShift(W,H,room,room);
    expect(s.k).toBe(1);
    const [x,y]=drawn(s,W,H,0.5,0.5);
    expect(x).toBeCloseTo(W/2,9);
    expect(y).toBeCloseTo((56+H-58)/2,9);
  });
  it("moves the model above an open sheet, and shrinks it with the room it has left",()=>{
    const free={...room,y1:room.y1-366},s=viewShift(W,H,free,room);
    expect(s.k).toBeCloseTo((free.y1-free.y0)/(room.y1-room.y0),12);
    const [x,y]=drawn(s,W,H,0.5,0.5);
    expect(x).toBeCloseTo(W/2,9);
    expect(y).toBeCloseTo((free.y0+free.y1)/2,9);
    // The frame keeps its proportions: drawn k times its size.
    const [x0,y0]=drawn(s,W,H,0,0),[x1,y1]=drawn(s,W,H,1,1);
    expect((x1-x0)/W).toBeCloseTo(s.k,12);
    expect((y1-y0)/H).toBeCloseTo(s.k,12);
  });
  it("moves the model right of a sheet on the left, and never shrinks it below the limit",()=>{
    const Wl=915,Hl=412,side={x0:0,y0:48,x1:Wl,y1:Hl-46};
    const s=viewShift(Wl,Hl,{...side,x0:360},side);
    expect(drawn(s,Wl,Hl,0.5,0.5)[0]).toBeCloseTo((360+Wl)/2,9);
    expect(viewShift(Wl,Hl,{...side,x0:880},side).k).toBe(0.3);
  });
  it("fits by the width on an upright phone and by the height on a wide screen",()=>{
    const fov=45*Math.PI/180;
    expect(fitAngle(fov,1894,905,905)).toBeCloseTo(fov/2,12);
    const upright=fitAngle(fov,390,730,844);
    expect(Math.tan(upright)/Math.tan(fov/2)).toBeCloseTo(390/844,12);
  });
  it("measures how far a tap is from a borehole drawn on the screen",()=>{
    expect(segmentDistance(13,50,10,0,10,100)).toEqual({d:3,t:0.5});
    expect(segmentDistance(10,-4,10,0,10,100)).toEqual({d:4,t:0});
    expect(segmentDistance(13,104,10,0,10,100)).toEqual({d:5,t:1});
    expect(segmentDistance(3,4,0,0,0,0)).toEqual({d:5,t:0});
  });
});
