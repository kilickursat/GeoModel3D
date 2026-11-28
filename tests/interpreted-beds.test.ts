import {describe,it,expect} from "vitest";
import type {GeoProject} from "../src/schema";
import {assignInterpretedBed,interpretedBedOptions} from "../src/interpretedBeds";
import {auditCollarAgreement} from "../src/correlation";
import {buildGeologicalModel} from "../src/model";
import {importFiles,toProjectJson} from "../src/io";
import {COLUMNS,projectFromTables,tablesFromProject} from "../src/tables";
import {checkpoint,createWorkspace,parseWorkspace,toWorkspaceJson} from "../src/workspace";

const lower={holeId:"A",from:3,to:5,unit:"clay"};
const newBed={id:"lower clay",beforeUnit:"rock"};

function site():GeoProject{
  return {name:"Correlated clay",units:[
    {id:"clay",name:"Logged clay",color:"#654321",gamma:18,gammaSat:20,erosive:true,source:"Design memo",
      params:{c:7,phi:19,K0:0.6,preconsolidation:120,customZero:0}},
    {id:"sand",name:"Sand",color:"#fedcba"},{id:"rock",name:"Rock",color:"#776655"}
  ],boreholes:["A","B"].map((id,index)=>({id,x:index*30,y:0,z:11,intervals:[
    {from:0,to:1,unit:"clay",name:"Soft clay"},{from:1,to:3,unit:"sand",name:"Brown sand"},
    {from:3,to:5,unit:"clay",name:"Stiff grey clay",...(index===0?{evidenceId:"log-A-3"}:{})},
    {from:5,to:6,unit:"rock",name:"Bedrock"}
  ]})),rules:[{match:"clay",unit:"clay"},{match:"sand",unit:"sand"},{match:"rock",unit:"rock"}],
    evidence:{version:1,sources:[{id:"page-source",name:"Boreholes.pdf",pages:[{page:1,width:600,height:800}]}],
      records:[{id:"log-A-3",sourceId:"page-source",method:"pdf-text",fields:{
        unit:{original:"clay",current:"clay",boxes:[{page:1,x0:0.12,y0:0.20,x1:0.48,y1:0.32,text:"Stiff grey clay"}],
          status:"accepted",events:[{at:"2026-11-20T00:00:00.000Z",action:"accepted",value:"clay"}]},
        description:{original:"Stiff grey clay",current:"Stiff grey clay",boxes:[],status:"unreviewed",events:[]}
      }}]}
  };
}

