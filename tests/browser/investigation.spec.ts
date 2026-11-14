import {test,expect,Page,Dialog} from "@playwright/test";
import {existsSync,readFileSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {build,downloadJson,importJson,openInput,prepare,saved} from "./helpers";

type Variant="inside"|"outside"|"unknown";
const appVersion=JSON.parse(readFileSync(resolve("package.json"),"utf8")).version as string;
function project(variant:Variant="inside"){
  const outside=variant==="outside",first=outside?940:1000,last=outside?1160:1100;
  return {format:"geomodel3d-project",version:1,name:`Investigation ${variant}`,crs:"Local survey grid",base:-5,
    ...(variant==="unknown"?{groundwater:{mode:"as-of",date:"2020-01-01"}}:{}),
    units:[{id:"fill",name:"Made ground",color:"#9a5b4f"},{id:"sand",name:"River sand",color:"#d9b871"}],
    boreholes:[[0,0],[100,0],[100,20],[0,20]].map(([x,y],i)=>({id:`BH-${i+1}`,x,y,z:10,depth:12,
      intervals:[{from:0,to:2,unit:"fill"},{from:2,to:12,unit:"sand"}],water:[{depth:1,date:"2026-01-10"}]})),
    // A recorded CPT remains a physical location to avoid, although it does not support this geological model.
    cpts:[{id:"CPT-unused",x:80,y:10,z:10,depth:[1,2],qc:[1,2]}],cptLayers:false,
    alignments:[{name:"Investigation corridor",points:[{x:outside?-60:0,y:10,chainage:first},{x:outside?160:100,y:10,chainage:last}],
      ...(variant==="unknown"?{}:{design:[{chainage:first,top:7,bottom:5},{chainage:last,top:7,bottom:5}]})}]};
}

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
  const [header,...values]=rows;return values.map(row=>Object.fromEntries(row.map((v,i)=>[header[i],v])));
}

async function showModel(page:Page){
  await page.getByRole("tab",{name:"3-D model",exact:true}).click();
  const sheet=page.locator('[data-sheet="section"]');
  if(await sheet.isVisible()&&await sheet.getAttribute("aria-expanded")==="false")await sheet.click();
}
async function loadProject(page:Page,variant:Variant="inside"){
  await openInput(page);const accept=(dialog:Dialog)=>dialog.accept();page.on("dialog",accept);
  try{await importJson(page,project(variant),`investigation-${variant}.json`);await expect(page.locator(".ws-status")).toContainText(`Imported investigation-${variant}.json`);await saved(page)}
  finally{page.off("dialog",accept)}
  await build(page);const workspace=await downloadJson(page);await showModel(page);return workspace;
}
async function openProject(page:Page,variant:Variant="inside"){
  await prepare(page);await page.goto("/?backend=webgl#input");return loadProject(page,variant);
}
async function planner(page:Page,run=true){
  await page.locator(".corridor-open").click();
  const corridor=page.getByRole("dialog",{name:"Corridor dashboard",exact:true});await expect(corridor).toBeVisible();
  await corridor.locator(".corridor-plan").click();
  const dialog=page.getByRole("dialog",{name:"Investigation planner",exact:true});await expect(dialog).toBeVisible();
  await expect(corridor).toHaveCount(0);
  await dialog.locator(".planner-budget").fill("2");await dialog.locator(".planner-spacing").fill("20");await dialog.locator(".planner-step").fill("10");
  if(run)await dialog.locator(".planner-run").click();return dialog;
}
async function downloadText(page:Page,selector:string){
  const pending=page.waitForEvent("download");await page.locator(selector).click();const download=await pending,path=await download.path();
  expect(path).not.toBeNull();return {name:download.suggestedFilename(),text:await readFile(path!,"utf8")};
}
async function csvDownload(page:Page){const file=await downloadText(page,".planner-csv");return {...file,rows:csvRows(file.text)}}
async function planDownload(page:Page){return JSON.parse((await downloadText(page,".planner-json")).text)}

