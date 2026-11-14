import {test,expect,Page} from "@playwright/test";
import {existsSync,readFileSync,writeFileSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {downloadJson,importJson,openInput,prepare,saved} from "./helpers";

const appVersion=JSON.parse(readFileSync(resolve("package.json"),"utf8")).version as string;
function csvRows(text:string){
  const rows:string[][]=[],row:string[]=[];let field="",quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++}else quoted=!quoted}
    else if(c===","&&!quoted){row.push(field);field=""}
    else if((c==="\n"||c==="\r")&&!quoted){row.push(field);rows.push([...row]);row.length=0;field="";if(c==="\r"&&text[i+1]==="\n")i++}
    else field+=c;
  }
  if(field||row.length){row.push(field);rows.push(row)}
  const [header,...body]=rows;return body.map(row=>Object.fromEntries(row.map((value,i)=>[header[i],value])));
}

// Four equally weighted hypotheses encode two independent binary observations at the alignment endpoints.
// A fixed, supplied margin keeps withheld collars within the training model's footprint; it does not make
// those collars training observations. The reference contact is planar, giving a hand-checkable q=0.
async function fixture(page:Page,small=false){
  return page.evaluate(async small=>{
    const wm="/src/workspace.ts",tm="/src/tables.ts",w=await import(wm),t=await import(tm),size=small?2:8;
    const positions=Array.from({length:size*size},(_,i)=>({x:140*(i%size)/(size-1),y:140*Math.floor(i/size)/(size-1)}));
    const projects=Array.from({length:4},(_,caseIndex)=>({name:`Contact hypothesis ${caseIndex+1}`,crs:"Local survey grid",base:-5,margin:50,groundwaterDepth:2,
      units:[{id:"fill",name:"Made ground",color:"#9a5b4f"},{id:"sand",name:"River sand",color:"#d9b871"}],
      boreholes:positions.map(({x,y},i)=>{
        const contact=[4,4+4*x/140,8-4*x/140,8][caseIndex];
        return {id:`BH-${String(i+1).padStart(2,"0")}`,x,y,z:10,depth:12,intervals:[{from:0,to:10-contact,unit:"fill"},{from:10-contact,to:12,unit:"sand"}]};
      }),
      alignments:[{name:"Information corridor",points:[{x:0,y:70,chainage:1000},{x:140,y:70,chainage:1140}],design:[{chainage:1000,top:7,bottom:5},{chainage:1140,top:7,bottom:5}]}]}));
    let doc=w.createWorkspace(t.tablesFromProject(projects[0]),projects[0]);doc=w.checkpoint(doc,projects[0],"Reference contact hypothesis");
    const referenceId=doc.activeRevisionId;
    doc=w.updateDraft(doc,t.tablesFromProject({...projects[0],name:"Unfinished reference draft"}),projects[0]);
    for(let i=1;i<projects.length;i++){
      doc=w.createScenario(doc,`Contact case ${i+1}`,referenceId);
      doc=w.updateDraft(doc,t.tablesFromProject(projects[i]),projects[i]);doc=w.checkpoint(doc,projects[i],`Saved contact hypothesis ${i+1}`);
      doc=w.updateDraft(doc,t.tablesFromProject({...projects[i],name:`Unfinished case ${i+1} draft`}),projects[i]);
    }
    return JSON.parse(w.toWorkspaceJson(doc));
  },small);
}

