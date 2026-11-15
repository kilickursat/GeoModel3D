import {test,expect,Page,Locator} from "@playwright/test";
import {existsSync,readFileSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import type {GeoProject} from "../../src/schema";
import {acceptCoreRun} from "../../src/corePhoto";
import {build,downloadJson,importJson,openInput,prepare,saved} from "./helpers";

const maliciousDescription='=HYPERLINK("https://example.invalid","<img src=x onerror=globalThis.depthInjected=true>")';
const modelRequest=(url:string)=>/core(?:Ai|Benchmark)[.-]worker|https:\/\/(?:[^/]+\.)?(?:huggingface\.co|hf\.co|hf\.space|xethub\.hf\.co)\//i.test(url);

// Synthetic drawing and manual annotations only. No image inference or geological accuracy is tested here.
async function fixture(page:Page,accepted=false):Promise<GeoProject>{
  const image=await page.evaluate(()=>{
    const canvas=document.createElement("canvas");canvas.width=1000;canvas.height=500;
    const c=canvas.getContext("2d")!;c.fillStyle="#e8e0d2";c.fillRect(0,0,1000,500);
    c.font="22px sans-serif";c.fillStyle="#273d45";c.fillText("SYNTHETIC DEPTH LOG · UI TEST ONLY",100,30);
    c.fillStyle="#bd765c";c.fillRect(100,50,400,150);c.fillStyle="#6d8b97";c.fillRect(500,50,400,150);
    c.fillStyle="#bd765c";c.fillRect(100,275,533,150);c.fillStyle="#6d8b97";c.fillRect(633,275,267,150);
    c.fillStyle="#273d45";c.fillText("0.5 m → 1.5 m",100,240);c.fillText("3.5 m ← 2.0 m",100,465);
    return canvas.toDataURL("image/png");
  });
  const project:GeoProject={
    name:"Depth-linked core evidence",crs:"Local grid",base:4,margin:2,
    units:[{id:"alpha",name:"Alpha annotation",color:"#bd765c"},{id:"beta",name:"Beta annotation",color:"#6d8b97"}],
    boreholes:[{id:"BH-01",x:0,y:0,z:10,depth:4,intervals:[{from:0,to:1,unit:"alpha"},{from:1,to:2.5,unit:"beta"},{from:2.5,to:3.2,unit:"alpha"},{from:3.2,to:4,unit:"beta"}],tests:[{depth:2,property:"qu",value:1000}]},
      {id:"BH-02",x:10,y:0,z:10,depth:4,intervals:[{from:0,to:1,unit:"alpha"},{from:1,to:4,unit:"beta"}]}],
    evidence:{version:1,sources:[{id:"depth-source",name:"=Synthetic depth source.png",sha256:"a".repeat(64),pages:[{page:1,width:1000,height:500,image}]}],records:[]},
    corePhotos:{version:1,runs:[{id:"depth-run",boreholeId:"BH-01",sourceId:"depth-source",from:0,to:4,lossReviewed:accepted,status:"draft",rows:[
      {id:"row-late",box:{x0:.1,y0:.55,x1:.9,y1:.85},from:2,to:3.5,direction:"rtl",registrationReviewed:accepted,pieces:[
        {id:"piece-c",end:2.5,sound:accepted?"sound":"unknown",breakAfter:"natural",unit:"beta",description:"Shallow end of the RTL row"},
        {id:"piece-d",end:3.5,sound:accepted?"sound":"unknown",breakAfter:"end",unit:"alpha",description:maliciousDescription}]},
      {id:"row-early",box:{x0:.1,y0:.1,x1:.9,y1:.4},from:.5,to:1.5,direction:"ltr",registrationReviewed:accepted,pieces:[
        {id:"piece-a",end:1,sound:accepted?"sound":"unknown",breakAfter:"natural",unit:"alpha",description:"First depth-ordered piece"},
        {id:"piece-b",end:1.5,sound:accepted?"sound":"unknown",breakAfter:"end",unit:"beta",description:"Second depth-ordered piece"}]}]}]}
  };
  if(!accepted)return project;
  const reviewed=acceptCoreRun(project,"depth-run",{reviewer:"Synthetic reviewer",replaceExisting:true});
  // Current log edits deliberately differ from immutable accepted photo annotations.
  reviewed.boreholes[0].intervals=structuredClone(project.boreholes[0].intervals);
  return reviewed;
}

async function load(page:Page,accepted=false){
  await prepare(page);await page.goto("/?backend=webgl#input");await openInput(page);
  const project=await fixture(page,accepted);await importJson(page,project,"depth-log-project.json");await saved(page);return project;
}
async function openDepth(page:Page){
  await page.locator('[data-step="logs"]').click();await page.locator(".ws-core-photos").click();
  const dialog=page.locator(".core-dialog");await expect(dialog).toBeVisible();await dialog.locator(".core-depth-toggle").click();
  await expect(dialog.locator(".core-depth-view")).toBeVisible();return dialog;
}
async function close(page:Page){await page.locator(".core-close").click();await expect(page.locator(".core-dialog")).toHaveCount(0)}
async function selectInterval(dialog:Locator,from:number,to:number){
  const selector=dialog.locator(".core-depth-select");
  const value=await selector.locator("option").evaluateAll((options,range)=>{
    const [from,to]=range;
    return options.find(option=>new RegExp(`^${from}\\s*[–-]\\s*${to}(?:\\s|m|$)`).test(option.textContent??""))?.getAttribute("value");
  },[from,to]);
  expect(value,`An interval selector option must expose ${from}–${to} m`).toBeTruthy();await selector.focus();await selector.selectOption(value!);
}
async function selectedBox(dialog:Locator){
  const selected=dialog.locator(".core-photo-depth-selection.selected");await expect(selected).toHaveCount(1);
  return selected.evaluate(el=>({left:parseFloat(el.style.left),top:parseFloat(el.style.top),width:parseFloat(el.style.width),height:parseFloat(el.style.height)}));
}
function csvRows(text:string){
  const rows:string[][]=[];let row:string[]=[],value="",quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++}else quoted=!quoted}
    else if(c===","&&!quoted){row.push(value);value=""}
    else if((c==="\r"||c==="\n")&&!quoted){if(c==="\r"&&text[i+1]==="\n")i++;row.push(value);rows.push(row);row=[];value=""}
    else value+=c;
  }
  if(row.length||value){row.push(value);rows.push(row)}
  expect(quoted).toBe(false);return rows;
}
async function exportCsv(page:Page){
  const pending=page.waitForEvent("download");await page.locator(".core-depth-export").click();const download=await pending,path=await download.path();
  expect(path).not.toBeNull();const text=await readFile(path!,"utf8"),rows=csvRows(text),headers=rows.shift()!;
  return {text,headers,rows:rows.map(row=>Object.fromEntries(headers.map((key,index)=>[key,row[index]]))),filename:download.suggestedFilename()};
}

