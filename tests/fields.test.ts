import {describe,it,expect} from "vitest";
import {stressAt,unitWeights,sectionField,colourScale,sequentialRamp,interpolate,availableFields,GAMMA_W,ASSUMED_WEIGHT,rankine,earthPressure,pressureProfile,earthPressureNotes} from "../src/fields";
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

  it("gives the horizontal effective stress where a unit's K0 is given, and only there",()=>{
    const withK0:GeoProject={...layered,units:[layered.units[0],{...layered.units[1],params:{K0:0.5}}]};
    const m=buildGeologicalModel(withK0),s=computeSection(m,{azimuth:90,offset:0});
    expect(availableFields(m).map(f=>f.key)).toEqual(["sv","u","s","sh","su"]);
    const sh=sectionField(m,s,"sh")!,eff=sectionField(m,s,"s")!;
    const mid=(s.s[0]+s.s[s.s.length-1])/2;
    expect(sh.at(mid,0)).toBeCloseTo(0.5*eff.at(mid,0),9);
    expect(sh.at(mid,7)).toBeNaN();
    expect(sh.notes.join(" ")).toMatch(/σ′h = K0 · σ′v with each unit's K0; not given for Clay, left uncoloured/);
    expect(sh.scale.edges.at(-1)!).toBeGreaterThanOrEqual(0.5*eff.at(mid,-10+1e-6)-1e-9);
  });
});

describe("earth pressures",()=>{
  const r={sv:80,u:20,s:60};
  it("take Rankine's coefficients",()=>{
    const {Ka,Kp}=rankine(30);
    expect(Ka).toBeCloseTo(1/3,12);
    expect(Kp).toBeCloseTo(3,12);
    expect(rankine(0)).toEqual({Ka:1,Kp:1});
  });

  it("are drained from c′ and φ′, and never pull on the wall",()=>{
    // Sand, φ′ = 30°: σ′a = 60/3, σ′p = 3 · 60, and at rest 0.5 · 60.
    const sand=earthPressure({phi:30,K0:0.5},r,"drained");
    expect(sand.active).toBeCloseTo(20,9);
    expect(sand.passive).toBeCloseTo(180,9);
    expect(sand.rest).toBeCloseTo(30,9);
    // c′ = 10 kPa lowers the active pressure by 2c′√Ka and raises the passive one by 2c′√Kp.
    const clay=earthPressure({c:10,phi:30},r,"drained");
    expect(clay.active).toBeCloseTo(20-20/Math.sqrt(3),9);
    expect(clay.passive).toBeCloseTo(180+20*Math.sqrt(3),9);
    expect(clay.rest).toBeNaN();
    // At the ground the cohesion would pull on the wall: the pressure is zero.
    const ground=earthPressure({c:10,phi:30},{sv:0,u:0,s:0},"drained");
    expect(ground.active).toBe(0);
    expect(ground.pull).toBeCloseTo(20/Math.sqrt(3),9);
    // Without φ′ there is no drained pressure.
    expect(earthPressure({su:30},r,"drained").active).toBeNaN();
  });

  it("are undrained total pressures from su, the units without one draining",()=>{
    const clay=earthPressure({su:25,phi:24,K0:0.6},r,"undrained");
    expect(clay.active).toBeCloseTo(80-50,9);
    expect(clay.passive).toBeCloseTo(80+50,9);
    expect(clay.rest).toBeCloseTo(0.6*60+20,9);
    // A stiffer clay would pull on the wall: the pressure is the water pressure.
    const stiff=earthPressure({su:40},r,"undrained");
    expect(stiff.active).toBeCloseTo(20,9);
    expect(stiff.pull).toBeCloseTo(20+80-80,9);
    // Sand drains: its effective pressures plus u.
    const sand=earthPressure({phi:30},r,"undrained");
    expect(sand.active).toBeCloseTo(20+20,9);
    expect(sand.passive).toBeCloseTo(180+20,9);
    expect(earthPressure(undefined,r,"undrained").active).toBeNaN();
  });

  it("follow a borehole exactly, with the depths where the soil would pull on the wall",()=>{
    // Clay with c′ = 10 kPa and φ′ = 30° from 0 to 4 m over sand with φ′ = 30°, water at 2 m: the clay pulls on the wall
    // down to where σ′v = 2c′/√Ka = 20√3 kPa, just below the water table.
    const z=[10,6,-10],w=[{above:17,below:18,source:"declared" as const},{above:19,below:20,source:"declared" as const}];
    const drained=pressureProfile(z,8,w,[{c:10,phi:30},{phi:30}],"drained");
    const crack=2+(20*Math.sqrt(3)-34)/(18-GAMMA_W);
    expect(drained.tension).toHaveLength(1);
    expect(drained.tension[0].top).toBe(10);
    expect(10-drained.tension[0].bottom).toBeCloseTo(crack,9);
    const clay=drained.segments[0].points;
    expect(clay.map(p=>10-p.e)).toEqual([0,2,expect.closeTo(crack,9),4]);
    expect(clay[2].pressure.active).toBeCloseTo(0,9);
    // At the base of the sand, 20 m down: σ′v = 2 · 17 + 2 · 18 + 16 · 20 − 18 γw.
    const base=drained.segments[1].points.at(-1)!,s=34+36+320-18*GAMMA_W;
    expect(base.pressure.active).toBeCloseTo(s/3,9);
    expect(base.pressure.passive).toBeCloseTo(3*s,9);
    // Undrained, with su = 30 kPa, the clay pulls on the wall all the way down, and the sand does not.
    const undrained=pressureProfile(z,8,w,[{c:10,phi:30,su:30},{phi:30}],"undrained");
    expect(undrained.tension).toEqual([{top:10,bottom:6}]);
    expect(undrained.segments[1].points.at(-1)!.pressure.active).toBeCloseTo(s/3+18*GAMMA_W,9);
  });

  it("say what they rest on",()=>{
    const names=["Fill","Clay","Sand","Rock"],params:Array<Record<string,number>|undefined>=[{phi:30},{su:25,phi:24,c:5},{phi:34,c:0},undefined];
    expect(earthPressureNotes(names,[0,1,2,3],params,"drained",[{from:0,to:1.234}])).toEqual([
      "Rankine, for a smooth vertical wall with level ground, from the ground surface down.",
      "Drained: effective pressures from c′ and φ′; the water pressure u acts besides them.",
      "No φ′ for Rock: no active or passive pressure there.",
      "c′ not given for Fill: taken as 0.",
      "The soil would pull on the wall at 0–1.23 m: the active pressure there is taken as zero."]);
    expect(earthPressureNotes(names,[1,2],params,"undrained",[{from:1.2,to:4.61},{from:11.5,to:22.2}])).toEqual([
      "Rankine, for a smooth vertical wall with level ground, from the ground surface down.",
      "Undrained: total pressures, water included; σv ∓ 2su in Clay; Sand drained, from c′ and φ′, with u added.",
      "The soil would pull on the wall at 1.2–4.61 and 11.5–22.2 m: the active pressure there is taken as the water pressure."]);
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
