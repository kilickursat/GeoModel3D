import {describe,expect,it} from "vitest";
import type {CorePiece,CoreRow,CoreRun} from "../src/corePhoto";
import type {Interval} from "../src/schema";
import {buildCoreDepthLog,coreDepthLogCsv} from "../src/coreDepthLog";
import {parseCsv} from "../src/io";

const piece=(id:string,end:number,unit:string,breakAfter:CorePiece["breakAfter"]="natural"):CorePiece=>({id,end,unit,breakAfter,sound:"sound",description:`Description ${id}`});
const row=(id:string,from:number,to:number,pieces:CorePiece[],direction:CoreRow["direction"]="ltr"):CoreRow=>({id,from,to,pieces,direction,registrationReviewed:true,box:{x0:.1,y0:.2,x1:.9,y1:.4}});
function run():CoreRun{return {id:"run",boreholeId:"BH-01",sourceId:"photo",from:0,to:4,status:"draft",lossReviewed:false,
  rows:[row("late",2,3.5,[piece("c",2.5,"B"),piece("d",3.5,"A","end")],"rtl"),row("early",.5,1.5,[piece("a",1,"A"),piece("b",1.5,"B","end")])]}}
const intervals:Interval[]=[{from:0,to:1,unit:"A"},{from:1,to:2.5,unit:"B"},{from:2.5,to:3.2,unit:"A"},{from:3.2,to:4,unit:"B",name:"Current interpretation",evidenceId:"log-evidence"}];
const units=new Set(["A","B"]);
const source={sourceId:"photo",sourceName:"Source.png",sourceSha256:"a".repeat(64)};
function freeze<T>(value:T):T{if(value&&typeof value==="object"){Object.freeze(value);Object.values(value).forEach(freeze)}return value}

