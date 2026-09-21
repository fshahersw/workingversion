// Verify the emitted server parser without accidentally resolving repository dependencies.
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, ".output/server");
const moduleName = (await readdir(join(server, "_ssr"))).find(name => /^pdf\.server-[\w-]+\.mjs$/.test(name));
assert.ok(moduleName, "Build first: emitted PDF extraction module is missing.");
const temporaryRoot = await realpath(tmpdir());
const temporary = await mkdtemp(join(temporaryRoot, "workingversion-pdf-build-check-"));
try {
  await cp(join(server, "_ssr", moduleName), join(temporary, "extract.mjs"));
  await cp(join(server, "node_modules"), join(temporary, "node_modules"), { recursive: true, dereference: true });
  // Physical order deliberately differs from the PDF page tree; text uses hex encoding.
  const text = value => "BT /F1 12 Tf 50 700 Td <" + Buffer.from(value).toString("hex") + "> Tj ET";
  const stream = value => "<< /Length " + Buffer.byteLength(value) + " >>\nstream\n" + value + "\nendstream";
  const objects = [
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"],
    [5, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>"],
    [6, stream(text("SECOND PAGE"))],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>"],
    [4, stream(text("FIRST PAGE"))],
    [7, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  ];
  let pdf = "%PDF-1.4\n"; const offsets = [];
  for (const [id, body] of objects) { offsets[id] = Buffer.byteLength(pdf); pdf += id + " 0 obj\n" + body + "\nendobj\n"; }
  const xref = Buffer.byteLength(pdf);
  pdf += "xref\n0 8\n0000000000 65535 f \n";
  for (let i = 1; i < 8; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  pdf += "trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  await writeFile(join(temporary, "fixture.pdf"), pdf);
  await writeFile(join(temporary, "probe.mjs"), [
    'import assert from "node:assert/strict";',
    'import { readFile, access } from "node:fs/promises";',
    'import { createRequire } from "node:module";',
    'import { dirname, join } from "node:path";',
    'import { extractPdf } from "./extract.mjs";',
    'const require = createRequire(import.meta.url);',
    'const canvas = require("@napi-rs/canvas").createCanvas(10, 10);',
    'assert.equal(canvas.width, 10);',
    'const assets = dirname(require.resolve("pdfjs-dist/package.json"));',
    'for (const asset of ["legacy/build/pdf.worker.mjs", "cmaps/Adobe-GB1-UCS2.bcmap", "standard_fonts/LiberationSans-Regular.ttf", "wasm/openjpeg.wasm"]) await access(join(assets, asset));',
    'const result = await extractPdf(new Uint8Array(await readFile(new URL("./fixture.pdf", import.meta.url))));',
    'assert.deepEqual(result, { pageCount: 2, pages: ["FIRST PAGE", "SECOND PAGE"] });',
    'console.log(JSON.stringify({ passed: true, platform: process.platform, arch: process.arch, pageCount: result.pageCount, isolatedArtifact: true }));',
  ].join("\n"));
  process.stdout.write(execFileSync(process.execPath, [join(temporary, "probe.mjs")], {
    cwd: temporary, env: { ...process.env, NODE_PATH: "" }, encoding: "utf8", timeout: 30_000,
  }));
} finally {
  // Only remove the exact temporary directory this script created.
  const actual = await realpath(temporary);
  assert.equal(dirname(actual), temporaryRoot);
  assert.ok(basename(actual).startsWith("workingversion-pdf-build-check-"));
  await rm(actual, { recursive: true, force: true });
}
