import {test,expect,Page,Dialog} from "@playwright/test";
import {existsSync,readFileSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {downloadJson,importJson,openInput,prepare,saved} from "./helpers";

type Variant="interior"|"outside"|"assumptions"|"grid";

// The inventory and method notes are quoted JSON fields, which can contain commas and newlines.
function csvRows(text:string){
  const rows:string[][]=[],row:string[]=[];let field="",quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){
      if(quoted&&text[i+1]==='"'){field+='"';i++}else quoted=!quoted;
    }else if(c===","&&!quoted){row.push(field);field=""}
    else if((c==="\n"||c==="\r")&&!quoted){
      row.push(field);rows.push([...row]);row.length=0;field="";
      if(c==="\r"&&text[i+1]==="\n")i++;
    }else field+=c;
  }
  if(field||row.length){row.push(field);rows.push(row)}
  return rows;
}

// The old model is flat at elevation 8 m for sand. A new hole logs sand at 6 m, giving a +2 m
// forecast error and a -2 m updated contact shift at exactly the same coordinates.
async function fixture(page:Page,variant:Variant="interior"){
  return page.evaluate(async variant=>{
    const wm="/src/workspace.ts",tm="/src/tables.ts",w=await import(wm),t=await import(tm);
    const before={name:"Impact baseline",crs:"Local survey grid",base:-5,groundwaterDepth:2,
      units:[{id:"fill",name:"Made ground",color:"#9a5b4f"},{id:"sand",name:"River sand",color:"#d9b871"}],
      boreholes:[[0,0],[40,0],[40,40],[0,40]].map(([x,y],i)=>({id:`BH-${i+1}`,x,y,z:10,depth:12,
        intervals:[{from:0,to:2,unit:"fill"},{from:2,to:12,unit:"sand"}]}))};
    let doc=w.createWorkspace(t.tablesFromProject(before),before);
    doc=w.checkpoint(doc,before,"Before additional investigation");
    doc=w.createScenario(doc,"Additional investigation",doc.activeRevisionId);
    const after:any=structuredClone(before);
    after.name="Impact update";
    if(variant==="assumptions")after.groundwater={mode:"assumed-depth",depth:4};
    else if(variant==="grid")after.crs="Different local survey grid";
    else after.boreholes.push({id:variant==="outside"?"BH-OUTSIDE":"BH-NEW",x:variant==="outside"?80:20,y:20,z:10,depth:12,
      intervals:[{from:0,to:4,unit:"fill"},{from:4,to:12,unit:"sand"}]});
    doc=w.updateDraft(doc,t.tablesFromProject(after),after);
    doc=w.checkpoint(doc,after,"New-data review fixture");
    return JSON.parse(w.toWorkspaceJson(doc));
  },variant);
}

async function openFixture(page:Page,variant:Variant="interior"){
  await prepare(page);await page.goto("/?backend=webgl#input");await openInput(page);
  const document=await fixture(page,variant);
  await importJson(page,document);await expect(page.locator(".ws-history")).toBeVisible();await saved(page);
  return document;
}

async function replaceFixture(page:Page,document:unknown){
  const accept=(dialog:Dialog)=>dialog.accept();page.on("dialog",accept);
  try{await importJson(page,document);await expect(page.locator(".ws-history")).toBeVisible();await saved(page)}
  finally{page.off("dialog",accept)}
}

async function review(page:Page,document:any,run=true){
  await page.locator('[data-step="scenarios"]').click();
  await page.locator(".ws-compare-before").selectOption(document.revisions[0].id);
  await page.locator(".ws-compare-after").selectOption(document.activeRevisionId);
  await page.locator(".ws-impact").click();
  const dialog=page.getByRole("dialog",{name:"New-data impact review",exact:true});
  await expect(dialog).toBeVisible();
  if(run)await dialog.locator(".impact-run").click();
  return dialog;
}

