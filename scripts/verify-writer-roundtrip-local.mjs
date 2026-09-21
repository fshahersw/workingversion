// Read-only proof for the synthetic document created and corrected through the UI.
// Capture revision 2 as writer-before.docx before making the browser correction.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

assert.equal(process.env.LOCAL_SYNTHETIC_MODE, '1', 'Explicit local synthetic mode is required');
assert.notEqual(process.env.NODE_ENV, 'production', 'Production is refused');
const [docId, expectedVersion, expectedHeading] = process.argv.slice(2);
assert.match(docId ?? '', /^[0-9A-HJKMNP-TV-Z]{26}$/);
assert.match(expectedVersion ?? '', /^[0-9]+$/);
assert.ok(Number.isSafeInteger(Number(expectedVersion)) && Number(expectedVersion) >= 3);
assert.match(expectedHeading ?? '', /^Heading[1-6]$/);
const output = resolve('.integration.local/results/office-roundtrip');
const beforeBytes = new Uint8Array(await readFile(resolve(output, 'writer-before.docx')));
const response = await fetch(`http://127.0.0.1:5189/api/office/docs/${docId}/content`, {
  redirect: 'error', signal: AbortSignal.timeout(30_000), cache: 'no-store',
});
assert.equal(response.status, 200);
assert.equal(response.headers.get('x-office-kind'), 'docx');
assert.equal(response.headers.get('x-office-version'), expectedVersion);
const afterBytes = new Uint8Array(await response.arrayBuffer());
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(response.headers.get('x-office-hash'), hash(afterBytes));
const [before, after] = await Promise.all([JSZip.loadAsync(beforeBytes), JSZip.loadAsync(afterBytes)]);
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = value => value === null || value === undefined ? '' : typeof value !== 'object' ? String(value)
  : Object.entries(value).filter(([key]) => !key.startsWith('@_')).map(([, child]) => array(child).map(text).join('')).join('');
async function inspect(zip) {
  const xml = await zip.file('word/document.xml').async('string');
  assert.equal(XMLValidator.validate(xml), true, 'Valid native WordprocessingML');
  const body = parser.parse(xml)['w:document']['w:body'];
  const paragraphs = array(body['w:p']).map(p => ({ text: array(p['w:r']).map(r => text(r['w:t'])).join(''),
    style: p['w:pPr']?.['w:pStyle']?.['@_w:val'] ?? null }));
  const tables = array(body['w:tbl']).map(table => array(table['w:tr']).map(row => array(row['w:tc']).map(cell =>
    array(cell['w:p']).flatMap(p => array(p['w:r'])).map(r => text(r['w:t'])).join(''))));
  assert.deepEqual(tables, [[['Item', 'Value'], ['Alpha', '12'], ['Beta', '18']]]);
  assert.equal(paragraphs.find(p => p.text === 'Local Office Quality Check')?.style, 'Heading1');
  assert.ok(paragraphs.some(p => p.text === 'The total is 30.'));
  assert.equal(paragraphs.filter(p => p.text === 'Test facts').length, 1);
  return { xml, paragraphs, tables };
}
const baseline = await inspect(before), corrected = await inspect(after);
assert.equal(baseline.paragraphs.find(p => p.text === 'Test facts').style, 'Heading2');
assert.equal(corrected.paragraphs.find(p => p.text === 'Test facts').style, expectedHeading);
const names = zip => Object.values(zip.files).filter(part => !part.dir).map(part => part.name).sort();
assert.deepEqual(names(after), names(before), 'The package preserves every source part');
const changedParts = [], unchangedParts = [];
for (const name of names(before)) {
  const a = await before.file(name).async('uint8array'), b = await after.file(name).async('uint8array');
  (hash(a) === hash(b) ? unchangedParts : changedParts).push(name);
}
assert.deepEqual(changedParts, ['word/document.xml'], 'Only the main document part changes');
// Compare complete XML after normalizing only the target paragraph style.
function normalizeHeading(xml, style) {
  let replaced = 0;
  const normalized = xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, paragraph => {
    if (!paragraph.includes('>Test facts</w:t>')) return paragraph;
    const marker = `<w:pStyle w:val="${style}"/>`;
    assert.ok(paragraph.includes(marker)); replaced++;
    return paragraph.replace(marker, '<w:pStyle w:val="EXPECTED_HEADING"/>');
  });
  assert.equal(replaced, 1);
  return normalized;
}
assert.equal(normalizeHeading(corrected.xml, expectedHeading), normalizeHeading(baseline.xml, 'Heading2'),
  'No unrelated paragraph content, table data, formatting, or section properties changed');
await writeFile(resolve(output, 'writer-after.docx'), afterBytes);
await writeFile(resolve(output, 'writer-after-document.xml'), corrected.xml);
const report = { checkedAt: new Date().toISOString(), synthetic: true, microsoftWordApplicationValidated: false,
  docId, version: Number(expectedVersion), beforeBytes: beforeBytes.length, afterBytes: afterBytes.length,
  beforeHash: hash(beforeBytes), afterHash: hash(afterBytes),
  baseline: baseline.paragraphs, corrected: corrected.paragraphs, tables: corrected.tables,
  changedParts, unchangedParts, exactDocumentChange: `Test facts: Heading2 -> ${expectedHeading}` };
await writeFile(resolve(output, 'writer-roundtrip-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
