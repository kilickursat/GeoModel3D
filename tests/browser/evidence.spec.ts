import {test,expect,Page} from "@playwright/test";
import {fileURLToPath} from "node:url";
import {readFile} from "node:fs/promises";
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

test("exports with page images say so, can leave the previews out, and cancel exports nothing",async({page})=>{
  await openEvidenceProject(page);
  const ask=page.locator("dialog.export-images");
  await page.locator(".ws-json").click();
  await expect(ask).toBeVisible();await expect(ask).toContainText("1 page image from your PDFs or scans");
  await expect(ask).toContainText("Source file names and the text read from them are included either way");
  let downloads=0;page.on("download",()=>{downloads++});
  await ask.locator('button[value="cancel"]').click();
  await expect(ask).toHaveCount(0);await page.waitForTimeout(300);expect(downloads).toBe(0);
  const pending=page.waitForEvent("download");
  await page.locator(".ws-json").click();await ask.locator('button[value="without-pages"]').click();
  const file=await (await pending).path();
  const exported=JSON.parse(await readFile(file!,"utf8"));
  const pages=exported.evidence.sources[0].pages;
  expect(pages).toHaveLength(2);for(const p of pages){expect(p.image).toBeUndefined();expect(p.width).toBe(600)}
  expect(exported.evidence.records.map((r:any)=>r.id)).toContain("collar-bh1");
});

test("shows the source image before OCR finishes and closes it on cancel",async({page})=>{
  await prepare(page);
  await page.goto("/?backend=webgl#input");await openInput(page);
  // Hold the worker download so the assertion covers the reading phase, even with a fast GPU.
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve});
  await page.route("**/assets/ocr.worker-*.js",async route=>{await held;await route.abort().catch(()=>{})});
  const image=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAFElEQVR4nGNUdmhgwAaYsIqSJQEAWH0A65PCMHQAAAAASUVORK5CYII=","base64");
  try{
    await page.locator(".pdf-file").setInputFiles({name:"source.png",mimeType:"image/png",buffer:image});
    await page.getByRole("button",{name:"Agree",exact:true}).click();
    const review=page.getByRole("dialog",{name:"Borehole logs read from documents"});
    await expect(review.locator(".dr-pageno")).toContainText("Page 1 of 1");
    await expect.poll(()=>review.locator(".dr-sheet canvas").evaluate((canvas:HTMLCanvasElement)=>
      [...canvas.getContext("2d")!.getImageData(1,1,1,1).data])).toEqual([35,64,128,255]);
    const original=await review.locator(".dr-sheet canvas").elementHandle();
    await review.getByRole("button",{name:"Fit width"}).click();
    expect(await original!.evaluate(canvas=>canvas.isConnected)).toBe(true);
    await expect(review.locator(".dr-use")).toBeDisabled();
    await review.locator(".dr-cancel").click();
    await expect(review).toHaveCount(0);
  }finally{release()}
});

test("a page read from its own text can be read again by OCR, which says so on the page",async({page})=>{
  test.setTimeout(240_000);
  await prepare(page);await page.goto("/?backend=webgl#input");await openInput(page);
  await page.locator(".pdf-file").setInputFiles(fileURLToPath(new URL("../fixtures/docread/bro-470162-strip.pdf",import.meta.url)));
  await page.getByRole("button",{name:"Agree",exact:true}).click();
  const review=page.getByRole("dialog",{name:"Borehole logs read from documents"});
  // The fixture contains the printed strip log on page 1 and a separate attribution page.
  await review.getByRole("button",{name:"Clear selection"}).click();
  await review.getByLabel("Read page 1",{exact:true}).check();
  await review.getByRole("button",{name:"Read selected pages"}).click();
  await expect(review.locator("#dr-f-id")).not.toHaveValue("",{timeout:60_000});
  // Read from the PDF's own text: no OCR label, and the override is offered.
  await expect(review.locator(".dr-readby")).toHaveText("");
  const ocr=review.locator(".dr-ocr");
  await expect(ocr).toBeVisible();
  await ocr.click();
  await expect(review.locator(".dr-readby")).toHaveText("Read by OCR: read by OCR on request",{timeout:200_000});
  await expect(ocr).toBeHidden();
  await expect(review.locator(".dr-unread")).toContainText("1 page read by OCR");
  await expect(review.locator(".dr-say")).toContainText(/Page 1 read by OCR/);
});

