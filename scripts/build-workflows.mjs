import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
const output = resolve(".artifacts/workflows");
await mkdir(output, { recursive: true });
const bun =
  process.env.BUN_BINARY ||
  (process.platform === "win32"
    ? resolve(process.env.APPDATA || "", "npm/node_modules/bun/bin/bun.exe")
    : "bun");
const result = spawnSync(
  bun,
  [
    "--no-env-file",
    "build",
    "infra/lambda/workflows/worker.ts",
    "infra/lambda/workflows/scheduler.ts",
    "--target=node",
    "--format=esm",
    "--outdir",
    output,
  ],
  { encoding: "utf8", stdio: "pipe" },
);
if (result.status !== 0)
  throw new Error(
    result.stderr || result.stdout || result.error?.message || "Worker build failed.",
  );
for (const entry of ["worker", "scheduler"]) {
  const code = await readFile(resolve(output, entry + ".js"));
  const loaded = await import(pathToFileURL(resolve(output, entry + ".js")).href);
  if (typeof loaded.handler !== "function")
    throw new Error(`${entry} bundle does not export its Lambda handler.`);
  const zip = new JSZip();
  zip.file(entry + ".mjs", code);
  await writeFile(
    resolve(output, entry + ".zip"),
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  console.log(
    `Packaged ${entry}.zip (${code.byteLength} bytes uncompressed). No deployment performed.`,
  );
}