async function csvDownload(page:Page){
  const pending=page.waitForEvent("download");
  await page.locator(".impact-csv").click();
  const download=await pending,path=await download.path();
  expect(path).not.toBeNull();
  const text=await readFile(path!,"utf8");
  const [header,...rows]=csvRows(text);
  return {text,name:download.suggestedFilename(),rows:rows.map(row=>Object.fromEntries(row.map((v,i)=>[header[i],v])))};
}

test("new-data impact checks the old forecast, pins signed CSV and preserves both revisions",async({page},testInfo)=>{
  const document=await openFixture(page),dialog=await review(page,document,false);
  await dialog.locator(".impact-run").evaluate((button:HTMLButtonElement)=>{
    button.click();globalThis.document.querySelector<HTMLButtonElement>(".impact-cancel")!.click();
  });
  await expect(dialog.locator(".impact-status")).toContainText(/cancel/i);
  await expect(dialog.locator(".impact-csv")).toBeDisabled();
  const canceled=await page.evaluate(async document=>{
    const module="/src/impactJob.ts",{createImpactJob}=await import(module);
    const job=createImpactJob(document.revisions[0].project,document.revisions[1].project);
    job.cancel();
    try{await job.result;return "resolved"}catch(error){return (error as Error).name}
  },document);
  expect(canceled).toBe("AbortError");
  await dialog.locator(".impact-run").click();
  await expect(dialog.locator(".impact-csv")).toBeEnabled();
  await expect(dialog.locator(".impact-inventory tr").filter({hasText:"Boreholes"}).locator("td")).toHaveText(["1","0","0","4"]);
  await expect(dialog.locator(".impact-id-details")).toContainText("BH-NEW");
  await expect(dialog.locator(".impact-selected-name")).toContainText("BH-NEW");
  await expect(dialog.locator(".impact-map svg")).toBeVisible();
  const sand=dialog.locator(".impact-contact-table tr").filter({hasText:"River sand"});
  await expect(sand).toHaveCount(1);
  await expect(sand).toContainText("8");await expect(sand).toContainText("6");
  const csv=await csvDownload(page),row=csv.rows.find(r=>r.unit_id==="sand");
  expect(row).toBeDefined();expect(row!.borehole_id).toBe("BH-NEW");
  expect(Number(row!.before_elevation_m)).toBeCloseTo(8,6);
  expect(Number(row!.logged_elevation_m)).toBeCloseTo(6,6);
  expect(Number(row!.after_elevation_m)).toBeCloseTo(6,6);
  expect(Number(row!.prediction_error_m)).toBeCloseTo(2,6);
  expect(Number(row!.model_shift_m)).toBeCloseTo(-2,6);
  expect(row!.before_revision_id).toBe(document.revisions[0].id);
  expect(row!.after_revision_id).toBe(document.activeRevisionId);
  expect(row!.before_scenario).toBe("Baseline");expect(row!.after_scenario).toBe("Additional investigation");
  expect(JSON.parse(row!.added_boreholes_ids)).toEqual(["BH-NEW"]);
  expect(JSON.parse(row!.modified_boreholes_ids)).toEqual([]);
  expect(JSON.parse(row!.unchanged_boreholes_ids)).toEqual(["BH-1","BH-2","BH-3","BH-4"]);
  await page.screenshot({path:testInfo.outputPath("new-data-impact-desktop.png"),fullPage:true});
  await dialog.locator(".impact-contact-table").scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath("new-data-impact-desktop-contacts.png"),fullPage:true});
  await dialog.locator(".impact-compare").click();
  const comparison=page.getByRole("dialog",{name:"Compare project revisions",exact:true});
  await expect(comparison).toBeVisible();await expect(dialog).toHaveCount(0);
  await comparison.locator(".cmp-run").click();await expect(comparison.locator(".cmp-csv")).toBeEnabled();
  await page.keyboard.press("Escape");
  const unchanged:any=await downloadJson(page);
  expect(unchanged.revisions).toEqual(document.revisions);
  expect(unchanged.draft).toEqual(document.draft);
});

