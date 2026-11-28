import {describe,it,expect} from "vitest";
import {auditCollarAgreement} from "../src/correlation";
import {correlationAcceptance,correlationAcceptanceLookup,setCorrelationAcceptance} from "../src/correlationDecisions";
import {importFiles,toProjectJson} from "../src/io";
import {buildGeologicalModel,type GeoModel} from "../src/model";
import type {GeoProject} from "../src/schema";
import {tablesFromProject,projectFromTables} from "../src/tables";
import {createWorkspace,checkpoint,parseWorkspace,toWorkspaceJson} from "../src/workspace";

const rationale="  Retain the lower clay as a local lens.\nReviewed against BH1.  ";
function site():GeoProject{
  return {name:"Recurring clay",units:["Clay","Sand"].map(id=>({id,name:id,color:"#777777"})),
    boreholes:[[0,0],[10,0],[0,10]].map(([x,y],k)=>({id:`BH${k+1}`,x,y,z:10,
      intervals:[{from:0,to:1,unit:"Clay"},{from:1,to:3,unit:"Sand"},{from:3,to:5,unit:"Clay",name:"Lower clay"}]}))};
}
const differences=(model:GeoModel)=>auditCollarAgreement(model).intervals.filter(i=>i.mismatchedMetres>0);
function acceptedSite(){
  const project=site(),model=buildGeologicalModel(project),tables=tablesFromProject(project);
  const interval=differences(model)[0];
  setCorrelationAcceptance(tables,model,interval,rationale);
  return projectFromTables(tables,project).project;
}
function state(project:GeoProject){
  const model=buildGeologicalModel(project);
  return differences(model).map(correlationAcceptanceLookup(model));
}

