import {describe,it,expect} from "vitest";
import {auditCollarAgreement} from "../src/correlation";
import {buildGeologicalModel} from "../src/model";
import type {Borehole,GeoProject} from "../src/schema";

function hole(id:string,x:number,y:number,z:number,bases:Array<[number,string]>):Borehole{
  return {id,x,y,z,intervals:bases.map(([to,unit],i)=>({from:i?bases[i-1][0]:0,to,unit}))};
}
const units=(ids:string[])=>ids.map(id=>({id,name:id,color:"#884402"}));

describe("collar agreement",()=>{
  it("reproduces the six reassignments in the three reviewed Antwerp DOV reports",()=>{
    // Databank Ondergrond Vlaanderen, Flemish Government, consulted 28 Nov 2026. Boring records
    // 1931-084105, 1948-120680 and 2016-147736. Depths and interpreted units from the PDF review
    // documented in bench/results/public-report-review/README.md.
    const sand="Sand",clay="Clay",fill="Made ground",gravel="Gravel",pyrite="Couche de pyrite";
    const project:GeoProject={name:"Antwerp",units:units([fill,sand,clay,pyrite,gravel]),boreholes:[
      hole("B187",151745,212969,6.31,[[15.5,sand],[16.5,sand],[18.5,sand],[24.5,sand],[24.55,clay],[26.25,clay],[27.75,clay],
        [28.05,clay],[29.95,clay],[30.55,clay],[31.15,clay],[31.45,clay],[39.3,clay]]),
      hole("B292",152026,212719,7,[[5.5,fill],[7.5,sand],[9.5,sand],[10,sand],[10.5,sand],[12,sand],[16.5,sand],[20,sand]]),
      hole("B100",151850,211858,2,[[2.6,fill],[3.9,sand],[5.4,sand],[5.55,sand],[7.45,sand],[8.35,sand],[24.59,sand],
        [25.08,gravel],[32.7,clay],[32.75,pyrite],[48.25,clay],[48.42,gravel],[55.1,clay],[55.46,gravel],[84,clay],[92,sand]])
    ]};
    const audit=auditCollarAgreement(buildGeologicalModel(project));
    expect(audit.status).toBe("modelled");
    expect(audit.intervals).toHaveLength(37);
    expect(audit.loggedMetres).toBeCloseTo(151.3,9);
    expect(audit.mismatchedMetres).toBeCloseTo(66.39,9);
    expect(audit.matchedMetres).toBeCloseTo(84.91,9);
    expect(audit.unknownMetres).toBe(0);
    expect(audit.discrepancies.map(d=>[d.holeId,d.intervalIndex,d.modelledUnit])).toEqual(
      [8,9,10,12,14,15].map(index=>["B100",index,gravel]));
    expect(audit.discrepancies.at(-2)).toEqual({holeId:"B100",kind:"borehole",intervalIndex:14,unit:clay,from:55.46,to:84,
      mismatchFrom:55.46,mismatchTo:84,modelledUnit:gravel,reason:"different-unit"});
  });

  it("counts partial mismatches, missing coverage and only logged depths",()=>{
    const b=hole("B",0,0,20,[[3,"A"],[6,"B"]]);
    b.intervals[0].from=1;
    b.intervals[1].from=5;
    const m=buildGeologicalModel({name:"gaps",units:units(["A","B"]),boreholes:[b]});
    // Exercise the measured final surfaces independently of the interpolation algorithm.
    m.horizons[1].z[0]=18;
    m.horizons[2].z[0]=14.5;
    const audit=auditCollarAgreement(m);
    expect(audit).toMatchObject({loggedMetres:3,matchedMetres:1.5,mismatchedMetres:1,unknownMetres:0.5});
    expect(audit.discrepancies).toMatchObject([
      {intervalIndex:0,from:1,to:3,mismatchFrom:2,mismatchTo:3,unit:"A",modelledUnit:"B",reason:"different-unit"},
      {intervalIndex:1,from:5,to:6,mismatchFrom:5.5,mismatchTo:6,unit:"B",modelledUnit:null,reason:"outside-coverage"}
    ]);
    expect(audit.intervals[0].discrepancies).toEqual(audit.discrepancies.slice(0,1));
  });

  it("retains every discrepant subrange of one interval in depth order",()=>{
    const logged=hole("H",0,0,10,[[6,"A"]]);
    const other=hole("J",20,0,10,[[2,"A"],[4,"B"],[6,"C"]]);
    const m=buildGeologicalModel({name:"segmented",units:units(["A","B","C"]),boreholes:[logged,other]});
    m.horizons[1].z[0]=9;
    m.horizons[2].z[0]=6.5;
    m.horizons[3].z[0]=5;
    const row=auditCollarAgreement(m).intervals[0];
    expect(row).toMatchObject({loggedMetres:6,matchedMetres:1,mismatchedMetres:4,unknownMetres:1});
    expect(row.discrepancies.map(d=>[d.mismatchFrom,d.mismatchTo,d.modelledUnit])).toEqual([[1,3.5,"B"],[3.5,5,"C"],[5,6,null]]);
  });

  it("records intervals without solids separately from mismatches",()=>{
    const b=hole("lone",0,0,20,[[2,"A"],[4,"B"],[5,"A"]]);
    const audit=auditCollarAgreement(buildGeologicalModel({name:"one log",units:units(["A","B"]),boreholes:[b]}));
    expect(audit).toMatchObject({status:"logs-only",loggedMetres:5,matchedMetres:0,mismatchedMetres:0,unknownMetres:5});
    expect(audit.discrepancies.map(d=>[d.reason,d.modelledUnit])).toEqual(Array(3).fill(["no-solids",null]));
  });

  it("resolves source rows per CPT after its filtered log is cloned, even for shared layer objects",()=>{
    const common={from:2,to:4,unit:"B"};
    const first={id:"T1",x:0,y:0,z:14,depth:[0,4],qc:[1,2],
      layers:[{from:0,to:2,unit:""},common]};
    const second={...first,id:"T2",x:20,
      layers:[{from:0,to:1,unit:""},{from:1,to:2,unit:"A"},common]};
    const m=buildGeologicalModel({name:"CPT source rows",units:units(["A","B"]),boreholes:[],cpts:[first,second],cptLayers:true});
    for(const logs of [m.cptLogs,structuredClone(m.cptLogs)]){
      const rows=auditCollarAgreement({...m,cptLogs:logs}).intervals;
      expect(rows.map(r=>[r.holeId,r.intervalIndex])).toEqual([["T1",1],["T2",1],["T2",2]]);
    }
  });

  it("addresses original CPT layer indices and distinguishes a CPT from a borehole with the same name",()=>{
    const b=hole("01",0,0,10,[[2,"A"],[5,"B"]]);
    const cpt={id:"01",x:20,y:0,z:14,depth:[0,6],qc:[1,2],
      layers:[{from:0,to:1,unit:""},{from:1,to:2,unit:"A"},{from:2,to:4,unit:"B"},{from:4,to:6,unit:"A"}]};
    const m=buildGeologicalModel({name:"CPT",units:units(["A","B"]),boreholes:[b],cpts:[cpt],cptLayers:true});
    const audit=auditCollarAgreement(m);
    expect(audit.intervals.map(r=>[r.kind,r.intervalIndex])).toEqual([["borehole",0],["borehole",1],["cpt",1],["cpt",2],["cpt",3]]);
    expect(audit.discrepancies).toEqual([{holeId:"01",kind:"cpt",intervalIndex:3,unit:"A",from:4,to:6,
      mismatchFrom:4,mismatchTo:6,modelledUnit:"B",reason:"different-unit"}]);
  });
});