test("investigation planner proposes spaced locations, exports pinned plans and preserves measured data",async({page},testInfo)=>{
  test.setTimeout(90_000);
  const workspace=await openProject(page),dialog=await planner(page,false);
  await expect(page.locator(".title span")).toHaveText(appVersion);
  await dialog.locator(".planner-run").evaluate((button:HTMLButtonElement)=>{button.click();document.querySelector<HTMLButtonElement>(".planner-cancel")!.click()});
  await expect(dialog.locator(".planner-status")).toContainText(/cancel/i);await expect(dialog.locator(".planner-csv")).toBeDisabled();
  const canceled=await page.evaluate(async project=>{
    const module="/src/investigationJob.ts",{createInvestigationJob}=await import(module);
    const job=createInvestigationJob(project,project.alignments[0],{budget:2,minSpacing:20,step:10});job.cancel();
    try{await job.result;return "resolved"}catch(error){return (error as Error).name}
  },project());expect(canceled).toBe("AbortError");
  await dialog.locator(".planner-run").click();await expect(dialog.locator(".planner-csv")).toBeEnabled();await expect(dialog.locator(".planner-json")).toBeEnabled();
  await expect(dialog.locator(".planner-map svg")).toBeVisible();
  const csv=await csvDownload(page),rows=csv.rows.filter(row=>row.proposal_id);expect(rows).toHaveLength(2);
  expect(Number(rows[0].rank)).toBe(1);expect(Number(rows[0].x_m)).toBeCloseTo(50,6);expect(Number(rows[0].y_m)).toBeCloseTo(10,6);
  expect(Number(rows[0].chainage_m)).toBeCloseTo(1050,6);expect(Number(rows[0].nearest_used_log_distance_m)).toBeCloseTo(Math.hypot(50,10),6);
  expect(Number(rows[1].x_m)).toBeCloseTo(20,6);
  for(const row of rows){expect(row.proposed_depth_m).toBe("");expect(row.reasons).not.toBe("");expect(Number(row.nearest_recorded_distance_m)).toBeGreaterThanOrEqual(20-1e-6)}
  expect(Math.hypot(Number(rows[0].x_m)-Number(rows[1].x_m),Number(rows[0].y_m)-Number(rows[1].y_m))).toBeGreaterThanOrEqual(20);
  expect(rows[0].engine_version).toBe(appVersion);expect(rows[0].scenario_label).toBe("Baseline");expect(Number.isFinite(Date.parse(rows[0].snapshot_captured_at))).toBe(true);
  expect(rows[0].location_budget).toBe("2");expect(rows[0].minimum_spacing_m).toBe("20");expect(rows[0].eligible_candidate_count).toBe("5");
  expect(JSON.parse(rows[0].crs).name).toBe("Local survey grid");expect(JSON.parse(rows[0].alignment_geometry)).toEqual(project().alignments[0].points);
  const plan=await planDownload(page);expect(plan.format).toBe("geomodel3d-investigation-plan");expect(plan.proposals).toHaveLength(2);expect(plan.options.budget).toBe(2);
  expect(plan.usedLogs).toHaveLength(4);expect(plan.recordedLogs).toHaveLength(5);expect(plan.summary.eligibleCount).toBe(5);
  expect(plan.summary.maxGapBefore).toBeCloseTo(Math.hypot(50,10),6);expect(plan.summary.maxGapAfter).toBeCloseTo(10,6);
  expect(plan.crs.name).toBe("Local survey grid");expect(plan.engineVersion).toBe(appVersion);expect(plan.scenarioLabel).toBe("Baseline");
  expect(plan.proposals[0].proposedDepth).toBeUndefined();expect(plan.proposals[0].x).toBeCloseTo(50,6);
  await page.screenshot({path:testInfo.outputPath("investigation-planner-desktop.png"),fullPage:true});
  await dialog.locator(".planner-sites").scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("investigation-planner-proposals.png"),fullPage:true});
  await dialog.locator(".planner-depth").fill("3");await expect(dialog.locator(".planner-csv")).toBeDisabled();await expect(dialog.locator(".planner-json")).toBeDisabled();
  await dialog.locator(".planner-run").click();await expect(dialog.locator(".planner-csv")).toBeEnabled();
  const depths=(await csvDownload(page)).rows.filter(row=>row.proposal_id);expect(depths.every(row=>Number(row.proposed_depth_m)===8)).toBe(true);
  expect(depths.every(row=>row.target_reference==="design-bottom")).toBe(true);
  await dialog.locator(".planner-budget").fill("0");await dialog.locator(".planner-run").click();await expect(dialog.locator(".planner-error")).toBeVisible();await expect(dialog.locator(".planner-csv")).toBeDisabled();
  await dialog.locator(".planner-budget").fill("2");await dialog.locator(".planner-run").click();await expect(dialog.locator(".planner-csv")).toBeEnabled();
  await dialog.locator(".planner-site").selectOption("0");await dialog.locator(".planner-view-chainage").click();await expect(dialog).toHaveCount(0);
  await expect(page.locator(".line-select")).toHaveValue("0");await expect(page.locator(".chainage")).toHaveValue("1050");
  await openInput(page);const unchanged=await downloadJson(page);expect(unchanged.revisions).toEqual(workspace.revisions);expect(unchanged.draft).toEqual(workspace.draft);
});

