#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import JSZip from "jszip";

const root = process.cwd();
const source = resolve(root, ".artifacts/kb-ingest");
const output = resolve(root, "infra/lambda/kb-ingest/artifacts/kb-ingest-workers.zip");
const zip = new JSZip();
const zipDate = new Date(1980, 0, 1, 0, 0, 0);

for (const name of ["reconcile.js", "sqs.js"]) {
  const bytes = await readFile(resolve(source, name)).catch(() => {
    throw new Error(`Missing ${name}; run build:kb-ingest-workers first`);
  });
  zip.file(name, bytes, {
    createFolders: false,
    date: zipDate,
    unixPermissions: 0o100644,
  });
}
zip.file("package.json", '{"private":true,"type":"module"}\n', {
  createFolders: false,
  date: zipDate,
  unixPermissions: 0o100644,
});

const bytes = await zip.generateAsync({
  type: "nodebuffer",
  platform: "UNIX",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
});
const inspected = await JSZip.loadAsync(bytes);
const entries = Object.values(inspected.files)
  .filter((entry) => !entry.dir)
  .map((entry) => entry.name)
  .sort();
if (JSON.stringify(entries) !== JSON.stringify(["package.json", "reconcile.js", "sqs.js"])) {
  throw new Error("Worker ZIP has unexpected entries");
}
const manifest = JSON.parse(await inspected.file("package.json").async("string"));
if (
  manifest?.type !== "module" ||
  Object.values(inspected.files).some((entry) => !entry.dir && entry.unixPermissions !== 0o100644)
) {
  throw new Error("Worker ZIP has invalid Node loader metadata or permissions");
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, bytes);
console.log(
  `Packaged ${relative(root, output)} (${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex")}).`,
);
