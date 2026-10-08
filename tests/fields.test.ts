import {describe,it,expect} from "vitest";
import {stressAt,unitWeights,sectionField,colourScale,sequentialRamp,interpolate,availableFields,GAMMA_W,ASSUMED_WEIGHT} from "../src/fields";
import {buildGeologicalModel} from "../src/model";
import {computeSection} from "../src/section";
import {sectionSvg} from "../src/sectionSvg";
import {GeoProject,valleyProject,sakaeProject} from "../src/geology";

const layered:GeoProject={
  name:"Two layers",
  units:[{id:"clay",name:"Clay",color:"#9c7a5b",gamma:17,gammaSat:18},{id:"sand",name:"Sand",color:"#d9b871",gamma:19,gammaSat:20}],
  boreholes:[[0,0],[50,0],[0,50],[50,50]].map(([x,y],i)=>({id:`B${i}`,x,y,z:10,intervals:[{from:0,to:4,unit:"clay"},{from:4,to:20,unit:"sand"}],water:[{depth:2}],
    tests:[{depth:1,property:"su",value:20+i},{depth:3,property:"su",value:30+i}]}))
};

describe("stresses",()=>{
  it("integrates unit weights above and below the water table",()=>{
    const w=[{above:17,below:18,source:"declared" as const},{above:19,below:20,source:"declared" as const}];
    const h=[10,6,-10];
    expect(stressAt(h,8,w,10)).toEqual({sv:0,u:0,s:0});
    const at5=stressAt(h,8,w,5)!;
    expect(at5.sv).toBeCloseTo(2*17+2*18+1*20,9);
    expect(at5.u).toBeCloseTo(3*GAMMA_W,9);
    expect(at5.s).toBeCloseTo(at5.sv-at5.u,9);
    expect(stressAt(h,8,w,11)).toBeNull();
    expect(stressAt(h,8,w,-11)).toBeNull();
    // Without a water table the soil is taken as dry.
    expect(stressAt(h,undefined,w,5)!.u).toBe(0);
    expect(stressAt(h,undefined,w,5)!.sv).toBeCloseTo(4*17+19,9);
  });

  it("models the water table from the logs, or at the assumed depth, and takes unit weights in order of preference",()=>{
    const m=buildGeologicalModel(layered);
    expect(m.water!.source).toMatch(/water levels logged in 4 of 4 boreholes/);
    expect(Math.max(...m.water!.z)).toBeCloseTo(8,9);
    expect(Math.min(...m.water!.z)).toBeCloseTo(8,9);
    expect(buildGeologicalModel(valleyProject).water).toBeUndefined();
    const assumed=buildGeologicalModel({...valleyProject,groundwaterDepth:1.5});
    expect(assumed.water!.source).toMatch(/assumed 1.5 m below ground/);
    for(let n=0;n<assumed.nodes.length;n+=97)expect(assumed.water!.z[n]).toBeCloseTo(assumed.horizons[0].z[n]-1.5,6);
    const w=unitWeights(buildGeologicalModel({...layered,units:[{id:"clay",name:"Clay",color:"#9c7a5b"},{id:"sand",name:"Sand",color:"#d9b871",gammaSat:21}],
      boreholes:layered.boreholes.map(b=>({...b,tests:[{depth:1,property:"gamma",value:16},{depth:2,property:"gamma",value:17}]}))}));
    expect(w[0]).toEqual({above:16.5,below:16.5,source:"measured",n:8});
    expect(w[1]).toEqual({above:21,below:21,source:"declared"});
    expect(unitWeights(buildGeologicalModel({...layered,units:layered.units.map(u=>({id:u.id,name:u.name,color:u.color}))}))[0]).toEqual({...ASSUMED_WEIGHT,source:"assumed"});
  });

  it("evaluates stresses on a section, increasing with depth and below the total stress",()=>{
    const m=buildGeologicalModel(layered),s=computeSection(m,{azimuth:90,offset:0});
    const sv=sectionField(m,s,"sv")!,eff=sectionField(m,s,"s")!,u=sectionField(m,s,"u")!;
    const mid=(s.s[0]+s.s[s.s.length-1])/2;
    expect(sv.at(mid,10)).toBeCloseTo(0,9);
    expect(sv.at(mid,0)).toBeCloseTo(2*17+2*18+6*20,9);
    expect(u.at(mid,0)).toBeCloseTo(8*GAMMA_W,9);
    expect(eff.at(mid,0)).toBeCloseTo(sv.at(mid,0)-u.at(mid,0),9);
    expect(sv.at(mid,12)).toBeNaN();
    expect(sv.unitAt(mid,7)).toBe(0);
    expect(sv.unitAt(mid,5)).toBe(1);
    expect(sv.scale.edges[0]).toBe(0);
    expect(sv.scale.edges.at(-1)!).toBeGreaterThanOrEqual(2*17+2*18+16*20-1e-9);
    expect(sv.notes.join(" ")).toMatch(/Water table: water levels logged/);
  });
});

