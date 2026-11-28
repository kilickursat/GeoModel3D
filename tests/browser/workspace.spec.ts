import {test,expect} from "@playwright/test";
import type {GeoProject} from "../../src/schema";
import {build,downloadJson,expectComplete,importFixture,importJson,openInput,prepare,rename,resume,saved} from "./helpers";

test.beforeEach(async({page})=>{await prepare(page);await page.goto("/?backend=webgl#input")});

test("reload preserves the full project and the latest draft edit",async({page})=>{
  await importFixture(page);
  const original=await downloadJson(page);
  expectComplete(original.draft.base);
  await rename(page,"Draft before reload");
  // Export immediately: no delay to accommodate the preview debounce.
  const exported=await downloadJson(page);
  expect(exported.draft.tables.project.name).toBe("Draft before reload");
  await saved(page);
  await resume(page);
  await page.locator('[data-step="project"]').click();
  await expect(page.locator('[data-field="name"]')).toHaveValue("Draft before reload");
  const reloaded=await downloadJson(page);
  expect(reloaded.draft.base).toEqual(original.draft.base);
  expectComplete(await downloadJson(page,".ws-json"));
});

test("build checkpoints remain immutable, restore, and branch without losing later revisions",async({page},testInfo)=>{
  await importFixture(page);
  await rename(page,"Design A");
  await build(page);
  await rename(page,"Design B");
  await build(page);
  const before=await downloadJson(page);
  expect(before.revisions.map(r=>r.project.name)).toEqual(["River crossing investigation","Design A","Design B"]);
  const revisionA=before.revisions[1];
  await page.locator('[data-step="history"]').click();
  page.once("dialog",dialog=>dialog.accept());
  await page.locator(`[data-restore="${revisionA.id}"]`).click();
  await saved(page);
  await resume(page);
  const restored=await downloadJson(page);
  expect(restored.activeRevisionId).toBe(revisionA.id);
  expect(restored.revisions).toEqual(before.revisions);
  expect(restored.draft.tables.project.name).toBe("Design A");
  expectComplete(restored.draft.base);
  await rename(page,"Design A alternative");
  await build(page);
  const branched=await downloadJson(page);
  expect(branched.revisions.slice(0,3)).toEqual(before.revisions);
  expect(branched.revisions[3].parentId).toBe(revisionA.id);
  await build(page);
  expect((await downloadJson(page)).revisions).toHaveLength(4);
  await page.locator('[data-step="history"]').click();
  await page.screenshot({path:testInfo.outputPath("revisions-desktop.png"),fullPage:true});
});

test("unfinished invalid cells survive workspace download and import",async({page,context})=>{
  await importFixture(page);
  await page.locator('[data-step="boreholes"]').click();
  await page.locator('input[data-r="0"][data-c="5"]').fill("survey pending");
  const exported=await downloadJson(page);
  expect(exported.draft.tables.rows.boreholes[0][5]).toBe("survey pending");
  expectComplete(exported.draft.base);
  // A second page exercises the file importer rather than resuming its in-memory draft.
  const other=await context.newPage();
  await prepare(other);await other.goto("/?backend=webgl");
  await expect(other.getByRole("tab",{name:"Input data",exact:true})).toBeVisible();
  await importJson(other,exported);
  await expect(other.locator(".ws-history")).toBeVisible();
  await other.locator('[data-step="boreholes"]').click();
  await expect(other.locator('input[data-r="0"][data-c="5"]')).toHaveValue("survey pending");
  const roundtrip=await downloadJson(other);
  expect(roundtrip.draft).toEqual(exported.draft);
  expect(roundtrip.revisions).toEqual(exported.revisions);
});

test("malformed and unsupported workspace imports leave the open draft and revisions intact",async({page})=>{
  await importFixture(page);
  await rename(page,"Keep this draft");
  const before=await downloadJson(page);
  for(const bad of [{...before,version:99},{...before,activeRevisionId:"missing-revision"}]){
    await importJson(page,bad);
    // The import handler must expose an error and must not install any part of the rejected document.
    await expect(page.locator(".ws-status")).toBeVisible();
    await expect(page.locator(".ws-status")).toContainText("Invalid workspace");
    const after=await downloadJson(page);
    expect(after.id).toBe(before.id);
    expect(after.draft).toEqual(before.draft);
    expect(after.revisions).toEqual(before.revisions);
  }
});

