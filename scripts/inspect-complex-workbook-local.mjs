// Read-only inspection of a synthetic workbook saved by the actual browser agent.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, posix } from 'node:path';
import JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

assert.equal(process.env.LOCAL_SYNTHETIC_MODE, '1');
assert.notEqual(process.env.NODE_ENV, 'production');
const [docId] = process.argv.slice(2);
assert.match(docId ?? '', /^[0-9A-HJKMNP-TV-Z]{26}$/);
const response = await fetch(`http://127.0.0.1:5189/api/office/docs/${docId}/content`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
assert.equal(response.status, 200);
assert.equal(response.headers.get('x-office-kind'), 'xlsx');
const bytes = new Uint8Array(await response.arrayBuffer());
const hash = createHash('sha256').update(bytes).digest('hex');
assert.equal(response.headers.get('x-office-hash'), hash);
const zip = await JSZip.loadAsync(bytes);
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
const list = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
async function part(name) {
  const entry = zip.file(name); assert.ok(entry, `Missing part: ${name}`);
  const text = await entry.async('string'); assert.equal(XMLValidator.validate(text), true, name);
  return parser.parse(text);
}
const text = value => typeof value === 'object' ? value?.['#text'] ?? '' : value ?? '';
const stringItem = value => value?.t !== undefined ? text(value.t) : list(value?.r).map(run => text(run.t)).join('');
const strings = zip.file('xl/sharedStrings.xml') ? list((await part('xl/sharedStrings.xml')).sst.si).map(stringItem) : [];
const workbook = (await part('xl/workbook.xml')).workbook;
const relationships = list((await part('xl/_rels/workbook.xml.rels')).Relationships.Relationship);
const packageErrors = [];
const byId = new Map();
for (const rel of relationships) {
  const id = rel['@_Id'];
  if (byId.has(id)) packageErrors.push({ kind: 'duplicate_relationship_id', part: 'xl/_rels/workbook.xml.rels', id, targets: [byId.get(id)['@_Target'], rel['@_Target']] });
  else byId.set(id, rel);
}
const sheets = [];
for (const tab of list(workbook.sheets.sheet)) {
  // Resolve by relationship type for forensic inspection after reporting a
  // duplicate ID. This does not make an ambiguous package valid.
  const rel = relationships.find(item => item['@_Id'] === tab['@_r:id'] && item['@_Type']?.endsWith('/worksheet')); assert.ok(rel);
  const target = rel['@_Target'].startsWith('/') ? rel['@_Target'].slice(1) : posix.normalize('xl/' + rel['@_Target']);
  const sheet = (await part(target)).worksheet;
  const cells = Object.fromEntries(list(sheet.sheetData.row).flatMap(row => list(row.c)).map(cell => [cell['@_r'], {
    value: cell['@_t'] === 's' ? strings[Number(cell.v)] : cell['@_t'] === 'inlineStr' ? stringItem(cell.is) : cell.v ?? null,
    ...(cell.f !== undefined ? { formula: text(cell.f) } : {}),
    type: cell['@_t'] ?? 'n', style: Number(cell['@_s'] ?? 0),
  }]));
  sheets.push({ name: tab['@_name'], part: target, cells,
    columns: list(sheet.cols?.col), merges: list(sheet.mergeCells?.mergeCell),
    views: sheet.sheetViews, pageSetup: sheet.pageSetup });
}
const charts = [];
for (const name of Object.keys(zip.files).filter(name => /^xl\/charts\/chart\d+\.xml$/.test(name))) {
  const document = await part(name);
  charts.push({ part: name, document });
}
const formulas = sheets.flatMap(sheet => Object.entries(sheet.cells).filter(([, cell]) => cell.formula !== undefined).map(([address, cell]) => ({ sheet: sheet.name, address, ...cell })));
const errors = sheets.flatMap(sheet => Object.entries(sheet.cells).filter(([, cell]) => cell.type === 'e').map(([address, cell]) => ({ sheet: sheet.name, address, ...cell })));
const missingFormulaCaches = formulas.filter(cell => cell.value === null);
const output = resolve('.integration.local/results/complex-workbook'); await mkdir(output, { recursive: true });
const report = { inspectedAt: new Date().toISOString(), docId, version: Number(response.headers.get('x-office-version')), sha256: hash,
  synthetic: true, microsoftExcelApplicationValidated: false, bytes: bytes.length, sheets, charts, errors, packageErrors, missingFormulaCaches,
  formulaCount: formulas.length, styles: (await part('xl/styles.xml')).styleSheet };
await writeFile(resolve(output, `${docId}.xlsx`), bytes);
await writeFile(resolve(output, `${docId}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, sheets: sheets.map(sheet => ({ name: sheet.name, cells: Object.keys(sheet.cells).length, formulas: Object.values(sheet.cells).filter(cell => cell.formula).length })), charts: charts.map(chart => chart.part), styles: undefined }, null, 2));
assert.equal(errors.length, 0, 'Saved workbook contains Excel errors');
assert.equal(missingFormulaCaches.length, 0, 'Saved workbook contains formulas without computed values');
assert.equal(packageErrors.length, 0, 'Saved workbook contains invalid package relationships');
