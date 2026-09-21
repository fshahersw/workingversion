// Key-free, read-only verification of the synthetic PDF editing acceptance scenario.
// node scripts/verify-local-pdf.mjs --base-url http://127.0.0.1:5189 --doc-id <id>
// Captured API artifacts can be rechecked with --offline-dir ../analysis.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(process.argv[i].startsWith("--") && process.argv[i + 1], "Use --option value pairs.");
  args.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const version = Number(args.get("version") ?? 2);
assert.ok(Number.isInteger(version) && version > 1, "A saved edit revision above 1 is required.");
const expectedText = args.get("expected-text") ?? "Synthetic PDF quality check";
const expectedNote = args.get("expected-note") ?? "Verify the original source";
let origin;
if (!args.has("offline-dir")) {
  const url = new URL(args.get("base-url"));
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.port &&
    !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
    "Only an explicit loopback HTTP origin is accepted.");
  assert.match(args.get("doc-id") ?? "", /^[0-9A-HJKMNP-TV-Z]{26}$/, "Provide the synthetic document ID.");
  origin = url.origin;
}
async function revision(n) {
  let bytes, headers;
  if (args.has("offline-dir")) {
    const dir = resolve(args.get("offline-dir"));
    bytes = new Uint8Array(await readFile(resolve(dir, "pdf-live-rev" + n + ".pdf")));
    const raw = JSON.parse(await readFile(resolve(dir, "pdf-live-rev" + n + "-headers.json"), "utf8"));
    headers = new Headers(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
  } else {
    const response = await fetch(origin + "/api/office/docs/" + args.get("doc-id") + "/content?version=" + n,
      { redirect: "error", signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 200, "Local PDF revision request must succeed.");
    bytes = new Uint8Array(await response.arrayBuffer()); headers = response.headers;
  }
  assert.equal(headers.get("x-office-kind"), "pdf");
  assert.equal(Number(headers.get("x-office-version")), n);
  assert.match(headers.get("content-type") ?? "", /^application\/pdf\b/);
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash, headers.get("x-office-hash"), "Native PDF bytes must match the saved revision hash.");
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 1);
  const page = document.getPage(0);
  assert.deepEqual(page.getMediaBox(), { x: 0, y: 0, width: 612, height: 792 });
  assert.equal(page.getRotation().angle, 0);
  const annotations = (page.node.Annots()?.asArray() ?? []).map(ref => document.context.lookup(ref, PDFDict));
  const task = getDocument({ data: bytes.slice(), verbosity: 0 });
  try {
    const rendered = await task.promise;
    const pdfPage = await rendered.getPage(1);
    assert.deepEqual(pdfPage.view, [0, 0, 612, 792]);
    const items = (await pdfPage.getTextContent()).items.filter(item => "str" in item);
    return { bytes, hash, annotations, items };
  } finally { await task.destroy(); }
}
const [original, saved] = await Promise.all([revision(1), revision(version)]);
assert.notEqual(saved.hash, original.hash, "Saved edit must differ from immutable original.");
assert.equal(original.items.map(item => item.str).join("").trim(), "", "Original synthetic revision remains blank.");
assert.equal(original.annotations.length, 0, "Original synthetic revision has no added annotations.");
const line = saved.items.find(item => item.str === expectedText);
assert.ok(line, "The exact requested line must be actual extractable PDF text.");
assert.equal(line.transform[4], 60); assert.equal(line.transform[5], 700);
assert.equal(Math.abs(line.transform[0]), 18);
const note = saved.annotations.find(annotation => {
  const contents = annotation.lookup(PDFName.of("Contents"));
  return annotation.lookup(PDFName.of("Subtype")) === PDFName.of("Text") &&
    (contents instanceof PDFString || contents instanceof PDFHexString) && contents.decodeText() === expectedNote;
});
assert.ok(note, "The exact requested note must be a native PDF Text annotation.");
const rectangle = note.lookup(PDFName.of("Rect"));
assert.equal(rectangle.lookup(0).asNumber(), 60);
assert.equal(rectangle.lookup(1).asNumber(), 650);
console.log(JSON.stringify({
  passed: true, version, pageCount: 1, originalUnchanged: true,
  actualText: true, textPosition: [60, 700], fontSize: 18,
  nativeNote: true, notePosition: [60, 650], visiblePage: [0, 0, 612, 792],
  hashVerified: true, savedHash: saved.hash, originalHash: original.hash,
}, null, 2));
