import {test,expect} from "@playwright/test";
import {build,downloadJson,importFixture,prepare,rename,resume,saved} from "./helpers";

test("mobile can save, restore and resume a complete workspace",async({page},testInfo)=>{
  await prepare(page);await page.goto("/?backend=webgl#input");
  await importFixture(page);
  await rename(page,"Mobile field revision");
  await build(page);
  await page.locator('[data-step="history"]').click();
  await expect(page.locator(".ws-history")).toBeVisible();
  page.once("dialog",dialog=>dialog.accept());
  await page.locator("[data-restore]").first().click();
  await saved(page);
  await expect(page.locator(".ws-workspace")).toBeVisible();
  const exported=await downloadJson(page);
  expect(exported.revisions).toHaveLength(2);
  expect(exported.draft.tables.project.name).toBe("River crossing investigation");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const box=await page.locator(".ws-workspace").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y+box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({path:testInfo.outputPath("revisions-mobile.png"),fullPage:true});
  await resume(page);
  expect((await downloadJson(page)).draft).toEqual(exported.draft);
});
