import {describe,it,expect} from "vitest";
import {planInvestigation,investigationCsv,InvestigationOptions} from "../src/investigation";
import type {Alignment,GeoProject} from "../src/schema";
import {parseCsv} from "../src/io";

function project():GeoProject{return {name:"Costed planning study",crs:"Local grid",base:-10,
  units:[{id:"fill",name:"Fill",color:"#a98"},{id:"sand",name:"Sand",color:"#db8"}],
  boreholes:[[0,0],[100,0],[100,20],[0,20]].map(([x,y],i)=>({id:`BH${i}`,x,y,z:10,
    intervals:[{from:0,to:2,unit:"fill"},{from:2,to:20,unit:"sand"}]}))};}
function line():Alignment{return {name:"Route",points:[{x:0,y:10,chainage:1000},{x:100,y:10,chainage:1100}],
  design:[{chainage:1000,top:7,bottom:5},{chainage:1100,top:7,bottom:5}]};}
function settings(p:GeoProject,varying=false):InvestigationOptions{
  const alternative=structuredClone(p);alternative.name="Alternative";
  for(const hole of alternative.boreholes){const depth=varying?2+2*hole.x/100:4;hole.intervals[0].to=depth;hole.intervals[1].from=depth}
  return {budget:5,minSpacing:0,step:10,disagreementContext:{unitId:"sand",cases:[{id:"ref",project:p},{id:"alt",project:alternative}]},
    information:{resolution:1,moneyBudget:1000,fixedCost:100,costPerMetre:20,contactBuffer:1,currency:"USD"}};
}

