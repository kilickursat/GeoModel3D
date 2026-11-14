import {test,expect,Page,Dialog} from "@playwright/test";
import {existsSync,readFileSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {build,downloadJson,importJson,openInput,prepare,saved} from "./helpers";

type Variant="design"|"unknown"|"outside";
function project(variant:Variant="design"){
  const line={name:"River corridor",points:[{x:-10,y:variant==="outside"?80:20,chainage:100},{x:50,y:variant==="outside"?80:20,chainage:160}],
    ...(variant==="unknown"?{}:{design:[{chainage:100,top:7,bottom:5},{chainage:160,top:7,bottom:5}]})};
  return {format:"geomodel3d-project",version:1,name:`Corridor ${variant}`,crs:"Local survey grid",base:-5,
    ...(variant==="unknown"?{groundwater:{mode:"as-of",date:"2020-01-01"}}:{}),
    units:[{id:"fill",name:"Made ground",color:"#9a5b4f"},{id:"sand",name:"River sand",color:"#d9b871"}],
    boreholes:[[0,0],[40,0],[40,40],[0,40]].map(([x,y],i)=>({id:`BH-${i+1}`,x,y,z:10,depth:12,
      intervals:[{from:0,to:2,unit:"fill"},{from:2,to:12,unit:"sand"}],water:[{depth:1,date:"2026-01-10"}]})),
    cpts:[{id:"CPT-unused",x:20,y:20,z:10,depth:[1,2],qc:[1,2]}],cptLayers:false,alignments:[line]};
}

// Exports include quoted JSON alignment/settings metadata, whose commas and newlines are part of a field.
function csvRows(text:string){
  const rows:string[][]=[],row:string[]=[];let field="",quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++}else quoted=!quoted}
    else if(c===","&&!quoted){row.push(field);field=""}
    else if((c==="\n"||c==="\r")&&!quoted){
      row.push(field);rows.push([...row]);row.length=0;field="";
      if(c==="\r"&&text[i+1]==="\n")i++;
    }else field+=c;
  }
  if(field||row.length){row.push(field);rows.push(row)}
  const [header,...values]=rows;
  return values.map(row=>Object.fromEntries(row.map((v,i)=>[header[i],v])));
}

async function showModel(page:Page){
  await page.getByRole("tab",{name:"3-D model",exact:true}).click();
  await expect(page.getByRole("tab",{name:"3-D model",exact:true})).toHaveAttribute("aria-selected","true");
  const section=page.locator('[data-sheet="section"]');
  if(await section.isVisible()&&await section.getAttribute("aria-expanded")==="false")await section.click();
}

async function loadProject(page:Page,variant:Variant="design"){
  await openInput(page);
  const accept=(dialog:Dialog)=>dialog.accept();page.on("dialog",accept);
  try{await importJson(page,project(variant),`corridor-${variant}.json`);await expect(page.locator(".ws-status")).toContainText(`Imported corridor-${variant}.json`);await saved(page)}
  finally{page.off("dialog",accept)}
  await build(page);
  const workspace=await downloadJson(page);
  await showModel(page);
  return workspace;
}

async function openProject(page:Page,variant:Variant="design"){
  await prepare(page);await page.goto("/?backend=webgl#input");return loadProject(page,variant);
}

async function dashboard(page:Page,run=true){
  await page.locator(".corridor-open").click();
  const dialog=page.getByRole("dialog",{name:"Corridor dashboard",exact:true});
  await expect(dialog).toBeVisible();
  if(run)await dialog.locator(".corridor-run").click();
  return dialog;
}

async function csvDownload(page:Page){
  const pending=page.waitForEvent("download");await page.locator(".corridor-csv").click();
  const download=await pending,path=await download.path();expect(path).not.toBeNull();
  return {name:download.suggestedFilename(),rows:csvRows(await readFile(path!,"utf8"))};
}

