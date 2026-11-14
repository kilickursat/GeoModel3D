import {defineConfig,devices} from "@playwright/test";
import {existsSync} from "node:fs";

// Use Playwright's bundled browser by default, or the system browser on machines that provide one.
const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??(existsSync("/usr/bin/chromium")?"/usr/bin/chromium":undefined);

export default defineConfig({
  testDir:"./tests/browser",
  timeout:45_000,
  expect:{timeout:10_000},
  fullyParallel:true,
  forbidOnly:!!process.env.CI,
  retries:0,
  workers:2,
  reporter:"list",
  use:{
    baseURL:"http://127.0.0.1:4173",
    trace:"retain-on-failure",
    screenshot:"only-on-failure",
    launchOptions:{executablePath,args:["--enable-unsafe-swiftshader"]}
  },
  projects:[
    {name:"desktop",testMatch:/workspace\.spec\.ts$/,use:{...devices["Desktop Chrome"],viewport:{width:1440,height:1000}}},
    {name:"mobile",testMatch:/mobile\.spec\.ts$/,use:{...devices["Pixel 7"]}},
    {name:"evidence",testMatch:/evidence\.spec\.ts$/,grepInvert:/mobile evidence inspector/,use:{...devices["Desktop Chrome"],viewport:{width:1440,height:1000}}},
    {name:"evidence-mobile",testMatch:/evidence\.spec\.ts$/,grep:/mobile evidence inspector/,use:{...devices["Pixel 7"]}},
    {name:"scenarios",testMatch:/scenarios\.spec\.ts$/,grepInvert:/mobile scenario comparison|standalone scenario workspace/,use:{...devices["Desktop Chrome"],viewport:{width:1440,height:1000}}},
    {name:"scenarios-mobile",testMatch:/scenarios\.spec\.ts$/,grep:/mobile scenario comparison/,use:{...devices["Pixel 7"]}},
    {name:"scenarios-offline",testMatch:/scenarios\.spec\.ts$/,grep:/standalone scenario workspace/,use:{...devices["Desktop Chrome"]}},
    {name:"impact",testMatch:/impact\.spec\.ts$/,grepInvert:/mobile new-data impact|standalone new-data impact/,use:{...devices["Desktop Chrome"],viewport:{width:1440,height:1000}}},
    {name:"impact-mobile",testMatch:/impact\.spec\.ts$/,grep:/mobile new-data impact/,use:{...devices["Pixel 7"]}},
    {name:"impact-offline",testMatch:/impact\.spec\.ts$/,grep:/standalone new-data impact/,use:{...devices["Desktop Chrome"]}},
    {name:"corridor",testMatch:/corridor\.spec\.ts$/,grepInvert:/mobile corridor dashboard|standalone corridor dashboard/,use:{...devices["Desktop Chrome"],viewport:{width:1440,height:1000}}},
    {name:"corridor-mobile",testMatch:/corridor\.spec\.ts$/,grep:/mobile corridor dashboard/,use:{...devices["Pixel 7"]}},
    {name:"corridor-offline",testMatch:/corridor\.spec\.ts$/,grep:/standalone corridor dashboard/,use:{...devices["Desktop Chrome"]}},
    {name:"investigation",testMatch:/(?:^|\/)investigation\.spec\.ts$/,grepInvert:/mobile investigation planner|standalone investigation planner/,use:{...devices["Desktop Chrome"],viewport:{width:1440,height:1000}}},
    {name:"investigation-mobile",testMatch:/(?:^|\/)investigation\.spec\.ts$/,grep:/mobile investigation planner/,use:{...devices["Pixel 7"]}},
    {name:"investigation-offline",testMatch:/(?:^|\/)investigation\.spec\.ts$/,grep:/standalone investigation planner/,use:{...devices["Desktop Chrome"]}},
    {name:"disagreement",testMatch:/disagreement\.spec\.ts$/,grepInvert:/mobile model disagreement|standalone model disagreement/,use:{...devices["Desktop Chrome"],viewport:{width:1440,height:1000}}},
    {name:"disagreement-mobile",testMatch:/disagreement\.spec\.ts$/,grep:/mobile model disagreement/,use:{...devices["Pixel 7"]}},
    {name:"disagreement-offline",testMatch:/disagreement\.spec\.ts$/,grep:/standalone model disagreement/,use:{...devices["Desktop Chrome"]}},
    {name:"calibrated-investigation",testMatch:/calibrated-investigation\.spec\.ts$/,grepInvert:/mobile calibrated workflow|standalone calibrated workflow/,use:{...devices["Desktop Chrome"],viewport:{width:1440,height:1000}}},
    {name:"calibrated-investigation-mobile",testMatch:/calibrated-investigation\.spec\.ts$/,grep:/mobile calibrated workflow/,use:{...devices["Pixel 7"]}},
    {name:"calibrated-investigation-offline",testMatch:/calibrated-investigation\.spec\.ts$/,grep:/standalone calibrated workflow/,use:{...devices["Desktop Chrome"]}},
    {name:"offline",testMatch:/offline\.spec\.ts$/,use:{...devices["Desktop Chrome"]}}
  ],
  webServer:{command:"npm run dev -- --host 127.0.0.1 --port 4173 --strictPort",url:"http://127.0.0.1:4173",reuseExistingServer:!process.env.CI,timeout:30_000}
});
