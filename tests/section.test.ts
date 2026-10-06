import {describe,it,expect} from "vitest";
import {computeSection,offsetRange,principalAzimuth} from "../src/section";
import {buildGeologicalModel} from "../src/model";
import {valleyProject,GeoProject,UnitDef} from "../src/geology";
import {randomPoints} from "./helpers";

const units:UnitDef[]=[{id:"U1",name:"U1",color:"#aa8866"},{id:"U2",name:"U2",color:"#667788"}];
const ground=(x:number,y:number)=>100+0.1*x-0.05*y;
const contactDepth=(x:number)=>8+0.02*x;

describe("vertical sections",()=>{
  const planar:GeoProject={name:"planar",units,boreholes:randomPoints(40,5,300,200).map((p,i)=>({
    id:"B"+i,x:p.x,y:p.y,z:ground(p.x,p.y),
    intervals:[{from:0,to:contactDepth(p.x),unit:"U1"},{from:contactDepth(p.x),to:40,unit:"U2"}]
  }))};
  const m=buildGeologicalModel(planar);

  it("reproduces planar horizons exactly along the section line",()=>{
    for(const [azimuth,offset] of [[30,12],[90,0],[145,-40]]){
      const s=computeSection(m,{azimuth,offset});
      expect(s.s.length).toBeGreaterThan(4);
      s.s.forEach((_,j)=>{
        const x=s.x[j],y=s.y[j];
        expect((x-s.origin.x)*s.normal.x+(y-s.origin.y)*s.normal.y).toBeCloseTo(0,9);
        expect(s.z[0][j]).toBeCloseTo(ground(x,y),9);
        expect(s.z[1][j]).toBeCloseTo(ground(x,y)-contactDepth(x),9);
        if(j)expect(s.s[j]).toBeGreaterThan(s.s[j-1]);
      });
    }
  });

  it("runs from footprint boundary to footprint boundary",()=>{
    const square:GeoProject={name:"square",units,boreholes:[[0,0],[100,0],[100,100],[0,100],[50,50]].map(([x,y],i)=>({id:"S"+i,x,y,z:10,intervals:[{from:0,to:2,unit:"U1"},{from:2,to:5,unit:"U2"}]}))};
    const s=computeSection(buildGeologicalModel(square),{azimuth:90,offset:0});
    expect(s.s).toEqual([-50,0,50]);
    expect(s.dir).toEqual({x:1,y:expect.closeTo(0,12)});
  });

  it("never gives a unit negative thickness on the valley model",()=>{
    const v=buildGeologicalModel(valleyProject);
    for(let azimuth=0;azimuth<180;azimuth+=15){
      const [lo,hi]=offsetRange(v,azimuth);
      for(const offset of [lo*0.9,(lo+hi)/2,hi*0.9]){
        const s=computeSection(v,{azimuth,offset});
        for(let k=1;k<s.z.length;k++)s.z[k].forEach((z,j)=>expect(z).toBeLessThanOrEqual(s.z[k-1][j]+1e-9));
      }
    }
  });

  it("projects only the boreholes within the buffer",()=>{
    const v=buildGeologicalModel(valleyProject);
    const s=computeSection(v,{azimuth:90,offset:0},40);
    expect(s.boreholes.length).toBeGreaterThan(0);
    for(const b of s.boreholes)expect(Math.abs(b.offset)).toBeLessThanOrEqual(40);
    expect(s.boreholes.map(b=>b.s)).toEqual([...s.boreholes.map(b=>b.s)].sort((a,b)=>a-b));
    expect(computeSection(v,{azimuth:90,offset:0}).boreholes.length).toBe(16);
  });

  it("defaults to the long axis of the borehole layout",()=>{
    const layout=(w:number,h:number)=>buildGeologicalModel({name:"l",units,boreholes:randomPoints(30,9,w,h).map((p,i)=>({id:"L"+i,...p,z:0,intervals:[{from:0,to:1,unit:"U1"}]}))});
    expect(principalAzimuth(layout(1000,60))).toBeCloseTo(90,-1);
    expect([0,180]).toContain(Math.round(principalAzimuth(layout(60,1000))/10)*10);
  });
});