test("corridor dashboard screens fixed stations, invalidates exports and returns to the selected chainage",async({page},testInfo)=>{
  const workspace=await openProject(page);
  await expect.poll(()=>page.locator(".section-control").evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
  const dialog=await dashboard(page,false);
  await dialog.locator(".corridor-run").evaluate((button:HTMLButtonElement)=>{
    button.click();document.querySelector<HTMLButtonElement>(".corridor-cancel")!.click();
  });
  await expect(dialog.locator(".corridor-status")).toContainText(/cancel/i);
  await expect(dialog.locator(".corridor-csv")).toBeDisabled();
  const cancelled=await page.evaluate(async project=>{
    const module="/src/corridorJob.ts",{createCorridorJob}=await import(module);
    const job=createCorridorJob(project,project.alignments[0],{step:10,minCover:5,maxSupportDistance:10});
    job.cancel();
    try{await job.result;return "resolved"}catch(error){return (error as Error).name}
  },project());
  expect(cancelled).toBe("AbortError");
  await dialog.locator(".corridor-max-distance").fill("10");
  await dialog.locator(".corridor-run").click();await expect(dialog.locator(".corridor-csv")).toBeEnabled();
  await expect(dialog.locator(".corridor-plot svg")).toBeVisible();
  const csv=await csvDownload(page);
  expect(csv.name).toContain("corridor");
  const middle=csv.rows.find(row=>Number(row.chainage_m)===130)!;
  expect(middle).toBeDefined();
  expect(Number(middle.ground_m)).toBeCloseTo(10,6);
  expect(Number(middle.design_top_m)).toBeCloseTo(7,6);
  expect(Number(middle.cover_m)).toBeCloseTo(3,6);
  expect(Number(middle.water_head_above_design_m)).toBeCloseTo(2,6);
  expect(middle.unit_top_id).toBe("sand");
  expect(middle.nearest_log_kind).toBe("borehole");
  expect(Number(middle.nearest_log_distance_m)).toBeCloseTo(Math.hypot(20,20),6);
  expect(middle.flags).toContain("low-cover");expect(middle.flags).toContain("water-above-design");expect(middle.flags).toContain("distant-support");
  expect(middle.project_name).toBe("Corridor design");expect(middle.alignment_name).toBe("River corridor");
  expect(middle.requested_step_m).toBe("10");expect(middle.min_cover_screen_m).toBe("5");expect(middle.max_support_distance_screen_m).toBe("10");
  expect(middle.engine_version).toBe(JSON.parse(readFileSync(resolve("package.json"),"utf8")).version);expect(middle.scenario_label).toBe("Baseline");
  expect(Number.isFinite(Date.parse(middle.snapshot_captured_at))).toBe(true);
  expect(JSON.parse(middle.alignment_geometry)).toEqual(project().alignments[0].points);
  expect(JSON.parse(middle.design_levels)).toEqual(project().alignments[0].design);
  expect(JSON.parse(middle.review_notes).join(" ")).toMatch(/station|sampling/i);
  const outside=csv.rows.find(row=>Number(row.chainage_m)===100)!;
  expect(outside.ground_m).toBe("");expect(outside.design_top_m).toBe("7");expect(outside.flags).toContain("outside-model");
  await dialog.locator(".corridor-filter").selectOption("outside-model");
  await expect(dialog.locator(".corridor-stations tbody tr:not([hidden])")).toHaveCount(csv.rows.filter(row=>row.inside_model==="false").length);
  await dialog.locator(".corridor-filter").selectOption("all");
  await page.screenshot({path:testInfo.outputPath("corridor-dashboard-desktop.png"),fullPage:true});
  await dialog.locator(".corridor-stations").scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath("corridor-dashboard-stations.png"),fullPage:true});
  await dialog.locator(".corridor-step").fill("0");
  await expect(dialog.locator(".corridor-csv")).toBeDisabled();
  await dialog.locator(".corridor-run").click();await expect(dialog.locator(".corridor-error")).toBeVisible();
  await expect(dialog.locator(".corridor-csv")).toBeDisabled();
  await dialog.locator(".corridor-step").fill("10");await dialog.locator(".corridor-min-cover").fill("");
  await dialog.locator(".corridor-max-distance").fill("");await dialog.locator(".corridor-run").click();
  await expect(dialog.locator(".corridor-csv")).toBeEnabled();
  const disabled=await csvDownload(page),sample=disabled.rows.find(row=>Number(row.chainage_m)===130)!;
  expect(sample.flags).not.toContain("low-cover");expect(sample.flags).not.toContain("distant-support");
  const index=await dialog.locator(".corridor-station option").evaluateAll(options=>options.findIndex(o=>(o.textContent??"").match(/\b130\b/)));
  expect(index).toBeGreaterThanOrEqual(0);await dialog.locator(".corridor-station").selectOption(String(index));
  await dialog.locator(".corridor-view").click();await expect(dialog).toHaveCount(0);
  await expect(page.locator(".line-select")).toHaveValue("0");await expect(page.locator(".chainage")).toHaveValue("130");
  await page.setViewportSize({width:1024,height:900});
  await expect.poll(()=>page.locator(".section-control").evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({path:testInfo.outputPath("corridor-section-controls-1024.png"),fullPage:true});
  await openInput(page);const unchanged=await downloadJson(page);
  expect(unchanged.revisions).toEqual(workspace.revisions);expect(unchanged.draft).toEqual(workspace.draft);
});

