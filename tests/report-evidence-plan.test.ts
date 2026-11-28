import {expect,it} from "vitest";
import {likelyEvidencePages} from "../src/docread/reportEvidencePlan";
import type {IndexedReportPage,PageRole} from "../src/docread/pageSelectionIndex";

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