async function load(page:Page,small=false){
  await prepare(page);await page.goto("/?backend=webgl#input");await openInput(page);
  const document=await fixture(page,small);await importJson(page,document);await saved(page);return document;
}
async function analysis(page:Page,document:any,calibrate=true){
  await page.locator('[data-step="scenarios"]').click();await page.locator(".ws-disagreement").click();
  const dialog=page.getByRole("dialog",{name:"Model disagreement",exact:true});await expect(dialog).toBeVisible();
  await dialog.locator(".disagreement-reference").selectOption(document.revisions[0].id);
  await dialog.locator(".disagreement-alternatives").selectOption(document.revisions.slice(1).map((r:any)=>r.id));
  await dialog.locator(".disagreement-surface").selectOption("sand");await dialog.locator(".disagreement-mode").selectOption("alignment");
  await dialog.locator(".disagreement-grid").fill("5");await dialog.locator(".disagreement-step").fill("70");await dialog.locator(".disagreement-holdouts").fill("1");
  if(calibrate){await dialog.locator(".disagreement-calibrate").check();await dialog.locator(".disagreement-coverage").selectOption("0.9");await dialog.locator(".disagreement-seed").fill("1729")}
  await dialog.locator(".disagreement-run").click();await expect(dialog.locator(".disagreement-json")).toBeEnabled();return dialog;
}
async function downloadText(page:Page,selector:string){
  const pending=page.waitForEvent("download");await page.locator(selector).click();const file=await pending,path=await file.path();expect(path).not.toBeNull();
  return readFile(path!,"utf8");
}
async function archive(page:Page){return JSON.parse(await downloadText(page,".disagreement-json"))}
async function informationPlan(page:Page,dialog:ReturnType<Page["getByRole"]>,money="1000"){
  await dialog.locator(".disagreement-plan").click();const planner=page.getByRole("dialog",{name:"Investigation planner",exact:true});await expect(planner).toBeVisible();
  await planner.locator(".planner-information").check();await expect(planner.locator(".planner-disagreement")).not.toBeChecked();
  await planner.locator(".planner-budget").fill("5");await planner.locator(".planner-spacing").fill("0");await planner.locator(".planner-step").fill("70");
  await planner.locator(".planner-money-budget").fill(money);await planner.locator(".planner-fixed-cost").fill("100");await planner.locator(".planner-cost-metre").fill("10");
  await planner.locator(".planner-resolution").fill("5");await planner.locator(".planner-bin-origin").fill("0");await planner.locator(".planner-contact-buffer").fill("1");
  await planner.locator(".planner-run").click();await expect(planner.locator(".planner-json")).toBeEnabled();return planner;
}
async function plan(page:Page){return JSON.parse(await downloadText(page,".planner-json"))}
async function expectPreserved(page:Page,document:any){
  await page.keyboard.press("Escape");await expect(page.locator(".ws-disagreement")).toBeFocused();
  const savedDocument:any=await downloadJson(page);expect(savedDocument.revisions).toEqual(document.revisions);expect(savedDocument.draft).toEqual(document.draft);expect(savedDocument.scenarios).toEqual(document.scenarios);
}

test("calibrated contact intervals separate training, calibration and independent audit observations",async({page},testInfo)=>{
  test.setTimeout(120_000);const document=await load(page);writeFileSync(testInfo.outputPath("calibrated-workspace.json"),JSON.stringify(document,null,2)+"\n");
  const dialog=await analysis(page,document);
  await expect(page.locator(".title span")).toHaveText(appVersion);await expect(dialog.locator(".disagreement-calibration-map svg")).toBeVisible();
  await expect(dialog.locator(".disagreement-calibration-section svg")).toBeVisible();await expect(dialog.locator(".disagreement-calibration-csv")).toBeEnabled();
  const output=await archive(page),c=output.calibration;expect(c).toBeDefined();expect(c.options.coverage).toBe(.9);expect(c.options.seed).toBe(1729);
  expect(c.partition.groups).toHaveLength(64);expect(c.partition.trainingCount+c.partition.calibrationCount+c.partition.auditCount).toBe(64);
  expect(new Set(c.partition.groups.map((g:any)=>g.id)).size).toBe(64);expect(c.partition.calibrationCount).toBeGreaterThanOrEqual(9);expect(c.partition.auditCount).toBeGreaterThan(0);
  const roles=new Map(c.partition.groups.map((g:any)=>[g.id,g.role]));expect(c.rows.every((row:any)=>roles.get(row.groupId)===row.role)).toBe(true);
  expect(c.rows.every((row:any)=>row.role!=="training")).toBe(true);expect(c.quantile).toBeCloseTo(0,8);
  expect(c.rank).toBe(Math.ceil((c.nCalibration+1)*.9));expect(c.finiteCalibration).toBe(c.nCalibration);
  for(const removal of c.partition.removals){expect(removal.boreholeIds).toHaveLength(c.partition.calibrationCount+c.partition.auditCount);expect(removal.remainingBoreholes).toBe(c.partition.trainingCount)}
  expect(c.report.cases.map((item:any)=>item.id)).toEqual(document.revisions.map((r:any)=>r.id));
  expect(c.notes.join(" ")).toMatch(/exchangeab/i);expect(output.report.grid.points.some((p:any)=>p.complete)).toBe(true);
  const csv=csvRows(await downloadText(page,".disagreement-calibration-csv"));expect(csv).not.toHaveLength(0);
  expect(csv[0].record_type).toBe("metadata");expect(JSON.parse(csv[0].partition)).toEqual(c.partition);expect(JSON.parse(csv[0].review_notes)).toEqual(c.notes);
  expect(csv.filter(row=>row.partition)).toHaveLength(1);expect(csv.filter(row=>row.review_notes)).toHaveLength(1);
  expect(csv.filter(row=>row.record_type==="calibration")).toHaveLength(c.nCalibration);expect(csv.filter(row=>row.record_type==="audit")).toHaveLength(c.partition.auditCount);
  for(const row of csv){expect(row.split_seed).toBe("1729");expect(Number(row.target_coverage)).toBe(.9);expect(Number(row.expansion_m)).toBeCloseTo(c.quantile,8);expect(JSON.parse(row.case_ids)).toEqual(document.revisions.map((r:any)=>r.id));expect(row.engine_version).toBe(appVersion)}
  expect(c.audit.all.nTotal).toBe(c.partition.auditCount);expect(c.audit.all.nCovered).toBe(c.rows.filter((row:any)=>row.role==="audit"&&row.covered).length);
  for(const sample of c.intervals.path.filter((sample:any)=>sample.complete)){expect(sample.lower).toBeCloseTo(sample.baseMin-c.quantile,8);expect(sample.upper).toBeCloseTo(sample.baseMax+c.quantile,8)}
  await dialog.locator(".disagreement-calibration h3").evaluate(el=>el.scrollIntoView({block:"start"}));await page.screenshot({path:testInfo.outputPath("calibrated-contact-desktop.png"),fullPage:true});
  await dialog.locator(".disagreement-seed").fill("1730");await expect(dialog.locator(".disagreement-json")).toBeDisabled();await expect(dialog.locator(".disagreement-calibration-csv")).toBeDisabled();
  await dialog.locator(".disagreement-run").focus();
  await dialog.locator(".disagreement-run").evaluate((button:HTMLButtonElement)=>{button.click();globalThis.document.querySelector<HTMLButtonElement>(".disagreement-cancel")!.click()});
  await expect(dialog.locator(".disagreement-status")).toContainText(/cancel/i);await expect(dialog.locator(".disagreement-calibration-csv")).toBeDisabled();
  await expectPreserved(page,document);
});

