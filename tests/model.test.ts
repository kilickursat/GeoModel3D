import {describe,it,expect} from "vitest";
import {buildGeologicalModel,boreholeContacts,unitCubicMetres,footprintArea,GeoModel} from "../src/model";
import {referenceProject,valleyProject,boreholeDepth,GeoProject,UnitDef} from "../src/geology";
import {triangleArea} from "../src/tin";

const ordered=(m:GeoModel)=>m.horizons.every((h,k)=>k===0||h.z.every((z,i)=>z<=m.horizons[k-1].z[i]+1e-9));

describe("reference layer-cake",()=>{
  const m=buildGeologicalModel(referenceProject);

  it("models every unit, one horizon per contact plus the model base",()=>{
    expect(m.units.map(u=>u.id)).toEqual(referenceProject.units.map(u=>u.id));
    expect(m.horizons.map(h=>h.id)).toEqual(["ground","base:Alluvium","base:Weathered Rock","base:Sandstone","base:Mudstone","base"]);
    expect(m.warnings).toEqual([]);
    expect(m.base).toBe(10);
  });

  it("honours every logged contact",()=>{
    m.boreholes.forEach((b,i)=>{
      expect(m.horizons[0].z[i]).toBe(b.z);
      for(let k=1;k<b.intervals.length;k++){
        expect(m.horizons[k].z[i]).toBeCloseTo(b.z-b.intervals[k].from,9);
        expect(m.horizons[k].observed[i]).toBe(1);
      }
      expect(m.horizons[5].observed[i]).toBe(0);
    });
    expect(ordered(m)).toBe(true);
  });
});

describe("heterogeneous valley",()=>{
  const m=buildGeologicalModel(valleyProject);
  const at=(id:string)=>m.boreholes.findIndex(b=>b.id===id);
  const unit=(id:string)=>m.units.findIndex(u=>u.id===id);
  const thickness=(u:number,i:number)=>m.horizons[u].z[i]-m.horizons[u+1].z[i];

  it("uses every borehole and keeps horizons in stratigraphic order",()=>{
    expect(m.boreholes.length).toBe(16);
    expect(m.warnings).toEqual([]);
    expect(ordered(m)).toBe(true);
  });

  it("gives units missing from a log zero thickness at that borehole",()=>{
    const i=at("BH-05");
    for(const u of ["Made Ground","Alluvium","Terrace Gravel"])expect(thickness(unit(u),i)).toBe(0);
    expect(m.horizons[unit("Mudstone")].z[i]).toBe(m.boreholes[i].z);
    const j=at("BH-10");
    expect(thickness(unit("Made Ground"),j)).toBe(0);
    expect(thickness(unit("Terrace Gravel"),j)).toBeCloseTo(6.3,9);
  });

  it("keeps the inferred base of the last unit a shallow hole entered below its final depth",()=>{
    const k=unit("Mudstone")+1;
    for(const id of ["BH-02","BH-06","BH-08","BH-12","BH-13"]){
      const i=at(id),b=m.boreholes[i];
      expect(m.horizons[k].observed[i]).toBe(0);
      expect(m.horizons[k].z[i]).toBeLessThanOrEqual(b.z-boreholeDepth(b)+1e-9);
    }
  });

  it("infers thicknesses within the range seen in fully logged holes",()=>{
    const u=unit("Sandstone"),seen:number[]=[];
    m.boreholes.forEach((_,i)=>{if(m.horizons[u+1].observed[i])seen.push(thickness(u,i))});
    m.boreholes.forEach((_,i)=>{
      if(m.horizons[u].observed[i])return;
      expect(thickness(u,i)).toBeGreaterThanOrEqual(Math.min(...seen)-1e-9);
      expect(thickness(u,i)).toBeLessThanOrEqual(Math.max(...seen)+1e-9);
    });
  });

  it("closes at a flat model base at the deepest end of hole",()=>{
    expect(m.base).toBeCloseTo(Math.min(...valleyProject.boreholes.map(b=>b.z-boreholeDepth(b))),9);
    expect(m.horizons.at(-1)!.z.every(z=>z===m.base)).toBe(true);
  });

  it("splits the column between ground and base into the unit volumes",()=>{
    const total=m.units.reduce((s,_,u)=>s+unitCubicMetres(m,u),0);
    const column=m.triangles.reduce((s,t)=>s+triangleArea(m.nodes,t)*[t.a,t.b,t.c].reduce((q,i)=>q+m.horizons[0].z[i]-m.base,0)/3,0);
    expect(total).toBeCloseTo(column,6);
    expect(footprintArea(m)).toBeGreaterThan(0);
  });
});

