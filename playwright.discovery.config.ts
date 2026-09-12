import { defineConfig } from "@playwright/test";
import { browserOrigin, browserServer } from "./tests/support/browser-server";
export default defineConfig({
  testDir: "tests/discovery",
  timeout: 90_000,
  workers: 1,
  outputDir: ".discovery.local/browser-results",
  use: {
    baseURL: browserOrigin,
    browserName: "chromium",
    channel: process.platform === "win32" ? "msedge" : undefined,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
  },
  webServer: browserServer,
});
