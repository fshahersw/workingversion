// Run this checkout's Vite process, never silently reuse a developer's other repo.
const port = Number(process.env.PLAYWRIGHT_PORT || "5189");
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid PLAYWRIGHT_PORT");
export const browserOrigin = `http://127.0.0.1:${port}`;
export const browserServer = {
  command: `node scripts/serve-browser-tests.mjs ${port}`,
  url: `${browserOrigin}/auth`,
  reuseExistingServer: false,
  timeout: 120_000,
};
