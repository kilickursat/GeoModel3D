import {expect,Page} from "@playwright/test";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import type {WorkspaceDocument} from "../../src/workspace";

export const fixturePath=fileURLToPath(new URL("./fixtures/complete-project.json",import.meta.url));

export async function prepare(page:Page){
  // Sample sites request public tiles at startup; none are needed for these local-data workflows.
  await page.route("**/*",route=>{
    const url=new URL(route.request().url());
    return !["http:","https:"].includes(url.protocol)||["127.0.0.1","localhost"].includes(url.hostname)?route.continue():route.abort();
  });
}

export async function openInput(page:Page){
  await page.getByRole("tab",{name:"Input data",exact:true}).click();
  await expect(page.locator(".workspace")).toBeVisible();
}

export async function importFixture(page:Page){
  await openInput(page);
  await page.locator(".file").setInputFiles(fixturePath);
  await expect(page.locator(".ws-status")).toContainText("Imported complete-project.json");
  await saved(page);
}

export async function saved(page:Page){
  await expect(page.locator(".ws-save-status")).toHaveText("Saved in this browser");
}

export async function downloadJson<T=WorkspaceDocument>(page:Page,selector=".ws-workspace"):Promise<T>{
  const pending=page.waitForEvent("download");
  await page.locator(selector).click();
  const download=await pending,path=await download.path();
  expect(path).not.toBeNull();
  return JSON.parse(await readFile(path!,"utf8")) as T;
}

export async function importJson(page:Page,document:unknown,name="review.workspace.geomodel3d.json"){
  await page.locator(".file").setInputFiles({name,mimeType:"application/json",buffer:Buffer.from(JSON.stringify(document))});
}

export async function resume(page:Page){
  await page.reload();
  await openInput(page);
  await page.locator('[data-start="saved"]').click();
  await saved(page);
}

export async function rename(page:Page,name:string){
  await page.locator('[data-step="project"]').click();
  await page.locator('[data-field="name"]').fill(name);
}

export async function build(page:Page){
  await page.locator(".ws-build").click();
  await expect(page.getByRole("tab",{name:"3-D model",exact:true})).toHaveAttribute("aria-selected","true");
  await openInput(page);
  await saved(page);
}

export function expectComplete(project:any){
  expect(project.cpts).toHaveLength(1);
  expect(project.cpts[0].id).toBe("CPT-01");
  expect(project.cpts[0].qc).toEqual([1,2,null,10,12]);
  expect(project.terrain.z).toEqual([10,10,10,10,10,10,10,10,null]);
  expect(project.alignments[0].name).toBe("Crossing centreline");
  expect(project.alignments[0].design[1].bottom).toBe(3);
  expect(project.rules).toHaveLength(2);
  expect(project.cptRules).toEqual([{match:"sand",unit:"sand"}]);
  expect(project.units[0].params.customStiffness).toBe(42);
}