test("core depth log aligns unsorted rows and gaps, maps RTL selection, and leaves the workspace unchanged",async({page},testInfo)=>{
  const requests:string[]=[],errors:string[]=[];page.on("request",r=>{if(modelRequest(r.url()))requests.push(r.url())});page.on("pageerror",e=>errors.push(e.message));
  await load(page);const before:any=await downloadJson(page),beforeProject:any=await downloadJson(page,".ws-json");
  const dialog=await openDepth(page);await expect(dialog.locator(".core-depth-view")).toContainText(/unrepresented/i);
  await selectInterval(dialog,3.2,3.5);await expect(dialog.locator(".core-row")).toHaveValue("row-late");
  await expect(dialog.locator(".core-depth-details")).toContainText(/different/i);
  const box=await selectedBox(dialog);expect(box.left).toBeCloseTo(10,6);expect(box.top).toBeCloseTo(55,6);expect(box.width).toBeCloseTo(16,6);expect(box.height).toBeCloseTo(30,6);
  await dialog.locator(".core-depth-inspect").click();await expect(dialog.locator(".core-photo-depth-selection.selected")).toBeFocused();
  await expect(dialog.locator('.core-piece[data-piece="piece-d"]')).toBeVisible();
  await expect(dialog.locator(".core-depth-details")).toContainText(maliciousDescription);
  expect(await page.evaluate(()=>Boolean((globalThis as any).depthInjected))).toBe(false);await expect(dialog.locator(".core-depth-host img")).toHaveCount(0);
  await selectInterval(dialog,0,.5);await expect(dialog.locator(".core-photo-depth-selection.selected")).toHaveCount(0);
  await expect(dialog.locator(".core-depth-details")).toContainText(/unrepresented/i);await expect(dialog.locator(".core-depth-inspect")).toBeHidden();
  await dialog.locator('.core-depth-photo-segment[data-segment="1"]').click();await expect(dialog.locator(".core-row")).toHaveValue("row-early");
  expect(await selectedBox(dialog)).toMatchObject({left:10,top:10,width:40});
  await expect(dialog.locator(".core-depth-select")).toBeFocused();
  const csv=await exportCsv(page);expect(csv.filename).toMatch(/\.csv$/);expect(csv.text).not.toContain("data:image");
  expect(csv.rows.map(r=>[Number(r.from_m),Number(r.to_m),r.photo_state,r.comparison])).toEqual([
    [0,.5,"unrepresented","no-photo"],[.5,1,"piece","same-unit"],[1,1.5,"piece","same-unit"],[1.5,2,"unrepresented","no-photo"],
    [2,2.5,"piece","same-unit"],[2.5,3.2,"piece","same-unit"],[3.2,3.5,"piece","different-unit"],[3.5,4,"unrepresented","no-photo"]]);
  const split=csv.rows.find(r=>Number(r.from_m)===3.2)!;
  expect(split).toMatchObject({run_id:"depth-run",borehole_id:"BH-01",source_id:"depth-source",source_name:"'=Synthetic depth source.png",source_sha256:"a".repeat(64),run_status:"draft",row_id:"row-late",piece_id:"piece-d",photo_direction:"rtl",photo_unit_id:"alpha",current_log_unit_id:"beta",photo_description:"'"+maliciousDescription,photo_piece_break_after:"end",segment_ends_piece:"true"});
  expect(csv.rows.find(r=>Number(r.from_m)===2.5)).toMatchObject({piece_id:"piece-d",photo_piece_break_after:"end",segment_ends_piece:"false"});
  expect(Number(split.photo_box_x0)).toBeCloseTo(.1,9);expect(Number(split.photo_box_x1)).toBeCloseTo(.26,9);expect(Number(split.photo_piece_from_m)).toBe(2.5);expect(Number(split.photo_piece_to_m)).toBe(3.5);
  expect(csv.rows.reduce((sum,r)=>sum+Number(r.length_m),0)).toBeCloseTo(4,9);
  await selectInterval(dialog,3.2,3.5);await dialog.locator(".core-photo-sheet").scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("core-depth-log-source.png"),fullPage:true});
  await dialog.locator(".core-depth-chart").scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("core-depth-log-desktop.png"),fullPage:true});
  page.once("dialog",()=>{throw new Error("Read-only navigation must not prompt about unsaved annotations")});await close(page);
  expect(await downloadJson(page,".ws-json")).toEqual(beforeProject);const after:any=await downloadJson(page);
  expect(after.draft).toEqual(before.draft);expect(after.revisions).toEqual(before.revisions);expect(after.scenarios).toEqual(before.scenarios);expect(after.evidenceImages).toEqual(before.evidenceImages);
  expect(requests).toEqual([]);expect(errors).toEqual([]);
});