test("cost-aware investigation gains two conditional bits and stops spending on redundant observations",async({page},testInfo)=>{
  test.setTimeout(120_000);const document=await load(page),dialog=await analysis(page,document,false),planner=await informationPlan(page,dialog),p=await plan(page);
  expect(p.options.information).toMatchObject({resolution:5,origin:0,moneyBudget:1000,fixedCost:100,costPerMetre:10,contactBuffer:1});
  expect(p.proposals).toHaveLength(2);expect(p.summary.priorEntropyBits).toBeCloseTo(2,8);expect(p.summary.cumulativeInformationBits).toBeCloseTo(2,8);
  expect(p.summary.totalCost).toBeCloseTo(340,6);expect(p.summary.unspentBudget).toBeCloseTo(660,6);expect(p.summary.stopReason).toBe("no-information");
  expect(p.proposals.map((site:any)=>Math.round(site.x)).sort((a:number,b:number)=>a-b)).toEqual([0,140]);
  for(const site of p.proposals){expect(site.information.expectedGainBits).toBeCloseTo(1,8);expect(site.information.estimatedCost).toBeCloseTo(170,6);expect(site.information.requiredContactDepth).toBeCloseTo(7,6);expect(site.proposedDepth).toBeGreaterThanOrEqual(site.information.requiredContactDepth);expect(site.information.remainingBudget).toBeGreaterThanOrEqual(0)}
  expect(p.options.disagreementContext).toBeUndefined();expect(p.disagreement.caseIds).toEqual(document.revisions.map((r:any)=>r.id));
  expect(p.notes.join(" ")).toMatch(/noiseless|measurement noise/i);expect(p.notes.join(" ")).toMatch(/greed/i);
  const csv=csvRows(await downloadText(page,".planner-csv"));expect(csv).toHaveLength(2);
  for(const row of csv){expect(row.ranking_method).toBe("expected-information-per-cost");expect(row.information_model).toBe("finite-case-noiseless-contact-bins");expect(Number(row.expected_conditional_information_bits)).toBeCloseTo(1,8);expect(Number(row.estimated_cost)).toBeCloseTo(170,6);expect(Number(row.contact_reaching_depth_m)).toBeCloseTo(7,6);expect(Number(row.total_estimated_cost)).toBeCloseTo(340,6);expect(Number(row.observation_resolution_m)).toBe(5);expect(JSON.parse(row.disagreement_case_ids)).toEqual(document.revisions.map((r:any)=>r.id))}
  await planner.locator(".planner-economic-summary").evaluate(el=>el.scrollIntoView({block:"start"}));await page.screenshot({path:testInfo.outputPath("information-cost-planner-desktop.png"),fullPage:true});
  await planner.locator(".planner-sites").scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("information-cost-planner-proposals.png"),fullPage:true});
  await planner.locator(".planner-money-budget").fill("169");await expect(planner.locator(".planner-json")).toBeDisabled();
  await planner.locator(".planner-run").click();await expect(planner.locator(".planner-json")).toBeEnabled();const insufficient=await plan(page);
  expect(insufficient.proposals).toHaveLength(0);expect(insufficient.summary.totalCost).toBe(0);expect(insufficient.summary.unspentBudget).toBe(169);expect(insufficient.summary.stopReason).toBe("money-budget");
  await planner.locator(".planner-resolution").fill("0");await planner.locator(".planner-run").click();await expect(planner.locator(".planner-error")).toBeVisible();await expect(planner.locator(".planner-json")).toBeDisabled();
  await expectPreserved(page,document);
});

