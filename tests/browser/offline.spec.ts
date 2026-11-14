import {test,expect} from "@playwright/test";
import {existsSync,readFileSync} from "node:fs";
import {resolve} from "node:path";
import {build,downloadJson,expectComplete,importFixture,importJson,rename} from "./helpers";

test("standalone HTML can import, build and export a complete workspace without a network",async({page,context})=>{
  const filename=resolve("dist/geomodel3d-offline.html");
  expect(existsSync(filename),"Run npm run build before the standalone browser smoke test").toBe(true);
  // Deliver the exact standalone artifact without Vite transforms. A local origin works even where a managed
  // browser blocks file:// navigation; every subsequent request is denied, so the app must be self-contained.
  const html=readFileSync(filename,"utf8");
  await page.route("**/*",route=>route.request().isNavigationRequest()
    ?route.fulfill({status:200,contentType:"text/html",body:html}):route.abort());
  await context.setOffline(true);
  const errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto("http://127.0.0.1:4173/standalone-test.html?backend=webgl#input");
  await importFixture(page);
  await rename(page,"Offline review");
  await build(page);
  const exported=await downloadJson(page);
  expect(exported.draft.tables.project.name).toBe("Offline review");
  expect(exported.revisions).toHaveLength(2);
  expectComplete(exported.revisions[1].project);
  page.once("dialog",dialog=>dialog.accept());
  await importJson(page,exported);
  await expect(page.locator(".ws-history")).toBeVisible();
  await build(page);
  const reopened=await downloadJson(page);
  expect(reopened.revisions).toEqual(exported.revisions);
  expectComplete(reopened.draft.base);
  expect(errors).toEqual([]);
});
