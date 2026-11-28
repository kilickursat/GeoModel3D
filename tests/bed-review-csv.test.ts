import {describe,expect,it} from "vitest";
import {importFiles,toCsv,parseCsv,toProjectJson} from "../src/io";
import {isBedReviewCsv,readBedReviewCsv,toBedReviewCsv} from "../src/bedReviewCsv";
import type {GeoProject} from "../src/schema";

const project:GeoProject={name:"Review",units:["Sand","Clay"].map(id=>({id,name:id,color:"#888888"})),
  boreholes:[{id:"B,1",x:10,y:10,z:10,intervals:[{unit:"Sand",from:0,to:2},{unit:"Clay",from:2,to:4},
    {unit:"Sand",from:4,to:6,name:"coarse \"sand\""}]}]};
const template=toBedReviewCsv(project);
function review(bed="Lower sand",rank="3",reason="Logged below clay,\nconfirmed on sheet 2."){
  const rows=parseCsv(template); rows[3].splice(7,3,bed,rank,reason); return toCsv(rows);
}

describe("reviewed bed worksheet import",()=>{
  it("exports every occurrence with a blank decision and imports a blank worksheet as a no-op",()=>{
    expect(readBedReviewCsv(template)).toEqual([]);
    expect(parseCsv(template).slice(1).map(r=>r.slice(0,5))).toEqual([
      ["B,1","0","2","Sand","Sand"],["B,1","2","4","Clay","Clay"],["B,1","4","6","Sand","Sand"]]);
    expect(importFiles([{name:"review.csv",text:template}],project).project).toBe(project);
    expect(isBedReviewCsv('hole_id,from,to,unit\nB,0,1,Sand')).toBe(false);
    expect(isBedReviewCsv(toProjectJson(project))).toBe(false);
  });
  it("applies only the reviewed interval through importFiles and keeps its original material after JSON export",()=>{
    const file={name:"review.csv",text:review()};
    const applied=importFiles([file],project).project;
    expect(applied.boreholes[0].intervals.map(i=>i.unit)).toEqual(["Sand","Clay","Lower sand"]);
    expect(applied.units.at(-1)).toMatchObject({id:"Lower sand",materialId:"Sand"});
    const reopened=importFiles([{name:"reviewed.json",text:toProjectJson(applied)}]).project;
    expect(importFiles([file],reopened).project).toBe(reopened);
    expect(reopened.bedAssignments?.[0].rationale).toBe('Logged below clay,\nconfirmed on sheet 2.');
  });
  it("refuses incomplete, reserved or malformed decisions, conflicting files and a missing source project",()=>{
    for(const file of [review(""),review("Lower sand","0"),review("Lower sand","3",""),review("unresolved"),
      review().replace("4,6,Sand",",6,Sand"),review().replace('"Logged below clay,','"unterminated"text,'),
      review().replace(/\n$/,',unexpected\n'),review().replace('from,to','from,from')])expect(()=>readBedReviewCsv(file)).toThrow();
    const file={name:"review.csv",text:review()};
    expect(()=>importFiles([file])).toThrow(/source project/);
    expect(()=>importFiles([file,{name:"case.json",text:toProjectJson(project)}],project)).toThrow(/on its own/);
  });
});
