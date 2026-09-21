// Synthetic, loopback-only integration gate. Requires scripts/local-office.mjs.
// Uses the real platform API, JWT grants, Office engine, revision persistence and downloads.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { toJSONAsync, fromCrossJSON } from 'seroval';

if (process.env.LOCAL_SYNTHETIC_MODE !== '1' || process.env.NODE_ENV === 'production') {
  throw new Error('Set LOCAL_SYNTHETIC_MODE=1 for this local synthetic test. Production is refused.');
}
const platform = 'http://127.0.0.1:5189';
const engine = 'http://127.0.0.1:8790';
const outputDir = resolve('.integration.local/results/office-roundtrip');
await mkdir(outputDir, { recursive: true });
const require = createRequire(import.meta.url);
const { CORPUS, PPTX_CORPUS, openPptx } = require('../services/office-engine/.build/fidelity.cjs');
const report = { startedAt: new Date().toISOString(), synthetic: true, microsoftOfficeValidated: false, results: [] };
const created = [];
const liveSessions = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function request(url, init) {
  assert.ok([platform, engine].includes(new URL(url).origin), 'Only loopback platform/engine requests are allowed');
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000), redirect: 'error' });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(`Local request failed (${response.status}): ${detail.error ?? new URL(url).pathname}`);
  }
  return response;
}
const source = await (await request(`${platform}/src/lib/office/office.functions.ts`)).text();
async function serverFn(name, data) {
  const id = source.match(new RegExp(`export const ${name}[\\s\\S]*?createClientRpc\\("([^"]+)"`))?.[1];
  assert.ok(id, `Missing local dev function ${name}`);
  const response = await request(`${platform}/_serverFn/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-tsr-serverFn': 'true' },
    body: JSON.stringify(await toJSONAsync({ data })),
  });
  const out = fromCrossJSON(await response.json(), { plugins: [] });
  if (out instanceof Error) throw out;
  if (out.error) throw new Error(String(out.error.message ?? out.error));
  return out.result;
}
async function create(kind, bytes) {
  const response = await request(`${platform}/api/office/docs`, { method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-office-kind': kind,
      'x-office-filename': encodeURIComponent(`Synthetic roundtrip ${randomUUID()}.${kind}`) }, body: bytes });
  const doc = await response.json();
  created.push(doc.draftId);
  return doc;
}
async function open(docId) {
  const grant = await serverFn('openEngineSessionFn', { docId });
  assert.equal(grant.engineUrl, engine);
  assert.equal(new URL(grant.source).origin, 'http://127.0.0.1:4568');
  const started = performance.now();
  const opened = await (await request(`${engine}/engine/open`, { method: 'POST',
    headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...grant.document, source: grant.source }),
  })).json();
  const session = { ...opened, token: grant.token, docId, openMs: performance.now() - started };
  liveSessions.push(session);
  return session;
}
async function rpc(session, channel, args) {
  const response = await (await request(`${engine}/engine/${session.sessionId}/rpc`, { method: 'POST',
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel, args, sequence: session.sequence, operationId: randomUUID() }),
  }).catch(error => { throw new Error(`${channel}: ${error.message}`); })).json();
  session.sequence = response.sequence;
  return response;
}
async function close(session) {
  await request(`${engine}/engine/${session.sessionId}/close`, { method: 'POST',
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: '{}' });
  const i = liveSessions.indexOf(session);
  if (i >= 0) liveSessions.splice(i, 1);
}
async function download(docId, extension) {
  const response = await request(`${platform}/api/office/docs/${docId}/content`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(response.headers.get('x-office-kind'), extension);
  assert.equal(response.headers.get('x-office-version'), '2');
  assert.equal(response.headers.get('x-office-hash'), hash(bytes));
  await writeFile(resolve(outputDir, `roundtrip.${extension}`), bytes);
  return bytes;
}
async function compareEntries(before, after, allowed) {
  const [a, b] = await Promise.all([JSZip.loadAsync(before), JSZip.loadAsync(after)]);
  const changed = []; let preserved = 0;
  for (const [name, part] of Object.entries(a.files)) {
    if (part.dir) continue;
    assert.ok(b.file(name), `Package part disappeared: ${name}`);
    const original = await part.async('uint8array');
    const saved = await b.file(name).async('uint8array');
    if (hash(original) === hash(saved)) preserved++;
    else { changed.push(name); assert.ok(allowed.includes(name), `Unexpected changed part: ${name}`); }
  }
  return { changed, preserved, originalEntries: Object.values(a.files).filter(p => !p.dir).length };
}

try {
  const fixture = CORPUS.find(item => item.name === 'compatibility-edit.xlsx');
  const initial = await fixture.build();
  const doc = await create('xlsx', initial);
  const session = await open(doc.draftId);
  const workbook = session.result;
  assert.ok(workbook?.sessionId && workbook.sheets?.length, 'XLSX worker returned no workbook');
  const sheetId = workbook.sheets[0].id;
  const save = { sessionId: workbook.sessionId, mode: 'save',
    edits: [
      { sheetId, row: 0, column: 2, writeValue: true, value: 12.5, style: { bold: true, numberFormat: '$#,##0.00', fillColor: '#FFFF00' } },
      { sheetId, row: 1, column: 3, writeValue: true, value: 25, formula: '=C1*2' },
    ],
    structuralOps: [], chartEdits: [], visualEdits: [], visualAdditions: [], tableAdditions: [], pivotAdditions: [],
    sheetOps: [], sheetOrder: [], filterStates: [], hyperlinkEdits: [], cfStates: [], dvStates: [], pageSetupStates: [],
    noteStates: [], formulaValues: [{ sheetId, row: 1, column: 3, value: 25 }], pivotCacheRefreshPaths: [],
    pivotRefreshUpdates: [], sheetProtections: [], definedNamesState: null,
  };
  const saveStart = performance.now();
  const saved = await rpc(session, 'workbook:save', [save]);
  const saveMs = performance.now() - saveStart;
  assert.equal(saved.document?.version, 2);
  assert.equal(saved.result?.canceled, false);
  const bytes = await download(doc.draftId, 'xlsx');
  const zip = await JSZip.loadAsync(bytes);
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const styles = await zip.file('xl/styles.xml').async('string');
  assert.match(sheet, /<c\b[^>]*r="C1"[^>]*>[\s\S]*?<v>12\.5<\/v>/);
  assert.match(sheet, /<f[^>]*>C1\*2<\/f>/);
  const formulaCell = sheet.match(/<c\b[^>]*r="D2"[^>]*>[\s\S]*?<\/c>/)?.[0];
  assert.ok(formulaCell);
  assert.match(formulaCell, /<v>25<\/v>/, 'New formula cached value must survive export');
  assert.match(sheet, /<f[^>]*>SUM\(C1:C2\)<\/f>/, 'Existing formula must survive');
  assert.match(styles, /\$#,##0\.00/);
  assert.match(styles, /FFFF00/);
  const preservation = await compareEntries(initial, bytes, ['xl/worksheets/sheet1.xml', 'xl/styles.xml', 'xl/workbook.xml']);
  await close(session);
  const reopened = await open(doc.draftId);
  const range = await rpc(reopened, 'workbook:read-range', [{ sessionId: reopened.result.sessionId,
    sheetId: reopened.result.sheets[0].id, range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 3 } }]);
  assert.match(JSON.stringify(range.result), /12\.5/);
  report.results.push({ kind: 'xlsx', openMs: session.openMs, saveMs, reopenMs: reopened.openMs, bytes: bytes.length,
    checks: ['numeric value', 'new formula + cached value', 'existing formula', 'number format', 'fill style', 'saved hash', 'revision 2', 'engine reload'], preservation });
  await close(reopened);

  const pptxInitial = await PPTX_CORPUS[0].build();
  const deck = await create('pptx', pptxInitial);
  const presentation = await open(deck.draftId);
  // Element IDs belong to the engine's current parse, not a separate local parse.
  const target = presentation.result.slides[0].nodes.find(node => node.sourceId && JSON.stringify(node).includes('Old'));
  assert.ok(target, 'Engine render model returned no editable text target');
  const edit = await rpc(presentation, 'slides:edit-text', [{ slideIndex: 0, sourceId: target.sourceId,
    paragraphs: [{ runs: [{ text: 'Synthetic office roundtrip', bold: true, fontSize: 24, color: '#17365D' }] }] }]);
  assert.ok(edit.result, 'The edit must return the updated slide');
  const pptxSaveStart = performance.now();
  const pptxSaved = await rpc(presentation, 'slides:save', []);
  const pptxSaveMs = performance.now() - pptxSaveStart;
  assert.equal(pptxSaved.result?.ok, true);
  assert.equal(pptxSaved.document?.version, 2);
  const pptxBytes = await download(deck.draftId, 'pptx');
  const output = await openPptx(pptxBytes);
  const textRuns = output.deck.slides[0].elements.flatMap(element => element.text?.paragraphs.flatMap(p => p.runs) ?? []);
  assert.ok(textRuns.some(run => run.text === 'Synthetic office roundtrip'), 'Text must remain editable in the saved model');
  assert.equal(output.deck.slides.length, 2);
  const pptxZip = await JSZip.loadAsync(pptxBytes);
  const slidePart = await pptxZip.file('ppt/slides/slide1.xml').async('string');
  assert.match(slidePart, /Synthetic office roundtrip/);
  assert.match(slidePart, /sz="2400"/);
  assert.match(slidePart, /b="1"/);
  assert.match(slidePart, /17365D/);
  const pptxPreservation = await compareEntries(pptxInitial, pptxBytes, ['ppt/slides/slide1.xml']);
  await close(presentation);
  const reloaded = await open(deck.draftId);
  const rendered = await rpc(reloaded, 'slides:get-render-slides', [1100]);
  const renderedText = rendered.result[0].nodes.map(node =>
    (node.text?.lines ?? []).map(line => line.runs.map(run => run.text).join('')).join('\n')).join('\n');
  assert.match(renderedText, /Synthetic office roundtrip/);
  report.results.push({ kind: 'pptx', openMs: presentation.openMs, saveMs: pptxSaveMs, reopenMs: reloaded.openMs, bytes: pptxBytes.length,
    checks: ['editable text', 'font size', 'bold', 'color', 'two-slide count', 'saved hash', 'revision 2', 'engine reload'], preservation: pptxPreservation });
  await close(reloaded);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const session of [...liveSessions]) await close(session).catch(() => undefined);
  for (const docId of created) await serverFn('deleteOfficeDocFn', { docId }).catch(() => undefined);
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
