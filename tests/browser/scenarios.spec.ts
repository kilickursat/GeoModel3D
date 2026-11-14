import {test,expect,Page,Dialog} from "@playwright/test";
import {existsSync,readFileSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {build,downloadJson,importJson,openInput,prepare,resume,saved} from "./helpers";
import {evidenceProject} from "./fixtures/evidence-project";

async function step(page:Page,name:string){
  await saved(page);
  await page.locator(`[data-step="${name}"]`).click();
  await expect(page.locator(`[data-step="${name}"]`)).toHaveAttribute("aria-current","step");
}

async function scenarioProject(page:Page){
  const project=await evidenceProject(page);
  project.name="Scenario study";
  project.groundwater={mode:"observed"};
  delete project.terrain;delete project.cpts;delete project.cptRules;
  project.boreholes.forEach((hole:any)=>{
    hole.intervals[0].to=2;hole.intervals[1].from=2;
    hole.water=[{depth:2,date:"2026-01-15",...(hole.id==="BH-01"?{evidenceId:"water-bh1"}:{})}];
  });
  return project;
}

async function openScenarioProject(page:Page,modify?:(project:any)=>void){
  const project=await scenarioProject(page);modify?.(project);
  await prepare(page);await page.goto("/?backend=webgl#input");await openInput(page);
  await importJson(page,project,"scenario-project.json");
  await expect(page.locator(".ws-status")).toContainText("Imported scenario-project.json");
  await saved(page);
  return project;
}

const scenarioDraft=(document:any,id:string)=>id===document.activeScenarioId?document.draft:document.scenarios.find((s:any)=>s.id===id).draft;
const scenarioHead=(document:any,id:string)=>document.scenarios.find((s:any)=>s.id===id).headRevisionId;

async function createScenario(page:Page,name:string,fromRevision?:string){
  await step(page,"scenarios");
  await page.locator(".ws-scenario-name").fill(name);
  if(fromRevision)await page.locator(".ws-scenario-from").selectOption(fromRevision);
  await page.locator(".ws-scenario-create").click();
  await saved(page);
}

async function switchScenario(page:Page,id:string){
  await step(page,"scenarios");
  await page.locator(".ws-scenario-select").selectOption(id);
  await saved(page);
  await expect(page.locator(".ws-scenario-select")).toHaveValue(id);
}

async function compare(page:Page,before:string,after:string,run=true){
  await step(page,"scenarios");
  await page.locator(".ws-compare-before").selectOption(before);
  await page.locator(".ws-compare-after").selectOption(after);
  await page.locator(".ws-compare").click();
  const dialog=page.getByRole("dialog",{name:"Compare project revisions",exact:true});
  await expect(dialog).toBeVisible();
  if(run)await dialog.locator(".cmp-run").click();
  return dialog;
}

async function csvDownload(page:Page){
  const pending=page.waitForEvent("download");
  await page.locator(".cmp-csv").click();
  const download=await pending,path=await download.path();
  expect(path).not.toBeNull();
  return {name:download.suggestedFilename(),text:await readFile(path!,"utf8")};
}

function csvPoints(csv:string){
  const lines=csv.trim().split(/\r?\n/),at=lines.findIndex(line=>line.startsWith("distance_m,"));
  expect(at).toBeGreaterThanOrEqual(0);
  const keys=lines[at].split(",");
  return lines.slice(at+1).filter(Boolean).map(line=>Object.fromEntries(line.split(",").map((value,i)=>[keys[i],value])));
}

// Construct error/unknown-data snapshots using the same workspace API used by the editor. These cases exercise
// comparison behavior; scenario creation and editing are independently driven through visible controls below.
async function variantWorkspace(page:Page,changes:{crs?:string;groundwater?:unknown}){
  const wire:any=await downloadJson(page);
  return page.evaluate(async({wire,changes})=>{
    const workspaceModule="/src/workspace.ts",tablesModule="/src/tables.ts";
    const w=await import(workspaceModule),t=await import(tablesModule);
    let document=w.parseWorkspace(wire);
    document=w.createScenario(document,"Comparison alternative",document.activeRevisionId);
    const project=structuredClone(document.draft.base);
    Object.assign(project,changes);
    document=w.updateDraft(document,t.tablesFromProject(project),project);
    document=w.checkpoint(document,project,"Comparison fixture");
    return JSON.parse(w.toWorkspaceJson(document));
  },{wire,changes});
}

async function replaceWorkspace(page:Page,document:unknown){
  const accept=(dialog:Dialog)=>dialog.accept();
  page.on("dialog",accept);
  try{await importJson(page,document);await expect(page.locator(".ws-history")).toBeVisible();await saved(page)}
  finally{page.off("dialog",accept)}
}

test("scenario drafts, evidence and heads survive switching, reload and workspace roundtrip",async({page,context},testInfo)=>{
  test.setTimeout(90_000);
  await openScenarioProject(page);
  const original:any=await downloadJson(page),baseline=original.activeScenarioId,firstRevision=original.activeRevisionId;
  await page.locator('input[data-r="0"][data-c="5"]').fill("survey pending");
  await createScenario(page,"Wet alternative");
  const alternative:any=await downloadJson(page),alternativeId=alternative.activeScenarioId;
  expect(alternativeId).not.toBe(baseline);
  expect(scenarioDraft(alternative,baseline).tables.rows.boreholes[0][5]).toBe("survey pending");
  await page.locator(".ws-scenario-name").fill("Wet alternative reviewed");
  await page.locator(".ws-scenario-rename").click();
  await expect(page.locator(".ws-scenario-select option:checked")).toHaveText("Wet alternative reviewed");
  await step(page,"boreholes");
  await expect(page.locator('input[data-r="0"][data-c="5"]')).toHaveValue("survey pending");
  await page.locator('input[data-r="0"][data-c="5"]').fill("10.5");
  await build(page);
  const built:any=await downloadJson(page),alternativeHead=scenarioHead(built,alternativeId);
  expect(alternativeHead).not.toBe(firstRevision);
  await step(page,"scenarios");
  await page.screenshot({path:testInfo.outputPath("scenario-list-desktop.png"),fullPage:true});
  await step(page,"boreholes");
  await page.locator('input[data-r="0"][data-c="5"]').fill("awaiting review");
  await step(page,"project");
  await page.locator(".ws-groundwater-mode").selectOption("as-of");
  await page.locator(".ws-groundwater-date").fill("date pending");
  await page.locator(".ws-groundwater-undated").check();
  await switchScenario(page,baseline);await step(page,"boreholes");
  await expect(page.locator('input[data-r="0"][data-c="5"]')).toHaveValue("survey pending");
  await switchScenario(page,alternativeId);await step(page,"boreholes");
  await expect(page.locator('input[data-r="0"][data-c="5"]')).toHaveValue("awaiting review");
  const unfinished:any=await downloadJson(page);
  expect(scenarioHead(unfinished,baseline)).toBe(firstRevision);
  expect(scenarioHead(unfinished,alternativeId)).toBe(alternativeHead);
  expect(unfinished.draft.tables.groundwaterDraft).toMatchObject({mode:"as-of",date:"date pending",includeUndated:true});
  expect(Object.keys(unfinished.evidenceImages)).toHaveLength(1);
  await resume(page);
  const reloaded:any=await downloadJson(page);
  expect(reloaded.scenarios).toEqual(unfinished.scenarios);
  expect(reloaded.draft).toEqual(unfinished.draft);
  const other=await context.newPage();await prepare(other);await other.goto("/?backend=webgl");
  await importJson(other,unfinished);
  await expect(other.locator(".ws-history")).toBeVisible();
  const imported:any=await downloadJson(other);
  expect(imported.scenarios).toEqual(unfinished.scenarios);
  expect(imported.draft).toEqual(unfinished.draft);
  await switchScenario(other,baseline);await step(other,"boreholes");
  await other.locator(".ed-evidence").first().click();
  await other.locator('[data-evidence-field="z"]').click();
  await expect(other.locator(".ev-original")).toHaveText("10");
  await expect(other.locator(".ev-current")).toHaveText("survey pending");
  await expect(other.locator(".ev-page-image")).toBeVisible();
  await other.keyboard.press("Escape");
  await step(other,"history");
  const acceptRestore=(dialog:Dialog)=>dialog.accept();
  other.on("dialog",acceptRestore);
  try{await other.locator(`[data-restore="${firstRevision}"]`).click()}
  finally{other.off("dialog",acceptRestore)}
  await step(other,"boreholes");
  await other.locator('input[data-r="0"][data-c="5"]').fill("11");
  await build(other);
  const branched:any=await downloadJson(other);
  expect(scenarioHead(branched,alternativeId)).toBe(alternativeHead);
  expect(scenarioDraft(branched,alternativeId)).toEqual(unfinished.draft);
  expect(scenarioHead(branched,baseline)).not.toBe(firstRevision);
  expect(branched.revisions.slice(0,unfinished.revisions.length)).toEqual(unfinished.revisions);
  // The displayed model belongs to Baseline while another scenario is being edited. Returning to that model
  // must preserve the other scenario and make any replacement of Baseline's unfinished draft explicit.
  await other.locator('input[data-r="0"][data-c="5"]').fill("baseline pending");
  await switchScenario(other,alternativeId);
  const beforeCurrent:any=await downloadJson(other);
  await step(other,"start");
  other.once("dialog",dialog=>dialog.dismiss());
  await other.locator('[data-start="current"]').click();
  const canceled:any=await downloadJson(other);
  expect(canceled.activeScenarioId).toBe(alternativeId);
  expect(canceled.draft).toEqual(beforeCurrent.draft);
  expect(canceled.scenarios).toEqual(beforeCurrent.scenarios);
  other.once("dialog",dialog=>dialog.accept());
  await other.locator('[data-start="current"]').click();
  await expect(other.locator('input[data-r="0"][data-c="5"]')).toHaveValue("11");
  const editingModel:any=await downloadJson(other);
  expect(editingModel.id).toBe(beforeCurrent.id);
  expect(editingModel.activeScenarioId).toBe(baseline);
  expect(editingModel.scenarios).toHaveLength(2);
  expect(scenarioDraft(editingModel,alternativeId)).toEqual(beforeCurrent.draft);
  expect(editingModel.revisions).toEqual(beforeCurrent.revisions);
});

test("comparison pins revisions, cancels workers and exports signed contact, water and pressure changes",async({page},testInfo)=>{
  test.setTimeout(90_000);
  await openScenarioProject(page);
  const baseline:any=await downloadJson(page),before=baseline.activeRevisionId;
  await createScenario(page,"Thicker fill",before);
  await step(page,"logs");
  for(let hole=0;hole<3;hole++){
    await page.locator(`input[data-r="${hole*2}"][data-c="2"]`).fill("3");
    await page.locator(`input[data-r="${hole*2+1}"][data-c="1"]`).fill("3");
  }
  await step(page,"project");
  await page.locator(".ws-groundwater-mode").selectOption("assumed-depth");
  await page.locator(".ws-groundwater-depth").fill("3");
  await build(page);
  const changed:any=await downloadJson(page),after=changed.activeRevisionId;
  expect(changed.revisions.at(-1).project.groundwater).toEqual({mode:"assumed-depth",depth:3});
  const dialog=await compare(page,before,after,false);
  await dialog.locator(".cmp-elevation").fill("0");
  await dialog.locator(".cmp-step").fill("5");
  // Cancel in the same browser task, before a very small comparison could finish in its worker.
  await dialog.locator(".cmp-run").focus();
  await dialog.locator(".cmp-run").evaluate((button:HTMLButtonElement)=>{
    button.click();document.querySelector<HTMLButtonElement>(".cmp-cancel")!.click();
  });
  await expect(dialog.locator(".cmp-status")).toContainText("Comparison canceled");
  await expect(dialog.locator(".cmp-csv")).toBeDisabled();
  const canceledJob=await page.evaluate(async()=>{
    const module="/src/comparisonJob.ts",{createComparisonJob}=await import(module);
    const project={name:"Cancellation fixture",crs:"Local grid",units:[{id:"sand",name:"Sand",color:"#d9b871"}],
      boreholes:[[0,0],[40,0],[0,40]].map(([x,y],i)=>({id:`BH${i}`,x,y,z:10,intervals:[{from:0,to:10,unit:"sand"}],water:[{depth:2}]}))};
    const job=createComparisonJob(project,project,{mode:"section",step:1});
    job.cancel();
    try{await job.result;return "resolved"}catch(error){return (error as Error).name}
  });
  expect(canceledJob).toBe("AbortError");
  await dialog.locator(".cmp-run").click();
  await expect(dialog.locator(".cmp-csv")).toBeEnabled();
  await expect(dialog.locator(".cmp-plot svg")).toBeVisible();
  const sand=dialog.locator(".cmp-contacts tr").filter({hasText:"Top of River sand (sand)"});
  expect(Number(await sand.locator("td").nth(3).textContent())).toBeCloseTo(-1,6);
  const csv=await csvDownload(page);
  expect(csv.text).toContain(before);expect(csv.text).toContain(after);
  const points=csvPoints(csv.text).filter(p=>p.before_inside==="true"&&p.after_inside==="true");
  expect(points.length).toBeGreaterThan(3);
  for(const point of points){
    expect(point.before_revision_id).toBe(before);expect(point.after_revision_id).toBe(after);
    expect(point.before_scenario).toBe("Baseline");expect(point.after_scenario).toBe("Thicker fill");
    expect(point.comparison_mode).toBe("section");
    expect(Number(point.delta_top_sand_m)).toBeCloseTo(-1,6);
    expect(Number(point.delta_ground_m)).toBeCloseTo(0,6);
    expect(Number(point.delta_water_m)).toBeCloseTo(-1,6);
    expect(Number(point.delta_u_kPa)).toBeCloseTo(-9.81,6);
  }
  await dialog.locator(".cmp-surface").selectOption("unit:sand");
  await dialog.locator(".cmp-plot").scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath("scenario-comparison-desktop.png"),fullPage:true});
  await dialog.locator(".cmp-step").fill("2");
  await expect(dialog.locator(".cmp-csv")).toBeDisabled();
  await expect(dialog.locator(".cmp-status")).toContainText("Settings changed");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".ws-compare")).toBeFocused();
  const untouched:any=await downloadJson(page);
  expect(untouched.revisions).toEqual(changed.revisions);
  expect(untouched.draft).toEqual(changed.draft);
});