describe("registered core depth-log comparison",()=>{
  it("orders rows by depth and splits exact photo/log boundaries while preserving every gap",()=>{
    const result=buildCoreDepthLog(run(),[...intervals].reverse(),units);
    expect(result.segments.map(s=>[s.from,s.to,s.photoState,s.comparison])).toEqual([
      [0,.5,"unrepresented","no-photo"],[.5,1,"piece","same-unit"],[1,1.5,"piece","same-unit"],[1.5,2,"unrepresented","no-photo"],
      [2,2.5,"piece","same-unit"],[2.5,3.2,"piece","same-unit"],[3.2,3.5,"piece","different-unit"],[3.5,4,"unrepresented","no-photo"]
    ]);
    expect(result.summary.runLength).toBe(4);expect(result.summary.registeredLength).toBe(2.5);expect(result.summary.unrepresentedLength).toBe(1.5);
    expect(result.summary.sameUnitLength).toBeCloseTo(2.2);expect(result.summary.differentUnitLength).toBeCloseTo(.3);expect(result.summary.unassessedLength).toBe(1.5);
  });
  it("maps RTL subintervals to exact source boxes without creating a fracture at a current-log boundary",()=>{
    const result=buildCoreDepthLog(run(),intervals,units),first=result.segments[5],second=result.segments[6];
    expect(first.photo).toMatchObject({rowId:"late",pieceId:"d",from:2.5,to:3.2,pieceFrom:2.5,pieceTo:3.5,breakAfter:"end",endsPiece:false,direction:"rtl"});
    expect(second.photo).toMatchObject({from:3.2,to:3.5,pieceFrom:2.5,pieceTo:3.5,endsPiece:true});
    expect(second.photo!.box.x0).toBeCloseTo(.1,12);expect(second.photo!.box.x1).toBeCloseTo(.26,12);
    expect(first.photo!.box.x0).toBeCloseTo(second.photo!.box.x1,12);expect(first.photo!.box.x1).toBeCloseTo(.1+.8*(1-.5/1.5),12);
    expect(second.currentLog).toEqual({from:3.2,to:3.5,originalFrom:3.2,originalTo:4,unit:"B",name:"Current interpretation",evidenceId:"log-evidence"});
  });
  it("distinguishes an empty registered row from unrepresented and reviewed-missing depth",()=>{
    const value=run();value.rows=[row("empty",1,3,[])];
    const draft=buildCoreDepthLog(value,[{from:0,to:4,unit:"A"}],units);
    expect(draft.segments.map(s=>[s.photoState,s.comparison])).toEqual([["unrepresented","no-photo"],["registered-unannotated","photo-unassigned"],["unrepresented","no-photo"]]);
    expect(draft.segments[1].photo).toMatchObject({rowId:"empty",unit:"",sound:"unknown",breakAfter:"unknown"});
    expect(draft.segments[1].photo).not.toHaveProperty("pieceId");expect(draft.summary.registeredLength).toBe(2);
    value.rows=[];value.lossReviewed=true;
    const empty=buildCoreDepthLog(value,[],units);
    expect(empty.segments).toEqual([{from:0,to:4,length:4,photoState:"reviewed-missing",currentLogCount:0,comparison:"no-photo"}]);
    expect(empty.summary).toEqual({runLength:4,registeredLength:0,unrepresentedLength:4,sameUnitLength:0,differentUnitLength:0,unassessedLength:4});
  });
  it("clips current intervals to the run and treats touching interval ends as a single interpretation",()=>{
    const value=run();value.from=1;value.to=3;value.rows=[row("r",1,3,[piece("p",3,"A","end")])];
    const result=buildCoreDepthLog(value,[{from:0,to:2,unit:"A"},{from:2,to:5,unit:"B"},{from:10,to:12,unit:"A"}],units);
    expect(result.segments.map(s=>[s.from,s.to,s.currentLogCount,s.comparison])).toEqual([[1,2,1,"same-unit"],[2,3,1,"different-unit"]]);
    expect(result.segments.map(s=>[s.currentLog!.originalFrom,s.currentLog!.originalTo])).toEqual([[0,2],[2,5]]);
    expect(result.segments[0].photo!.endsPiece).toBe(false);expect(result.segments[1].photo!.endsPiece).toBe(true);
  });
  it("keeps overlapping current logs ambiguous, including identical unit labels",()=>{
    const value=run();value.rows=[row("r",0,4,[piece("p",4,"A","end")])];
    const result=buildCoreDepthLog(value,[{from:0,to:3,unit:"A"},{from:1,to:4,unit:"A"}],units);
    expect(result.segments.map(s=>[s.from,s.to,s.currentLogCount,s.comparison])).toEqual([[0,1,1,"same-unit"],[1,3,2,"ambiguous-current-log"],[3,4,1,"same-unit"]]);
    expect(result.segments[1].currentLog).toBeUndefined();expect(result.summary.sameUnitLength).toBe(2);expect(result.summary.unassessedLength).toBe(2);
    const duplicates=buildCoreDepthLog(value,[{from:0,to:4,unit:"A"},{from:0,to:4,unit:"A"}],units);
    expect(duplicates.segments[0]).toMatchObject({currentLogCount:2,comparison:"ambiguous-current-log"});expect(duplicates.segments[0].currentLog).toBeUndefined();
  });
  it("does not compare blank or catalogue-missing units, and matches IDs exactly",()=>{
    const value=run();value.rows=[row("r",0,4,[piece("p",4,"A","end")])];
    const one=(photoUnit:string,currentUnit:string,known:ReadonlySet<string>|undefined=units)=>{
      value.rows[0].pieces[0].unit=photoUnit;
      return buildCoreDepthLog(value,[{from:0,to:4,unit:currentUnit}],known).segments[0].comparison;
    };
    expect(one(" ","A")).toBe("photo-unassigned");expect(one("A","\t")).toBe("current-unassigned");
    expect(one("absent","absent")).toBe("photo-unit-missing");expect(one("A","absent")).toBe("current-unit-missing");
    expect(one("A","a",new Set(["A","a"]))).toBe("different-unit");expect(one("A ","A",new Set(["A ","A"]))).toBe("different-unit");
    value.rows[0].pieces[0].unit="absent";
    expect(buildCoreDepthLog(value,[{from:0,to:4,unit:"absent"}]).segments[0].comparison).toBe("same-unit");
    expect(buildCoreDepthLog(value,[],units).segments[0].comparison).toBe("no-current-log");
  });
  it("preserves accepted annotation provenance when the current log changes without mutating either input",()=>{
    const value=run();value.status="accepted";value.lossReviewed=true;value.reviewedBy="Reviewer";value.acceptedAt="2026-11-15T00:00:00.000Z";value.reviewEvidenceId="accepted-review";
    const original=structuredClone(value),logs=structuredClone(intervals);freeze(value);freeze(logs);
    const result=buildCoreDepthLog(value,logs,units);
    expect(result).toMatchObject({runId:"run",boreholeId:"BH-01",sourceId:"photo",status:"accepted",reviewedBy:"Reviewer",acceptedAt:value.acceptedAt,reviewEvidenceId:"accepted-review",lossReviewed:true});
    expect(result.segments[6].comparison).toBe("different-unit");expect(result.segments[6].photo!.unit).toBe("A");expect(result.segments[6].currentLog!.unit).toBe("B");
    result.segments[6].photo!.box.x0=0;result.segments[6].photo!.unit="mutated output";result.segments[6].currentLog!.unit="mutated output";
    expect(value).toEqual(original);expect(logs).toEqual(intervals);
  });
  it("rejects invalid depths, overlapping photos, broken piece coverage and oversized inputs",()=>{
    for(const edit of [(r:CoreRun)=>{r.from=NaN},(r:CoreRun)=>{r.to=Infinity},(r:CoreRun)=>{r.to=r.from},(r:CoreRun)=>{r.rows[0].from=-1},
      (r:CoreRun)=>{r.rows[0].from=1},(r:CoreRun)=>{r.rows[1].pieces[1].end=1.4},(r:CoreRun)=>{r.rows[0].box.x1=2},(r:CoreRun)=>{r.rows[0].id=r.rows[1].id}]){
      const value=run();edit(value);expect(()=>buildCoreDepthLog(value,intervals)).toThrow(/Cannot build the core depth log/);
    }
    expect(()=>buildCoreDepthLog(run(),[{from:0,to:NaN,unit:"A"}])).toThrow(/current log intervals/);
    expect(()=>buildCoreDepthLog(run(),[{from:1,to:1,unit:"A"}])).toThrow(/current log intervals/);
    expect(()=>buildCoreDepthLog({...run(),rows:[]},Array(100_001).fill({from:0,to:1,unit:"A"}))).toThrow(/too many/);
  });
  it("honours the importer's tiny boundary tolerance without bridging an actual positive row gap",()=>{
    const value:CoreRun={...run(),from:0,to:.6,rows:[row("r1",0,.1+.2,[piece("p1",.3,"A","natural")]),row("r2",.3,.6,[piece("p2",.6,"A","end")])]};
    const result=buildCoreDepthLog(value,[{from:0,to:.6,unit:"A"}],units);
    expect(result.summary.registeredLength).toBeCloseTo(.6,14);expect(result.summary.unrepresentedLength).toBe(0);
    value.rows[1].from=.3001;
    expect(buildCoreDepthLog(value,intervals,units).summary.unrepresentedLength).toBeCloseTo(.0001,12);
  });
  it("sweeps many overlapping logs without expanding their Cartesian product into the result",()=>{
    const value={...run(),rows:[]},logs=Array.from({length:5000},(_,i)=>({from:i/5000,to:3+i/5000,unit:"A"}));
    const result=buildCoreDepthLog(value,logs,units);
    expect(result.segments.length).toBe(10000);expect(Math.max(...result.segments.map(s=>s.currentLogCount))).toBe(5000);
    expect(result.segments.every(s=>s.currentLogCount<2||!s.currentLog)).toBe(true);
  });
});