describe("reading a log",()=>{
  const units:UnitDef[]=["A","B","C"].map(id=>({id,name:id,color:"#888888"}));
  const hole=(intervals:Array<[number,number,string]>,depth?:number)=>({id:"H",x:0,y:0,z:100,depth,intervals:intervals.map(([from,to,unit])=>({from,to,unit}))});

  it("merges a unit split over several intervals and skips absent units",()=>{
    const c=boreholeContacts(hole([[0,2,"A"],[2,5,"A"],[5,9,"C"]]),units);
    expect(c.depth).toEqual([0,5,5,null]);
    expect(c.deepest).toBe(2);
    expect(c.eoh).toBe(9);
    expect(c.notes).toEqual([]);
  });

  it("puts a contact in the middle of an unlogged gap",()=>{
    const c=boreholeContacts(hole([[0,4,"A"],[6,10,"B"]]),units);
    expect(c.depth).toEqual([0,5,null,null]);
    expect(c.notes[0]).toMatch(/no log between 4 and 6 m/);
  });

  it("models an older unit logged above a younger one as the younger unit",()=>{
    const c=boreholeContacts(hole([[0,3,"B"],[3,5,"A"],[5,8,"C"]]),units);
    expect(c.depth).toEqual([0,0,5,null]);
    expect(c.notes[0]).toMatch(/out of stratigraphic order/);
  });

  it("takes the recorded final depth when it is below the last interval",()=>{
    expect(boreholeContacts(hole([[0,9,"A"]],15),units).eoh).toBe(15);
  });

  it("leaves the contacts above a log that begins below the collar unknown",()=>{
    const c=boreholeContacts(hole([[8,10,"B"],[10,14,"C"]]),units);
    expect(c.depth).toEqual([0,null,10,null]);
    expect(c.start).toBe(8);
    expect(c.notes).toEqual(["not logged above 8 m; the contacts above are inferred from the neighbouring boreholes"]);
    // A log of the top unit that begins below the collar is that unit up to the ground.
    expect(boreholeContacts(hole([[1,4,"A"],[4,9,"B"]]),units).depth).toEqual([0,4,null,null]);
  });

  it("infers those contacts from the neighbouring boreholes, never below the start of the log",()=>{
    const full=(id:string,x:number,y:number,a:number)=>({id,x,y,z:100,intervals:[{from:0,to:a,unit:"A"},{from:a,to:10,unit:"B"},{from:10,to:20,unit:"C"}]});
    const p:GeoProject={name:"t",units,boreholes:[full("1",0,0,3),full("2",100,0,3),full("3",0,100,3),full("4",100,100,3),
      {id:"late",x:50,y:50,z:100,intervals:[{from:8,to:10,unit:"B"},{from:10,to:20,unit:"C"}]},
      {id:"later",x:50,y:10,z:100,intervals:[{from:1,to:10,unit:"B"},{from:10,to:20,unit:"C"}]}]};
    const m=buildGeologicalModel(p),late=m.boreholes.findIndex(b=>b.id==="late"),later=m.boreholes.findIndex(b=>b.id==="later");
    expect(m.horizons[1].z[late]).toBeCloseTo(97,9);
    expect(m.horizons[1].observed[late]).toBe(0);
    // Logged from 1 m in B: the base of A is at most 1 m deep there.
    expect(m.horizons[1].z[later]).toBeCloseTo(99,9);
    expect(m.warnings.some(w=>/no log between/.test(w))).toBe(false);
  });
});

describe("model warnings",()=>{
  const units:UnitDef[]=[{id:"A",name:"A",color:"#888888"},{id:"B",name:"B",color:"#777777"},{id:"Z",name:"Z",color:"#666666"}];
  const project=(boreholes:GeoProject["boreholes"]):GeoProject=>({name:"t",units,boreholes});
  const log=[{from:0,to:3,unit:"A"},{from:3,to:9,unit:"B"}];

  it("skips boreholes without a collar position or at a repeated position",()=>{
    const m=buildGeologicalModel(project([
      {id:"P1",x:0,y:0,z:10,intervals:log},{id:"P2",x:50,y:0,z:10,intervals:log},{id:"P3",x:0,y:50,z:10,intervals:log},
      {id:"P4",x:NaN,y:5,z:10,intervals:log},{id:"P5",x:50,y:0,z:11,intervals:log}
    ]));
    expect(m.boreholes.map(b=>b.id)).toEqual(["P1","P2","P3"]);
    expect(m.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^P4: collar/),expect.stringMatching(/^P5: same collar position as P2/)]));
  });

  it("reports units that are undeclared or never logged",()=>{
    const m=buildGeologicalModel(project([{id:"P1",x:0,y:0,z:10,intervals:[...log,{from:9,to:12,unit:"Q"}]}]));
    expect(m.units.map(u=>u.id)).toEqual(["A","B"]);
    expect(m.warnings.join("\n")).toMatch(/missing from the unit list were ignored: Q/);
    expect(m.warnings.join("\n")).toMatch(/no logged intervals are not modelled: Z/);
  });

  it("explains why boreholes on one line give no surfaces",()=>{
    const m=buildGeologicalModel(project([0,1,2,3].map(i=>({id:"L"+i,x:i*10,y:i*10,z:10,intervals:log}))));
    expect(m.triangles).toEqual([]);
    expect(m.warnings.join("\n")).toMatch(/one line/);
  });
});