test("core depth log keeps accepted photo evidence distinct from the edited current log in the model inspector",async({page})=>{
  await load(page,true);await build(page);const before:any=await downloadJson(page,".ws-json");
  await page.getByRole("tab",{name:"3-D model",exact:true}).click();await page.locator(".site-core-photos summary").click();await page.locator('[data-core-run="depth-run"]').click();
  const dialog=page.locator(".core-dialog");await expect(dialog).toBeVisible();await dialog.locator(".core-depth-toggle").click();
  await expect(dialog.locator(".core-depth-view")).toContainText(/accepted/i);await expect(dialog.locator(".core-depth-view")).toContainText(/missing core/i);
  await selectInterval(dialog,3.2,3.5);await expect(dialog.locator(".core-depth-details")).toContainText(/different/i);
  await expect(dialog.locator('.core-piece[data-piece="piece-d"] .core-piece-unit')).toHaveValue("alpha");await expect(dialog.locator('.core-piece[data-piece="piece-d"] .core-piece-unit')).toBeDisabled();
  await expect(dialog.locator(".core-save")).toBeHidden();await expect(dialog.locator(".core-accept")).toHaveCount(0);
  await close(page);await openInput(page);expect(await downloadJson(page,".ws-json")).toEqual(before);
});

test("core depth log refreshes draft descriptions and CSV without replacing accepted borehole observations",async({page})=>{
  await load(page,true);const before:any=await downloadJson(page,".ws-json"),dialog=await openDepth(page);
  await selectInterval(dialog,3.2,3.5);const description=dialog.locator('.core-piece[data-piece="piece-d"] .core-piece-description');
  await description.fill("Revised manual description after opening the depth log");const csv=await exportCsv(page);
  await expect(dialog.locator(".core-run-state")).toContainText("Draft");await expect(dialog.locator(".core-depth-intro")).toContainText("draft");
  const changed=csv.rows.filter(r=>r.piece_id==="piece-d");expect(changed).toHaveLength(2);
  for(const row of changed)expect(row).toMatchObject({run_status:"draft",photo_description:"Revised manual description after opening the depth log"});
  await dialog.locator(".core-save").click();await close(page);const after:any=await downloadJson(page,".ws-json");
  expect(after.boreholes).toEqual(before.boreholes);expect(after.evidence).toEqual(before.evidence);expect(after.corePhotos.runs[0].status).toBe("draft");
});

