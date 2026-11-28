import {test,expect,type Browser} from "@playwright/test";
import {prepare,openInput,saved,downloadJson} from "./helpers";
import type {GeoProject} from "../../src/schema";

// Create a native-text PDF in Chromium. The schedule and log have no shared page
// and the only geographic link is the printed hole identifier.
async function mixedReport(browser:Browser,duplicate:boolean){
  const sheet=await browser.newPage();
  try{
    await sheet.setContent(`<style>
      @page{size:A4;margin:20mm}body{font:12pt Arial}section{break-after:page}section:last-child{break-after:auto}
      table{width:100%;border-collapse:collapse}td,th{padding:6px;text-align:left}
      </style><section><h1>Executive summary</h1><p>Site investigation for an approach road. The field records follow.</p></section>
      <section><h2>Borehole location schedule</h2><table>
      <tr><th>Borehole ID</th><th>Easting (m)</th><th>Northing (m)</th><th>Ground level (m)</th></tr>
      <tr><td>BH-04</td><td>432100</td><td>5867100</td><td>42.5</td></tr>
      ${duplicate?"<tr><td>BH-04</td><td>432208</td><td>5867105</td><td>41.8</td></tr>":""}
      </table></section><section><h2>Borehole log</h2><p>Borehole No: BH-04</p>
      <table><colgroup><col style="width:11%"><col style="width:11%"><col></colgroup>
      <tr><th>From (m)</th><th>To (m)</th><th>Description</th></tr>
      <tr><td>0.00</td><td>2.00</td><td>Soft brown clay</td></tr><tr><td>2.00</td><td>6.00</td><td>Dense sand</td></tr></table></section>`);
    return await sheet.pdf({preferCSSPageSize:true});
  }finally{await sheet.close()}
}

for(const duplicate of [false,true])test(duplicate?"conflicting survey rows require a decision":"joins a schedule and log from separate source pages",async({browser,page})=>{
  test.setTimeout(90_000);
  const pdf=await mixedReport(browser,duplicate);
  await prepare(page);await page.goto("/?backend=webgl#input");await openInput(page);
  await page.locator(".pdf-file").setInputFiles({name:"investigation.pdf",mimeType:"application/pdf",buffer:pdf});
  await page.getByRole("button",{name:"Agree",exact:true}).click();
  const review=page.getByRole("dialog",{name:"Borehole logs read from documents"});
  await review.getByRole("button",{name:"Clear selection"}).click();
  await review.getByLabel("Read page 2",{exact:true}).check();
  await review.getByLabel("Read page 3",{exact:true}).check();
  await review.getByRole("button",{name:"Read selected pages"}).click();
  await expect(review.locator("#dr-f-id")).toHaveValue("BH-04");
  await expect(review.locator("#dr-f-x")).toHaveValue("");
  const schedule=review.getByRole("region",{name:"Collar schedule"});
  await expect(schedule.locator("[data-schedule-use]")).toHaveCount(duplicate?2:1);
  if(duplicate){
    await review.locator(".dr-use").click();
    await expect(review).toBeVisible();
    await expect(review.locator("#dr-f-x")).toHaveValue("");
  }
  const choice=duplicate?"1":"0";
  await schedule.locator(`[data-schedule-view="${choice}"]`).click();
  await expect(review.locator(".dr-pageno")).toContainText("Page 2");
  await schedule.locator(`[data-schedule-use="${choice}"]`).click();
  await expect(review.locator("#dr-f-x")).toHaveValue(duplicate?"432208":"432100");
  await review.locator(".dr-use").click();
  await expect(review).toHaveCount(0);
  await saved(page);
  const project=await downloadJson<GeoProject>(page,".ws-json");
  expect(project.boreholes).toHaveLength(1);
  const [hole]=project.boreholes;
  expect(hole).toMatchObject({id:"BH-04",x:duplicate?432208:432100,y:duplicate?5867105:5867100,z:duplicate?41.8:42.5});
  expect(hole.intervals.map(i=>[i.from,i.to])).toEqual([[0,2],[2,6]]);
  const evidence=project.evidence!;
  const fields=evidence.records.find(r=>r.id===hole.evidenceId)!.fields;
  expect(fields.id.boxes.map(b=>b.page)).toContain(3);
  expect(fields.x.boxes.map(b=>b.page)).toContain(2);
  expect(evidence.sources[0].pages.map(p=>p.page).sort()).toEqual([2,3]);
});
