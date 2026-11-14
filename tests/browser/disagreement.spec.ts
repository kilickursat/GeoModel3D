import {test,expect,Page,Dialog} from "@playwright/test";
import {existsSync,readFileSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {downloadJson,importJson,openInput,prepare,saved} from "./helpers";

const appVersion=JSON.parse(readFileSync(resolve("package.json"),"utf8")).version as string;
type Variant="outlier"|"flat"|"missing"|"grid";

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
  const [header,...body]=rows;
  return body.map(row=>Object.fromEntries(row.map((value,i)=>[header[i],value])));
}

// The reference's central contact is deliberately wrong relative to the surrounding planar logs. Removing the
// held-out BH alone would admit its formerly coincident CPT and leak the observed4m contact into the prediction.
async function fixture(page:Page,variant:Variant="outlier"){
  return page.evaluate(async variant=>{
    const wm="/src/workspace.ts",tm="/src/tables.ts",w=await import(wm),t=await import(tm);
    const top=(contact:number)=>[{from:0,to:10-contact,unit:"fill"},{from:10-contact,to:12,unit:"sand"}];
    const centre=variant==="outlier"?4:8;
    const before={name:"Reference interpretation",crs:"Local survey grid",base:-5,groundwaterDepth:2,
      units:[{id:"fill",name:"Made ground",color:"#9a5b4f"},{id:"sand",name:"River sand",color:"#d9b871"}],
      boreholes:[[0,0],[40,0],[40,40],[0,40],[20,20]].map(([x,y],i)=>({id:i===4?"BH-CENTRE":`BH-${i+1}`,x,y,z:10,depth:12,intervals:top(i===4?centre:8)})),
      cptLayers:true,cpts:[{id:"CPT-CENTRE",x:20,y:20,z:10,depth:[1,2],qc:[1,2],layersSource:"reviewed",layers:top(centre)}],
      alignments:[{name:"Validation corridor",points:[{x:0,y:20,chainage:1000},{x:40,y:20,chainage:1040}],design:[{chainage:1000,top:7,bottom:5},{chainage:1040,top:7,bottom:5}]}]};
    let doc=w.createWorkspace(t.tablesFromProject(before),before);doc=w.checkpoint(doc,before,"Reference before range review");
    doc=w.createScenario(doc,"Deep sand alternative",doc.activeRevisionId);
    const after:any=structuredClone(before);after.name="Alternative interpretation";
    after.boreholes.forEach((hole:any)=>{hole.intervals=top(6);if(variant==="missing")hole.x+=20});
    after.cpts[0].layers=top(6);if(variant==="missing")after.cpts[0].x+=20;
    if(variant==="grid")after.crs="Different local survey grid";
    doc=w.updateDraft(doc,t.tablesFromProject(after),after);doc=w.checkpoint(doc,after,"Alternative range review");
    return JSON.parse(w.toWorkspaceJson(doc));
  },variant);
}

async function openFixture(page:Page,variant:Variant="outlier"){
  await prepare(page);await page.goto("/?backend=webgl#input");await openInput(page);
  const document=await fixture(page,variant);await importJson(page,document);await expect(page.locator(".ws-history")).toBeVisible();await saved(page);
  return document;
}
async function replaceFixture(page:Page,document:unknown){
  const accept=(dialog:Dialog)=>dialog.accept();page.on("dialog",accept);
  try{await importJson(page,document);await expect(page.locator(".ws-history")).toBeVisible();await saved(page)}finally{page.off("dialog",accept)}
}
async function analysis(page:Page,document:any,run=true){
  await page.locator('[data-step="scenarios"]').click();
  await page.locator(".ws-compare-before").selectOption(document.revisions[0].id);await page.locator(".ws-compare-after").selectOption(document.activeRevisionId);
  await page.locator(".ws-disagreement").click();
  const dialog=page.getByRole("dialog",{name:"Model disagreement",exact:true});await expect(dialog).toBeVisible();
  await dialog.locator(".disagreement-reference").selectOption(document.revisions[0].id);
  await dialog.locator(".disagreement-alternatives").selectOption([document.activeRevisionId]);
  await dialog.locator(".disagreement-surface").selectOption("sand");await dialog.locator(".disagreement-mode").selectOption("alignment");
  await expect(dialog.locator(".disagreement-alignment")).toHaveValue("0");await expect(dialog.locator(".disagreement-alignment option:checked")).toHaveText("Validation corridor");
  await dialog.locator(".disagreement-grid").fill("5");await dialog.locator(".disagreement-step").fill("10");
  if(run)await dialog.locator(".disagreement-run").click();
  return dialog;
}
async function downloadText(page:Page,selector:string){
  const pending=page.waitForEvent("download");await page.locator(selector).click();const file=await pending,path=await file.path();expect(path).not.toBeNull();
  return {name:file.suggestedFilename(),text:await readFile(path!,"utf8")};
}
async function downloadRows(page:Page,selector:string){const file=await downloadText(page,selector);return {...file,rows:csvRows(file.text)}}

