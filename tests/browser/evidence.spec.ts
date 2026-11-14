import {test,expect,Page} from "@playwright/test";
import {fileURLToPath} from "node:url";
import {build,downloadJson,importJson,openInput,prepare,resume,saved} from "./helpers";
import {evidenceProject} from "./fixtures/evidence-project";

async function openEvidenceProject(page:Page,modify?:(project:any)=>void){
  const project=await evidenceProject(page);
  modify?.(project);
  await prepare(page);await page.goto("/?backend=webgl#input");
  await openInput(page);
  await importJson(page,project,"evidence-project.json");
  await expect(page.locator(".ws-status")).toContainText("Imported evidence-project.json");
  await saved(page);
  return project;
}

const record=(document:any,id:string)=>document.draft.tables.evidence.records.find((r:any)=>r.id===id);
async function unpackWorkspace(page:Page,document:unknown):Promise<any>{
  return page.evaluate(async document=>{
    const module="/src/workspace.ts";
    return (await import(module)).parseWorkspace(document);
  },document);
}
async function step(page:Page,name:string){
  await saved(page);
  await page.locator(`[data-step="${name}"]`).click();
  await expect(page.locator(`[data-step="${name}"]`)).toHaveAttribute("aria-current","step");
}

test("source inspector shows field evidence and page highlights, contains focus and escapes document text",async({page},testInfo)=>{
  const attack='<img src=x onerror="globalThis.evidenceInjected=true">';
  await openEvidenceProject(page,p=>{
    p.evidence.sources[0].name=attack+".pdf";
    p.evidence.records[0].fields.remarks={...structuredClone(p.evidence.records[0].fields.id),original:attack,current:attack};
    p.evidence.records[0].fields.remarks.boxes[0].text=attack;
    p.evidence.records[0].fields.toString={original:"custom value",current:"custom value",boxes:[],status:"unreviewed",events:[]};
  });
  const trigger=page.locator(".ed-evidence").first();
  await trigger.click();
  const dialog=page.locator(".ev-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await dialog.locator('[data-evidence-field="toString"]').click();
  await expect(dialog.locator(".ev-original")).toHaveText("custom value");
  await expect(dialog.locator(".ev-current")).toHaveText("custom value");
  await dialog.locator('[data-evidence-field="remarks"]').click();
  await expect(dialog.locator(".ev-original")).toHaveText(attack);
  await expect(dialog.locator(".ev-current")).toHaveText(attack);
  await expect(dialog.locator(".ev-status")).toHaveAttribute("data-status","unreviewed");
  await expect(dialog.locator(".ev-page-image")).toBeVisible();
  await expect(dialog.locator(".ev-box")).toHaveCount(1);
  const bounds=await dialog.locator(".ev-box").evaluate((element:HTMLElement)=>({left:element.style.left,top:element.style.top,width:element.style.width,height:element.style.height}));
  expect(parseFloat(bounds.left)).toBeCloseTo(10);
  expect(parseFloat(bounds.top)).toBeCloseTo(20);
  expect(parseFloat(bounds.width)).toBeCloseTo(50);
  expect(parseFloat(bounds.height)).toBeCloseTo(5);
  await dialog.locator('[data-evidence-field="depth"]').click();
  await expect(dialog.locator('[data-evidence-field="depth"]')).toHaveAttribute("aria-pressed","true");
  await expect(dialog.locator(".ev-original")).toHaveText("12");
  await expect(dialog.locator(".ev-page-prev")).toBeEnabled();
  await expect(dialog.locator(".ev-page-next")).toBeDisabled();
  await dialog.locator(".ev-page-prev").click();
  await expect(dialog.locator(".ev-box")).toHaveCount(0);
  await dialog.locator('[data-evidence-field="z"]').click();
  for(let n=0;n<16;n++){
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(element=>element.contains(document.activeElement))).toBe(true);
  }
  expect(await page.evaluate(()=>Boolean((globalThis as any).evidenceInjected))).toBe(false);
  expect(await dialog.locator('img[src="x"]').count()).toBe(0);
  await page.screenshot({path:testInfo.outputPath("evidence-desktop.png"),fullPage:true});
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("edits, row deletion and borehole renaming retain stable evidence without rewriting sources",async({page})=>{
  const original=await openEvidenceProject(page);
  await page.locator('input[data-r="0"][data-c="5"]').fill("10.5");
  await page.locator('input[data-r="0"][data-c="0"]').fill("BH-01-renamed");
  await step(page,"logs");
  await page.locator('.ed-table tbody tr[data-r="0"] .ed-del').click();
  await page.locator('input[data-r="0"][data-c="0"]').fill("BH-01-renamed");
  await page.locator('input[data-r="0"][data-c="1"]').fill("3");
  await page.locator(".ed-evidence").first().click();
  await page.locator('.ev-dialog [data-evidence-field="from"]').click();
  await expect(page.locator(".ev-original")).toHaveText("2");
  await expect(page.locator(".ev-current")).toHaveText("3");
  await expect(page.locator(".ev-status")).toContainText(/corrected/i);
  await page.locator(".ev-accept").click();
  await expect(page.locator(".ev-status")).toHaveAttribute("data-status","accepted");
  await page.keyboard.press("Escape");
  // Add an unsourced interval after the existing rows. The importer sorts it ahead of the sourced sand layer.
  await page.locator(".ed-add").click();
  const manual=page.locator(".ed-table tbody tr").last();
  for(const [column,value] of [[0,"BH-01-renamed"],[1,"0"],[2,"1"],[3,"fill"],[4,"Manual fill"]] as const)
    await manual.locator(`input[data-c="${column}"]`).fill(value);
  await step(page,"water");
  await page.locator('input[data-r="0"][data-c="0"]').fill("BH-01-renamed");
  await step(page,"spt");
  await page.locator('input[data-r="0"][data-c="0"]').fill("BH-01-renamed");
  await step(page,"tests");
  await page.locator('input[data-r="0"][data-c="0"]').fill("BH-01-renamed");
  const draft:any=await downloadJson(page);
  expect(draft.draft.tables.evidenceRows.logs[0]).toBe("layer-sand-bh1");
  expect(draft.draft.tables.evidenceRows.logs.at(-1)).toBeNull();
  expect(record(draft,"collar-bh1").fields.z).toMatchObject({original:"10",current:"10.5",status:"corrected"});
  expect(record(draft,"collar-bh1").fields.id).toMatchObject({original:"BH-01",current:"BH-01-renamed",status:"corrected"});
  const boundary=record(draft,"layer-sand-bh1").fields.from;
  expect(boundary.events).toContainEqual(expect.objectContaining({action:"corrected",previous:"2",value:"3"}));
  expect(boundary.events.at(-1)).toMatchObject({action:"accepted",value:"3"});
  expect(boundary.status).toBe("accepted");
  expect(Object.values(draft.evidenceImages)).toHaveLength(1);
  expect(draft.draft.tables.evidence.sources[0].pages[0].image).toMatch(/^workspace-image:/);
  expect((await unpackWorkspace(page,draft)).draft.tables.evidence.sources).toEqual(original.evidence.sources);
  await build(page);
  const project:any=await downloadJson(page,".ws-json");
  const hole=project.boreholes.find((b:any)=>b.id==="BH-01-renamed");
  expect(hole.evidenceId).toBe("collar-bh1");
  expect(hole.intervals[0].from).toBe(0);
  expect(hole.intervals[0].evidenceId).toBeUndefined();
  expect(hole.intervals[1].evidenceId).toBe("layer-sand-bh1");
  expect(hole.water[0].evidenceId).toBe("water-bh1");
  expect(project.evidence.sources).toEqual(original.evidence.sources);
});

test("evidence survives invalid draft reload, workspace import, and revision restore",async({page,context})=>{
  await openEvidenceProject(page);
  const baseline:any=await downloadJson(page);
  await page.locator('input[data-r="0"][data-c="5"]').fill("10.5");
  await build(page);
  await page.locator('[data-step="boreholes"]').click();
  await page.locator('input[data-r="0"][data-c="5"]').fill("survey pending");
  const unfinished:any=await downloadJson(page);
  expect(record(unfinished,"collar-bh1").fields.z.current).toBe("survey pending");
  await page.locator(".file").setInputFiles({name:"orphan.csv",mimeType:"text/csv",buffer:Buffer.from("hole_id,x,y,z,from,to,unit,evidence_id\nOrphan,0,0,10,0,5,sand,unknown-record\n")});
  await expect(page.locator(".ws-status")).toContainText("CSV evidence IDs require");
  const rejected:any=await downloadJson(page);
  expect(rejected.id).toBe(unfinished.id);
  expect(rejected.draft).toEqual(unfinished.draft);
  await saved(page);await resume(page);
  const reloaded:any=await downloadJson(page);
  expect(reloaded.draft.tables.evidence).toEqual(unfinished.draft.tables.evidence);
  const other=await context.newPage();await prepare(other);await other.goto("/?backend=webgl");
  await expect(other.getByRole("tab",{name:"Input data",exact:true})).toBeVisible();
  await importJson(other,unfinished);
  await expect(other.locator(".ws-history")).toBeVisible();
  const imported:any=await downloadJson(other);
  expect(imported.draft).toEqual(unfinished.draft);
  await other.locator(`[data-restore="${baseline.revisions[0].id}"]`).click();
  await saved(other);
  const restored:any=await downloadJson(other);
  expect(record(restored,"collar-bh1").fields.z).toMatchObject({original:"10",current:"10",status:"unreviewed"});
  expect(restored.revisions).toEqual(unfinished.revisions);
  await other.locator('[data-step="boreholes"]').click();
  await other.locator(".ed-evidence").first().click();
  await expect(other.locator(".ev-page-image")).toBeVisible();
});

test("unit rule changes show the actual model value and require renewed acceptance",async({page})=>{
  await openEvidenceProject(page,p=>{
    p.rules[0].unit="sand";
    const field=p.evidence.records.find((r:any)=>r.id==="layer-fill-bh1").fields.unit;
    field.status="accepted";
    field.events=[{at:"2026-11-14T00:00:00.000Z",action:"accepted",value:"fill"}];
  });
  await build(page);
  await page.getByRole("tab",{name:"3-D model",exact:true}).click();
  await page.locator(".site-evidence summary").click();
  await page.locator('.site-evidence [data-evidence="layer-fill-bh1"]').click();
  await page.locator('.ev-dialog [data-evidence-field="unit"]').click();
  await expect(page.locator(".ev-original")).toHaveText("fill");
  await expect(page.locator(".ev-current")).toHaveText("sand");
  await expect(page.locator(".ev-status")).toHaveAttribute("data-status","changed");
  await expect(page.locator(".ev-accept")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await openInput(page);await step(page,"logs");
  await page.locator(".ed-evidence").first().click();
  await page.locator('.ev-dialog [data-evidence-field="unit"]').click();
  await expect(page.locator(".ev-current")).toHaveText("sand");
  await expect(page.locator(".ev-status")).toHaveAttribute("data-status","changed");
  await page.locator(".ev-accept").click();
  await expect(page.locator(".ev-status")).toHaveAttribute("data-status","accepted");
  await page.keyboard.press("Escape");
  const accepted:any=await downloadJson(page);
  const field=record(accepted,"layer-fill-bh1").fields.unit;
  expect(field).toMatchObject({original:"fill",current:"sand",status:"accepted"});
  expect(field.events.map((event:any)=>event.action)).toEqual(["accepted","corrected","accepted"]);
  await resume(page);await step(page,"logs");
  await page.locator(".ed-evidence").first().click();
  await page.locator('.ev-dialog [data-evidence-field="unit"]').click();
  await expect(page.locator(".ev-current")).toHaveText("sand");
  await expect(page.locator(".ev-status")).toHaveAttribute("data-status","accepted");
});

test("PDF review carries corrected values, source snapshots and highlights into the saved workspace",async({page},testInfo)=>{
  test.setTimeout(90_000);
  await prepare(page);await page.goto("/?backend=webgl#input");await openInput(page);
  const pdf=fileURLToPath(new URL("../fixtures/docread/bro-tables.pdf",import.meta.url));
  await page.locator(".pdf-file").setInputFiles(pdf);
  await page.getByRole("button",{name:"Agree",exact:true}).click();
  const review=page.getByRole("dialog",{name:"Borehole logs read from documents"});
  await expect(review.locator("#dr-f-id")).toHaveValue("BHR000000470162",{timeout:60_000});
  await expect(review.locator("#dr-f-ground")).toHaveValue("3.64");
  await review.locator("#dr-f-ground").fill("3.7");
  await review.locator(".dr-use").click();
  await expect(review).toHaveCount(0,{timeout:30_000});
  await saved(page);
  const exported:any=await unpackWorkspace(page,await downloadJson(page));
  const tables=exported.draft.tables,id=tables.evidenceRows.boreholes[0],source= tables.evidence.sources[0];
  expect(source.name).toBe("bro-tables.pdf");
  expect(source.pages[0].image).toMatch(/^data:image\/png;base64,/);
  expect(record(exported,id).fields.z).toMatchObject({original:"3.64",current:"3.7",status:"corrected"});
  expect(record(exported,id).fields.z.boxes.length).toBeGreaterThan(0);
  await page.locator(".ed-evidence").first().click();
  await page.locator('.ev-dialog [data-evidence-field="z"]').click();
  await expect(page.locator(".ev-original")).toHaveText("3.64");
  await expect(page.locator(".ev-current")).toHaveText("3.7");
  await expect(page.locator(".ev-page-image")).toBeVisible();
  expect(await page.locator(".ev-box").count()).toBeGreaterThan(0);
  await page.screenshot({path:testInfo.outputPath("evidence-pdf-review.png"),fullPage:true});
  await page.keyboard.press("Escape");
  await build(page);await resume(page);
  const persisted:any=await unpackWorkspace(page,await downloadJson(page));
  expect(persisted.draft.tables.evidence).toEqual(tables.evidence);
});

test("mobile evidence inspector keeps controls usable and returns focus after closing",async({page},testInfo)=>{
  await openEvidenceProject(page);
  const trigger=page.locator(".ed-evidence").first();
  await trigger.click();
  const dialog=page.locator(".ev-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-evidence-field="z"]').click();
  await expect(dialog.locator(".ev-current")).toHaveText("10");
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("evidence-mobile.png"),fullPage:true});
  await dialog.locator(".ev-page-image").scrollIntoViewIfNeeded();
  await expect(dialog.locator(".ev-page-image")).toBeVisible();
  await page.screenshot({path:testInfo.outputPath("evidence-mobile-page.png"),fullPage:true});
  await dialog.locator(".ev-close").click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
