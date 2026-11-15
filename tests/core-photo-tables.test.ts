import {describe,expect,it} from "vitest";
import {acceptCoreRun} from "../src/corePhoto";
import {applyCorePhotoProject} from "../src/corePhotoTables";
import type {GeoProject} from "../src/schema";
import {projectForCorePhotos,tablesFromProject} from "../src/tables";

const PNG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYh8AAAAASUVORK5CYII=";
function fixture():GeoProject{
  return {name:"Raw draft preservation",units:[{id:"rock",name:"Rock",color:"#778899"}],
    boreholes:[{id:"BH1",x:0,y:0,z:10,depth:10,intervals:[{from:0,to:5,unit:"rock",name:"Original rock"},{from:8,to:9,unit:"rock",name:"Retained log"}]},
      {id:"BH2",x:10,y:10,z:10,depth:12,intervals:[{from:0,to:10,unit:"rock"}]}],
    evidence:{version:1,sources:[{id:"photo",name:"Synthetic.png",pages:[{page:1,width:1,height:1,image:PNG}]}],records:[]},
    corePhotos:{version:1,runs:[{id:"run",boreholeId:"BH1",sourceId:"photo",from:1,to:3,lossReviewed:true,status:"draft",rows:[{
      id:"row",from:1,to:2.8,box:{x0:0,y0:0,x1:1,y1:1},direction:"ltr",registrationReviewed:true,pieces:[{id:"piece",end:2.8,sound:"sound",breakAfter:"end",unit:"rock",description:"Reviewed recovered core"}]
    }]}]}};
}