describe("correlation acceptance records",()=>{
  it("persists the exact reason and extent through editable tables, project JSON and workspace checkpoints",()=>{
    const project=acceptedSite(),accepted=project.correlationAcceptances![0];
    expect(accepted).toMatchObject({rationale,kind:"borehole",holeId:"BH1",from:3,to:5,unit:"Clay",materialId:"Clay",
      segments:[{from:3,to:5,unit:"Sand",materialId:"Sand"}]});
    expect(state(project)).toEqual([accepted,undefined,undefined]);
    const imported=importFiles([{name:"project.json",text:toProjectJson(project)}]).project;
    expect(state(imported)).toEqual(state(project));
    const doc=checkpoint(createWorkspace(tablesFromProject(imported),imported),imported,"Accept lens at BH1");
    const restored=parseWorkspace(JSON.parse(toWorkspaceJson(doc)));
    expect(restored.draft.tables.correlationAcceptances).toEqual([accepted]);
    expect(state(restored.revisions[0].project)).toEqual(state(project));
    expect(state(projectFromTables(restored.draft.tables,restored.draft.base).project)).toEqual(state(project));
  });

  it("invalidates acceptance for a changed source, material or collar without discarding its history",()=>{
    for(const edit of [
      (p:GeoProject)=>{p.boreholes[0].x=0.2},
      (p:GeoProject)=>{p.boreholes[0].z=9.9},
      (p:GeoProject)=>{p.boreholes[0].intervals[2].name="Clayey gravel"},
      (p:GeoProject)=>{p.boreholes[0].intervals[2].to=5.1},
      (p:GeoProject)=>{p.units[1].name="Gravel"},
      (p:GeoProject)=>{p.units[1].materialId="Other";p.units.push({id:"Other",name:"Other",color:"#333333"})}
    ]){
      const p=acceptedSite();edit(p);expect(state(p).filter(Boolean)).toEqual([]);
      expect(p.correlationAcceptances![0].rationale).toBe(rationale);
    }
    const p=acceptedSite();p.description="A different project description";
    expect(state(p)[0]?.rationale).toBe(rationale);
  });

  it("ties a reason to every mismatched segment and rejects uncovered or matching intervals",()=>{
    const project=acceptedSite(),model=buildGeologicalModel(project),tables=tablesFromProject(project);
    // The modelled column now crosses the source interval part way through it.
    model.horizons[1].z[0]=6;
    const interval=differences(model).find(i=>i.holeId==="BH1"&&i.from===3)!;
    expect(interval.discrepancies.map(d=>[d.mismatchFrom,d.mismatchTo])).toEqual([[4,5]]);
    expect(correlationAcceptance(model,interval)).toBeUndefined();
    expect(()=>setCorrelationAcceptance(tables,model,interval," \t")).toThrow(/reason/);
    setCorrelationAcceptance(tables,model,interval,"Check the revised extent");
    expect(tables.correlationAcceptances).toHaveLength(1);
    expect(tables.correlationAcceptances![0].segments[0].from).toBe(4);
    const exact=auditCollarAgreement(model).intervals.find(i=>!i.mismatchedMetres)!;
    expect(()=>setCorrelationAcceptance(tables,model,exact,"Verified")).toThrow();
    model.horizons.at(-1)!.z[0]=5.5;
    const incomplete=auditCollarAgreement(model).intervals.find(i=>i.holeId==="BH1"&&i.from===3)!;
    expect(incomplete.unknownMetres).toBeGreaterThan(0);
    expect(()=>setCorrelationAcceptance(tables,model,incomplete,"Verified")).toThrow();
  });

  it("keeps CPT and borehole decisions separate when their IDs and depth ranges coincide",()=>{
    const project=site();
    project.cptLayers=true;
    project.cpts=[{id:"BH1",x:10,y:10,z:10,depth:[0,5],qc:[1,2],layers:[
      {from:0,to:0.1,unit:""},...project.boreholes[0].intervals]}];
    const model=buildGeologicalModel(project),rows=differences(model).filter(i=>i.holeId==="BH1");
    const tables=tablesFromProject(project);
    expect(rows.map(i=>[i.kind,i.intervalIndex])).toEqual([["borehole",2],["cpt",3]]);
    for(const row of rows)setCorrelationAcceptance(tables,model,row,`Reviewed ${row.kind}`);
    const json=toProjectJson(projectFromTables(tables,project).project);
    const loaded=importFiles([{name:"CPT.json",text:json}]).project;
    expect(state(loaded).filter(Boolean).map(a=>a!.rationale)).toEqual(["Reviewed borehole","Reviewed cpt"]);
  });

  it("refuses ambiguous source IDs on import and cannot accept either duplicate in an existing model",()=>{
    const project=site();project.cptLayers=true;
    const cpt={id:"CPT",x:10,y:10,z:10,depth:[0,5],qc:[1,2],layers:project.boreholes[0].intervals};
    project.cpts=[cpt];
    const model=buildGeologicalModel(project),tables=tablesFromProject(project);
    const first=differences(model).find(i=>i.kind==="cpt")!;
    const prior=setCorrelationAcceptance(tables,model,first,"Nearby lens");
    project.correlationAcceptances=[prior];project.cpts.push({...cpt,x:20});
    expect(()=>importFiles([{name:"ambiguous.json",text:toProjectJson(project)}])).toThrow(/duplicate CPT ID/);
    const ambiguous=buildGeologicalModel(project),rows=differences(ambiguous).filter(i=>i.kind==="cpt");
    expect(rows).toHaveLength(2);
    for(const i of rows){
      expect(correlationAcceptance(ambiguous,i)).toBeUndefined();
      expect(()=>setCorrelationAcceptance(tables,ambiguous,i,"Assumed lens")).toThrow(/exactly one source/);
    }
    // Legacy borehole JSON keeps the last complete record. A decision for the old collar is still stale.
    const replacement=acceptedSite();
    replacement.boreholes.push({...replacement.boreholes[0],x:99});
    const resolved=importFiles([{name:"duplicates.json",text:toProjectJson(replacement)}]).project;
    expect(resolved.boreholes.filter(b=>b.id==="BH1").map(b=>b.x)).toEqual([99]);
    expect(state(resolved).filter(Boolean)).toEqual([]);
  });

  it("rejects malformed imported decisions without reviving them in legacy projects",()=>{
    const p=acceptedSite(),record=p.correlationAcceptances![0];
    for(const invalid of [null,{},[record,record],[{...record,rationale:""}],[{...record,segments:[{from:2,to:8,unit:"Sand",materialId:"Sand"}]}]]){
      const doc={...JSON.parse(toProjectJson(p)),correlationAcceptances:invalid};
      expect(()=>importFiles([{name:"bad.json",text:JSON.stringify(doc)}])).toThrow(/correlation acceptance/i);
      const ws=createWorkspace(tablesFromProject(p),p);
      const stored=JSON.parse(toWorkspaceJson(ws));stored.draft.tables.correlationAcceptances=invalid;
      expect(()=>parseWorkspace(stored)).toThrow(/correlation acceptance/i);
    }
    expect(acceptedSite().correlationAcceptances).toHaveLength(1);
    expect(JSON.parse(toProjectJson(site()))).not.toHaveProperty("correlationAcceptances");
  });
});
