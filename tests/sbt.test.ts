import {describe,it,expect} from "vitest";
import {behaviourIndex,soilBehaviour,cptLayers,layerUnits,joinLayers,waterTableAt,zoneOf,SBT_ZONES,SoilBehaviour} from "../src/sbt";
import {importFiles,toProjectJson} from "../src/io";
import {buildGeologicalModel} from "../src/model";
import {crossValidate} from "../src/validation";
import {Cpt,GeoProject,rotterdamProject} from "../src/geology";

describe("soil behaviour type (Robertson 2009)",()=>{
  it("gives Ic, Qtn and Fr as an independent implementation does",()=>{
    // Reference values from groundhog 0.15 (behaviourindex_pcpt_robertsonwride), which solves for Ic by root finding.
    const cases:Array<[number,number,number,number,{Qtn:number;Fr:number;ic:number;n:number}]>=[
      [10,50,100,60,{Qtn:128.25960025628214,Fr:0.5050505050505051,ic:1.645401574178723,n:0.5068979997620935}],
      [1,40,150,80,{Qtn:10.625,Fr:4.705882352941177,ic:3.090892825539789,n:1}],
      // Cn = (pa/σ′v0)^n is capped at 1.7.
      [0.3,25,60,40,{Qtn:4.08,Fr:10.416666666666668,ic:3.630875147595067,n:1}],
      [25,120,200,110,{Qtn:237.68149510337403,Fr:0.48387096774193544,ic:1.4196414037249572,n:0.4458833748192087}]
    ];
    for(const [qt,fs,sv,s,want] of cases){
      const r=behaviourIndex(qt,fs,sv,s);
      expect(r.ic).toBeCloseTo(want.ic,6);
      expect(r.Qtn).toBeCloseTo(want.Qtn,4);
      expect(r.Fr).toBeCloseTo(want.Fr,9);
      expect(r.n).toBeCloseTo(want.n,6);
    }
    expect(Number.isNaN(behaviourIndex(0.1,10,150,80).ic)).toBe(true);
  });

  it("bands Ic into zones 2 to 7 of Robertson's chart",()=>{
    expect([1.2,1.31,2.04,2.05,2.59,2.6,2.94,2.95,3.59,3.6,4.2].map(zoneOf)).toEqual([7,6,6,5,5,4,4,3,3,2,2]);
    expect(SBT_ZONES.map(z=>z.soil.split(":")[0])).toEqual(["Sand","Sand","Sand mixture","Silt mixture","Clay","Peat"]);
  });

  it("takes the unit weight from the CPT, corrects qt for u2, and counts the water table",()=>{
    // Robertson & Cabal (2010): γ/γw = 0.27 log Rf + 0.36 log(qt/pa) + 1.236; Rf = 50/(10·10) = 0.5 %.
    const c:Cpt={id:"c",x:0,y:0,z:10,depth:[1],qc:[10],fs:[50]};
    const dry=soilBehaviour(c);
    expect(dry.gamma[0]).toBeCloseTo(9.81*(0.27*Math.log10(0.5)+0.36*Math.log10(100)+1.236),9);
    expect(dry.sv[0]).toBeCloseTo(dry.gamma[0],9);
    expect(dry.u0[0]).toBe(0);
    expect(dry.qtFrom).toBe("qc");
    const wet=soilBehaviour({...c,u2:[100],a:0.8},9.5);
    expect(wet.qt[0]).toBeCloseTo(10.02,9);
    expect(wet.qtFrom).toBe("corrected");
    expect(wet.u0[0]).toBeCloseTo(0.5*9.81,9);
    expect(wet.s[0]).toBeCloseTo(wet.sv[0]-0.5*9.81,9);
    expect(wet.ic[0]).toBeCloseTo(behaviourIndex(10.02,50,wet.sv[0],wet.s[0]).ic,12);
    // Water above the start, as over a water bed, adds to σv0 and u0 alike.
    const bed=soilBehaviour(c,12);
    expect(bed.sv[0]-dry.sv[0]).toBeCloseTo(2*9.81,9);
    expect(bed.s[0]).toBeCloseTo(dry.sv[0]-9.81,9);
    expect(soilBehaviour({...c,fs:undefined}).notes.join(" ")).toMatch(/no sleeve friction/);
  });

  it("makes layers of the zones, joining runs thinner than 0.5 m to the nearest neighbour in Ic",()=>{
    const depth=Array.from({length:61},(_,i)=>i/10),c:Cpt={id:"c",x:0,y:0,z:10,depth,qc:depth.map(()=>1)};
    // Sand to 2 m, 0.3 m of clay, sand to 4 m, then 0.4 m of silt mixture and clay to 6 m.
    const ic=depth.map(d=>d<2?1.8:d<2.3?3.2:d<4?1.9:d<4.4?2.8:3.3);
    const b={ic,zone:ic.map(zoneOf)} as SoilBehaviour;
    expect(cptLayers(c,b)).toEqual([
      {from:0,to:4,unit:"",name:"Sand: clean sand to silty sand (SBTn 6)"},
      {from:4,to:6,unit:"",name:"Clay: silty clay to clay (SBTn 3)"}
    ]);
  });

  it("gives layers units by rules on their soil and the elevation of each metre of them",()=>{
    const layers=[{from:0,to:5,unit:"",name:"Sand: clean sand to silty sand (SBTn 6)"},{from:5,to:6,unit:"",name:"Peat: organic soil (SBTn 2)"}];
    const rules=[{match:"^sand",unit:"Upper sand",minZ:7},{match:"^sand",unit:"Lower sand"},{match:"^clay",unit:"Clay",minN:4}];
    expect(layerUnits(layers,10,rules)).toEqual([
      {from:0,to:4,unit:"Upper sand",name:"Sand: clean sand to silty sand (SBTn 6)"},
      {from:4,to:5,unit:"Lower sand",name:"Sand: clean sand to silty sand (SBTn 6)"},
      {from:5,to:6,unit:"",name:"Peat: organic soil (SBTn 2)"}
    ]);
    expect(joinLayers([{from:0,to:1,unit:"A",name:"x"},{from:1,to:2,unit:"A",name:"x"},{from:2,to:3,unit:"B",name:"x"}])).toEqual([{from:0,to:2,unit:"A",name:"x"},{from:2,to:3,unit:"B",name:"x"}]);
  });

  it("takes the water table from the boreholes, else the assumed depth",()=>{
    const p:GeoProject={name:"w",units:[],boreholes:[
      {id:"A",x:0,y:0,z:10,intervals:[],water:[{depth:2},{depth:3}]},{id:"B",x:100,y:0,z:12,intervals:[],water:[{depth:1}]}]};
    expect(waterTableAt(p,50,0,20)).toBeCloseTo(9.5,9);
    expect(waterTableAt(p,50,0,9)).toBe(9);
    expect(waterTableAt({...p,boreholes:[],groundwaterDepth:1.5},0,0,4)).toBe(2.5);
    expect(waterTableAt({...p,boreholes:[]},0,0,4)).toBeUndefined();
  });
});

