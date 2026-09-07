#!/usr/bin/env node
import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const output = resolve(root, ".artifacts/kb-ingest");
const bunExecutable =
  process.platform === "win32"
    ? resolve(process.env.APPDATA ?? "", "npm/node_modules/bun/bin/bun.exe")
    : "bun";
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const result = spawnSync(
  bunExecutable,
  [
    "--no-env-file",
    "build",
    "infra/lambda/kb-ingest/sqs.ts",
    "infra/lambda/kb-ingest/reconcile.ts",
    "--target=node",
    "--format=esm",
    "--outdir",
    output,
    "--minify",
  ],
  {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);
if (result.status !== 0) {
  const detail = result.error?.message || result.stderr || result.stdout || "unknown error";
  throw new Error(`Worker bundle failed: ${String(detail).trim()}`);
}
for (const name of ["sqs.js", "reconcile.js"]) {
  const bundle = resolve(output, name);
  const info = await stat(bundle).catch(() => null);
  if (!info?.isFile() || info.size < 100) {
    throw new Error(`Worker bundle is missing ${name}`);
  }
  const loaded = await import(`${pathToFileURL(bundle).href}?validation=${info.size}`);
  if (typeof loaded.handler !== "function") {
    throw new Error(`Worker bundle ${name} does not export a handler`);
  }
}
console.log("Built and loaded deterministic KB ingest worker bundles without loading .env.");
