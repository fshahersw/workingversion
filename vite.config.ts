// Leftover local Vite wrapper only (not the Lovable SaaS). Keep until a
// stock TanStack Start config is proven for the Lambda node-server build.
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
    const value = s
      .slice(i + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (key && value) process.env[key] = value;
  }
}

applyLocalEnv();

// The vendored Writer (src/writer) keeps its upstream `@genoffice/*` package
// specifiers. Resolve them here explicitly (regexes, most specific first) so
// dev and build do not depend on the tsconfig-paths plugin having read the
// matching `paths` entries.
const writerPkg = (p: string) => resolve(process.cwd(), "src/writer/packages", p);
const writerAliases = [
  { find: /^@genoffice\/agent-core$/, replacement: writerPkg("agent-core/src/index.ts") },
  { find: /^@genoffice\/ai-provider$/, replacement: writerPkg("ai-provider/src/index.ts") },
  { find: /^@genoffice\/docx-engine$/, replacement: writerPkg("docx-engine/src/index.ts") },
  { find: /^@genoffice\/docx-engine\/math$/, replacement: writerPkg("docx-engine/src/math.ts") },
  {
    find: /^@genoffice\/docx-engine\/metafile$/,
    replacement: writerPkg("docx-engine/src/metafile.ts"),
  },
  { find: /^@genoffice\/font-metrics$/, replacement: writerPkg("font-metrics/src/index.ts") },
  { find: /^@genoffice\/i18n$/, replacement: writerPkg("i18n/src/index.ts") },
  { find: /^@genoffice\/project-store$/, replacement: writerPkg("project-store/src/index.ts") },
  { find: /^@genoffice\/pptx-engine$/, replacement: writerPkg("pptx-engine/src/index.ts") },
  {
    find: /^@genoffice\/pptx-engine\/custgeom$/,
    replacement: writerPkg("pptx-engine/src/custgeom.ts"),
  },
  {
    find: /^@genoffice\/pptx-engine\/identity$/,
    replacement: writerPkg("pptx-engine/src/identity.ts"),
  },
  {
    find: /^@genoffice\/pptx-engine\/table-grid$/,
    replacement: writerPkg("pptx-engine/src/table-grid.ts"),
  },
  {
    find: /^@genoffice\/pptx-engine\/background-promote$/,
    replacement: writerPkg("pptx-engine/src/background-promote.ts"),
  },
  {
    find: /^@genoffice\/pptx-engine\/smartart-layout$/,
    replacement: writerPkg("pptx-engine/src/smartart-layout.ts"),
  },
  { find: /^@genoffice\/pptx-render$/, replacement: writerPkg("pptx-render/src/index.ts") },
  {
    find: /^@genoffice\/pptx-render\/preset-geometry$/,
    replacement: writerPkg("pptx-render/src/preset-geometry.ts"),
  },
  { find: /^@genoffice\/ui$/, replacement: writerPkg("ui/src/index.ts") },
  { find: /^@genoffice\/ui\/(.+)$/, replacement: `${writerPkg("ui/src")}/$1` },
];

// The vendored Sheets and Slides code (src/office/<app>) was written against
// zod 4 and the Electron preload API. Resolve those specifiers differently only
// for importers inside each tree: `zod` -> the zod4 alias package, `electron`
// and the drop-open bridge -> that app's browser shims. The rest of the app
// keeps zod 3.
const officeTree = (app: string) => resolve(process.cwd(), "src/office", app).replaceAll("\\", "/");
const OFFICE_TREES = ["sheets", "slides"].map(officeTree);
const officeScopedResolver = {
  name: "sw-office-scoped-resolver",
  enforce: "pre" as const,
  async resolveId(
    this: {
      resolve: (id: string, importer?: string, opts?: { skipSelf?: boolean }) => Promise<unknown>;
    },
    id: string,
    importer?: string,
  ) {
    if (!importer) return null;
    const from = importer.replaceAll("\\", "/");
    const tree = OFFICE_TREES.find((t) => from.startsWith(t + "/"));
    if (!tree) return null;
    if (id === "zod") return this.resolve("zod4", importer, { skipSelf: true });
    if (id === "electron") return resolve(tree, "web/host/electron.ts");
    if (id === "@genoffice/electron-utils/drop-open") return resolve(tree, "web/host/drop-open.ts");
    return null;
  },
};

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
    ...(process.env["LITAI_LAMBDA_BUILD"] === "true" ? { envDir: false } : {}),
    ssr: { external: ["node:sqlite"] },
    resolve: { alias: writerAliases },
    plugins: [officeScopedResolver],
    // The Sheets/Slides preloads read this desktop debug flag at module load.
    define: { "process.env.GENOFFICE_DEBUG_HOOKS": '"0"' },
  },
});