test("model disagreement samples ranges and validates held-out contacts without coincident-log leakage",async({page},testInfo)=>{
  test.setTimeout(90_000);
  const document=await openFixture(page),dialog=await analysis(page,document,false);
  await expect(page.locator(".title span")).toHaveText(appVersion);
  await dialog.locator(".disagreement-run").evaluate((button:HTMLButtonElement)=>{button.click();globalThis.document.querySelector<HTMLButtonElement>(".disagreement-cancel")!.click()});
  await expect(dialog.locator(".disagreement-status")).toContainText(/cancel/i);await expect(dialog.locator(".disagreement-csv")).toBeDisabled();
  const cancelled=await page.evaluate(async document=>{
    const module="/src/disagreementJob.ts",{createDisagreementJob}=await import(module);
    const cases=document.revisions.map((r:any)=>({id:r.id,project:r.project}));
    const job=createDisagreementJob(cases,{unitId:"sand",mode:"alignment",alignment:cases[0].project.alignments[0],gridSize:5,step:10,maxHoldouts:12});job.cancel();
    try{await job.result;return "resolved"}catch(error){return (error as Error).name}
  },document);
  expect(cancelled).toBe("AbortError");
  await dialog.locator(".disagreement-run").click();await expect(dialog.locator(".disagreement-csv")).toBeEnabled();
  await expect(dialog.locator(".disagreement-map svg")).toBeVisible();await expect(dialog.locator(".disagreement-section svg")).toBeVisible();
  const ranges=await downloadRows(page,".disagreement-csv"),corner=ranges.rows.find(row=>row.sample_type==="map"&&Number(row.x_m)===0&&Number(row.y_m)===0)!;
  expect(corner).toBeDefined();expect(corner.complete).toBe("true");expect(Number(corner.min_elevation_m)).toBeCloseTo(6,6);expect(Number(corner.max_elevation_m)).toBeCloseTo(8,6);
  expect(Number(corner.range_width_m)).toBeCloseTo(2,6);expect(corner.engine_version).toBe(appVersion);expect(corner.reference_revision_id).toBe(document.revisions[0].id);
  expect(JSON.parse(corner.revision_ids)).toEqual([document.revisions[0].id,document.activeRevisionId]);expect(JSON.parse(corner.scenario_labels)).toEqual(["Baseline","Deep sand alternative"]);
  expect(Number.isFinite(Date.parse(corner.snapshot_captured_at))).toBe(true);
  const validation=await downloadRows(page,".disagreement-validation-csv"),centre=validation.rows.find(row=>row.borehole_id==="BH-CENTRE")!;
  expect(centre).toBeDefined();expect(Number(centre.logged_elevation_m)).toBeCloseTo(4,6);expect(Number(centre.min_elevation_m)).toBeCloseTo(6,6);
  expect(Number(centre.max_elevation_m)).toBeCloseTo(8,6);expect(Number(centre.range_width_m)).toBeCloseTo(2,6);
  expect(Number(centre.reference_error_m)).toBeCloseTo(4,6);expect(centre.covered).toBe("false");expect(centre.extrapolated).toBe("false");
  expect(JSON.parse(centre.missing_case_ids)).toEqual([]);
  const predictions=JSON.parse(centre.predictions);expect(predictions).toHaveLength(2);
  for(const prediction of predictions){expect(prediction.removedBoreholes).toBe(1);expect(prediction.removedCpts).toBe(1)}
  const archived=JSON.parse((await downloadText(page,".disagreement-json")).text);
  expect(archived.format).toBe("geomodel3d-disagreement-analysis");expect(archived.engineVersion).toBe(appVersion);
  expect(archived.validation.summary).toMatchObject({nScored:1,nCovered:0,empiricalCoverage:0,mae:4});
  expect(archived.sourceRevisions.map((source:any)=>source.id)).toEqual([document.revisions[0].id,document.activeRevisionId]);
  await page.screenshot({path:testInfo.outputPath("model-disagreement-desktop.png"),fullPage:true});
  await dialog.locator(".disagreement-validation").scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("model-disagreement-validation.png"),fullPage:true});
  await dialog.locator(".disagreement-step").fill("0");await expect(dialog.locator(".disagreement-csv")).toBeDisabled();await expect(dialog.locator(".disagreement-validation-csv")).toBeDisabled();
  await dialog.locator(".disagreement-run").click();await expect(dialog.locator(".disagreement-error")).toBeVisible();await expect(dialog.locator(".disagreement-json")).toBeDisabled();
  await page.keyboard.press("Escape");await expect(page.locator(".ws-disagreement")).toBeFocused();
  const unchanged:any=await downloadJson(page);expect(unchanged.revisions).toEqual(document.revisions);expect(unchanged.draft).toEqual(document.draft);
});

