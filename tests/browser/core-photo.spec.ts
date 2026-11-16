import {test,expect,Page,Locator} from "@playwright/test";
import {existsSync,readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {build,downloadJson,importJson,openInput,prepare,resume,saved} from "./helpers";

const appVersion=JSON.parse(readFileSync(resolve("package.json"),"utf8")).version as string;

// This drawing is a synthetic test fixture, not a photograph or a geological training example.
async function photo(page:Page){
  return page.evaluate(()=>{
    const canvas=document.createElement("canvas");canvas.width=1200;canvas.height=400;
    const c=canvas.getContext("2d")!;c.fillStyle="#d8c9ae";c.fillRect(0,0,1200,400);
    c.fillStyle="#4c453d";c.fillRect(40,65,1120,100);c.fillRect(40,235,1120,100);
    for(const y of [78,248])for(let i=0;i<12;i++){
      c.fillStyle=["#ada48f","#8c8c7b","#c4b99e"][i%3];c.fillRect(60+i*90,y,84,72);
      c.strokeStyle="#665f54";c.beginPath();c.moveTo(70+i*90,y+15);c.lineTo(125+i*90,y+48);c.stroke();
    }
    c.fillStyle="#181818";c.font="24px sans-serif";c.fillText("SYNTHETIC CORE BOX · UI TEST ONLY",45,35);
    c.font="17px sans-serif";c.fillText("0 m → 0.9 m · final 0.1 m missing",45,195);c.fillText("← alternate row direction",45,370);
    return canvas.toDataURL("image/png");
  });
}

function project(image?:string){
  return {
    name:"Core photo validation",crs:"Local grid",base:7,margin:2,
    units:[{id:"rock",name:"Reviewed rock",color:"#8c8c7b"}],
    boreholes:[{id:"BH-01",x:0,y:0,z:10,depth:2,intervals:[{from:0,to:2,unit:"rock",name:"Existing log"}]},
      {id:"BH-02",x:20,y:0,z:10,depth:2,intervals:[{from:0,to:2,unit:"rock"}]},
      {id:"BH-03",x:0,y:20,z:10,depth:2,intervals:[{from:0,to:2,unit:"rock"}]}],
    ...(image?{evidence:{version:1,sources:[{id:"core-source",name:"Synthetic core box.png",pages:[{page:1,width:1200,height:400,image}]}],records:[]},
      corePhotos:{version:1,runs:[{id:"core-run",boreholeId:"BH-01",sourceId:"core-source",from:0,to:1,lossReviewed:false,status:"draft",
        rows:[{id:"core-row",box:{x0:.05,y0:.195,x1:.95,y1:.375},from:0,to:.9,direction:"ltr",registrationReviewed:false,
          pieces:[{id:"piece-a",end:.08,sound:"unknown",breakAfter:"mechanical",unit:"rock",description:"Short sound piece joined at a drilling break"},
            {id:"piece-b",end:.16,sound:"unknown",breakAfter:"natural",unit:"rock",description:"Matching second piece"},
            {id:"piece-c",end:.5,sound:"unknown",breakAfter:"natural",unit:"rock",description:"Unsound material"},
            {id:"piece-d",end:.9,sound:"unknown",breakAfter:"end",unit:"rock",description:"Sound rock"}]}]}]}}:{})
  };
}

async function load(page:Page,registered=false){
  await prepare(page);await page.goto("/?backend=webgl#input");await openInput(page);
  const image=await photo(page),p=project(registered?image:undefined);
  await importJson(page,p,"core-project.json");await saved(page);return {image,project:p};
}
async function openCore(page:Page){
  await page.locator('[data-step="logs"]').click();await page.locator(".ws-core-photos").click();
  const dialog=page.locator(".core-dialog");await expect(dialog).toBeVisible();return dialog;
}
async function closeCore(page:Page){
  await page.locator(".core-close").click();await expect(page.locator(".core-dialog")).toHaveCount(0);await saved(page);
}
async function review(dialog:Locator){
  await dialog.locator(".core-registration").check();
  for(const [i,sound] of ["sound","sound","unsound","sound"].entries())await dialog.locator(".core-piece").nth(i).locator(".core-piece-sound").selectOption(sound);
  await dialog.locator(".core-loss-reviewed").check();await dialog.locator(".core-reviewer").fill("Synthetic test reviewer");
}
async function accept(dialog:Locator){
  await dialog.locator(".core-replace").check();await dialog.locator(".core-accept").click();
  await expect(dialog.locator(".core-result")).toContainText(/56(?:\.0+)?\s*%/);
}

test("core photo upload registers recovered rows and accepts only reviewed RQD with explicit log replacement",async({page},testInfo)=>{
  test.setTimeout(90_000);const {image}=await load(page),unfinished=["BH-02","7","","rock","Unfinished unrelated logging"];
  await page.locator('[data-step="boreholes"]').click();await page.locator('.ed-table input[data-r="0"][data-c="6"]').fill("unfinished depth");await saved(page);
  await page.locator('[data-step="logs"]').click();await page.locator(".ed-add").click();
  for(const [column,value] of unfinished.entries())await page.locator('.ed-table tbody tr').last().locator(`input[data-c="${column}"]`).fill(value);
  await saved(page);const dialog=await openCore(page);
  await expect(page.locator(".title span")).toHaveText(appVersion);
  await dialog.locator(".core-upload").setInputFiles({name:"synthetic-core.png",mimeType:"image/png",buffer:Buffer.from(image.split(",")[1],"base64")});
  await dialog.locator(".core-borehole").selectOption("BH-01");await dialog.locator(".core-from").fill("0");await dialog.locator(".core-to").fill("1");
  await expect(dialog.locator(".core-add-run")).toBeEnabled();await dialog.locator(".core-add-run").click();
  await dialog.locator(".core-row-from").fill("0");await dialog.locator(".core-row-to").fill("0.9");
  await dialog.locator(".core-row-y0").fill("19.5");await dialog.locator(".core-row-y1").fill("37.5");
  await dialog.locator(".core-add-row").click();
  for(const depth of ["0.08","0.16","0.5"]){await dialog.locator(".core-cut-depth").fill(depth);await dialog.locator(".core-add-cut").click()}
  await expect(dialog.locator(".core-piece")).toHaveCount(4);
  // Local AI descriptions are an opt-in lab (?labs=core-ai): the ordinary review offers no model.
  await expect(dialog.locator(".core-ai-open, .core-ai-piece-open")).toHaveCount(0);
  await expect(dialog.locator(".core-result")).toContainText(/pending|review|unavailable/i);
  if(await dialog.locator(".core-accept").isEnabled())await dialog.locator(".core-accept").click();
  await expect(dialog.locator(".core-result")).toContainText(/pending|review|unavailable/i);
  await expect(dialog.locator(".core-run-state")).toContainText("Draft");
  for(const [i,breakAfter] of ["mechanical","natural","natural","end"].entries()){
    const piece=dialog.locator(".core-piece").nth(i);await piece.locator(".core-piece-break").selectOption(breakAfter);await piece.locator(".core-piece-unit").selectOption("rock");
  }
  await review(dialog);await expect(dialog.locator(".core-result")).toContainText(/90(?:\.0+)?\s*%/);
  await dialog.locator(".core-accept").click();await expect(dialog.locator(".core-notice")).toContainText(/overlap|existing/i);
  await expect(dialog.locator(".core-run-state")).toContainText("Draft");
  await dialog.locator(".core-accept").hover();
  const contrast=await dialog.locator(".core-accept").evaluate(button=>{
    const style=getComputedStyle(button),luminance=(color:string)=>{
      const rgb=color.match(/[\d.]+/g)!.slice(0,3).map(v=>Number(v)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
      return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
    },a=luminance(style.color),b=luminance(style.backgroundColor);
    return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await accept(dialog);await dialog.locator(".core-result").scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("core-photo-reviewed-desktop.png"),fullPage:true});await closeCore(page);
  const acceptedDraft:any=await downloadJson(page);expect(acceptedDraft.draft.tables.rows.logs).toContainEqual(unfinished);
  expect(acceptedDraft.draft.tables.rows.boreholes.find((r:string[])=>r[0]==="BH-01")[6]).toBe("unfinished depth");
  const p:any=await downloadJson(page,".ws-json"),run=p.corePhotos.runs[0],logged=p.boreholes.find((b:any)=>b.id==="BH-01");
  expect(run.status).toBe("accepted");expect(run.reviewedBy).toBe("Synthetic test reviewer");expect(logged.tests??[]).toEqual([]);
  expect(logged.intervals.map((i:any)=>[i.from,i.to])).toEqual([[0,.08],[.08,.16],[.16,.5],[.5,.9],[1,2]]);
  expect(p.evidence.sources[0].sha256).toMatch(/^[a-f0-9]{64}$/);expect(p.evidence.sources[0].pages[0].image).toMatch(/^data:image\/png;base64,/);
  const sourceId=logged.intervals[0].evidenceId,record=p.evidence.records.find((r:any)=>r.id===sourceId);expect(record).toBeDefined();
  expect(record.sourceId).toBe(run.sourceId);expect(Object.values(record.fields).some((f:any)=>f.boxes.length>0)).toBe(true);
  await build(page);await page.getByRole("tab",{name:"3-D model",exact:true}).click();
  await page.locator(".site-evidence summary").click();await page.locator(`.site-evidence [data-evidence="${sourceId}"]`).click();
  await expect(page.locator(".ev-page-image")).toBeVisible();await expect(page.locator(".ev-box").first()).toBeVisible();await page.keyboard.press("Escape");
  await page.locator(".site-core-photos summary").click();await page.locator(`[data-core-run="${run.id}"]`).click();
  await expect(page.locator(".core-dialog")).toBeVisible();if(await page.locator(".core-accept").count())await expect(page.locator(".core-accept")).toBeDisabled();
  await page.screenshot({path:testInfo.outputPath("core-photo-model-evidence.png"),fullPage:true});await closeCore(page);await openInput(page);
  const revision=await openCore(page);await revision.locator(".core-cut-depth").fill("0.7");await revision.locator(".core-add-cut").click();
  await expect(revision.locator(".core-piece")).toHaveCount(5);await expect(revision.locator(".core-run-state")).toContainText("Draft");
  await expect(revision.locator(".core-result")).toContainText("Pending review");await revision.locator(".core-save").click();await closeCore(page);
  const amended:any=await downloadJson(page,".ws-json");expect(amended.corePhotos.runs[0].status).toBe("draft");
  expect(amended.boreholes.find((b:any)=>b.id==="BH-01").intervals).toEqual(logged.intervals);expect(amended.evidence.records).toEqual(p.evidence.records);
  const amendedDraft:any=await downloadJson(page);expect(amendedDraft.draft.tables.rows.logs).toContainEqual(unfinished);
  expect(amendedDraft.draft.tables.rows.boreholes.find((r:string[])=>r[0]==="BH-01")[6]).toBe("unfinished depth");
});

test("core photo drafts survive workspace export, reload and independent scenario edits",async({page},testInfo)=>{
  await load(page,true);let dialog=await openCore(page);await dialog.locator(".core-piece").first().locator(".core-piece-description").fill("Original unfinished photo interpretation");
  await dialog.locator(".core-save").click();await closeCore(page);const original:any=await downloadJson(page),first=original.activeScenarioId;
  expect(original.draft.tables.corePhotos.runs[0].status).toBe("draft");expect(Object.keys(original.evidenceImages)).toHaveLength(1);
  await resume(page);dialog=await openCore(page);await expect(dialog.locator(".core-piece-description").first()).toHaveValue("Original unfinished photo interpretation");await closeCore(page);
  await page.locator('[data-step="scenarios"]').click();await page.locator(".ws-scenario-name").fill("Alternative photo log");await page.locator(".ws-scenario-create").click();await saved(page);
  dialog=await openCore(page);await dialog.locator(".core-piece-description").first().fill("Alternative interpretation, still unreviewed");await dialog.locator(".core-save").click();await closeCore(page);
  const alternative:any=await downloadJson(page);expect(alternative.activeScenarioId).not.toBe(first);expect(alternative.draft.tables.corePhotos.runs[0].rows[0].pieces[0].description).toBe("Alternative interpretation, still unreviewed");
  await page.locator('[data-step="scenarios"]').click();await page.locator(".ws-scenario-select").selectOption(first);await saved(page);
  const restored:any=await downloadJson(page);expect(restored.draft.tables.corePhotos).toEqual(original.draft.tables.corePhotos);expect(restored.revisions).toEqual(original.revisions);
  writeFileSync(testInfo.outputPath("core-photo-workspace.json"),JSON.stringify(restored,null,2)+"\n");
  page.once("dialog",d=>d.accept());await importJson(page,restored);await saved(page);dialog=await openCore(page);
  await expect(dialog.locator(".core-piece-description").first()).toHaveValue("Original unfinished photo interpretation");await expect(dialog.locator(".core-photo")).toBeVisible();
});

test("core photo right-to-left registration maps a photo click to depth and saves the source bounds",async({page})=>{
  const {image}=await load(page);const p:any=project(image),row=p.corePhotos.runs[0].rows[0];row.direction="rtl";row.to=1;row.pieces=[{id:"rtl-piece",end:1,sound:"unknown",breakAfter:"end",unit:"rock",description:"Right to left"}];
  page.once("dialog",d=>d.accept());await importJson(page,p);await saved(page);const dialog=await openCore(page);
  await dialog.locator(".core-photo-cut").click();const bounds=await dialog.locator(".core-photo").boundingBox();expect(bounds).not.toBeNull();
  await page.mouse.click(bounds!.x+bounds!.width*.275,bounds!.y+bounds!.height*.285);
  await expect(dialog.locator(".core-piece")).toHaveCount(2);await dialog.locator(".core-save").click();await closeCore(page);
  const exported:any=await downloadJson(page,".ws-json"),actual=exported.corePhotos.runs[0].rows[0];expect(actual.direction).toBe("rtl");expect(actual.pieces[0].end).toBeCloseTo(.75,2);
  expect(actual.box).toEqual({x0:.05,y0:.195,x1:.95,y1:.375});expect(actual.registrationReviewed).toBe(false);
});

test("core photo first project starts from a collar and unit without an invented log",async({page})=>{
  test.setTimeout(90_000);await prepare(page);await page.goto("/?backend=webgl#input");await openInput(page);
  const image=await photo(page);await page.locator('[data-start="new"]').click();await saved(page);
  await page.locator('[data-step="units"]').click();await page.locator('.ed-table input[data-r="0"][data-c="0"]').fill("rock");
  await page.locator('.ed-table input[data-r="0"][data-c="1"]').fill("Reviewed rock");await saved(page);
  await page.locator('[data-step="boreholes"]').click();await page.locator(".ws-core-photos").click();let dialog=page.locator(".core-dialog");await expect(dialog).toBeVisible();
  await dialog.locator(".core-upload").setInputFiles({name:"first-core.png",mimeType:"image/png",buffer:Buffer.from(image.split(",")[1],"base64")});
  await expect(dialog.locator(".core-add-run")).toBeEnabled();await dialog.locator(".core-add-run").click();
  await dialog.locator(".core-add-row").click();await dialog.locator(".core-save").click();await closeCore(page);
  const draft:any=await downloadJson(page);expect(draft.draft.tables.corePhotos.runs).toHaveLength(1);expect(draft.draft.tables.corePhotos.runs[0].status).toBe("draft");
  expect(draft.draft.tables.rows.logs.filter((r:string[])=>r[2].trim()&&r[3].trim())).toHaveLength(0);
  await resume(page);dialog=await openCore(page);await dialog.locator(".core-registration").check();await dialog.locator(".core-piece-sound").selectOption("sound");
  await dialog.locator(".core-piece-unit").selectOption("rock");await dialog.locator(".core-loss-reviewed").check();await dialog.locator(".core-reviewer").fill("Photo-first reviewer");
  await expect(dialog.locator(".core-replace")).not.toBeChecked();await dialog.locator(".core-accept").click();
  await expect(dialog.locator(".core-run-state")).toContainText("Accepted by Photo-first reviewer");await closeCore(page);await build(page);
  const result:any=await downloadJson(page,".ws-json");expect(result.boreholes).toHaveLength(1);expect(result.boreholes[0]).toMatchObject({id:"BH-01",x:0,y:0,z:0});
  expect(result.boreholes[0].intervals).toHaveLength(1);expect(result.boreholes[0].intervals[0]).toMatchObject({from:0,to:1,unit:"rock"});
  expect(result.corePhotos.runs[0].status).toBe("accepted");expect(result.boreholes[0].tests??[]).toEqual([]);
});

test("core photo runs can repair a renamed collar one registration at a time",async({page})=>{
  const {image}=await load(page),p:any=project(image),second=structuredClone(p.corePhotos.runs[0]);
  second.id="second-run";second.from=1;second.to=2;
  for(const row of second.rows){row.id="second-row";row.from+=1;row.to+=1;for(const piece of row.pieces){piece.id=`second-${piece.id}`;piece.end+=1}}
  p.corePhotos.runs.push(second);page.once("dialog",d=>d.accept());await importJson(page,p);await saved(page);
  await page.locator('[data-step="boreholes"]').click();await page.locator('.ed-table input[data-r="0"][data-c="0"]').fill("BH-01-renamed");await saved(page);
  await page.locator(".ws-core-photos").click();const dialog=page.locator(".core-dialog");await expect(dialog).toBeVisible();
  for(const id of ["core-run","second-run"]){
    await dialog.locator(".core-run").selectOption(id);await dialog.locator(".core-edit-run-panel summary").click();
    await dialog.locator(".core-edit-borehole").selectOption("BH-01-renamed");await dialog.locator(".core-edit-run").click();
    await expect(dialog.locator(".core-run-heading h3")).toContainText("BH-01-renamed");
  }
  await dialog.locator(".core-save").click();await closeCore(page);await build(page);
  const result:any=await downloadJson(page,".ws-json");expect(result.corePhotos.runs.map((r:any)=>r.boreholeId)).toEqual(["BH-01-renamed","BH-01-renamed"]);
  expect(result.boreholes.some((b:any)=>b.id==="BH-01-renamed")).toBe(true);
});

test("mobile core photo review fits iPhone Chromium emulation and preserves keyboard focus",async({page},testInfo)=>{
  await load(page,true);const dialog=await openCore(page);expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  expect(await dialog.locator(".core-content").evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await review(dialog);await accept(dialog);await dialog.locator(".core-result").scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath("core-photo-reviewed-iphone.png"),fullPage:true});
  for(let i=0;i<24;i++){await page.keyboard.press("Tab");expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true)}
  await closeCore(page);await expect(page.locator(".ws-core-photos")).toBeFocused();
  const p:any=await downloadJson(page,".ws-json");expect(p.corePhotos.runs[0].status).toBe("accepted");
});