describe("core depth-log CSV",()=>{
  it("exports full provenance, exact clipped boxes and original piece boundaries with blanks for unavailable values",()=>{
    const value=run(),log=buildCoreDepthLog(value,intervals,units),rows=parseCsv(coreDepthLogCsv(log,source)),header=rows[0],records=rows.slice(1).map(row=>Object.fromEntries(header.map((key,i)=>[key,row[i]])));
    expect(records).toHaveLength(log.segments.length);expect(rows.every(row=>row.length===header.length)).toBe(true);
    expect(records[6]).toMatchObject({run_id:"run",source_id:"photo",source_name:"Source.png",source_sha256:"a".repeat(64),run_status:"draft",run_loss_reviewed:"false",from_m:"3.2",to_m:"3.5",row_id:"late",piece_id:"d",photo_piece_from_m:"2.5",photo_piece_to_m:"3.5",photo_direction:"rtl",photo_piece_break_after:"end",segment_ends_piece:"true",current_log_original_to_m:"4",current_log_unit_id:"B",current_log_evidence_id:"log-evidence",comparison:"different-unit"});
    expect(Number(records[6].photo_box_x1)).toBeCloseTo(.26,12);expect(records[5].segment_ends_piece).toBe("false");
    expect(records[0]).toMatchObject({row_id:"",piece_id:"",photo_unit_id:"",photo_box_x0:"",segment_ends_piece:"",run_reviewed_by:"",run_accepted_at:"",comparison:"no-photo"});
    const ambiguous=parseCsv(coreDepthLogCsv(buildCoreDepthLog(value,[...intervals,...intervals],units),source));
    const first=Object.fromEntries(ambiguous[0].map((key,i)=>[key,ambiguous[1][i]]));
    expect(first).toMatchObject({current_log_count:"2",current_log_unit_id:"",current_log_from_m:"",comparison:"ambiguous-current-log"});
  });
  it("quotes literal commas, quotes and newlines and neutralizes spreadsheet formulas without exporting images",()=>{
    const value=run();value.boreholeId='=HYPERLINK("https://example.invalid")';value.rows[1].pieces[0].description='  @SUM(1,2)\nquoted "observation"';
    const csv=coreDepthLogCsv(buildCoreDepthLog(value,intervals,units),{sourceId:"photo",sourceName:"+source,\"name\".png"}),rows=parseCsv(csv),header=rows[0];
    expect(rows[1][header.indexOf("borehole_id")]).toBe("'"+value.boreholeId);expect(rows[1][header.indexOf("source_name")]).toBe("'+source,\"name\".png");
    expect(rows[2][header.indexOf("photo_description")]).toBe("'"+value.rows[1].pieces[0].description);
    expect(rows[1][header.indexOf("source_sha256")]).toBe("");expect(csv).not.toContain("data:image");
    expect(()=>coreDepthLogCsv(buildCoreDepthLog(value,intervals),{sourceId:"other",sourceName:"Incorrect source"})).toThrow(/does not match/);
  });
});