test("investigation planner makes outside locations, missing depth and budget shortfalls explicit",async({page})=>{
  test.setTimeout(90_000);await openProject(page,"outside");const dialog=await planner(page,false);
  await dialog.locator(".planner-budget").fill("1");await dialog.locator(".planner-depth").fill("3");await dialog.locator(".planner-outside").check();
  await dialog.locator(".planner-run").click();await expect(dialog.locator(".planner-csv")).toBeEnabled();
  const outside=(await csvDownload(page)).rows.find(row=>row.proposal_id)!;
  expect(outside.inside_model).toBe("false");expect(outside.model_ground_m).toBe("");expect(outside.proposed_depth_m).toBe("");expect(outside.flags).toContain("outside-model");
  await dialog.locator(".planner-spacing").fill("1000");await dialog.locator(".planner-run").click();await expect(dialog.locator(".planner-json")).toBeEnabled();
  const empty=await planDownload(page);expect(empty.proposals).toHaveLength(0);expect(empty.summary.budgetShortfall).toBe(1);
  const emptyCsv=(await csvDownload(page)).rows;expect(emptyCsv).toHaveLength(1);expect(emptyCsv[0].proposal_id).toBe("");expect(emptyCsv[0].scenario_label).toBe("Baseline");
  await page.keyboard.press("Escape");await expect(page.locator(".corridor-open")).toBeFocused();
  await loadProject(page,"unknown");const unknown=await planner(page,false);await unknown.locator(".planner-depth").fill("3");await unknown.locator(".planner-run").click();
  await expect(unknown.locator(".planner-csv")).toBeEnabled();
  const unknownRows=(await csvDownload(page)).rows.filter(row=>row.proposal_id);expect(unknownRows.length).toBeGreaterThan(0);
  expect(unknownRows.every(row=>row.proposed_depth_m===""&&row.design_top_m===""&&row.water_head_above_design_m==="")).toBe(true);
  expect(unknownRows.every(row=>row.flags.includes("missing-design")&&row.flags.includes("water-unknown"))).toBe(true);
});

test("mobile investigation planner keeps proposed sites and keyboard controls inside the dialog",async({page},testInfo)=>{
  await openProject(page);const dialog=await planner(page);await expect(dialog.locator(".planner-csv")).toBeEnabled();
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("investigation-planner-mobile.png"),fullPage:true});
  for(let i=0;i<22;i++){await page.keyboard.press("Tab");expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true)}
  await dialog.locator(".planner-map").scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("investigation-planner-mobile-map.png"),fullPage:true});
  await dialog.locator(".planner-sites").scrollIntoViewIfNeeded();const table=dialog.locator(".planner-sites").locator("..");
  expect(await table.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);await table.evaluate(el=>{el.scrollLeft=el.scrollWidth});
  await page.screenshot({path:testInfo.outputPath("investigation-planner-mobile-sites.png"),fullPage:true});
  await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);await expect(page.locator(".corridor-open")).toBeFocused();
});

test("standalone investigation planner runs the inline worker with networking disabled",async({page,context},testInfo)=>{
  const filename=resolve("dist/geomodel3d-offline.html");expect(existsSync(filename),"Build standalone before UI checks").toBe(true);
  const html=readFileSync(filename,"utf8"),errors:string[]=[];
  await page.route("**/*",route=>route.request().isNavigationRequest()?route.fulfill({status:200,contentType:"text/html",body:html}):route.abort());
  await context.setOffline(true);page.on("pageerror",error=>errors.push(error.message));
  await page.goto("http://127.0.0.1:4173/standalone-investigation.html?backend=webgl#input");await loadProject(page);
  await expect(page.locator(".title span")).toHaveText(appVersion);
  const dialog=await planner(page);await expect(dialog.locator(".planner-csv")).toBeEnabled();
  const rows=(await csvDownload(page)).rows.filter(row=>row.proposal_id);expect(rows).toHaveLength(2);expect(Number(rows[0].x_m)).toBeCloseTo(50,6);
  expect(Number(rows[0].nearest_used_log_distance_m)).toBeCloseTo(Math.hypot(50,10),6);expect(rows[0].proposed_depth_m).toBe("");
  const plan=await planDownload(page);expect(plan.proposals).toHaveLength(2);expect(plan.format).toBe("geomodel3d-investigation-plan");
  await page.screenshot({path:testInfo.outputPath("investigation-planner-offline.png"),fullPage:true});expect(errors).toEqual([]);
});