test("comparison rejects incompatible grids and leaves missing dated groundwater unavailable",async({page})=>{
  test.setTimeout(90_000);
  await openScenarioProject(page,p=>{p.groundwater={mode:"as-of",date:"2025-12-31",includeUndated:false}});
  const original:any=await downloadJson(page),before=original.activeRevisionId;
  const wrongGrid=await variantWorkspace(page,{crs:"Other survey grid"});
  await replaceWorkspace(page,wrongGrid);
  let dialog=await compare(page,before,wrongGrid.activeRevisionId);
  await expect(dialog.locator(".cmp-error")).toContainText("different local grids");
  await expect(dialog.locator(".cmp-csv")).toBeDisabled();
  await page.keyboard.press("Escape");
  await replaceWorkspace(page,original);
  const knownWater=await variantWorkspace(page,{groundwater:{mode:"assumed-depth",depth:3}});
  await replaceWorkspace(page,knownWater);
  dialog=await compare(page,before,knownWater.activeRevisionId,false);
  await dialog.locator(".cmp-elevation").fill("0");
  await dialog.locator(".cmp-mode").selectOption("alignment");
  await dialog.locator(".cmp-run").click();
  await expect(dialog.locator(".cmp-csv")).toBeEnabled();
  expect(await dialog.getByText("Unavailable",{exact:true}).count()).toBeGreaterThan(0);
  const csv=await csvDownload(page),points=csvPoints(csv.text);
  expect(Number(points[0].distance_m)).toBeCloseTo(100);
  expect(Number(points.at(-1)!.distance_m)).toBeCloseTo(120);
  for(const point of points){
    expect(point.before_water_m).toBe("");expect(point.delta_water_m).toBe("");
    expect(point.before_u_kPa).toBe("");expect(point.delta_u_kPa).toBe("");
    expect(Number(point.after_water_m)).toBeCloseTo(7,6);
  }
});

