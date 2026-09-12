import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/workflows",
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  outputDir: ".workflows.local/browser-results",
  use: {
    baseURL: "http://127.0.0.1:5175",
    browserName: "chromium",
    channel: process.platform === "win32" ? "msedge" : undefined,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node node_modules/vite/bin/vite.js dev --host 127.0.0.1 --port 5175 --strictPort",
    url: "http://127.0.0.1:5175/auth",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