async function openMixedReportPicker(page:Page){
  // Generate a self-contained original report: two text pages and an image-only page.
  const sheet=await page.context().newPage();
  await sheet.setContent(`<style>@page{size:A4}article{break-after:page}article:last-child{break-after:auto}</style>
    <article><h1>Executive summary</h1><p>The site investigation considered a proposed foundation in the north field.</p></article>
    <article><h1>Borehole locations</h1><table><tr><th>Borehole ID</th><th>Easting</th><th>Northing</th></tr>
    <tr><td>BH-01</td><td>530000</td><td>185000</td></tr><tr><td>BH-02</td><td>531000</td><td>186000</td></tr></table></article>
    <article><canvas id="scan" width="500" height="500"></canvas></article>`);
  await sheet.locator("canvas").evaluate((canvas:HTMLCanvasElement)=>{
    const ctx=canvas.getContext("2d")!;ctx.fillStyle="black";ctx.fillRect(20,20,80,80);
  });
  const pdf=await sheet.pdf({preferCSSPageSize:true,printBackground:true});
  await sheet.close();await prepare(page);await page.goto("/?backend=webgl#input");await openInput(page);
  await page.locator(".pdf-file").setInputFiles({name:"mixed-pages.pdf",mimeType:"application/pdf",buffer:pdf});
  await page.getByRole("button",{name:"Agree",exact:true}).click();
  const review=page.getByRole("dialog",{name:"Borehole logs read from documents"});
  const picker=review.getByRole("region",{name:"Report page selection"});
  await expect(picker).toBeVisible();
  return {review,picker};
}

test("mixed report pages can be previewed and excluded before OCR and Qwen",async({page})=>{
  const expensive:string[]=[];
  page.on("request",req=>{if(/ocr\.worker-|reportQwen[^/]*worker-|huggingface\.co/.test(req.url()))expensive.push(req.url())});
  const {review,picker}=await openMixedReportPicker(page);
  await expect(picker.getByRole("checkbox",{name:"Read page 1"})).not.toBeChecked();
  await expect(picker.getByRole("checkbox",{name:"Read page 2"})).toBeChecked();
  const scan=picker.getByRole("checkbox",{name:"Read page 3"});
  await expect(scan).toBeChecked();
  await picker.getByRole("button",{name:"Preview page 3"}).click();
  await expect(picker.getByRole("heading",{name:"Source · page 3"})).toBeVisible();
  await picker.getByRole("button",{name:"Select log and location pages"}).click();
  await expect(scan).not.toBeChecked();
  await expect(picker).toContainText("1 of 3 pages selected · 1 excluded page has no usable indexed text");
  expect(expensive).toEqual([]);

  // Hold the optional module so cancellation is exercised without needing a physical GPU or model download.
  let release!:()=>void;
  const held=new Promise<void>(r=>{release=r});
  await page.route(/\/assets\/reportQwen-[^/]*\.js$/,async route=>{await held;await route.fallback().catch(()=>{})});
  try{
    await picker.getByText("Local Qwen page suggestions",{exact:true}).click();
    await picker.getByLabel("Analyze").selectOption("checked");
    await picker.getByRole("button",{name:"Get Qwen suggestions"}).click();
    await picker.getByRole("button",{name:"Stop Qwen"}).click();
    await expect(picker).toContainText("Qwen stopped.");
    await expect(scan).not.toBeChecked();
    await picker.getByRole("button",{name:"Read selected pages"}).click();
    await expect(picker).toHaveCount(0);
    await expect(review.locator(".dr-checks")).toContainText("No borehole log was read");
    expect(expensive).toEqual([]);
  }finally{release()}
});

test("Qwen page proposals can be applied during a run and survive stopping and a scoped rerun",async({page})=>{
  const {picker}=await openMixedReportPicker(page);
  // Hold inference at one completed page on the first run. Later callbacks exercise stale and out-of-scope delivery.
  await page.route(/\/assets\/reportQwen-[^/]*\.js$/,route=>route.fulfill({contentType:"application/javascript",body:`
    let run=0;
    export async function suggestReportPages(pages,{signal,onPage}){
      if(++run===1){
        onPage(1,"log");
        await new Promise(resolve=>signal.addEventListener("abort",()=>{onPage(2,"log");resolve()},{once:true}));
      }else if(run===2){
        onPage(1,"other");onPage(2,"schedule");
      }else{onPage(1,"other")}
      return {logs:[],schedules:[],unreadable:[]};
    }`}));
  const first=picker.getByRole("checkbox",{name:"Read page 1"}),second=picker.getByRole("checkbox",{name:"Read page 2"});
  const third=picker.getByRole("checkbox",{name:"Read page 3"});
  const status=picker.locator(".dr-qwen-status");
  const run=picker.getByRole("button",{name:"Get Qwen suggestions"});
  await picker.getByText("Local Qwen page suggestions",{exact:true}).click();
  await picker.getByLabel("Analyze").selectOption("all");
  await run.click();
  await expect(status).toContainText("1 of 2 readable pages classified");
  await expect(picker.getByText("Qwen suggests borehole log",{exact:true})).toHaveCount(1);
  await expect(first).not.toBeChecked();
  await picker.getByRole("button",{name:"Include 1 suggested page"}).click();
  await expect(first).toBeChecked();
  await picker.getByRole("button",{name:"Stop Qwen"}).click();
  await expect(status).toContainText("Qwen stopped. 1 of 2");
  await expect(picker.getByText("Qwen suggests borehole log",{exact:true})).toHaveCount(1);
  await first.uncheck();await third.uncheck();
  await picker.getByLabel("Analyze").selectOption("checked");
  await run.click();
  await expect(status).toContainText("1 of 1 readable page classified");
  await expect(picker.getByText("Qwen suggests borehole log",{exact:true})).toHaveCount(1);
  await expect(picker.getByText("Qwen suggests location schedule",{exact:true})).toHaveCount(1);
  await expect(first).not.toBeChecked();
  await picker.getByRole("button",{name:"Include 1 suggested page"}).click();
  await second.uncheck();
  await run.click();
  await expect(picker.getByText("Qwen did not suggest this page",{exact:true})).toHaveCount(1);
  await expect(picker.getByText("Qwen suggests location schedule",{exact:true})).toHaveCount(1);
  await expect(first).toBeChecked();
  await expect(second).not.toBeChecked();
});

