import {describe,it,expect} from "vitest";
import {planInvestigation,investigationCsv} from "../src/investigation";
import type {Alignment,GeoProject} from "../src/schema";
import {parseCsv} from "../src/io";

function project():GeoProject{return {name:"Planning study",crs:"Local grid",base:-10,
  units:[{id:"fill",name:"Fill",color:"#a98"},{id:"sand",name:"Sand",color:"#db8"}],
  boreholes:[[0,0],[100,0],[100,20],[0,20]].map(([x,y],i)=>({id:`BH${i}`,x,y,z:10,
    intervals:[{from:0,to:2,unit:"fill"},{from:2,to:20,unit:"sand"}],water:[{depth:1,date:"2026-01-01"}]}))};}
function line():Alignment{return {name:"Route",points:[{x:0,y:10,chainage:1000},{x:100,y:10,chainage:1100}],
  design:[{chainage:1000,top:7,bottom:5},{chainage:1100,top:7,bottom:5}]};}

describe("investigation location planning",()=>{
  it("selects the largest included-log gap first, then spreads hypothetical sites deterministically",()=>{
    const p=project(),a=line(),original=structuredClone([p,a]);
    const result=planInvestigation(p,a,{budget:3,minSpacing:20,step:10});
    expect(result.proposals.map(q=>q.x)).toEqual([50,20,80]);
    expect(result.proposals.map(q=>q.rank)).toEqual([1,2,3]);
    expect(result.proposals[0].baselineDistance).toBeCloseTo(Math.sqrt(2600),10);
    expect(result.proposals[0].planningDistance).toBeCloseTo(Math.sqrt(2600),10);
    expect(result.proposals[1].planningDistance).toBeCloseTo(Math.sqrt(500),10);
    expect(result.summary).toMatchObject({eligibleCount:7,proposedCount:3,budgetShortfall:0,maxGapAfter:10});
    expect(result.summary.maxGapBefore).toBeCloseTo(Math.sqrt(2600),10);
    expect(result.proposals.every(q=>q.proposedDepth===undefined)).toBe(true);
    expect([p,a]).toEqual(original);expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(planInvestigation(p,a,{budget:3,minSpacing:20,step:10})).toEqual(result);
  });

  it("uses all recorded collars for spacing but only admitted logs for the coverage proxy",()=>{
    const p=project();p.cpts=[{id:"Raw-only",x:80,y:10,z:10,depth:[1,2],qc:[1,2]}];
    const r=planInvestigation(p,line(),{budget:3,minSpacing:20,step:10});
    expect(r.proposals.map(q=>q.x)).toEqual([50,20]);expect(r.summary.budgetShortfall).toBe(1);
    expect(r.usedLogs.every(log=>log.kind==="borehole")).toBe(true);
    expect(r.recordedLogs.find(log=>log.id==="Raw-only")).toMatchObject({kind:"cpt",x:80,y:10});
    expect(r.candidates[r.corridor.stations.findIndex(s=>s.x===80)]).toMatchObject({eligible:false,exclusion:"near-recorded",nearestRecordedDistance:0});
    expect(r.proposals[0].baselineDistance).toBeCloseTo(Math.sqrt(2600),10);
    expect(r.proposals[0].nearestRecordedDistance).toBe(30);
  });

  it("admits reviewed CPT layers into used coverage without using unmodelled CPT readings",()=>{
    const p=project();p.cptLayers=true;p.cpts=[{id:"Layered",x:50,y:10,z:10,depth:[1,2],qc:[1,2],layersSource:"reviewed",
      layers:[{from:0,to:2,unit:"fill"},{from:2,to:20,unit:"sand"}]}];
    const r=planInvestigation(p,line(),{budget:1,minSpacing:0,step:10});
    expect(r.usedLogs.some(log=>log.id==="Layered"&&log.kind==="cpt")).toBe(true);
    expect(r.proposals[0].x).not.toBe(50);expect(r.proposals[0].baselineDistance).toBeLessThan(35);
  });

  it("keeps outside candidates opt-in and never fabricates their ground or proposed depths",()=>{
    const a=line();a.points=[{x:-60,y:10,chainage:940},{x:160,y:10,chainage:1160}];a.design=[{chainage:940,top:7,bottom:5},{chainage:1160,top:7,bottom:5}];
    const inside=planInvestigation(project(),a,{budget:1,minSpacing:0,step:10,depthBelowDesign:3});
    expect(inside.proposals[0].inside).toBe(true);expect(inside.proposals[0].x).toBe(50);expect(inside.summary.excludedOutside).toBeGreaterThan(0);
    const outside=planInvestigation(project(),a,{budget:1,minSpacing:0,step:10,includeOutside:true,depthBelowDesign:3});
    expect(outside.proposals[0]).toMatchObject({x:-60,inside:false});expect(outside.proposals[0].ground).toBeUndefined();
    expect(outside.proposals[0].proposedDepth).toBeUndefined();expect(outside.summary.excludedOutside).toBe(0);
    expect(outside.proposals[0].reasons.join(" ")).toMatch(/Outside the existing model/);
  });

  it("calculates only explicitly requested geometric depth targets and reports below-model termination",()=>{
    const r=planInvestigation(project(),line(),{budget:1,minSpacing:0,step:10,depthBelowDesign:3}),q=r.proposals[0];
    expect(q).toMatchObject({ground:10,targetElevation:5,targetReference:"design-bottom",proposedDepth:8,terminationElevation:2,belowModel:false});
    const deep=planInvestigation(project(),line(),{budget:1,minSpacing:0,depthBelowDesign:30}).proposals[0];
    expect(deep).toMatchObject({proposedDepth:35,terminationElevation:-25,belowModel:true});expect(deep.reasons.join(" ")).toMatch(/below the existing model base/);
    const a=line();a.design!.forEach(d=>{delete d.bottom});
    expect(planInvestigation(project(),a,{budget:1,minSpacing:0,depthBelowDesign:0}).proposals[0]).toMatchObject({targetReference:"design-top",proposedDepth:3});
  });

  it("withholds depth when design or below-ground penetration is unavailable",()=>{
    const a=line();delete a.design;
    const missing=planInvestigation(project(),a,{budget:1,minSpacing:0,depthBelowDesign:3}).proposals[0];
    expect(missing.proposedDepth).toBeUndefined();expect(missing.reasons.join(" ")).toMatch(/no depth was invented/);
    a.design=[{chainage:1000,top:12},{chainage:1100,top:12}];
    const above=planInvestigation(project(),a,{budget:1,minSpacing:0,depthBelowDesign:1}).proposals[0];
    expect(above.proposedDepth).toBeUndefined();expect(above.terminationElevation).toBeUndefined();
    expect(above.reasons.join(" ")).toMatch(/no below-ground penetration/);
  });

  it("preserves missing as-of water and does not turn unknowns into priority severity",()=>{
    const p=project();p.groundwater={mode:"as-of",date:"2020-01-01"};
    const r=planInvestigation(p,line(),{budget:1,minSpacing:0,step:10,prioritizeFlags:true});
    expect(r.proposals[0].x).toBe(50);expect(r.proposals[0].water).toBeUndefined();expect(r.proposals[0].waterHead).toBeUndefined();
    expect(r.proposals[0].flags).toContain("water-unknown");expect(r.proposals[0].reasons[0]).not.toContain("prioritized");
  });

  it("uses explicitly enabled screen priority before distance without a weighted severity score",()=>{
    const p=project();p.boreholes.forEach(b=>{delete b.water});
    const a=line();a.design=[{chainage:1000,top:9,bottom:5},{chainage:1020,top:9,bottom:5},{chainage:1030,top:0,bottom:-2},{chainage:1100,top:0,bottom:-2}];
    const ordinary=planInvestigation(p,a,{budget:1,minSpacing:0,step:10,minCover:2});expect(ordinary.proposals[0].x).toBe(50);
    const prioritized=planInvestigation(p,a,{budget:1,minSpacing:0,step:10,minCover:2,prioritizeFlags:true});
    expect(prioritized.proposals[0].x).toBe(20);expect(prioritized.proposals[0].flags).toContain("low-cover");
    expect(prioritized.proposals[0].reasons[0]).toMatch(/Flagged stations were prioritized: low-cover/);
  });

  it("uses physical XY spacing even where supplied chainage has a different scale",()=>{
    const a=line();a.points[1].chainage=2000;a.design=[{chainage:1000,top:7},{chainage:2000,top:7}];
    const r=planInvestigation(project(),a,{budget:5,minSpacing:30,step:100});
    expect(r.proposals.length).toBe(1);expect(r.proposals[0]).toMatchObject({x:50,chainage:1500});
    expect(r.summary.budgetShortfall).toBe(4);expect(r.notes.join(" ")).toMatch(/Euclidean/);
  });

  it("deduplicates self-revisiting route positions even when minimum spacing is zero",()=>{
    const a:Alignment={name:"There and back",points:[{x:0,y:10,chainage:0},{x:100,y:10,chainage:100},{x:0,y:10,chainage:200}]};
    const r=planInvestigation(project(),a,{budget:50,minSpacing:0,step:10});
    expect(r.summary.excludedDuplicate).toBeGreaterThan(0);expect(r.proposals.length).toBe(11);
    expect(new Set(r.proposals.map(q=>`${q.x},${q.y}`)).size).toBe(r.proposals.length);
    expect(r.proposals.every(q=>q.chainage<=100)).toBe(true);
  });

  it("always excludes near-coincident recorded locations even with spacing zero",()=>{
    const p=project();p.cpts=[{id:"Position",x:50.0005,y:10,z:10,depth:[1],qc:[1]}];
    const r=planInvestigation(p,line(),{budget:50,minSpacing:0,step:10});
    expect(r.proposals.some(q=>q.x===50)).toBe(false);expect(r.summary.excludedRecorded).toBe(1);
    expect(r.proposals.every(q=>q.id!=="Position")).toBe(true);
    p.boreholes[0].id="Proposed-01";
    expect(planInvestigation(p,line(),{budget:1,minSpacing:0}).proposals[0].id).toBe("Proposed-01-plan");
  });

  it("keeps the same initial eligible grid in before/after proxies and includes selected zero distances",()=>{
    const r=planInvestigation(project(),line(),{budget:50,minSpacing:0,step:10});
    expect(r.proposals.length).toBe(r.summary.eligibleCount);expect(r.summary.maxGapAfter).toBe(0);
    expect(r.summary.maxGapBefore).toBeCloseTo(Math.sqrt(2600),10);
    expect(r.notes.join(" ")).toMatch(/same initial eligible candidate grid/);
  });

  it("handles no used logs with an explicit geometric seed and no finite baseline improvement claim",()=>{
    const p=project();p.boreholes=[];
    const r=planInvestigation(p,line(),{budget:2,minSpacing:0,includeOutside:true,step:10,depthBelowDesign:3});
    expect(r.usedLogs).toEqual([]);expect(r.proposals[0].x).toBe(50);expect(r.proposals[1].x).toBe(0);
    expect(r.summary.maxGapBefore).toBeUndefined();expect(r.summary.maxGapAfter).toBe(50);
    expect(r.proposals[0].planningDistance).toBeUndefined();expect(r.proposals[0].proposedDepth).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/no finite baseline improvement claim/);expect(JSON.stringify(r)).not.toMatch(/Infinity|NaN/);
  });

  it("returns an explicit empty plan and preserves settings in its CSV",()=>{
    const r=planInvestigation(project(),line(),{budget:5,minSpacing:1000}),rows=parseCsv(investigationCsv(r)),h=rows[0],value=(key:string)=>rows[1][h.indexOf(key)];
    expect(r.proposals).toEqual([]);expect(r.summary).toMatchObject({eligibleCount:0,budgetShortfall:5});
    expect(rows).toHaveLength(2);expect(value("proposal_id")).toBe("");expect(value("location_budget")).toBe("5");
    expect(value("minimum_spacing_m")).toBe("1000");expect(value("project_name")).toBe("Planning study");
    expect(value("max_candidate_gap_before_m")).toBe("");expect(JSON.parse(value("review_notes")).join(" ")).toMatch(/No eligible/);
  });

  it("exports proposed values and blank unknowns separately from observed inputs",()=>{
    const p=project(),r=planInvestigation(p,line(),{budget:1,minSpacing:0}),rows=parseCsv(investigationCsv(r)),h=rows[0],v=(key:string)=>rows[1][h.indexOf(key)];
    expect(v("proposal_id")).toBe("Proposed-01");expect(v("model_ground_m")).toBe("10");expect(v("proposed_depth_m")).toBe("");
    expect(Number(v("nearest_used_log_distance_m"))).toBeCloseTo(Math.sqrt(2600),10);
    expect(v("location_budget")).toBe("1");expect(JSON.parse(v("alignment_geometry"))).toEqual(line().points);
    expect(JSON.parse(v("crs"))).toEqual({name:"Local grid"});expect(v("alignment_start_m")).toBe("1000");
    expect(JSON.parse(v("reasons")).join(" ")).toMatch(/Largest remaining distance/);
  });

  it("bounds candidate work and retains actual coarsened station spacing",()=>{
    const r=planInvestigation(project(),line(),{budget:1,minSpacing:0,step:1e-10,maxSamples:11});
    expect(r.candidates.length).toBeLessThanOrEqual(11);expect(r.corridor.range.actualStep).toBe(10);
    expect(r.notes.join(" ")).toMatch(/regular chainage spacing increased/);
  });

  it("validates count, spacing, threshold, boolean and identity inputs",()=>{
    const p=project(),a=line();
    for(const budget of [0,-1,1.5,51,NaN])expect(()=>planInvestigation(p,a,{budget})).toThrow(/budget/);
    for(const minSpacing of [-1,NaN,Infinity])expect(()=>planInvestigation(p,a,{minSpacing})).toThrow(/spacing/);
    for(const depthBelowDesign of [-1,NaN,Infinity])expect(()=>planInvestigation(p,a,{depthBelowDesign})).toThrow(/Depth below design/);
    expect(()=>planInvestigation(p,a,{includeOutside:1 as unknown as boolean})).toThrow(/boolean/);
    expect(()=>planInvestigation(p,a,{step:0})).toThrow(/station spacing/);
    expect(()=>planInvestigation(p,a,{minCover:-1})).toThrow(/threshold/);
    expect(()=>planInvestigation({...p,boreholes:[...p.boreholes,p.boreholes[0]]},a)).toThrow(/IDs must be unique/);
  });
});