// Three CPTs on a line, each soft clay over sand, as a CPT table.
const cpt=(id:string,x:number,top:number)=>Array.from({length:121},(_,i)=>{const d=i/10,clay=d<top;return `${id},${x},0,5,${d},${clay?0.6:12},${clay?25:60}`}).join("\n");
const table={name:"cpts.csv",text:`cpt_id,x,y,z,depth (m),qc (MPa),fs (kPa)\n${cpt("C1",0,4)}\n${cpt("C2",50,5)}\n${cpt("C3",100,6)}\n`};

describe("CPT layers in the model",()=>{
  it("models CPTs alone from their layers, grouped by principal soil",()=>{
    const {project,warnings}=importFiles([table]);
    expect(project.boreholes).toEqual([]);
    expect([project.cptLayers,project.cptRules?.length]).toEqual([true,10]);
    expect(project.units.map(u=>u.id)).toEqual(["Clay","Sand"]);
    expect(warnings.join(" ")).toMatch(/The model is built from the CPTs alone/);
    const m=buildGeologicalModel(project);
    expect([m.boreholes.length,m.cptLogs.length,m.units.length]).toEqual([0,3,2]);
    // The base of the clay follows the CPTs: 4, 5 and 6 m below the start at 5 m.
    const at=(i:number)=>m.horizons[1].z[i];
    expect([at(0),at(1),at(2)].map(v=>Math.round(v*10)/10)).toEqual([1,0,-1]);
    const v=crossValidate(project);
    expect(v.boreholes.map(b=>[b.id,b.cpt])).toEqual([["C1",true],["C2",true],["C3",true]]);
    expect(v.notes.join(" ")).toMatch(/3 of the logs are CPT layers/);
    // The project file keeps the layers, their rules and the choice.
    const back=importFiles([{name:"p.json",text:toProjectJson(project)}]).project;
    expect([back.cptLayers,back.cptRules?.length,back.cpts![1].layers]).toEqual([true,10,project.cpts![1].layers]);
  });

  it("splits a soil that lies above and below other units into an upper and a lower unit",()=>{
    // Sand to 6 m, clay to 9 m, sand to 15 m below a start at 5 m: the split lies at 5 - 7.5 = -2.5 m.
    const sandwich=(id:string,x:number)=>Array.from({length:151},(_,i)=>{const d=i/10,clay=d>=6&&d<9;return `${id},${x},0,5,${d},${clay?0.6:12},${clay?25:60}`}).join("\n");
    const {project,warnings}=importFiles([{name:"s.csv",text:`cpt_id,x,y,z,depth (m),qc (MPa),fs (kPa)\n${sandwich("S1",0)}\n${sandwich("S2",50)}\n${sandwich("S3",20)}\n`}]);
    expect(project.units.map(u=>u.id)).toEqual(["Sand, upper","Clay","Sand, lower"]);
    expect(warnings).toContain("Sand lies above and below other units in 3 of 3 CPTs: split into an upper and a lower unit at -2.5 m, the median elevation between them");
    expect(project.cptRules!.filter(r=>/^Sand,/.test(r.unit)).map(r=>[r.unit,r.minZ])).toEqual([["Sand, upper",-2.5],["Sand, lower",undefined]]);
    const m=buildGeologicalModel(project);
    expect(m.warnings.filter(w=>/out of stratigraphic order/.test(w))).toEqual([]);
  });

  it("builds a borehole model with the CPT layers only when asked, by the project's rules",()=>{
    const holes:GeoProject={name:"h",units:[{id:"Clay",name:"Clay",color:"#9c7a5b"},{id:"Sand",name:"Sand",color:"#d9b871"}],
      rules:[{match:"^clay",unit:"Clay"},{match:"^sand",unit:"Sand"}],
      boreholes:[[0,20],[100,20],[50,-60]].map(([x,y],i)=>({id:`B${i}`,x,y,z:5,intervals:[{from:0,to:5,unit:"Clay",name:"Clay"},{from:5,to:12,unit:"Sand",name:"Sand"}]}))};
    const r=importFiles([table],holes);
    expect(r.project.cpts!.every(c=>c.layers!.every(l=>l.unit==="Clay"||l.unit==="Sand"))).toBe(true);
    expect(buildGeologicalModel(r.project).cptLogs).toEqual([]);
    const m=buildGeologicalModel({...r.project,cptLayers:true});
    expect([m.boreholes.length,m.cptLogs.map(l=>l.id)]).toEqual([3,["C1","C2","C3"]]);
  });

  it("builds Maasvlakte with the layers of its CPTs, in the site's own units",()=>{
    expect(rotterdamProject.cptLayers).toBe(true);
    const m=buildGeologicalModel(rotterdamProject);
    expect(m.boreholes.length).toBe(100);
    expect(m.cptLogs.length).toBeGreaterThanOrEqual(24);
    for(const l of m.cptLogs)for(const i of l.intervals)expect(["Sand","Holocene clay","Pleistocene"]).toContain(i.unit);
    expect(m.units.map(u=>u.id)).toEqual(["Sand","Holocene clay","Pleistocene"]);
  });
});