test("model disagreement preserves missing coverage, rejects grids and transfers pinned ranges into planning",async({page},testInfo)=>{
  test.setTimeout(90_000);
  const document=await openFixture(page,"flat"),dialog=await analysis(page,document);
  await expect(dialog.locator(".disagreement-csv")).toBeEnabled();
  const report=JSON.parse((await downloadText(page,".disagreement-json")).text);
  expect(report.report.cases.map((item:any)=>item.id)).toEqual([document.revisions[0].id,document.activeRevisionId]);
  const corner=report.report.grid.points.find((point:any)=>point.x===0&&point.y===0)!;
  expect(corner).toMatchObject({complete:true,count:2,total:2,min:6,max:8,width:2});
  expect(report.report.points.every((point:any)=>point.complete&&Math.abs(point.width-2)<1e-6)).toBe(true);
  await dialog.locator(".disagreement-plan").click();await expect(dialog).toHaveCount(0);
  const planner=page.getByRole("dialog",{name:"Investigation planner",exact:true});await expect(planner).toBeVisible();
  await expect(planner.locator(".planner-disagreement")).toBeChecked();await planner.locator(".planner-spacing").fill("0");await planner.locator(".planner-budget").fill("2");
  await planner.locator(".planner-run").click();await expect(planner.locator(".planner-json")).toBeEnabled();
  const planned=JSON.parse((await downloadText(page,".planner-json")).text);
  expect(planned.proposals).toHaveLength(2);expect(planned.proposals.every((proposal:any)=>proposal.modelRange&&Math.abs(proposal.modelRange.width-2)<1e-6)).toBe(true);
  expect(planned.options.prioritizeDisagreement).toBe(true);expect(planned.disagreement).toMatchObject({unitId:"sand",caseIds:[document.revisions[0].id,document.activeRevisionId]});
  expect(planned.options.disagreementContext).toBeUndefined();
  const proposalCsv=await downloadRows(page,".planner-csv");
  expect(proposalCsv.rows).toHaveLength(2);expect(proposalCsv.rows.every(row=>row.ranking_method==="selected-interpretation-range"&&Math.abs(Number(row.model_range_width_m)-2)<1e-6)).toBe(true);
  expect(JSON.parse(proposalCsv.rows[0].disagreement_case_ids)).toEqual([document.revisions[0].id,document.activeRevisionId]);
  await page.screenshot({path:testInfo.outputPath("model-disagreement-planner.png"),fullPage:true});
  await page.keyboard.press("Escape");await expect(page.locator(".ws-disagreement")).toBeFocused();
  const unchanged:any=await downloadJson(page);expect(unchanged.revisions).toEqual(document.revisions);expect(unchanged.draft).toEqual(document.draft);
  const missing=await fixture(page,"missing");await replaceFixture(page,missing);const partial=await analysis(page,missing);await expect(partial.locator(".disagreement-csv")).toBeEnabled();
  const missingReport=JSON.parse((await downloadText(page,".disagreement-json")).text),edge=missingReport.report.grid.points.find((point:any)=>point.x===0&&point.y===0)!;
  expect(edge.complete).toBe(false);expect(edge.count).toBe(1);expect(edge.min).toBeUndefined();expect(edge.width).toBeUndefined();expect(edge.missingCaseIds).toEqual([missing.activeRevisionId]);
  const missingCsv=await downloadRows(page,".disagreement-csv"),missingRow=missingCsv.rows.find(row=>row.sample_type==="map"&&Number(row.x_m)===0&&Number(row.y_m)===0)!;
  expect(missingRow.min_elevation_m).toBe("");expect(missingRow.max_elevation_m).toBe("");expect(missingRow.range_width_m).toBe("");expect(JSON.parse(missingRow.missing_case_ids)).toEqual([missing.activeRevisionId]);
  await page.keyboard.press("Escape");const grid=await fixture(page,"grid");await replaceFixture(page,grid);const incompatible=await analysis(page,grid);
  await expect(incompatible.locator(".disagreement-error")).toContainText(/different local grids|coordinate systems/i);await expect(incompatible.locator(".disagreement-csv")).toBeDisabled();
});