test("standalone core photo workflow reviews images, saves evidence and builds without networking",async({page,context},testInfo)=>{
  test.setTimeout(90_000);await prepare(page);await page.goto("/?backend=webgl#input");const p=project(await photo(page)),file=resolve("dist/geomodel3d-offline.html");
  expect(existsSync(file),"Build the standalone HTML before browser validation").toBe(true);const html=readFileSync(file,"utf8"),errors:string[]=[];
  await page.route("**/*",route=>route.request().isNavigationRequest()?route.fulfill({status:200,contentType:"text/html",body:html}):route.abort());await context.setOffline(true);
  page.on("pageerror",error=>errors.push(error.message));await page.goto("http://127.0.0.1:4173/standalone-core-photo.html?backend=webgl#input");
  await openInput(page);await importJson(page,p);await saved(page);await expect(page.locator(".title span")).toHaveText(appVersion);
  const dialog=await openCore(page);await expect(dialog.locator(".core-photo")).toBeVisible();await review(dialog);await accept(dialog);
  await page.screenshot({path:testInfo.outputPath("core-photo-offline.png"),fullPage:true});await closeCore(page);await build(page);
  const workspace:any=await downloadJson(page);expect(workspace.revisions.at(-1).project.corePhotos.runs[0].status).toBe("accepted");expect(Object.keys(workspace.evidenceImages)).toHaveLength(1);expect(errors).toEqual([]);
});
