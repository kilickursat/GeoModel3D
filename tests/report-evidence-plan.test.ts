import {expect,it} from "vitest";
import {likelyEvidencePages} from "../src/docread/reportEvidencePlan";
import {indexReportPage,type IndexedReportPage,type PageRole} from "../src/docread/pageSelectionIndex";
import {reportQuestionPassages} from "../src/docread/reportQwenExcerpt";

const page=(number:number,role:PageRole,...lines:string[]):IndexedReportPage=>({page:number,role,lines,excerpt:lines[0]??""});
const pages=[
  page(1,"report","Executive summary"),
  page(2,"schedule","Borehole location schedule"),
  page(3,"log","Borehole log","Easting (m) 314026","Northing (m) 6866950"),
  page(4,"report","Lithological description of the cores. Measured interval 1–7.2 m."),
  page(5,"planned","Planned latitude -28.31; planned longitude 145.103266","The actual site is nearby."),
  page(6,"scan"),
  page(7,"unknown","Water level observed 7 m below ground"),
];

it("shortlists evidence for the requested question and preserves original page identities",()=>{
  expect(likelyEvidencePages(pages,"both").map(p=>p.page)).toEqual([2,3,4]);
  expect(likelyEvidencePages(pages,"schedule").map(p=>p.page)).toEqual([2,3]);
  expect(likelyEvidencePages(pages,"log").map(p=>p.page)).toEqual([3,4]);
  expect(likelyEvidencePages(pages.slice(4),"both")).toEqual([]);
  const mixed=page(8,"planned","Planned northing 6866940","Surveyed collar coordinates","Easting 314026","Northing 6866950");
  expect(likelyEvidencePages([mixed],"schedule")).toEqual([mixed]);
});

const narrative=Array(35).fill("Field notes and documentation accompany this investigation.");
it("quotes a paired Lambert survey with its original hole name and coordinate quality",()=>{
  const fields=["Proefnummer: VL-39/R","X (m Lambert 2008):","713481,75 (afgelezen van kaart)",
    "Y (m Lambert 2008): 675321,25 (afgelezen van kaart)"];
  const p=indexReportPage(19,[...narrative,...fields,...narrative]);
  const {schedule}=reportQuestionPassages(p.lines);
  expect(schedule).toContain(fields.join("\n"));
  expect(likelyEvidencePages([p],"schedule")).toEqual([p]);
  expect(likelyEvidencePages([p],"log")).toEqual([]);
});

it("quotes split Japanese headers, DMS values and depth/soil records as printed",()=>{
  const labels=["孔番号 北 緯","現場位置 東 経"],coordinates=["SK-37 34度 18分 11.07秒","137度 32分 54.93秒"];
  const headers=["層","厚","(m)","深","度","(m)","土","質","区","分"];
  const records=["72.37 0.63 0.63","礫混じり","砂","(SG)","70.32 2.05 2.68","粘土","(C)"];
  const p=indexReportPage(11,["柱状図",...labels,...narrative,...coordinates,...headers,...narrative,...records,...narrative]);
  const q=reportQuestionPassages(p.lines);
  expect(q.schedule).toContain(labels.join("\n"));
  expect(q.schedule).toContain(coordinates.join("\n"));
  expect(q.log).toContain(headers.join("\n"));expect(q.log).toContain(records.join("\n"));
  expect(likelyEvidencePages([p],"schedule")).toEqual([p]);
  expect(likelyEvidencePages([p],"log")).toEqual([p]);
});

it("requires paired coordinate fields or a measured material record before widening the shortlist",()=>{
  const unrelated=page(9,"report","Laboratory repeatability trial","X (mm): 32378","Y (mm): 67532","Lambert reference in bibliography",
    "表面試験","北 緯 東 経","40度11分03秒","土質 深度 (m)","20.25 35.25 60.75","温度変化");
  const partial=page(13,"report","Proefnummer: VL-48","X (mLambert): 125348","Y (mm): 45000");
  for(const target of ["schedule","log","both"] as const)expect(likelyEvidencePages([unrelated,partial],target)).toEqual([]);
});