test("legacy table drafts migrate without losing unfinished text",async({page})=>{
  await page.evaluate(async()=>{
    const modulePath="/src/tables.ts";
    const {exampleTables}=await import(modulePath);
    const tables=exampleTables();
    tables.project.name="Legacy field notes";
    tables.rows.boreholes[0][5]="check survey";
    localStorage.setItem("geomodel3d.input.v1",JSON.stringify({tables,savedAt:"2026-01-15T12:00:00.000Z"}));
  });
  await resume(page);
  const migrated=await downloadJson(page);
  expect(migrated.draft.tables.project.name).toBe("Legacy field notes");
  expect(migrated.draft.tables.rows.boreholes[0][5]).toBe("check survey");
  expect(migrated.revisions).toEqual([]);
  expect(await page.evaluate(()=>localStorage.getItem("geomodel3d.input.v1"))).not.toBeNull();
  await resume(page);
  expect((await downloadJson(page)).draft).toEqual(migrated.draft);
});

test("a failed browser save is visible, keeps the previous save, and still allows export",async({page})=>{
  await importFixture(page);
  const before=await downloadJson(page);
  await saved(page);
  await page.evaluate(()=>{
    const original=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(names:string|string[],mode?:IDBTransactionMode,options?:IDBTransactionOptions){
      if(mode==="readwrite")throw new DOMException("Simulated quota failure","QuotaExceededError");
      return original.call(this,names,mode,options);
    };
  });
  await rename(page,"Not committed to browser");
  await expect(page.locator(".ws-save-status")).toContainText("Not saved in this browser");
  const exported=await downloadJson(page);
  expect(exported.draft.tables.project.name).toBe("Not committed to browser");
  expectComplete(exported.draft.base);
  await resume(page);
  expect((await downloadJson(page)).draft).toEqual(before.draft);
});

test("cancelling case or workspace replacement preserves the saved draft and history",async({page})=>{
  await importFixture(page);
  await rename(page,"Keep my investigation");
  const before=await downloadJson(page);
  await saved(page);
  await page.locator('[data-step="start"]').click();
  page.once("dialog",dialog=>dialog.dismiss());
  await page.locator('[data-start="new"]').click();
  expect((await downloadJson(page)).draft).toEqual(before.draft);
  const replacement={...before,id:"another-workspace",draft:{...before.draft,tables:{...before.draft.tables,project:{...before.draft.tables.project,name:"Replacement"}}}};
  const replacementDialog=page.waitForEvent("dialog"),upload=importJson(page,replacement);
  await (await replacementDialog).dismiss();
  await upload;
  await resume(page);
  const after=await downloadJson(page);
  expect(after.id).toBe(before.id);
  expect(after.draft).toEqual(before.draft);
  expect(after.revisions).toEqual(before.revisions);
});

test("discard restores complete original data after a CRS edit and build",async({page})=>{
  await importFixture(page);
  const original=await downloadJson(page);
  await page.locator('[data-step="project"]').click();
  await page.locator('[data-field="crs"]').fill("EPSG:32631");
  await build(page);
  const changed=await downloadJson(page);
  expect(changed.draft.base?.terrain).toBeUndefined();
  expect(changed.draft.base?.cpts).toBeUndefined();
  expect(changed.draft.base?.alignments).toBeUndefined();
  page.once("dialog",dialog=>dialog.accept());
  await page.locator(".ws-discard").click();
  await saved(page);
  const discarded=await downloadJson(page);
  expect(discarded.draft).toEqual(original.draft);
  expect(discarded.revisions).toEqual(changed.revisions);
  await resume(page);
  expectComplete(await downloadJson(page,".ws-json"));
});

test("continue saved case flushes a pending current draft instead of reopening stale text",async({page})=>{
  await importFixture(page);
  await rename(page,"Most recent typing");
  // Go straight to Continue without waiting for the autosave timer.
  await page.locator('[data-step="start"]').click();
  page.once("dialog",dialog=>dialog.accept());
  await page.locator('[data-start="saved"]').click();
  await saved(page);
  await page.locator('[data-step="project"]').click();
  await expect(page.locator('[data-field="name"]')).toHaveValue("Most recent typing");
  await resume(page);
  expect((await downloadJson(page)).draft.tables.project.name).toBe("Most recent typing");
});

test("adding a private alignment to a mapped site requires a fresh map choice",async({page})=>{
  await page.getByRole("tab",{name:"3-D model",exact:true}).click();
  const map=page.locator('[data-view="map"]');
  await expect(map).toBeChecked();
  await page.locator(".file").setInputFiles({
    name:"private-centreline.csv",mimeType:"text/csv",
    buffer:Buffer.from("point,x,y,chainage\nP1,0,0,0\nP2,25,0,25")
  });
  await expect(page.locator(".dataset option:checked")).toContainText("Your data");
  await expect(map).not.toBeChecked();
});