describe("cost-aware information investigation planning",()=>{
  it("costs the deepest selected-case contact and stops after a redundant site would add zero information",()=>{
    const p=project(),options=settings(p),original=structuredClone([p,options]),plan=planInvestigation(p,line(),options);
    expect(plan.proposals).toHaveLength(1);expect(plan.proposals[0].x).toBe(50);
    expect(plan.proposals[0]).toMatchObject({proposedDepth:5,terminationElevation:5,information:{bins:[8,6],requiredContactDepth:5,estimatedDepth:5,estimatedCost:200,expectedGainBits:1,cumulativeGainBits:1,remainingBudget:800}});
    expect(plan.summary).toMatchObject({totalCost:200,unspentBudget:800,cumulativeInformationBits:1,priorEntropyBits:1,stopReason:"no-information",budgetShortfall:4});
    expect(plan.options.prioritizeDisagreement).toBeUndefined();expect(plan.options.information?.priors).toEqual([.5,.5]);
    expect([p,options]).toEqual(original);expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
    expect(planInvestigation(p,line(),options)).toEqual(plan);
  });
  it("prefers cheaper equally informative shallow investigations rather than wider contact spread",()=>{
    const p=project(),options=settings(p,true),plan=planInvestigation(p,line(),options);
    expect(plan.proposals).toHaveLength(1);expect(plan.proposals[0].x).toBe(10);
    expect(plan.proposals[0].information?.estimatedCost).toBeCloseTo(164,9);
    expect(plan.proposals[0].information?.expectedGainBits).toBe(1);
    expect(plan.proposals[0].modelRange!.width).toBeCloseTo(.2,10);
    options.information!.origin=.5;
    expect(planInvestigation(p,line(),options).proposals[0].x).toBe(30);
  });
  it("conditions later selections on joint earlier outcomes and never spends for redundant case partitions",()=>{
    const p=project(),options=settings(p);
    const cases=[p,...Array.from({length:3},()=>structuredClone(p))];
    cases.forEach((value,k)=>value.boreholes.forEach(hole=>{
      const contact=k===0?8:k===1?7+hole.x/100:k===2?8-hole.x/100:7;
      hole.intervals[0].to=10-contact;hole.intervals[1].from=10-contact;
    }));
    options.disagreementContext!.cases=cases.map((value,i)=>({id:`case${i}`,project:value}));
    options.information={resolution:1,origin:.5,moneyBudget:200,fixedCost:100,costPerMetre:0,contactBuffer:1};
    const plan=planInvestigation(p,line(),options);
    expect(plan.proposals).toHaveLength(2);
    expect(plan.proposals.map(q=>q.information!.expectedGainBits)).toEqual([1,1]);
    expect(plan.proposals.map(q=>q.information!.cumulativeGainBits)).toEqual([1,2]);
    expect(plan.summary).toMatchObject({totalCost:200,unspentBudget:0,priorEntropyBits:2,cumulativeInformationBits:2,stopReason:"no-information"});
  });
  it("keeps the monetary budget hard, allows an exact-cost purchase and never fills zero-information sites",()=>{
    const p=project(),options=settings(p);options.information!.moneyBudget=199;
    const insufficient=planInvestigation(p,line(),options);
    expect(insufficient.proposals).toEqual([]);expect(insufficient.summary).toMatchObject({totalCost:0,unspentBudget:199,stopReason:"money-budget"});
    options.information!.moneyBudget=200;
    expect(planInvestigation(p,line(),options).summary).toMatchObject({totalCost:200,unspentBudget:0,proposedCount:1});
    const identical=settings(p);identical.disagreementContext!.cases[1].project=structuredClone(p);
    const zero=planInvestigation(p,line(),identical);expect(zero.proposals).toEqual([]);expect(zero.summary.stopReason).toBe("no-information");
  });
  it("includes deeper explicit design requirements in both proposal depth and cost",()=>{
    const p=project(),options=settings(p);options.depthBelowDesign=10;
    const plan=planInvestigation(p,line(),options);
    expect(plan.proposals[0]).toMatchObject({proposedDepth:15,terminationElevation:-5,information:{requiredContactDepth:5,estimatedDepth:15,estimatedCost:400}});
    const missing=line();delete missing.design;
    const unavailable=planInvestigation(p,missing,options);expect(unavailable.proposals).toEqual([]);expect(unavailable.summary.excludedCost).toBeGreaterThan(0);
    expect(unavailable.candidates.filter(c=>c.exclusion==="unknown-cost").every(c=>c.costReason?.includes("requested design target"))).toBe(true);
  });
  it("costs contact and design reach under alternative ground levels rather than just reference ground",()=>{
    const p=project(),options=settings(p),alternative=options.disagreementContext!.cases[1].project;
    for(const hole of alternative.boreholes){hole.z=20;hole.intervals[0].to=14;hole.intervals[1].from=14}
    const contactOnly=planInvestigation(p,line(),options);
    expect(contactOnly.proposals[0]).toMatchObject({ground:10,proposedDepth:15,information:{requiredContactDepth:15,estimatedCost:400}});
    options.depthBelowDesign=10;
    expect(planInvestigation(p,line(),options).proposals[0]).toMatchObject({proposedDepth:25,information:{requiredContactDepth:15,estimatedDepth:25,estimatedCost:600}});
  });
  it("does not credit observable information for a selected unit that pinches out in an interpretation",()=>{
    const p=project(),options=settings(p);
    options.disagreementContext!.cases[1].project.boreholes.filter(hole=>hole.x===0).forEach(hole=>{hole.intervals=[{from:0,to:20,unit:"fill"}]});
    const route=line();route.points=[{x:0,y:1,chainage:1000},{x:0,y:19,chainage:1100}];
    const plan=planInvestigation(p,route,options);
    expect(plan.proposals).toEqual([]);expect(plan.summary).toMatchObject({cumulativeInformationBits:0,stopReason:"no-eligible"});
    expect(plan.summary.excludedCost).toBeGreaterThan(0);
    expect(plan.candidates.some(c=>c.costReason?.includes("positive-thickness observable"))).toBe(true);
  });
  it("excludes unknown footprint/cost and every selected case's recorded collars",()=>{
    const p=project(),options=settings(p);options.disagreementContext!.cases[1].project.cpts=[{id:"Unused",x:50,y:10,z:10,depth:[1],qc:[1]}];options.minSpacing=20;
    const plan=planInvestigation(p,line(),options);
    expect(plan.proposals.every(q=>Math.hypot(q.x-50,q.y-10)>=20)).toBe(true);
    expect(plan.candidates.find(c=>plan.corridor.stations[c.stationIndex].x===50)).toMatchObject({exclusion:"near-recorded"});
    options.disagreementContext!.cases[1].project.boreholes.forEach(b=>b.x+=50);
    const partial=planInvestigation(p,line(),options);expect(partial.summary.excludedDisagreement).toBeGreaterThan(0);
    expect(partial.proposals.every(q=>q.modelRange?.count===2)).toBe(true);
    const extreme=settings(p);extreme.information!.fixedCost=Number.MIN_VALUE;extreme.information!.costPerMetre=0;
    const unknown=planInvestigation(p,line(),extreme);expect(unknown.proposals).toEqual([]);expect(unknown.summary.excludedCost).toBeGreaterThan(0);
  });
  it("reports supplied prior entropy and retains all assumptions in exports without raw projects",()=>{
    const p=project(),options=settings(p);options.information!.priors=[9,1];(options.disagreementContext!.cases[1].project as any).evidence={secret:"private page"};
    const plan=planInvestigation(p,line(),options),rows=parseCsv(investigationCsv(plan)),head=rows[0],value=(name:string)=>rows[1][head.indexOf(name)];
    expect(plan.summary.cumulativeInformationBits).toBeCloseTo(-.9*Math.log2(.9)-.1*Math.log2(.1),12);
    expect(value("ranking_method")).toBe("expected-information-per-cost");expect(value("information_model")).toBe("finite-case-noiseless-contact-bins");
    expect(JSON.parse(value("information_prior_weights"))).toEqual([.9,.1]);expect(value("estimated_cost")).toBe("200");expect(value("cost_currency")).toBe("USD");
    expect(JSON.parse(value("assumed_contact_bins"))).toEqual([8,6]);expect(JSON.parse(value("disagreement_case_ids"))).toEqual(["ref","alt"]);
    expect(JSON.stringify(plan)).not.toContain("private page");expect((plan.options as any).disagreementContext).toBeUndefined();
    expect(plan.notes.join(" ")).toMatch(/measurement noise is not modeled/);expect(plan.notes.join(" ")).toMatch(/not a globally optimal/);
    options.information!.moneyBudget=1;const empty=parseCsv(investigationCsv(planInvestigation(p,line(),options)));
    expect(empty).toHaveLength(2);expect(empty[1][empty[0].indexOf("monetary_budget")]).toBe("1");expect(empty[1][empty[0].indexOf("estimated_cost")]).toBe("");
  });
  it("rejects stale contexts, mixed ranking modes and absent information context",()=>{
    const p=project(),options=settings(p);
    expect(()=>planInvestigation(p,line(),{...options,prioritizeDisagreement:true})).toThrow(/either/);
    expect(()=>planInvestigation(p,line(),{...options,prioritizeFlags:true})).toThrow(/either/);
    expect(()=>planInvestigation(p,line(),{...options,disagreementContext:undefined})).toThrow(/needs selected saved cases/);
    const stale=structuredClone(p);stale.boreholes[0].z++;
    expect(()=>planInvestigation(stale,line(),options)).toThrow(/snapshot must match/);
    options.information!.moneyBudget=0;expect(()=>planInvestigation(p,line(),options)).toThrow(/monetary budget/);
  });
});
