import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import { validateOfficeArchive } from './validate-archive.server';

async function packageDoc(body: string) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}
test('valid repetitive Word tables remain saveable within the absolute expansion budget', async () => {
  const row = '<w:tr>' + '<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>Synthetic table value</w:t></w:r></w:p></w:tc>'.repeat(4) + '</w:tr>';
  const body = '<w:tbl><w:tblPr/><w:tblGrid/>' + row.repeat(3000) + '</w:tbl>';
  const bytes = await packageDoc(body);
  assert.ok(body.length / bytes.length > 200, 'fixture reproduces legitimate highly-compressible table XML');
  assert.equal(validateOfficeArchive(bytes, 'docx').kind, 'docx');
});
test('absolute expanded part and aggregate budgets still reject excessive XML', async () => {
  const bytes = await packageDoc('<w:p><w:r><w:t>' + 'x'.repeat(33 * 1024 * 1024) + '</w:t></w:r></w:p>');
  assert.throws(() => validateOfficeArchive(bytes, 'docx'), /decompression limits/);
  const small = await packageDoc('<w:p/>');
  assert.throws(() => validateOfficeArchive(small, 'docx', { expanded: 128 * 1024 * 1024 }), /expanded-size limits/);
});