test("corridor dashboard preserves missing design, unknown groundwater and outside model gaps",async({page})=>{
  await openProject(page,"unknown");const unknown=await dashboard(page);
  await expect(unknown.locator(".corridor-csv")).toBeEnabled();
  const missing=await csvDownload(page),inside=missing.rows.find(row=>Number(row.chainage_m)===130)!;
  expect(inside.design_top_m).toBe("");expect(inside.cover_m).toBe("");expect(inside.water_m).toBe("");expect(inside.water_head_above_design_m).toBe("");
  expect(inside.flags).toContain("missing-design");expect(inside.flags).toContain("water-unknown");
  await page.keyboard.press("Escape");await expect(page.locator(".corridor-open")).toBeFocused();
  await loadProject(page,"outside");const outside=await dashboard(page);
  await expect(outside.locator(".corridor-csv")).toBeEnabled();
  const csv=await csvDownload(page);
  expect(csv.rows.every(row=>row.ground_m===""&&row.flags.includes("outside-model"))).toBe(true);
  expect(csv.rows.every(row=>row.design_top_m==="7")).toBe(true);
});

test("mobile corridor dashboard keeps profile and tables usable with keyboard focus",async({page},testInfo)=>{
  await openProject(page);const dialog=await dashboard(page);
  await expect(dialog.locator(".corridor-csv")).toBeEnabled();
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("corridor-dashboard-mobile.png"),fullPage:true});
  for(let i=0;i<16;i++){await page.keyboard.press("Tab");expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true)}
  await dialog.locator(".corridor-plot").press("ArrowRight");await expect(dialog.locator(".corridor-station")).toHaveValue("1");
  await dialog.locator(".corridor-plot").press("ArrowLeft");await expect(dialog.locator(".corridor-station")).toHaveValue("0");
  await dialog.locator(".corridor-plot").scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath("corridor-dashboard-mobile-profile.png"),fullPage:true});
  await dialog.locator(".corridor-stations").scrollIntoViewIfNeeded();
  const table=dialog.locator(".corridor-stations").locator("..");
  expect(await table.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);
  await table.evaluate(el=>{el.scrollLeft=el.scrollWidth});
  await page.screenshot({path:testInfo.outputPath("corridor-dashboard-mobile-stations.png"),fullPage:true});
  await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);await expect(page.locator(".corridor-open")).toBeFocused();
});

test("standalone corridor dashboard runs the inline worker with networking disabled",async({page,context},testInfo)=>{
  const filename=resolve("dist/geomodel3d-offline.html");expect(existsSync(filename),"Build standalone before UI checks").toBe(true);
  const html=readFileSync(filename,"utf8"),errors:string[]=[];
  await page.route("**/*",route=>route.request().isNavigationRequest()?route.fulfill({status:200,contentType:"text/html",body:html}):route.abort());
  await context.setOffline(true);page.on("pageerror",error=>errors.push(error.message));
  await page.goto("http://127.0.0.1:4173/standalone-corridor.html?backend=webgl#input");
  await loadProject(page);const dialog=await dashboard(page);await expect(dialog.locator(".corridor-csv")).toBeEnabled();
  const csv=await csvDownload(page),row=csv.rows.find(row=>Number(row.chainage_m)===130)!;
  expect(Number(row.cover_m)).toBeCloseTo(3,6);expect(Number(row.water_head_above_design_m)).toBeCloseTo(2,6);
  await page.screenshot({path:testInfo.outputPath("corridor-dashboard-offline.png"),fullPage:true});expect(errors).toEqual([]);
});
