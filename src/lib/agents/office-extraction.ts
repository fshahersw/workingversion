/** Full native extraction for Office. Returned preview is bounded; the complete
 * UTF-8 sidecar is paged separately. Unsupported visual content is explicit. */
export function officeExtractionPython(name: string): string {
  return `
import json, os, zipfile, xml.etree.ElementTree as ET
name = ${JSON.stringify(name)}
ext = name.rsplit('.',1)[-1].lower()
out = {"kind": ext, "meta": {}, "text": ""}
parts = []
try:
    if ext == 'docx':
        ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
        W = '{'+ns['w']+'}'
        def visible(el):
            if el.tag in (W+'del', W+'moveFrom'): return ''
            if el.tag == W+'t': return el.text or ''
            if el.tag == W+'tab': return '\\t'
            if el.tag in (W+'br', W+'cr'): return '\\n'
            return ''.join(visible(c) for c in el)
        with zipfile.ZipFile(name) as z:
            files = ['word/document.xml'] + sorted(n for n in z.namelist() if n.startswith('word/') and (n.startswith('word/header') or n.startswith('word/footer') or n in ('word/footnotes.xml','word/endnotes.xml','word/comments.xml')) and n.endswith('.xml'))
            for part in files:
                root = ET.fromstring(z.read(part))
                parts.append('=== '+part+' ===')
                # Body paragraphs include table cells in document order. Prune
                # deleted/moved-from containers before traversing paragraphs.
                def paragraphs(el):
                    if el.tag in (W+'del', W+'moveFrom'): return
                    if el.tag == W+'p':
                        yield visible(el)
                        return
                    for c in el: yield from paragraphs(c)
                parts.extend(paragraphs(root))
            out['meta']['parts'] = files
    elif ext in ('xlsx','xlsm'):
        import openpyxl
        wb = openpyxl.load_workbook(name, read_only=True, data_only=False)
        cached = openpyxl.load_workbook(name, read_only=True, data_only=True)
        sheets = []
        for ws in wb.worksheets:
            parts.append('=== SHEET: '+ws.title+' ('+ws.sheet_state+') ===')
            cache_rows = cached[ws.title].iter_rows()
            count = 0
            for row in ws.iter_rows():
                cached_row = next(cache_rows, ())
                cells = []
                for i, c in enumerate(row):
                    if c.value is None: continue
                    value = str(c.value)
                    if c.data_type == 'f':
                        cv = cached_row[i].value if i < len(cached_row) else None
                        value += ' [cached value: '+(str(cv) if cv is not None else 'unavailable; not recalculated')+']'
                    cells.append(c.coordinate+'='+value)
                if cells: parts.append(' | '.join(cells)); count += 1
            sheets.append({'name':ws.title,'nonemptyRows':count,'state':ws.sheet_state})
        out['meta']['sheets'] = sheets
        wb.close(); cached.close()
    elif ext == 'xls':
        import pandas as pd
        with pd.ExcelFile(name) as wb:
            for sheet in wb.sheet_names:
                parts.append('=== SHEET: '+sheet+' ===\\n'+wb.parse(sheet).to_csv(index=False))
        out['meta']['note'] = 'Legacy XLS: values extracted; formula definitions may be unavailable.'
    elif ext == 'pptx':
        from pptx import Presentation
        prs = Presentation(name)
        def shape_text(shape):
            if hasattr(shape, 'shapes'):
                for child in shape.shapes: yield from shape_text(child)
            if shape.has_text_frame: yield shape.text_frame.text
            if shape.has_table:
                for row in shape.table.rows: yield ' | '.join(c.text for c in row.cells)
            if shape.has_chart:
                for series in shape.chart.series: yield 'Chart series '+str(series.name)+': '+str(list(series.values))
        for i, slide in enumerate(prs.slides):
            parts.append('[slide '+str(i+1)+']')
            for shape in slide.shapes: parts.extend(shape_text(shape))
            if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
                parts.append('[speaker notes] '+slide.notes_slide.notes_text_frame.text)
        out['meta']['slides'] = len(prs.slides)
    elif ext in ('html','htm'):
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(open(name,encoding='utf-8',errors='replace').read(),'html.parser')
        for tag in soup(['script','style']): tag.decompose()
        parts.append(soup.get_text('\\n'))
    elif ext == 'rtf':
        from striprtf.striprtf import rtf_to_text
        parts.append(rtf_to_text(open(name,encoding='utf-8',errors='replace').read()))
    else:
        parts.append(open(name,encoding='utf-8-sig',errors='strict').read())
    full = '\\n'.join(parts)
    if not full.strip(): raise ValueError('No native text found. Scanned content requires OCR.')
    if len(full) > 50_000_000: raise ValueError('Extracted text exceeds 50 million characters. Split the file; no partial extraction was accepted.')
    with open(name+'.extracted.txt','w',encoding='utf-8',newline='') as f: f.write(full)
    out['chars'] = len(full)
    out['text'] = full[:64000]
    out['meta']['nextOffset'] = len(out['text'].encode('utf-8')) if len(full) > 64000 else None
    out['meta']['coverage'] = 'Native text, tables and supported notes. Images, embedded files, visual layout and unrecognized objects require separate visual/OCR review. Deleted Word revisions excluded; comments and headers are labeled separately.'
except Exception as e:
    out['error'] = str(e)[:300]; out['chars'] = 0; out['text'] = ''
print('<<DOC>>'+json.dumps(out)+'<<END>>')
`;
}

/** Read a bounded byte range, carrying a split UTF-8 character into the next page. */
export function extractedPagePython(name: string, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid extraction offset");
  return `
import json, os, codecs
p = ${JSON.stringify(name + ".extracted.txt")}
start = ${offset}
with open(p,'rb') as f:
    f.seek(start)
    raw = f.read(256000)
decoder = codecs.getincrementaldecoder('utf-8')()
text = decoder.decode(raw, final=start+len(raw)>=os.path.getsize(p))
pending = decoder.getstate()[0]
end = start+len(raw)-len(pending)
print('<<PAGE>>'+json.dumps({'text':text,'nextOffset':end if end<os.path.getsize(p) else None})+'<<END>>')
`;
}
