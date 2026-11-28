import {describe,expect,it} from "vitest";
import {indexReportPage,initialPageSelection,needsPageSelection,recordPageAssessment} from "../src/docread/pageSelectionIndex";
import {reportPageExcerpts} from "../src/docread/reportQwen";

describe("local report page index",()=>{
  const log=(n:number)=>indexReportPage(n,["BOREHOLE LOG BH-01","Depth (m)","Description of strata","0.0 2.0 4.0 7.0","Grey clay over sand"]);
  const schedule=indexReportPage(2,["Table 3. Borehole locations","Borehole ID","Easting","Northing","BH-01 523351 181002","BH-03 525000 181222"]);
  it("identifies logs and coordinate schedules while keeping opaque and partial continuation sheets selected",()=>{
    const contents=indexReportPage(1,["Contents","1 Borehole locations ........ 10","2 Borehole logs ......... 22","Appendix 3"]);
    const uncertain=indexReportPage(4,["BH-01 continued from the previous sheet","Blue grey silty sand below gravel"]);
    const scan=indexReportPage(5,[]);
    const pages=[contents,schedule,log(3),uncertain,scan];
    expect(pages.map(p=>p.role)).toEqual(["report","schedule","log","unknown","scan"]);
    expect(needsPageSelection(pages)).toBe(true);
    expect([...initialPageSelection(pages)]).toEqual([2,3,4,5]);
    expect(schedule.lines.join(" ")).toContain("BH-01 523351 181002");
    expect(scan.lines).toEqual([]);
  });
  it("fast-tracks log-only PDFs and prompts before OCR of unclassified multipage scans",()=>{
    expect(needsPageSelection([log(1),log(2)])).toBe(false);
    const scan=indexReportPage(1,[]);
    expect(needsPageSelection([scan])).toBe(false);
    expect(needsPageSelection([scan,indexReportPage(2,[])])).toBe(true);
  });
  it("keeps interpreted Dutch formation tables out of the measured-log fast path",()=>{
    const interpreted=["DOV Boorrapport","Informele stratigrafie - 15/11/1969","Van(m) Tot(m) Beschrijving",
      "0.00 3.25 Quartair","3.25 8.25 Tertiair - Scaldisiaan","8.25 22.75 Tertiair - Antwerpiaan"];
    const appendix=indexReportPage(2,interpreted),measured=indexReportPage(1,[...interpreted,"Lithologische beschrijving","0.0 0.50 bruine zandhoudende klei"]);
    expect([measured.role,appendix.role]).toEqual(["log","interpreted"]);
    expect(needsPageSelection([measured,appendix])).toBe(true);
    expect([...initialPageSelection([measured,appendix])]).toEqual([1]);
  });
  it("applies each completed evidence question independently and preserves unasked questions",()=>{
    const collar=recordPageAssessment(undefined,"schedule","schedule");
    expect(collar).toEqual({schedule:true});
    const layers=recordPageAssessment(collar,"log","log");
    expect(layers).toEqual({log:true,schedule:true});
    expect(recordPageAssessment(layers,"log","other")).toEqual({log:false,schedule:true});
    expect(recordPageAssessment(layers,"both","other")).toEqual({log:false,schedule:false});
    expect(collar).toEqual({schedule:true});
  });
  it("keeps datum and groundwater context even where a long page otherwise looks like prose",()=>{
    const narrative=Array(6).fill("These measurements were made in the field as part of the site investigation.");
    const survey=indexReportPage(3,[...narrative,"The vertical datum is NAVD 88."]);
    const water=indexReportPage(4,[...narrative,"Water-level measurements at BH-03 were taken three days after drilling."]);
    expect([survey.role,water.role]).toEqual(["datum","water"]);
    expect([...initialPageSelection([survey,water])]).toEqual([3,4]);
  });
  it("labels proposed coordinates explicitly while allowing review of other evidence on the same page",()=>{
    const page=indexReportPage(4,["Borehole locations","Planned eastings and northings below",
      "Planned easting (m)","Planned northing (m)","BH-01 523351 181002","BH-03 525000 181222"]);
    expect(page.role).toBe("planned");
    expect(page.excerpt).toMatch(/planned easting/i);
    expect(initialPageSelection([page]).has(4)).toBe(true);
  });
  it("passes the indexed field/value window to Qwen without a second lossy sampling step",()=>{
    const prose=Array.from({length:55},(_,i)=>`Field work paragraph ${i+1} describes access and construction activities.`);
    const location=["As-drilled collar","Hole ID BH-12","Longitude (WGS84) 18.423617","Latitude (WGS84) -33.925429"];
    const p=indexReportPage(6,[...prose,...location,...prose]);
    const [{text}]=reportPageExcerpts([p]);
    expect(text).toBe(p.lines.join("\n"));
    expect(text).toContain(location.join("\n"));
    expect(text.length).toBeLessThan(prose.join("\n").length);
  });
});
