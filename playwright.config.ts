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
    {name:"offline",testMatch:/offline\.spec\.ts$/,use:{...devices["Desktop Chrome"]}}
  ],
  webServer:{command:"npm run dev -- --host 127.0.0.1 --port 4173 --strictPort",url:"http://127.0.0.1:4173",reuseExistingServer:!process.env.CI,timeout:30_000}
});