describe("measured properties",()=>{
  it("interpolates within a unit only, closer in depth than across",()=>{
    const m=buildGeologicalModel(layered),s=computeSection(m,{azimuth:90,offset:0});
    const su=sectionField(m,s,"su")!;
    const mid=(s.s[0]+s.s[s.s.length-1])/2;
    // 1 m and 3 m deep, between holes 35 m away: nearer the values at the same depth.
    expect(su.at(mid,9)).toBeGreaterThan(20);
    expect(su.at(mid,9)).toBeLessThan(26.5);
    expect(su.at(mid,7)).toBeGreaterThan(26.5);
    expect(su.at(mid,0)).toBeNaN();
    expect(su.notes.join(" ")).toMatch(/Not measured in Sand/);
    expect(interpolate([{x:0,y:0,z:0,value:1},{x:100,y:0,z:0,value:3}],0,0,0)).toBe(1);
    expect(interpolate([],0,0,0)).toBeNaN();
  });
  it("lists the stresses, then the measured properties",()=>{
    expect(availableFields(buildGeologicalModel(layered)).map(f=>f.key)).toEqual(["sv","u","s","su"]);
    expect(availableFields(buildGeologicalModel(sakaeProject)).map(f=>f.key)).toEqual(["sv","u","s","N"]);
  });
});

describe("colour scale",()=>{
  it("bands values at round steps on a single-hue ramp of falling lightness",()=>{
    const c=colourScale(0,437,false);
    expect(c.edges).toEqual([0,50,100,150,200,250,300,350,400,450]);
    expect(c.colorOf(0)).toBe(c.colors[0]);
    expect(c.colorOf(449)).toBe(c.colors.at(-1));
    expect(c.colorOf(NaN)).toBeNull();
    const lum=(h:string)=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)).reduce((a,v,i)=>a+v*[0.2126,0.7152,0.0722][i],0);
    const ramp=sequentialRamp(9);
    for(let i=1;i<ramp.length;i++)expect(lum(ramp[i])).toBeLessThan(lum(ramp[i-1]));
    expect(colourScale(0,437,false,true).colors).toEqual([...c.colors].reverse());
    expect(colourScale(-9,-3,true).edges).toEqual([-9,-8,-7,-6,-5,-4,-3]);
  });
});

describe("fields in the section drawing",()=>{
  it("colours the section by a field, with a colour bar and the water table",()=>{
    const m=buildGeologicalModel(sakaeProject),s=computeSection(m,{azimuth:170,offset:0},300);
    const plain=sectionSvg(m,s,{width:900,height:500,theme:"light"});
    expect(plain).toContain("<title>Water table</title>");
    expect(plain).toContain("blue = water table");
    expect(plain).not.toContain("clipPath");
    const svg=sectionSvg(m,s,{width:900,height:500,theme:"light",field:sectionField(m,s,"s")!});
    expect(svg).toMatch(/<clipPath id="field-clip-\d+">/);
    expect(svg).toContain(">σ′v (kPa)</text>");
    expect(svg.match(/<rect [^>]*fill="#[0-9a-f]{6}"\/>/g)!.length).toBeGreaterThan(100);
    expect(svg).toMatch(/data-frame="[\d.,-]+"/);
  });
});