test("mobile scenario comparison keeps controls accessible and returns keyboard focus",async({page},testInfo)=>{
  await openScenarioProject(page);
  const original:any=await downloadJson(page),before=original.activeRevisionId;
  await createScenario(page,"Mobile alternative",before);
  await step(page,"boreholes");
  await page.locator('input[data-r="0"][data-c="5"]').fill("11");
  await build(page);
  const alternative:any=await downloadJson(page);
  const dialog=await compare(page,before,alternative.activeRevisionId);
  await expect(dialog.locator(".cmp-csv")).toBeEnabled();
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("scenario-comparison-mobile.png"),fullPage:true});
  for(let n=0;n<16;n++){
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);
  }
  await dialog.locator(".cmp-plot").scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath("scenario-comparison-mobile-chart.png"),fullPage:true});
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".ws-compare")).toBeFocused();
});

test("standalone scenario workspace reopens and compares in a worker with networking disabled",async({page,context},testInfo)=>{
  test.setTimeout(90_000);
  const project=await scenarioProject(page),filename=resolve("dist/geomodel3d-offline.html");
  expect(existsSync(filename),"Run npm run build before the standalone browser smoke test").toBe(true);
  const html=readFileSync(filename,"utf8"),errors:string[]=[];
  await page.route("**/*",route=>route.request().isNavigationRequest()
    ?route.fulfill({status:200,contentType:"text/html",body:html}):route.abort());
  await context.setOffline(true);page.on("pageerror",error=>errors.push(error.message));
  await page.goto("http://127.0.0.1:4173/standalone-scenarios.html?backend=webgl#input");
  await openInput(page);await importJson(page,project,"scenario-project.json");await saved(page);
  const original:any=await downloadJson(page),before=original.activeRevisionId;
  await createScenario(page,"Offline alternative",before);
  await step(page,"boreholes");
  await page.locator('input[data-r="0"][data-c="5"]').fill("11");
  await build(page);
  const exported:any=await downloadJson(page),after=exported.activeRevisionId;
  expect(exported.scenarios).toHaveLength(2);
  await replaceWorkspace(page,exported);
  const reopened:any=await downloadJson(page);
  expect(reopened.scenarios).toEqual(exported.scenarios);
  const dialog=await compare(page,before,after);
  await expect(dialog.locator(".cmp-csv")).toBeEnabled();
  expect(csvPoints((await csvDownload(page)).text).length).toBeGreaterThan(1);
  await page.screenshot({path:testInfo.outputPath("scenario-comparison-offline.png"),fullPage:true});
  expect(errors).toEqual([]);
});