test("calibration reports an unavailable finite interval when calibration observations are insufficient",async({page})=>{
  test.setTimeout(120_000);const document=await load(page,true),dialog=await analysis(page,document),output=await archive(page),c=output.calibration;
  expect(c.quantile).toBeUndefined();expect(c.rank).toBeGreaterThan(c.nCalibration);expect(c.unavailableReason).toMatch(/finite|calibration|rank|sample/i);
  await expect(dialog.locator(".disagreement-calibration-unavailable")).toBeVisible();await expect(dialog.locator(".disagreement-json")).toBeEnabled();
  expect(c.intervals.grid.every((p:any)=>p.lower===undefined&&p.upper===undefined)).toBe(true);await expectPreserved(page,document);
});

test("mobile calibrated workflow keeps intervals and cost planning inside the dialog with keyboard access",async({page},testInfo)=>{
  test.setTimeout(120_000);const document=await load(page),dialog=await analysis(page,document);
  await expect(dialog.locator(".disagreement-calibration-map svg")).toBeVisible();expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  for(let i=0;i<20;i++){await page.keyboard.press("Tab");expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true)}
  await dialog.locator(".disagreement-calibration h3").evaluate(el=>el.scrollIntoView({block:"start"}));await page.screenshot({path:testInfo.outputPath("calibrated-contact-mobile.png"),fullPage:true});
  const planner=await informationPlan(page,dialog,"340");expect(await planner.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  const p=await plan(page);expect(p.summary.totalCost).toBeLessThanOrEqual(340);expect(p.summary.cumulativeInformationBits).toBeCloseTo(2,8);
  for(let i=0;i<26;i++){await page.keyboard.press("Tab");expect(await planner.evaluate(el=>el.contains(document.activeElement))).toBe(true)}
  await planner.locator(".planner-economic-summary").evaluate(el=>el.scrollIntoView({block:"start"}));await page.screenshot({path:testInfo.outputPath("information-cost-planner-mobile.png"),fullPage:true});await expectPreserved(page,document);
});

test("standalone calibrated workflow computes intervals and priced information plans without networking",async({page,context},testInfo)=>{
  test.setTimeout(120_000);await prepare(page);await page.goto("/?backend=webgl#input");const document=await fixture(page),filename=resolve("dist/geomodel3d-offline.html");
  expect(existsSync(filename),"Build the standalone HTML before browser validation").toBe(true);const html=readFileSync(filename,"utf8"),errors:string[]=[];
  await page.route("**/*",route=>route.request().isNavigationRequest()?route.fulfill({status:200,contentType:"text/html",body:html}):route.abort());await context.setOffline(true);
  page.on("pageerror",error=>errors.push(error.message));await page.goto("http://127.0.0.1:4173/standalone-calibrated.html?backend=webgl#input");
  await openInput(page);await importJson(page,document);await saved(page);await expect(page.locator(".title span")).toHaveText(appVersion);
  const dialog=await analysis(page,document),output=await archive(page);expect(output.calibration.quantile).toBeCloseTo(0,8);await expect(dialog.locator(".disagreement-calibration-map svg")).toBeVisible();
  const planner=await informationPlan(page,dialog),p=await plan(page);expect(p.proposals).toHaveLength(2);expect(p.summary.cumulativeInformationBits).toBeCloseTo(2,8);expect(p.summary.totalCost).toBeCloseTo(340,6);
  await planner.locator(".planner-economic-summary").evaluate(el=>el.scrollIntoView({block:"start"}));await page.screenshot({path:testInfo.outputPath("information-cost-planner-offline.png"),fullPage:true});expect(errors).toEqual([]);await expectPreserved(page,document);
});