describe("applying core-photo changes to raw editor tables",()=>{
  it("replaces the accepted run while preserving invalid rows in the same and other holes",()=>{
    const initial=fixture(),tables=tablesFromProject(initial);
    tables.rows.logs[0]=[" BH1 "," 0,0 ","5.000"," rock "," Original rock "];
    const sameHole=["BH1","9.0","unfinished","rock","Keep this unfinished outside log"];
    const otherHole=["BH2","","11,0","rock","Keep this unfinished second hole"];
    tables.rows.logs.push(sameHole,otherHole);
    tables.rows.logs[1]=["BH1","8,0","9.000","rock"," Retained log "];
    tables.rows.boreholes[1][6]=" 12.000 ";
    tables.rows.water.push(["BH2","in progress",""]);
    tables.project.description="  Unfinished project text  ";
    const raw=structuredClone(tables),before=projectForCorePhotos(tables,initial),after=acceptCoreRun(before,"run",{reviewer:"Reviewer",replaceExisting:true});
    const result=applyCorePhotoProject(tables,before,after);
    expect(tables).toEqual(raw);
    expect(result.rows.logs).toContainEqual(sameHole);expect(result.rows.logs).toContainEqual(otherHole);
    expect(result.rows.logs).toContainEqual(raw.rows.logs[1]);expect(result.rows.logs).toContainEqual(raw.rows.logs[2]);
    expect(result.rows.logs).not.toContainEqual(raw.rows.logs[0]);
    expect(result.rows.logs.slice(-3).map(r=>r.slice(0,4))).toEqual([["BH1","0","1","rock"],["BH1","1","2.8","rock"],["BH1","3","5","rock"]]);
    expect(result.rows.water).toEqual(raw.rows.water);expect(result.project).toEqual(raw.project);
    expect(result.rows.boreholes).toEqual(raw.rows.boreholes);
    expect(result.evidenceRows!.logs).toHaveLength(result.rows.logs.length);
    expect(result.evidenceRows!.logs!.filter(Boolean)).toHaveLength(1);
    expect(result.evidence).toEqual(after.evidence);expect(result.corePhotos).toEqual(after.corePhotos);
  });

  it("saves photo drafts without normalizing raw text or inventing evidence bindings",()=>{
    const before=fixture(),tables=tablesFromProject(before);
    tables.rows.logs[0][1]="0,000";tables.rows.logs.push(["BH1","still typing","","",""]);
    tables.rows.boreholes[0][6]="10.0000";
    const after=structuredClone(before);after.corePhotos!.runs[0].lossReviewed=false;
    const result=applyCorePhotoProject(tables,before,after);
    expect(result.rows).toEqual(tables.rows);expect(result.evidenceRows).toEqual(tables.evidenceRows);
    expect(result.corePhotos).toEqual(after.corePhotos);
    result.corePhotos!.runs[0].rows[0].pieces[0].description="Detached";
    expect(after.corePhotos!.runs[0].rows[0].pieces[0].description).toBe("Reviewed recovered core");
  });

  it("uses multiset differences and keeps source bindings aligned when only one duplicate is removed",()=>{
    const before=fixture(),tables=tablesFromProject(before),same={...before.boreholes[0].intervals[0],evidenceId:"source-log"};
    before.boreholes[0].intervals=[same,{...same}];before.boreholes[1].intervals=[];
    tables.rows.logs=[["BH1","0","5","rock","Original rock"],["BH1","0.000","5.00","rock","Original rock"],["BH2","invalid","","",""]];
    tables.evidenceRows={logs:["source-log","source-log",null],water:[]};
    const after=structuredClone(before);after.boreholes[0].intervals.pop();
    const result=applyCorePhotoProject(tables,before,after);
    expect(result.rows.logs).toEqual([tables.rows.logs[1],tables.rows.logs[2]]);
    expect(result.evidenceRows).toEqual({logs:["source-log",null],water:[]});
  });

  it("changes only a changed hole's final depth and does not duplicate additions on a subsequent save",()=>{
    const before=fixture(),tables=tablesFromProject(before);
    tables.rows.boreholes[0][6]="10.000";tables.rows.boreholes[1][6]="12,000";
    const after=acceptCoreRun(before,"run",{reviewer:"Reviewer",replaceExisting:true});after.boreholes[0].depth=15;
    const first=applyCorePhotoProject(tables,before,after);
    expect(first.rows.boreholes[0][6]).toBe("15");expect(first.rows.boreholes[1][6]).toBe("12,000");
    const second=applyCorePhotoProject(first,after,after);
    expect(second).toEqual(first);
    const draft=structuredClone(after);draft.corePhotos!.runs[0].status="draft";
    expect(applyCorePhotoProject(first,after,draft).rows).toEqual(first.rows);
  });

  it.each(["incomplete","","5.000"])("preserves final-depth text %j when accepting an internal run does not extend the hole",rawDepth=>{
    const initial=fixture();initial.boreholes[0].intervals.splice(1);delete initial.boreholes[0].depth;
    const tables=tablesFromProject(initial);tables.rows.boreholes[0][6]=rawDepth;
    const before=projectForCorePhotos(tables,initial),after=acceptCoreRun(before,"run",{reviewer:"Reviewer",replaceExisting:true});
    expect(before.boreholes[0].depth).toBeUndefined();expect(after.boreholes[0].depth).toBe(5);
    const result=applyCorePhotoProject(tables,before,after);
    expect(result.rows.boreholes[0][6]).toBe(rawDepth);
    expect(result.rows.logs.some(row=>row[4]==="Reviewed recovered core")).toBe(true);
  });

  it("uses evidence identity as part of a row match and keeps incomplete or unassigned rows",()=>{
    const before=fixture(),after=structuredClone(before),tables=tablesFromProject(before);
    before.boreholes[0].intervals[0].evidenceId="wanted";after.boreholes[0].intervals.shift();
    tables.rows.logs[0][1]="0e0";
    tables.rows.logs.push(["BH1","0","5","","Unassigned draft"]);
    tables.evidenceRows={logs:["other",null,null,null]};
    const result=applyCorePhotoProject(tables,before,after);
    expect(result.rows.logs).toEqual(tables.rows.logs);
    expect(result.evidenceRows!.logs).toEqual(tables.evidenceRows.logs);
  });
});