test("Qwen searches for a chosen ground-model input and shows the source passage used for each question",async({page})=>{
  // Keep the actual page index, client and worker request. Substitute two deterministic worker replies.
  await page.addInitScript(()=>{
    type Request={question:"log"|"schedule";excerpt:string}[][];
    const requests:Request[]=[];
    Object.assign(window,{testQwenRequests:requests});
    window.Worker=new Proxy(window.Worker,{construct(original,args){
      if(!String(args[0]).includes("reportQwen.worker"))return Reflect.construct(original,args);
      return {
        onmessage:null as ((event:{data:unknown})=>void)|null,
        postMessage(this:{onmessage:((event:{data:unknown})=>void)|null},request:Request){
          requests.push(request);
          const role=request[0][0].question;
          this.onmessage?.({data:{index:0,role}});
          if(requests.length===1)this.onmessage?.({data:{roles:[role]}});
        },terminate(){}
      };
    }});
  });
  const {picker}=await openMixedReportPicker(page);
  await picker.getByText("Local Qwen page suggestions",{exact:true}).click();
  const goal=picker.getByLabel("Find evidence for"),scope=picker.getByLabel("Analyze");
  const run=picker.getByRole("button",{name:"Get Qwen suggestions"}),second=picker.getByRole("checkbox",{name:"Read page 2"});
  await expect(goal).toHaveValue("both");await expect(scope).toHaveValue("likely");
  await goal.selectOption("schedule");await second.uncheck();
  await expect(picker.locator(".dr-qwen-scope-note")).toContainText("1 of 3 pages will be searched");
  await run.click();
  await expect(picker.locator(".dr-qwen-missing")).toContainText("completed collar locations");
  await expect(second).not.toBeChecked();
  await picker.getByRole("button",{name:"Inspect Qwen text for page 2"}).click();
  const passages=picker.getByRole("region",{name:"Text Qwen evaluated"});
  await expect(picker.getByRole("heading",{name:"Source · page 2"})).toBeVisible();
  await expect(passages.getByRole("heading",{name:"Completed collar locations"})).toBeVisible();
  const request=()=>page.evaluate(()=>(window as unknown as {testQwenRequests:{question:string;excerpt:string}[][][]}).testQwenRequests);
  const first=(await request())[0];
  expect(first).toHaveLength(1);expect(first[0].map(q=>q.question)).toEqual(["schedule"]);
  expect(first[0][0].excerpt).toContain("530000");
  expect(await passages.locator("pre").allTextContents()).toEqual([first[0][0].excerpt]);
  await picker.getByRole("button",{name:"Include 1 suggested page"}).click();
  await expect(picker.locator(".dr-qwen-missing")).toBeEmpty();
  await goal.selectOption("log");await expect(run).toBeDisabled();
  await scope.selectOption("checked");await run.click();
  await expect(picker).toContainText("Qwen suggests borehole log and location schedule");
  await picker.getByRole("button",{name:"Stop Qwen"}).click();
  await expect(picker).toContainText("Qwen stopped.");
  await expect(second).toBeChecked();
  const secondRun=(await request())[1];
  expect(secondRun).toHaveLength(1);expect(secondRun[0].map(q=>q.question)).toEqual(["log"]);
  expect(await passages.locator("pre").allTextContents()).toEqual([first[0][0].excerpt,secondRun[0][0].excerpt]);
});