test("core depth log bounds large charts and exports all intervals after a narrow depth selection",async({page})=>{
  await prepare(page);await page.goto("/?backend=webgl#input");await openInput(page);const p=await fixture(page),run=p.corePhotos!.runs[0];run.rows=[run.rows[1]];
  const row=run.rows[0];row.from=0;row.to=4;row.pieces=Array.from({length:1100},(_,i)=>({id:`small-${i}`,end:(i+1)*4/1100,sound:"unknown",breakAfter:i===1099?"end":"natural",unit:"alpha",description:`Small synthetic interval ${i}`}));
  await importJson(page,p);await saved(page);const dialog=await openDepth(page);
  await expect(dialog.locator(".core-depth-view")).toContainText(/narrow/i);await expect(dialog.locator(".core-depth-select")).toBeDisabled();
  await dialog.locator(".core-depth-window-from").fill("1");await dialog.locator(".core-depth-window-to").fill("1.1");await dialog.locator(".core-depth-apply").click();
  await expect(dialog.locator(".core-depth-select")).toBeEnabled();const visible=await dialog.locator(".core-depth-select option").count();expect(visible).toBeGreaterThan(20);expect(visible).toBeLessThan(40);
  const csv=await exportCsv(page);expect(csv.rows.length).toBeGreaterThanOrEqual(1100);
  await dialog.locator(".core-depth-reset").click();await expect(dialog.locator(".core-depth-select")).toBeDisabled();await close(page);
});

test("mobile core depth log fits and supports keyboard source selection without editing annotations",async({page},testInfo)=>{
  await load(page);const before:any=await downloadJson(page,".ws-json"),dialog=await openDepth(page);
  await selectInterval(dialog,3.2,3.5);await expect(dialog.locator(".core-depth-select")).toBeFocused();
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);expect(await dialog.locator(".core-content").evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  expect(await dialog.locator(".core-depth-view").evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  for(let i=0;i<18;i++){await page.keyboard.press("Tab");expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true)}
  await dialog.locator(".core-depth-chart").scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("core-depth-log-mobile.png"),fullPage:true});
  await close(page);await expect(page.locator(".ws-core-photos")).toBeFocused();expect(await downloadJson(page,".ws-json")).toEqual(before);
});

test("standalone core depth log maps and exports photo evidence with networking disabled",async({page,context},testInfo)=>{
  await prepare(page);await page.goto("/?backend=webgl#input");const p=await fixture(page,true),file=resolve("dist/geomodel3d-offline.html");
  expect(existsSync(file),"Build the standalone HTML before browser validation").toBe(true);const html=readFileSync(file,"utf8"),errors:string[]=[],requests:string[]=[];
  await page.route("**/*",route=>route.request().isNavigationRequest()?route.fulfill({status:200,contentType:"text/html",body:html}):route.abort());await context.setOffline(true);
  page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(modelRequest(r.url()))requests.push(r.url())});
  await page.goto("http://127.0.0.1:4173/standalone-core-depth-log.html?backend=webgl#input");await openInput(page);await importJson(page,p);await saved(page);const before:any=await downloadJson(page,".ws-json");
  const dialog=await openDepth(page);await selectInterval(dialog,3.2,3.5);expect((await selectedBox(dialog)).width).toBeCloseTo(16,6);
  const csv=await exportCsv(page);expect(csv.rows.length).toBeGreaterThan(5);await dialog.locator(".core-depth-chart").scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("core-depth-log-offline.png"),fullPage:true});
  await close(page);expect(await downloadJson(page,".ws-json")).toEqual(before);expect(requests).toEqual([]);expect(errors).toEqual([]);
});
