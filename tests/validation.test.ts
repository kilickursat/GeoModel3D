import {describe,it,expect} from "vitest";
import {crossValidate} from "../src/validation";
import {GeoProject,UnitDef} from "../src/geology";

const units:UnitDef[]=["A","B","C"].map(id=>({id,name:"Unit "+id,color:"#888888"}));
// A 3 × 3 grid of boreholes, 50 m apart, through planar horizons: the ground, the top of B and the top of C.
const plane=(x:number,y:number)=>({ground:100+0.01*x-0.02*y,b:95+0.005*x,c:80-0.01*y});
const grid=(shift=(_x:number,_y:number)=>0):GeoProject=>({name:"planes",units,boreholes:[0,1,2].flatMap(r=>[0,1,2].map(c=>{
  const x=c*50,y=r*50,p=plane(x,y),z=p.ground,bTop=z-p.b,cTop=z-p.c+shift(x,y);
  return {id:`H${r}${c}`,x,y,z,intervals:[{from:0,to:bTop,unit:"A"},{from:bTop,to:cTop,unit:"B"},{from:cTop,to:cTop+10,unit:"C"}]};
}))});

describe("cross-validation",()=>{
  it("predicts the boreholes inside the others exactly where the horizons are planes, and keeps the others apart",()=>{
    const steps:number[]=[];
    const v=crossValidate(grid(),done=>steps.push(done));
    expect(steps).toEqual([0,1,2,3,4,5,6,7,8,9]);
    expect(v.surfaces).toEqual(["Ground surface","Top of Unit B","Top of Unit C"]);
    // The corners lie outside the outline of the other eight; the rest lie inside it or on it.
    expect(v.boreholes.filter(b=>b.outside).map(b=>b.id).sort()).toEqual(["H00","H02","H20","H22"]);
    for(const b of v.boreholes.filter(b=>!b.outside)){
      expect(b.contacts.map(q=>q.k)).toEqual([0,1,2]);
      for(const q of b.contacts)expect(Math.abs(q.error)).toBeLessThan(1e-9);
    }
    expect(v.inside.map(s=>[s.name,s.n])).toEqual([["Ground surface",5],["Top of Unit B",5],["Top of Unit C",5]]);
    expect(Math.max(...v.inside.map(s=>s.rms))).toBeLessThan(1e-9);
    expect(v.share.inside).toBeCloseTo(1,9);
    expect(v.outside.every(s=>s.n===4)).toBe(true);
    expect(v.terrain).toBe(false);
  });

  it("gives the error of a contact logged off the plane, predicted minus logged",()=>{
    // The top of C logged 2 m deeper in the middle borehole: the others predict it 2 m higher.
    const v=crossValidate(grid((x,y)=>x===50&&y===50?2:0));
    const mid=v.boreholes.find(b=>b.id==="H11")!;
    expect(mid.contacts.find(q=>q.k===2)!.error).toBeCloseTo(2,9);
    expect(mid.worst!.k).toBe(2);
    const c=v.inside.find(s=>s.k===2)!;
    expect(c.max).toBeCloseTo(2,9);
    expect(c.at).toBe("H11");
  });

  it("withholds coincident borehole and CPT logs together when checking a site",()=>{
    const p=grid((x,y)=>x===50&&y===50?2:0);
    const centre=p.boreholes[4];
    const duplicate={...centre,id:"duplicate",x:centre.x+0.0001};
    const cpt={id:"coincident CPT",x:centre.x,y:centre.y,z:centre.z,depth:[0,30],qc:[1,1],layers:centre.intervals};
    for(const project of [
      {...p,boreholes:[...p.boreholes,duplicate]},
      {...p,cptLayers:true,cpts:[cpt]}
    ]){
      const v=crossValidate(project);
      expect(v.boreholes).toHaveLength(9);
      const check=v.boreholes.find(b=>b.id===centre.id)!;
      expect(check.contacts.find(c=>c.k===2)!.error).toBeCloseTo(2,9);
    }
  });

  it("counts the logged metres predicted in the unit logged",()=>{
    // B pinches out in the middle borehole, logged 2 m thick in the four around it: the others predict 2 m of B where
    // the middle borehole logged C.
    const hole=(id:string,x:number,y:number,b:boolean)=>({id,x,y,z:10,intervals:b?[{from:0,to:2,unit:"A"},{from:2,to:4,unit:"B"},{from:4,to:10,unit:"C"}]:[{from:0,to:2,unit:"A"},{from:2,to:10,unit:"C"}]});
    const v=crossValidate({name:"pinch",units,boreholes:[hole("NW",0,100,true),hole("NE",100,100,true),hole("SW",0,0,true),hole("SE",100,0,true),hole("M",50,50,false)]});
    const m=v.boreholes.find(b=>b.id==="M")!;
    expect(m.outside).toBe(false);
    expect([m.logged,m.right]).toEqual([10,8]);
    expect(m.contacts.map(q=>[q.k,Number(q.error.toFixed(9))])).toEqual([[0,0],[2,-2]]);
  });

  it("scores observed contacts separately from kernel estimates at a gap or an erosion surface",()=>{
    const p=grid(),held=p.boreholes[4];
    held.intervals=[{from:0,to:2,unit:"A"},{from:4,to:10,unit:"C"}];
    p.units=p.units.map(u=>u.id==="A"?{...u,erosive:true}:u);
    const v=crossValidate(p),mid=v.boreholes.find(b=>b.id===held.id)!;
    expect(mid.contacts.map(c=>c.k)).toEqual([0]);
    expect(mid.omittedTops).toEqual([{unit:"C",reason:"reference"}]);
    expect(mid.logged).toBe(8);
    expect(v.notes.some(n=>n.includes("Excluded 1 bed-top comparison"))).toBe(true);
  });

  it("withholds the top of a bed ID repeated at the held collar or anywhere in the contributing training logs",()=>{
    const p=grid(),held=p.boreholes[4];
    held.intervals=[{from:0,to:2,unit:"A"},{from:2,to:4,unit:"B"},{from:4,to:7,unit:"C"},{from:7,to:9,unit:"B"}];
    const v=crossValidate(p),mid=v.boreholes.find(b=>b.id===held.id)!,other=v.boreholes.find(b=>b.id==="H01")!;
    expect(mid.omittedTops).toContainEqual({unit:"B",reason:"reference"});
    expect(other.omittedTops).toContainEqual({unit:"B",reason:"ambiguity"});
    expect(v.boreholes.every(b=>b.contacts.every(c=>c.k!==1))).toBe(true);
    expect(mid.logged).toBe(9);
    expect(v.notes).toContain("Excluded 8 bed-top comparisons from contact errors (training logs contain conflicting or repeated bed IDs).");
    expect(v.boreholes.every(b=>b.contacts.some(c=>c.k===0))).toBe(true);
  });

  it("distinguishes contiguous samples from disconnected occurrences of the same bed ID",()=>{
    const p=grid(),held=p.boreholes[4];
    held.intervals=[{from:0,to:2,unit:"A"},{from:2,to:3,unit:"B"},{from:3,to:5,unit:"B"},{from:5,to:7,unit:"C"}];
    const atCentre=()=>crossValidate(p).boreholes.find(b=>b.id===held.id)!;
    expect(atCentre().contacts.filter(c=>c.k===1).map(c=>c.logged)).toEqual([held.z-2]);
    held.intervals[2].from=3.5;
    expect(atCentre().omittedTops).toContainEqual({unit:"B",reason:"reference"});
    held.intervals[2].unit="lower B";
    held.intervals[2].from=3;
    p.units=[units[0],units[1],{...units[1],id:"lower B",materialId:"B"},units[2]];
    for(const b of p.boreholes)if(b!==held){
      const upper=b.intervals[1],base=upper.to;upper.to=(upper.from+base)/2;
      b.intervals.splice(2,0,{from:upper.to,to:base,unit:"lower B"});
    }
    expect(atCentre().contacts.map(c=>c.k)).toEqual([0,1,2,3]);
  });

  it("records training-only gaps separately from measured targets and ignores rejected source collars",()=>{
    const p=grid(),held=p.boreholes[4];
    for(const b of p.boreholes)if(b!==held)b.intervals[1].from+=0.5;
    p.boreholes.push({...p.boreholes[0],id:"ignored",intervals:held.intervals});
    const mid=crossValidate(p).boreholes.find(b=>b.id===held.id)!;
    expect(mid.omittedTops).toContainEqual({unit:"B",reason:"training"});
    expect(mid.contacts.map(c=>c.k)).toEqual([0,2]);
  });

  it("does not count a contact for a bed that pinches out at the predicted location",()=>{
    const p=grid();
    for(const b of p.boreholes){
      b.intervals=b.id==="H11"||b.id==="H22"
        ?[{from:0,to:2,unit:"A"},{from:2,to:3,unit:"B"},{from:3,to:8,unit:"C"}]
        :[{from:0,to:2,unit:"A"},{from:2,to:8,unit:"C"}];
    }
    const mid=crossValidate(p).boreholes.find(b=>b.id==="H11")!;
    expect(mid.contacts.map(c=>c.k)).toEqual([0,2]);
    expect(mid.omittedTops).toContainEqual({unit:"B",reason:"prediction"});
    expect(mid.logged-mid.right).toBeCloseTo(1);
  });

  it("withholds depth-agreement totals for an overlapping log while scoring its surveyed ground",()=>{
    const p=grid(),held=p.boreholes[4];
    for(const b of p.boreholes)b.intervals=[{from:0,to:2,unit:"A"},{from:2,to:4,unit:"B"},{from:4,to:7,unit:"C"}];
    held.intervals[0].to=3;
    const v=crossValidate(p),mid=v.boreholes.find(b=>b.id===held.id)!;
    expect([mid.logged,mid.right,mid.materialRight]).toEqual([0,0,0]);
    expect(mid.depthScoreUnavailable).toBe(true);
    expect(mid.contacts.map(c=>c.k)).toEqual([0]);
    expect(v.boreholes.reduce((n,b)=>n+b.logged,0)).toBe(8*7);
    expect(v.notes.some(s=>s.includes("H11")&&s.includes("excluded from the bed and material agreement totals"))).toBe(true);
  });

  it("counts a shared rounding sliver only once in exact bed and material depth totals",()=>{
    const p=grid(),held=p.boreholes[4];
    for(const b of p.boreholes)b.intervals=[{from:0,to:2,unit:"A"},{from:2,to:4,unit:"B"},{from:4,to:7,unit:"C"}];
    held.intervals[1].from-=1e-9;
    const v=crossValidate(p),mid=v.boreholes.find(b=>b.id===held.id)!;
    expect(mid.depthScoreUnavailable).toBeUndefined();
    expect(mid.logged).toBe(7);
    expect(mid.right).toBeLessThanOrEqual(mid.logged);
    expect(mid.materialRight).toBeLessThanOrEqual(mid.logged);
  });

  it("counts source-material overlap across interpreted beds independently from bed identity",()=>{
    const p=grid();
    p.units=[{...units[0],materialId:"sand"},{...units[1],materialId:"sand"},units[2]];
    for(const b of p.boreholes){
      const boundary=b.id==="H11"?3:5;
      b.intervals=[{from:0,to:boundary,unit:"A"},{from:boundary,to:8,unit:"B"},{from:8,to:10,unit:"C"}];
    }
    const v=crossValidate(p),mid=v.boreholes.find(b=>b.id==="H11")!;
    expect([mid.logged,mid.materialRight,mid.right]).toEqual([10,10,8]);
    expect(v.materialShare.inside).toBeCloseTo(1,9);
    expect(v.share.inside).toBeLessThan(v.materialShare.inside);
  });

  it("names the units that only one borehole logs",()=>{
    const p=grid();
    p.units=[...units,{id:"D",name:"Unit D",color:"#777777"}];
    p.boreholes[4].intervals.push({from:p.boreholes[4].intervals[2].to,to:p.boreholes[4].intervals[2].to+5,unit:"D"});
    const v=crossValidate(p);
    expect(v.boreholes.find(b=>b.id==="H11")!.unique).toEqual(["D"]);
    expect(v.notes).toContain("Logged in one borehole only, so not predicted from the others: Unit D");
  });
});

describe("the probe node",()=>{
  it("gives the full model's horizons at a point, from a few nodes instead of a refined mesh",async()=>{
    const {channelProject,valleyProject}=await import("../src/geology");
    const {buildGeologicalModel,sampleModel}=await import("../src/model");
    // Without terrain, the same to rounding, erosion surfaces included; with terrain, within the terrain's
    // interpolation between the refined mesh's nodes.
    for(const [p,tolerance] of [[{...channelProject,terrain:undefined},1e-9],[valleyProject,0.05]] as const){
      const holes=buildGeologicalModel(p).boreholes;
      let compared=0;
      for(const b of holes){
        const q={...p,boreholes:holes.filter(o=>o!==b)},full=sampleModel(buildGeologicalModel(q),b.x,b.y);
        // Boreholes outside the others are left to the model extent.
        if(!full)continue;
        const probed=sampleModel(buildGeologicalModel(q,{probe:{x:b.x,y:b.y}}),b.x,b.y)!;
        full.forEach((z,k)=>expect(Math.abs(probed[k]-z)).toBeLessThan(tolerance));
        if(++compared===3)break;
      }
      expect(compared).toBe(3);
    }
  });
});