test("a lost graphics context leaves the workspace available for export",async({page})=>{
  await importFixture(page);
  await page.getByRole("tab",{name:"3-D model",exact:true}).click();
  await page.locator("#app > canvas").dispatchEvent("webglcontextlost",{cancelable:true});
  const status=page.locator(".renderer-status");
  await expect(status).toBeVisible();
  await expect(status).toContainText("edit your data or export your project");
  await expect(status.getByRole("link")).toHaveAttribute("target","_blank");
  await expect(status.getByRole("link")).toHaveAttribute("href",page.url());
  await openInput(page);
  expectComplete(await downloadJson(page,".ws-json"));
});

test("reviews repeated clay, reopens the decision after a depth edit, and correlates a separate bed",async({page})=>{
  const collar={z:10,intervals:[{from:0,to:1,unit:"clay",name:"Upper clay"},{from:1,to:5,unit:"sand",name:"Dense sand"}]};
  const project={
    name:"Repeated clay",units:[{id:"clay",name:"Clay",color:"#97634c"},{id:"sand",name:"Sand",color:"#ebc77f"}],
    boreholes:[
      {id:"BH-1",x:0,y:0,z:10,intervals:[collar.intervals[0],{...collar.intervals[1],to:3},{from:3,to:5,unit:"clay",name:"Stiff laminated clay"}]},
      {...collar,id:"BH-2",x:20,y:0},{...collar,id:"BH-3",x:0,y:20}
    ]
  };
  await openInput(page);
  await importJson(page,project,"repeated-clay.json");
  await expect(page.locator(".ws-status")).toContainText("Imported repeated-clay.json");
  const step=page.locator('[data-step="correlations"]'),review=page.locator(".ws-correlations");
  const showModel=async()=>{
    await page.locator(".ws-build").click();
    await expect(page.getByRole("tab",{name:"3-D model",exact:true})).toHaveAttribute("aria-selected","true");
  };
  await showModel();
  await expect(page.locator(".volume-review")).toContainText("Provisional volumes");
  await openInput(page);
  await step.click();
  const segment=review.getByRole("table",{name:"Differences at this collar"}).locator("tbody tr");
  await expect(segment.getByRole("cell")).toHaveText(["sand","3","5","2"]);
  const rationale="The lower clay lens is local to BH-1 and its extent is unknown.";
  await review.getByLabel("Reason for acceptance").fill(rationale);
  await review.getByRole("button",{name:"Accept interval differences"}).click();
  const accepted=await downloadJson<GeoProject>(page,".ws-json");
  expect(accepted.correlationAcceptances).toEqual([expect.objectContaining({holeId:"BH-1",from:3,to:5,rationale})]);
  expect(accepted.boreholes[0].intervals).toEqual(project.boreholes[0].intervals);

  page.once("dialog",dialog=>dialog.accept());
  await importJson(page,accepted,"accepted-clay.json");
  await expect(page.locator(".ws-status")).toContainText("Imported accepted-clay.json");
  await step.click();
  await expect(review).toContainText(rationale);
  await showModel();
  await expect(page.locator(".volume-review")).toContainText("Collar differences accepted with reasons for 1 logged interval");
  await openInput(page);
  await page.locator('[data-step="logs"]').click();
  await page.locator('input[data-r="2"][data-c="2"]').fill("4.8");
  await step.click();
  await expect(review.locator(".cr-summary")).toContainText("1 interval pending review");
  await expect(review.getByLabel("Reason for acceptance")).toHaveValue("");
  await expect(segment.getByRole("cell")).toHaveText(["sand","3","4.8","1.8"]);
  await showModel();
  await expect(page.locator(".volume-review")).toContainText("Provisional volumes");
  await openInput(page);
  await step.click();

  await review.getByText("Assign an interpreted bed",{exact:true}).click();
  await review.getByLabel("Bed assignment").selectOption("new");
  await review.getByLabel("New bed ID").fill("lower-clay");
  await review.getByLabel("Position in unit order").selectOption({label:"At the bottom"});
  await review.getByRole("button",{name:"Assign bed",exact:true}).click();
  await expect(review.locator(".cr-summary")).toContainText("All logged intervals match the model");
  const resolved=await downloadJson<GeoProject>(page,".ws-json");
  expect(resolved.units.map(u=>u.id)).toEqual(["clay","sand","lower-clay"]);
  expect(resolved.units[2].materialId).toBe("clay");
  expect(resolved.boreholes[0].intervals).toEqual([
    project.boreholes[0].intervals[0],project.boreholes[0].intervals[1],
    {from:3,to:4.8,unit:"lower-clay",name:"Stiff laminated clay"}
  ]);
  await showModel();
  await expect(page.locator(".stats")).toContainText("3 boreholes");
  await expect(page.locator(".volume-review")).toBeHidden();
});
