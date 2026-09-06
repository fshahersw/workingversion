// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Vite keeps existing process.env values. A stale machine-level
// DOCKETBIRD_API_KEY then wins over .env and DocketBird returns 401.
// Match the pipeline scripts: .env is the local source of truth.
function applyLocalEnv() {
  if (process.env["LITAI_LAMBDA_BUILD"] === "true") return;
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const i = s.indexOf("=");
    const key = s.slice(0, i).trim();
    const value = s.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && value) process.env[key] = value;
  }
}

applyLocalEnv();

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  // Lambda Web Adapter needs a Node process that listens on PORT. The Lovable
  // wrapper otherwise defaults production builds to cloudflare-module.
  nitro: {
    preset: "node-server",
  },
  vite: {
    ssr: { external: ["node:sqlite"] },
  },
});