test("mobile model disagreement keeps map, validation and keyboard focus within the dialog",async({page},testInfo)=>{
  test.setTimeout(90_000);
  const document=await openFixture(page),dialog=await analysis(page,document);await expect(dialog.locator(".disagreement-csv")).toBeEnabled();
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  for(let i=0;i<18;i++){await page.keyboard.press("Tab");expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true)}
  await dialog.locator(".disagreement-map").scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("model-disagreement-mobile-map.png"),fullPage:true});
  await dialog.locator(".disagreement-validation").scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("model-disagreement-mobile-validation.png"),fullPage:true});
  await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);await expect(page.locator(".ws-disagreement")).toBeFocused();
});

test("standalone model disagreement evaluates ranges and held-out validation with networking disabled",async({page,context},testInfo)=>{
  test.setTimeout(90_000);
  await prepare(page);await page.goto("/?backend=webgl#input");const document=await fixture(page),filename=resolve("dist/geomodel3d-offline.html");
  expect(existsSync(filename),"Run npm run build before the standalone browser check").toBe(true);const html=readFileSync(filename,"utf8"),errors:string[]=[];
  await page.route("**/*",route=>route.request().isNavigationRequest()?route.fulfill({status:200,contentType:"text/html",body:html}):route.abort());
  await context.setOffline(true);page.on("pageerror",error=>errors.push(error.message));await page.goto("http://127.0.0.1:4173/standalone-disagreement.html?backend=webgl#input");
  await expect(page.locator(".title span")).toHaveText(appVersion);await openInput(page);await importJson(page,document);await saved(page);
  const dialog=await analysis(page,document);await expect(dialog.locator(".disagreement-csv")).toBeEnabled();
  const validation=await downloadRows(page,".disagreement-validation-csv"),centre=validation.rows.find(row=>row.borehole_id==="BH-CENTRE")!;
  expect(Number(centre.min_elevation_m)).toBeCloseTo(6,6);expect(Number(centre.max_elevation_m)).toBeCloseTo(8,6);expect(centre.covered).toBe("false");
  await page.screenshot({path:testInfo.outputPath("model-disagreement-offline.png"),fullPage:true});expect(errors).toEqual([]);
});