describe("selected-interpretation investigation priority",()=>{
  function cases(p=project(),varying=false){
    const alternative=structuredClone(p);alternative.name="Alternative";
    for(const hole of alternative.boreholes){
      const top=varying?2+2*hole.x/100:4;
      hole.intervals[0].to=top;hole.intervals[1].from=top;
    }
    return [{id:"before",label:"Reference",project:p},{id:"after",label:"Alternative",project:alternative}];
  }

  it("ranks exact candidate contact ranges before the geometric gap, then breaks ties by the existing rule",()=>{
    const p=project(),selected=cases(p,true),copy=structuredClone([p,selected]);
    const ordinary=planInvestigation(p,line(),{budget:1,minSpacing:0,step:10});
    const result=planInvestigation(p,line(),{budget:1,minSpacing:0,step:10,prioritizeDisagreement:true,disagreementContext:{cases:selected,unitId:"sand"}});
    expect(ordinary.proposals[0].x).toBe(50);expect(result.proposals[0].x).toBe(100);
    expect(result.proposals[0].modelRange).toMatchObject({unitId:"sand",min:6,max:8,width:2,count:2,total:2,caseIds:["before","after"]});
    expect(result.proposals[0].reasons[0]).toMatch(/Largest remaining complete selected-interpretation range/);
    expect(result.proposals[0].reasons[1]).toMatch(/used to break range ties/);
    expect([p,selected]).toEqual(copy);
    const uniform=planInvestigation(p,line(),{budget:1,minSpacing:0,step:10,prioritizeDisagreement:true,disagreementContext:{cases:cases(p),unitId:"sand"}});
    expect(uniform.proposals[0].x).toBe(50);expect(uniform.proposals[0].modelRange!.width).toBeCloseTo(2,9);
  });

  it("treats a complete zero range as valid but excludes missing cases instead of treating them as zero",()=>{
    const p=project(),identical=[{id:"one",project:p},{id:"two",project:structuredClone(p)}];
    const zero=planInvestigation(p,line(),{budget:1,minSpacing:0,step:10,prioritizeDisagreement:true,disagreementContext:{cases:identical,unitId:"sand"}});
    expect(zero.proposals[0]).toMatchObject({x:50,modelRange:{width:0,count:2,total:2}});expect(zero.summary.excludedDisagreement).toBe(0);
    const selected=cases(p);selected[1].project.boreholes.forEach(h=>h.x+=50);
    const partial=planInvestigation(p,line(),{budget:1,minSpacing:0,step:10,prioritizeDisagreement:true,disagreementContext:{cases:selected,unitId:"sand"}});
    expect(partial.summary.excludedDisagreement).toBeGreaterThan(0);expect(partial.proposals[0].x).toBe(50);
    const missing=partial.candidates.find(c=>c.exclusion==="missing-disagreement")!;
    expect(missing.missingCaseIds).toEqual(["after"]);
    expect(partial.proposals.every(q=>q.modelRange?.count===q.modelRange?.total)).toBe(true);
    selected[1].project.units=selected[1].project.units.filter(u=>u.id!=="sand");
    const empty=planInvestigation(p,line(),{budget:2,minSpacing:0,prioritizeDisagreement:true,disagreementContext:{cases:selected,unitId:"sand"}});
    expect(empty.proposals).toEqual([]);expect(empty.summary.budgetShortfall).toBe(2);expect(empty.summary.excludedDisagreement).toBeGreaterThan(0);
    const rows=parseCsv(investigationCsv(empty)),header=rows[0];
    expect(rows[1][header.indexOf("model_range_width_m")]).toBe("");
    expect(rows[1][header.indexOf("disagreement_contact_id")]).toBe("sand");
  });

  it("preserves physical spacing from collars in every selected case, including moved IDs and unused CPTs",()=>{
    const p=project(),selected=cases(p);
    selected[1].project.cpts=[{id:"Alternative-only",x:50,y:10,z:10,depth:[1,2],qc:[1,2]}];
    selected[1].project.boreholes[0].x=1;
    const result=planInvestigation(p,line(),{budget:2,minSpacing:20,step:10,prioritizeDisagreement:true,disagreementContext:{cases:selected,unitId:"sand"}});
    expect(result.recordedLogs).toContainEqual({id:"Alternative-only",kind:"cpt",x:50,y:10});
    expect(result.recordedLogs.filter(log=>log.id==="BH0")).toHaveLength(2);
    expect(result.usedLogs).not.toContainEqual({id:"Alternative-only",kind:"cpt",x:50,y:10});
    expect(result.proposals.every(site=>Math.hypot(site.x-50,site.y-10)>=20-1e-9)).toBe(true);
    expect(result.candidates.find(c=>result.corridor.stations[c.stationIndex].x===50)).toMatchObject({exclusion:"near-recorded"});
  });

  it("rejects stale/foreign snapshots, incompatible grids, invalid priorities and contacts",()=>{
    const p=project(),selected=cases(p),context={cases:selected,unitId:"sand"};
    const stale=structuredClone(p);stale.boreholes[0].z+=1;
    expect(()=>planInvestigation(stale,line(),{prioritizeDisagreement:true,disagreementContext:context})).toThrow(/reference snapshot must match/);
    expect(()=>planInvestigation(p,line(),{prioritizeDisagreement:true})).toThrow(/needs selected saved cases/);
    expect(()=>planInvestigation(p,line(),{prioritizeDisagreement:true,prioritizeFlags:true,disagreementContext:context})).toThrow(/either/);
    expect(()=>planInvestigation(p,line(),{prioritizeDisagreement:true,disagreementContext:{cases:selected,unitId:"unknown"}})).toThrow(/absent from the reference/);
    selected[1].project.crs="Another grid";
    expect(()=>planInvestigation(p,line(),{prioritizeDisagreement:true,disagreementContext:context})).toThrow(/different local grids/);
    expect(()=>planInvestigation(p,line(),{prioritizeDisagreement:"yes" as unknown as boolean})).toThrow(/boolean/);
  });

  it("keeps source projects out of plans/CSV while retaining case identities and exact range metadata",()=>{
    const p=project(),selected=cases(p);
    (selected[1].project as any).evidence={privatePreview:"DO_NOT_EXPORT_SOURCE_PAGES"};
    const result=planInvestigation(p,line(),{budget:1,minSpacing:0,prioritizeDisagreement:true,disagreementContext:{cases:selected,unitId:"sand"}});
    expect(result.disagreement).toEqual({unitId:"sand",caseIds:["before","after"],caseLabels:["Reference","Alternative"]});
    expect((result.options as any).disagreementContext).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("DO_NOT_EXPORT_SOURCE_PAGES");
    const rows=parseCsv(investigationCsv(result)),header=rows[0],value=(name:string)=>rows[1][header.indexOf(name)];
    expect(value("ranking_method")).toBe("selected-interpretation-range");expect(value("disagreement_contact_id")).toBe("sand");
    expect(JSON.parse(value("disagreement_case_ids"))).toEqual(["before","after"]);
    expect(Number(value("model_range_width_m"))).toBeCloseTo(2,9);
    expect(value("model_range_count")).toBe("2");expect(value("model_range_total")).toBe("2");
    const evidenceOnly=structuredClone(p);evidenceOnly.boreholes[0].evidenceId="source-id";
    expect(()=>planInvestigation(evidenceOnly,line(),{budget:1,prioritizeDisagreement:true,disagreementContext:{cases:cases(p),unitId:"sand"}})).not.toThrow();
    const normal=planInvestigation(p,line(),{budget:1,minSpacing:0,disagreementContext:{cases:selected,unitId:"sand"}});
    expect(normal.proposals[0].x).toBe(50);expect(normal.disagreement).toBeUndefined();expect(normal.proposals[0].modelRange).toBeUndefined();
  });
});
