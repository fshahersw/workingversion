// Read-only verification of the deterministic fixtures entered through the live
// local Office agents. No cloud requests, provider calls, or document mutations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

assert.equal(process.env.LOCAL_SYNTHETIC_MODE, '1');
assert.notEqual(process.env.NODE_ENV, 'production');
const [kind, docId, expectedVersion] = process.argv.slice(2);
assert.ok(['xlsx', 'pptx'].includes(kind));
assert.match(docId ?? '', /^[0-9A-HJKMNP-TV-Z]{26}$/);
assert.match(expectedVersion ?? '', /^[1-9][0-9]*$/);
const response = await fetch(`http://127.0.0.1:5189/api/office/docs/${docId}/content`, {
  redirect: 'error', signal: AbortSignal.timeout(30_000), cache: 'no-store',
});
assert.equal(response.status, 200);
assert.equal(response.headers.get('x-office-kind'), kind);
assert.equal(response.headers.get('x-office-version'), expectedVersion);
const bytes = new Uint8Array(await response.arrayBuffer());
const sha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(response.headers.get('x-office-hash'), sha256);
const zip = await JSZip.loadAsync(bytes);
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const xmlParts = {};
async function part(name) {
  assert.ok(zip.file(name), `Missing native part ${name}`);
  const xml = await zip.file(name).async('string');
  assert.equal(XMLValidator.validate(xml), true, name);
  xmlParts[name] = xml;
  return parser.parse(xml);
}
let details;
if (kind === 'xlsx') {
  const workbook = (await part('xl/workbook.xml')).workbook;
  const tabs = array(workbook.sheets.sheet);
  assert.equal(tabs.length, 1); assert.equal(tabs[0]['@_name'], 'Sheet1');
  const relationships = array((await part('xl/_rels/workbook.xml.rels')).Relationships.Relationship);
  const sheetTarget = relationships.find(rel => rel['@_Id'] === tabs[0]['@_r:id'])?.['@_Target'];
  assert.equal(sheetTarget, 'worksheets/sheet1.xml');
  const worksheet = (await part(`xl/${sheetTarget}`)).worksheet;
  const cells = Object.fromEntries(array(worksheet.sheetData.row).flatMap(row => array(row.c)).map(cell => [cell['@_r'], cell]));
  assert.deepEqual(Object.keys(cells).sort(), ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4']);
  const text = cell => typeof cell?.is?.t === 'object' ? cell.is.t['#text'] : cell?.is?.t;
  for (const [address, value] of Object.entries({ A1: 'Item', B1: 'Amount', A2: 'Alpha', A3: 'Beta', A4: 'Total' })) {
    assert.equal(text(cells[address]), value, address);
  }
  assert.equal(cells.B2.v, '12'); assert.equal(cells.B3.v, '13');
  assert.equal(cells.B4.f, 'SUM(B2:B3)'); assert.equal(cells.B4.v, '25', 'Native formula cache must match current inputs');
  const styles = (await part('xl/styles.xml')).styleSheet;
  const xfs = array(styles.cellXfs.xf), fonts = array(styles.fonts.font), formats = array(styles.numFmts.numFmt);
  const style = cell => xfs[Number(cell['@_s'] ?? 0)];
  const bold = cell => Object.hasOwn(fonts[Number(style(cell)['@_fontId'])], 'b');
  assert.deepEqual(Object.entries(cells).filter(([, cell]) => bold(cell)).map(([address]) => address).sort(), ['A1', 'B1']);
  const currency = ['B2', 'B3', 'B4'].map(address => {
    const numFmtId = style(cells[address])['@_numFmtId'];
    const formatCode = formats.find(format => format['@_numFmtId'] === numFmtId)?.['@_formatCode'];
    assert.match(formatCode ?? '', /\$/); assert.match(formatCode, /0\.00/);
    return { address, numFmtId, formatCode };
  });
  details = { sheets: 1, sheetName: 'Sheet1', nativeFormula: cells.B4.f, cachedValue: Number(cells.B4.v),
    numericInputs: [Number(cells.B2.v), Number(cells.B3.v)], boldCells: ['A1', 'B1'], currency, exactContentAndStyles: true };
} else {
  const presentation = (await part('ppt/presentation.xml'))['p:presentation'];
  assert.equal(array(presentation['p:sldIdLst']['p:sldId']).length, 1);
  const size = presentation['p:sldSz'];
  // The fixture is the platform's unmodified 13 1/3 x 7 1/2 inch blank deck.
  assert.equal(Number(size['@_cx']), 12192000); assert.equal(Number(size['@_cy']), 6858000);
  const slide = (await part('ppt/slides/slide1.xml'))['p:sld']['p:cSld']['p:spTree'];
  const shapes = array(slide['p:sp']);
  assert.equal(shapes.length, 1, 'Exactly one native editable text shape');
  for (const key of ['p:pic', 'p:graphicFrame', 'p:grpSp']) assert.equal(array(slide[key]).length, 0, `No unexpected ${key}`);
  const shape = shapes[0], transform = shape['p:spPr']['a:xfrm'];
  assert.deepEqual([transform['a:off']['@_x'], transform['a:off']['@_y'], transform['a:ext']['@_cx'], transform['a:ext']['@_cy']].map(Number),
    [914400, 914400, 6400800, 914400]);
  const paragraphs = array(shape['p:txBody']['a:p']);
  const runs = paragraphs.flatMap(p => array(p['a:r']));
  assert.equal(runs.map(run => run['a:t']).join(''), 'Synthetic slide quality check');
  assert.ok(runs.length > 0);
  for (const run of runs) {
    assert.equal(Number(run['a:rPr']['@_sz']), 2400);
    assert.equal(run['a:rPr']['@_b'], '1');
    assert.equal(run['a:rPr']['a:solidFill']['a:srgbClr']['@_val'].toUpperCase(), '172E4C');
  }
  details = { slides: 1, sizeEmu: [Number(size['@_cx']), Number(size['@_cy'])], editableTextShapes: 1,
    text: runs.map(run => run['a:t']).join(''), geometryEmu: [914400, 914400, 6400800, 914400],
    fontPoints: 24, bold: true, color: '172E4C', exactContentAndStyles: true };
}
const output = resolve('.integration.local/results/browser-office');
await mkdir(output, { recursive: true });
await writeFile(resolve(output, `${kind}-agent-verified.${kind}`), bytes);
const report = { checkedAt: new Date().toISOString(), synthetic: true, microsoftOfficeApplicationValidated: false,
  docId, version: Number(expectedVersion), kind, bytes: bytes.length, sha256, details, xmlParts };
await writeFile(resolve(output, `${kind}-agent-verified.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, xmlParts: Object.keys(xmlParts) }, null, 2));