test("new-data impact leaves outside forecasts unavailable and identifies changes without additions",async({page})=>{
  const outside=await openFixture(page,"outside"),dialog=await review(page,outside);
  await expect(dialog.locator(".impact-csv")).toBeEnabled();
  await expect(dialog.locator(".impact-selected-name")).toContainText("BH-OUTSIDE");
  await expect(dialog.locator(".impact-results")).toContainText(/outside/i);
  const csv=await csvDownload(page),sand=csv.rows.find(r=>r.unit_id==="sand");
  expect(sand!.before_inside).toBe("false");expect(sand!.before_elevation_m).toBe("");
  expect(sand!.prediction_error_m).toBe("");expect(sand!.model_shift_m).toBe("");
  await page.keyboard.press("Escape");
  await expect(page.locator(".ws-impact")).toBeFocused();
  const assumptions=await fixture(page,"assumptions");
  await replaceFixture(page,assumptions);
  const noData=await review(page,assumptions);
  await expect(noData.locator(".impact-csv")).toBeEnabled();
  await expect(noData.locator(".impact-results")).toContainText(/no (new|added) boreholes/i);
  await expect(noData.locator(".impact-changes")).toContainText(/groundwater/i);
  await expect(noData.locator(".impact-results")).toContainText(/attribut|caus|solely/i);
  const empty=await csvDownload(page);
  expect(empty.rows).toHaveLength(1);expect(empty.rows[0].borehole_id).toBe("");
  expect(empty.rows[0].before_revision_id).toBe(assumptions.revisions[0].id);
  expect(empty.rows[0].after_revision_id).toBe(assumptions.activeRevisionId);
  expect(JSON.parse(empty.rows[0].other_changes)).toContain("Groundwater policy or fallback depth");
  await page.keyboard.press("Escape");
  const otherGrid=await fixture(page,"grid");await replaceFixture(page,otherGrid);
  const failed=await review(page,otherGrid);
  await expect(failed.locator(".impact-error")).toContainText(/different local grids/i);
  await expect(failed.locator(".impact-csv")).toBeDisabled();
});

test("mobile new-data impact keeps map, tables and keyboard controls inside the dialog",async({page},testInfo)=>{
  const document=await openFixture(page),dialog=await review(page,document);
  await expect(dialog.locator(".impact-csv")).toBeEnabled();
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("new-data-impact-mobile.png"),fullPage:true});
  for(let i=0;i<15;i++){
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);
  }
  await dialog.locator(".impact-contact-table").scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath("new-data-impact-mobile-contacts.png"),fullPage:true});
  const contacts=dialog.locator(".impact-contact-table").locator("..");
  expect(await contacts.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);
  await contacts.evaluate(el=>{el.scrollLeft=el.scrollWidth});
  await page.screenshot({path:testInfo.outputPath("new-data-impact-mobile-differences.png"),fullPage:true});
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);await expect(page.locator(".ws-impact")).toBeFocused();
});

test("standalone new-data impact runs the inline worker with networking disabled",async({page,context},testInfo)=>{
  await prepare(page);await page.goto("/?backend=webgl#input");
  const document=await fixture(page),filename=resolve("dist/geomodel3d-offline.html");
  expect(existsSync(filename),"Run npm run build before the standalone browser check").toBe(true);
  const html=readFileSync(filename,"utf8"),errors:string[]=[];
  await page.route("**/*",route=>route.request().isNavigationRequest()
    ?route.fulfill({status:200,contentType:"text/html",body:html}):route.abort());
  await context.setOffline(true);page.on("pageerror",error=>errors.push(error.message));
  await page.goto("http://127.0.0.1:4173/standalone-impact.html?backend=webgl#input");
  await openInput(page);await importJson(page,document);await saved(page);
  const dialog=await review(page,document);
  await expect(dialog.locator(".impact-csv")).toBeEnabled();
  const csv=await csvDownload(page),sand=csv.rows.find(r=>r.unit_id==="sand");
  expect(Number(sand!.prediction_error_m)).toBeCloseTo(2,6);
  expect(Number(sand!.model_shift_m)).toBeCloseTo(-2,6);
  await page.screenshot({path:testInfo.outputPath("new-data-impact-offline.png"),fullPage:true});
  expect(errors).toEqual([]);
});