describe("interpreted beds",()=>{
  it("creates one bed at the selected position, reuses it, and keeps the measured intervals and design values across exports",()=>{
    const p=site(),tables=tablesFromProject(p),original=structuredClone(p);
    const audit=(q:GeoProject)=>auditCollarAgreement(buildGeologicalModel(q,{triangles:32}));
    expect(audit(p).mismatchedMetres).toBe(4);
    assignInterpretedBed(tables,lower,newBed);
    expect(interpretedBedOptions(tables,"clay")).toEqual(["clay","lower clay"]);
    expect(interpretedBedOptions(tables,"lower clay")).toEqual(["clay","lower clay"]);
    assignInterpretedBed(tables,{...lower,holeId:"B"},{id:"lower clay"});

    const project=projectFromTables(tables,p).project;
    const imported=importFiles([{name:"reopened.json",text:toProjectJson(project)}]).project;
    const workspace=checkpoint(createWorkspace(tables,p),project,"Assigned lower clay");
    const reopened=parseWorkspace(JSON.parse(toWorkspaceJson(workspace)));
    const restored=projectFromTables(reopened.draft.tables,reopened.draft.base).project;
    for(const saved of [project,imported,restored,reopened.revisions[0].project]){
      expect(saved.units.map(u=>u.id)).toEqual(["clay","sand","lower clay","rock"]);
      expect(saved.units[2]).toEqual({...p.units[0],id:"lower clay",name:"lower clay",materialId:"clay"});
      expect(saved.rules).toEqual(p.rules);
      for(const [i,b] of saved.boreholes.entries()){
        expect(b.intervals).toEqual(p.boreholes[i].intervals.map((r,k)=>k===2?{...r,unit:"lower clay"}:r));
      }
      expect(audit(saved).mismatchedMetres).toBe(0);
      const record=saved.evidence!.records[0],source=p.evidence!.records[0];
      expect(saved.evidence!.sources).toEqual(p.evidence!.sources);
      expect(record.fields.description).toEqual(source.fields.description);
      expect(record.fields.unit).toMatchObject({original:"clay",current:"lower clay",status:"corrected",boxes:source.fields.unit.boxes});
      expect(record.fields.unit.events).toHaveLength(2);
      expect(record.fields.unit.events[0]).toEqual(source.fields.unit.events[0]);
      expect(record.fields.unit.events[1]).toMatchObject({action:"corrected",previous:"clay",value:"lower clay"});
    }
    expect(p).toEqual(original);
  });

  it("inherits custom design parameters from the selected bed during repeated assignments in the same draft",()=>{
    const p=site(),established="Clay lens";
    const lens={...p.units[0],id:established,name:established,materialId:"clay",
      params:{...p.units[0].params,preconsolidation:260,secondaryCompression:0.03}};
    p.units.splice(2,0,lens);
    p.boreholes[0].intervals[2].unit=established;
    const tables=tablesFromProject(p);
    assignInterpretedBed(tables,{...lower,unit:established},{id:"Lens A",beforeUnit:"rock"});
    // The second assignment occurs before a build has added Lens A to the base project.
    assignInterpretedBed(tables,{...lower,unit:"Lens A"},{id:"Lens A2",beforeUnit:"rock"});
    const restored=parseWorkspace(JSON.parse(toWorkspaceJson(createWorkspace(tables,p))));
    const built=projectFromTables(restored.draft.tables,restored.draft.base).project;
    for(const u of [built,importFiles([{name:"split.json",text:toProjectJson(built)}]).project]){
      for(const id of ["Lens A","Lens A2"]){
        expect(u.units.find(b=>b.id===id)).toMatchObject({materialId:"clay",params:lens.params});
      }
      expect(u.boreholes[0].intervals[2]).toMatchObject({unit:"Lens A2",name:"Stiff grey clay",from:3,to:5});
      expect(u.units[0].params).toEqual(p.units[0].params);
    }
  });

  it("keeps an unfinished Units row in the draft and retains unpublished edits to the source unit",()=>{
    const p=site(),tables=tablesFromProject(p),unfinished=COLUMNS.units.map(()=>"");
    unfinished[1]="Untitled pending material";
    tables.rows.units.splice(1,0,unfinished);
    tables.rows.units[0][4]="18.25";
    assignInterpretedBed(tables,lower,newBed);
    expect(tables.rows.units).toContainEqual(unfinished);
    expect(tables.rows.units.filter(r=>r[0]).map(r=>r[0])).toEqual(["clay","sand","lower clay","rock"]);
    expect(tables.rows.units.find(r=>r[0]==="lower clay")![4]).toBe("18.25");
  });

  it("rejects ambiguous log rows, stale targets and reuse across materials without changing the draft or evidence",()=>{
    const t=tablesFromProject(site());
    const duplicate=structuredClone(t);
    duplicate.rows.logs.push([...duplicate.rows.logs[2]]);
    duplicate.evidenceRows!.logs!.push(null);
    const duplicateUnit=structuredClone(t);
    duplicateUnit.rows.units.push([...duplicateUnit.rows.units[0]]);
    for(const [tables,target] of [[duplicate,newBed],[duplicateUnit,newBed],[t,{id:"sand"}],[t,{id:"lower clay",beforeUnit:"missing"}],[t,{id:"sand",beforeUnit:null}]] as const){
      const before=structuredClone(tables);
      expect(()=>assignInterpretedBed(tables,lower,target)).toThrow();
      expect(tables).toEqual(before);
    }
  });

  it("opens an old workspace's Units rows and appends a deeper interpreted bed",()=>{
    const p=site(),legacy=tablesFromProject(p);
    legacy.rows.units.forEach(row=>row.pop());
    const reopened=parseWorkspace(createWorkspace(legacy,p));
    const tables=reopened.draft.tables;
    expect(tables.rows.units.every(r=>r.length===COLUMNS.units.length)).toBe(true);
    assignInterpretedBed(tables,lower,{id:"deepest clay",beforeUnit:null});
    const project=projectFromTables(tables,reopened.draft.base).project;
    expect(project.units.at(-1)).toEqual({...p.units[0],id:"deepest clay",name:"deepest clay",materialId:"clay"});
  });
});
