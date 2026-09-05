// ============================================================================
// Native document generation via the AgentCore code interpreter (server-only).
//
// Turns markdown into a polished DOCX / XLSX / PDF: cover page, heading styles,
// markdown tables -> native styled/sized tables, bullet/number lists, page
// numbers + running header/footer, and diagrams (```dot / ```graphviz blocks
// rendered with graphviz). Three professional styles: legal (navy/serif),
// modern (teal/sans), minimal (understated). reportlab / python-docx / openpyxl
// / graphviz(+dot) are all preinstalled. Returns base64 for the chat artifact
// (download) pipeline.
// ============================================================================
import { runPython, writeFile, markSeen, getFile } from "./code-interpreter.server";

// One String.raw literal (keeps Python \n \d \s escapes). Backticks are built
// with chr(96) so no ` breaks the template literal; no \1 backrefs (lambdas).
const DOCGEN_PY = String.raw`
import re, os, datetime
BT = chr(96); FENCE = BT * 3
_OPEN = r'^\s*' + FENCE + r'(\w+)?\s*$'
_CLOSE = r'^\s*' + FENCE + r'\s*$'
_STOP = r'^(#{1,6}\s|\s*' + FENCE + r'|\s*[-*+]\s|\s*\d+[.)]\s)'
FIRM = "Seeger Weiss LLP"
CONF = "Confidential - Attorney Work Product"

def _parse_blocks(md):
    lines = (md or "").split("\n")
    blocks, i = [], 0
    while i < len(lines):
        line = lines[i]
        m = re.match(_OPEN, line)
        if m:
            lang = (m.group(1) or "").lower(); i += 1; buf = []
            while i < len(lines) and not re.match(_CLOSE, lines[i]):
                buf.append(lines[i]); i += 1
            i += 1; blocks.append(("code", lang, "\n".join(buf))); continue
        if "|" in line and i+1 < len(lines) and "-" in lines[i+1] and re.match(r'^\s*\|?[\s:|-]+\|?\s*$', lines[i+1]):
            tbl = [line]; i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                tbl.append(lines[i]); i += 1
            rows = [[c.strip() for c in r.strip().strip("|").split("|")] for r in tbl]
            blocks.append(("table", None, rows)); continue
        hm = re.match(r'^(#{1,6})\s+(.*)$', line)
        if hm:
            blocks.append(("heading", len(hm.group(1)), hm.group(2).strip())); i += 1; continue
        if re.match(r'^\s*[-*+]\s+', line):
            items = []
            while i < len(lines) and re.match(r'^\s*[-*+]\s+(.*)$', lines[i]):
                items.append(re.match(r'^\s*[-*+]\s+(.*)$', lines[i]).group(1).strip()); i += 1
            blocks.append(("bullets", None, items)); continue
        if re.match(r'^\s*\d+[.)]\s+', line):
            items = []
            while i < len(lines) and re.match(r'^\s*\d+[.)]\s+(.*)$', lines[i]):
                items.append(re.match(r'^\s*\d+[.)]\s+(.*)$', lines[i]).group(1).strip()); i += 1
            blocks.append(("numbers", None, items)); continue
        if not line.strip():
            i += 1; continue
        para = [line]; i += 1
        while i < len(lines) and lines[i].strip() and not re.match(_STOP, lines[i]) and "|" not in lines[i]:
            para.append(lines[i]); i += 1
        blocks.append(("para", None, " ".join(para)))
    return blocks

def _inline(t):
    g1 = lambda m: m.group(1)
    t = re.sub(r'\*\*(.+?)\*\*', g1, t); t = re.sub(r'\*(.+?)\*', g1, t)
    t = re.sub(BT + r'(.+?)' + BT, g1, t)
    t = re.sub(r'\[(.+?)\]\((.+?)\)', lambda m: m.group(1) + " (" + m.group(2) + ")", t)
    return t

def _esc(t):
    return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def _num(s):
    x = str(s).replace(",", "").replace("$", "").strip()
    try:
        if re.match(r'^-?\d+$', x): return int(x)
        return float(x)
    except Exception:
        return s

def _render_dot(dot, stem):
    try:
        import graphviz
        src = graphviz.Source(dot); src.format = "png"
        p = src.render(filename=stem, cleanup=True)
        return p if os.path.exists(p) else None
    except Exception:
        return None

STYLES = {
    "legal":   {"accent": "#1F2A5E", "rule": "#C9A227", "band": "#1F2A5E", "zebra": "#EEF1F8", "grid": "#C7CEE0",
                "pdf_font": "Times-Roman", "pdf_bold": "Times-Bold", "docx_font": "Georgia", "label": "Litigation Research Report"},
    "modern":  {"accent": "#0F766E", "rule": "#14B8A6", "band": "#0F766E", "zebra": "#ECFDF9", "grid": "#B9E7DF",
                "pdf_font": "Helvetica", "pdf_bold": "Helvetica-Bold", "docx_font": "Calibri", "label": "Research Report"},
    "minimal": {"accent": "#1A1A1A", "rule": "#9AA0A6", "band": "#2B2B2B", "zebra": "#F5F5F5", "grid": "#D6D6D6",
                "pdf_font": "Helvetica", "pdf_bold": "Helvetica-Bold", "docx_font": "Calibri", "label": "Report"},
}
def _sty(name): return STYLES.get(name, STYLES["legal"])

def build_docx(title, blocks, outfile, style):
    import docx
    from docx.shared import Pt, Inches, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    S = _sty(style)
    def _rgb(h):
        h = h.lstrip("#"); return RGBColor(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    def _shade(cell, hexc):
        tcPr = cell._tc.get_or_add_tcPr(); shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear"); shd.set(qn("w:fill"), hexc.lstrip("#")); tcPr.append(shd)
    accent = _rgb(S["accent"]); font = S["docx_font"]
    d = docx.Document()
    nf = d.styles["Normal"].font; nf.name = font; nf.size = Pt(11)
    for i in (1, 2, 3):
        try:
            hs = d.styles["Heading %d" % i].font; hs.color.rgb = accent; hs.name = font
        except Exception: pass
    for _ in range(6): d.add_paragraph()
    tp = d.add_paragraph(); tp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    tr = tp.add_run(title); tr.bold = True; tr.font.size = Pt(28); tr.font.color.rgb = accent; tr.font.name = font
    sp = d.add_paragraph(); sp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    srr = sp.add_run(S["label"]); srr.font.size = Pt(12); srr.font.color.rgb = RGBColor(0x66, 0x66, 0x66); srr.font.name = font
    dp = d.add_paragraph(); dp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    dr = dp.add_run(FIRM + "   |   " + datetime.date.today().strftime("%B %d, %Y"))
    dr.font.size = Pt(10); dr.font.color.rgb = RGBColor(0x88, 0x88, 0x88); dr.font.name = font
    d.add_page_break()
    fpar = d.sections[0].footer.paragraphs[0]; fpar.alignment = WD_ALIGN_PARAGRAPH.CENTER
    fr = fpar.add_run(CONF + "   -   Page "); fr.font.size = Pt(8); fr.font.color.rgb = RGBColor(0x88, 0x88, 0x88)
    pg = fpar.add_run(); fld = OxmlElement("w:fldSimple"); fld.set(qn("w:instr"), "PAGE"); pg._r.append(fld)
    dn = 0
    for kind, meta, val in blocks:
        if kind == "heading":
            d.add_heading(_inline(val), level=min(meta, 4))
        elif kind == "para":
            d.add_paragraph(_inline(val))
        elif kind == "bullets":
            for it in val: d.add_paragraph(_inline(it), style="List Bullet")
        elif kind == "numbers":
            for it in val: d.add_paragraph(_inline(it), style="List Number")
        elif kind == "table":
            rows = val
            if not rows: continue
            cols = max(len(r) for r in rows)
            tbl = d.add_table(rows=len(rows), cols=cols)
            try: tbl.style = "Table Grid"
            except Exception: pass
            tbl.autofit = True
            for ri, row in enumerate(rows):
                for ci in range(cols):
                    cell = tbl.cell(ri, ci); cell.text = _inline(row[ci]) if ci < len(row) else ""
                    if ri == 0:
                        _shade(cell, S["accent"])
                        for p in cell.paragraphs:
                            for rr in p.runs:
                                rr.bold = True; rr.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        elif kind == "code":
            if meta in ("dot", "graphviz"):
                png = _render_dot(val, "dgx_%d" % dn); dn += 1
                if png: d.add_picture(png, width=Inches(6.0))
                else:
                    p = d.add_paragraph(); rr = p.add_run(val); rr.font.name = "Consolas"; rr.font.size = Pt(9)
            else:
                p = d.add_paragraph(); rr = p.add_run(val); rr.font.name = "Consolas"; rr.font.size = Pt(9)
    d.save(outfile); return outfile

def build_pdf(title, blocks, outfile, style):
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                    PageBreak, Image, ListFlowable, ListItem, HRFlowable)
    S = _sty(style)
    accent = colors.HexColor(S["accent"]); rule = colors.HexColor(S["rule"]); band = colors.HexColor(S["band"])
    zebra = colors.HexColor(S["zebra"]); grid = colors.HexColor(S["grid"])
    font = S["pdf_font"]; bold = S["pdf_bold"]
    ss = getSampleStyleSheet()
    body = ParagraphStyle("Bodyx", parent=ss["BodyText"], fontName=font, fontSize=10.5, leading=15, spaceAfter=6)
    h1 = ParagraphStyle("H1x", parent=ss["Heading1"], fontName=bold, fontSize=15, textColor=accent, spaceBefore=14, spaceAfter=6)
    h2 = ParagraphStyle("H2x", parent=ss["Heading2"], fontName=bold, fontSize=12.5, textColor=accent, spaceBefore=10, spaceAfter=4)
    h3 = ParagraphStyle("H3x", parent=ss["Heading3"], fontName=bold, fontSize=11, textColor=accent, spaceBefore=8, spaceAfter=3)
    ctitle = ParagraphStyle("CTx", fontName=bold, fontSize=28, leading=34, alignment=TA_CENTER, textColor=accent)
    csub = ParagraphStyle("CSx", fontName=font, fontSize=12, alignment=TA_CENTER, textColor=colors.grey)
    W, H = letter
    def _cover(canvas, doc):
        canvas.saveState()
        canvas.setFillColor(band); canvas.rect(0, H - 2.1 * inch, W, 2.1 * inch, fill=1, stroke=0)
        canvas.setFillColor(colors.white); canvas.setFont(bold, 12)
        canvas.drawString(0.9 * inch, H - 1.7 * inch, FIRM.upper())
        canvas.setFillColor(colors.grey); canvas.setFont(font, 9)
        canvas.drawString(0.9 * inch, 0.55 * inch, CONF)
        canvas.drawRightString(W - 0.9 * inch, 0.55 * inch, datetime.date.today().strftime("%B %d, %Y"))
        canvas.restoreState()
    def _page(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(accent); canvas.setLineWidth(1.5)
        canvas.line(0.9 * inch, H - 0.7 * inch, W - 0.9 * inch, H - 0.7 * inch)
        canvas.setFont(font, 8); canvas.setFillColor(colors.grey)
        canvas.drawString(0.9 * inch, 0.55 * inch, FIRM + "  |  " + CONF)
        canvas.drawRightString(W - 0.9 * inch, 0.55 * inch, "Page %d" % doc.page)
        canvas.restoreState()
    doc = SimpleDocTemplate(outfile, pagesize=letter, topMargin=0.95 * inch, bottomMargin=0.85 * inch,
                            leftMargin=0.9 * inch, rightMargin=0.9 * inch, title=title)
    avail = W - 1.8 * inch
    hmap = {1: h1, 2: h2, 3: h3}
    story = [Spacer(1, 3.0 * inch), Paragraph(_esc(title), ctitle), Spacer(1, 10),
             HRFlowable(width=3.0 * inch, thickness=2, color=rule, spaceBefore=4, spaceAfter=12, hAlign="CENTER"),
             Paragraph(S["label"], csub), PageBreak()]
    dn = 0
    for kind, meta, val in blocks:
        if kind == "heading":
            story.append(Paragraph(_esc(_inline(val)), hmap.get(min(meta, 3), h3)))
        elif kind == "para":
            story.append(Paragraph(_esc(_inline(val)), body))
        elif kind == "bullets":
            story.append(ListFlowable([ListItem(Paragraph(_esc(_inline(it)), body)) for it in val],
                                      bulletType="bullet", bulletColor=accent, leftIndent=16)); story.append(Spacer(1, 4))
        elif kind == "numbers":
            story.append(ListFlowable([ListItem(Paragraph(_esc(_inline(it)), body)) for it in val],
                                      bulletType="1", leftIndent=16)); story.append(Spacer(1, 4))
        elif kind == "table":
            data = [[Paragraph(_esc(_inline(c)), body) for c in r] for r in val]
            cols = max(len(r) for r in val); cw = avail / cols
            tb = Table(data, colWidths=[cw] * cols, repeatRows=1)
            tb.setStyle(TableStyle([
                ("GRID", (0, 0), (-1, -1), 0.5, grid),
                ("BACKGROUND", (0, 0), (-1, 0), band),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), bold),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, zebra]),
                ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            story += [tb, Spacer(1, 8)]
        elif kind == "code":
            if meta in ("dot", "graphviz"):
                png = _render_dot(val, "pdg_%d" % dn); dn += 1
                if png:
                    iw, ih = ImageReader(png).getSize(); w = min(avail, iw); h = w * ih / iw
                    story += [Image(png, width=w, height=h), Spacer(1, 8)]
                else:
                    story.append(Paragraph("<font face='Courier' size=8>%s</font>" % _esc(val).replace("\n", "<br/>"), body))
            else:
                story.append(Paragraph("<font face='Courier' size=8>%s</font>" % _esc(val).replace("\n", "<br/>"), body))
    doc.build(story, onFirstPage=_cover, onLaterPages=_page); return outfile

def build_xlsx(title, blocks, outfile, style):
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
    S = _sty(style); accent = S["accent"].lstrip("#")
    wb = openpyxl.Workbook(); wb.remove(wb.active)
    hdr_fill = PatternFill("solid", fgColor=accent); hdr_font = Font(bold=True, color="FFFFFF")
    thin = Side(style="thin", color=S["grid"].lstrip("#")); border = Border(left=thin, right=thin, top=thin, bottom=thin)
    tables = [b for b in blocks if b[0] == "table"]
    if not tables:
        ws = wb.create_sheet("Document"); ws["A1"] = title
        ws["A1"].font = Font(bold=True, size=14, color=accent); r = 3
        for kind, meta, val in blocks:
            if kind in ("bullets", "numbers"):
                for it in val: ws.cell(row=r, column=1, value=("- " if kind == "bullets" else "") + _inline(it)); r += 1
            elif kind in ("heading", "para"):
                c = ws.cell(row=r, column=1, value=_inline(val))
                if kind == "heading": c.font = Font(bold=True, size=12, color=accent)
                r += 1
        ws.column_dimensions["A"].width = 100
    else:
        for ti, (_, _, rows) in enumerate(tables):
            ws = wb.create_sheet(("Data" if len(tables) == 1 else "Table %d" % (ti + 1)))
            for ri, row in enumerate(rows):
                for ci, c in enumerate(row):
                    cell = ws.cell(row=ri + 1, column=ci + 1, value=(_num(c) if ri > 0 else str(c))); cell.border = border
                    if ri == 0:
                        cell.fill = hdr_fill; cell.font = hdr_font; cell.alignment = Alignment(horizontal="center")
            ncols = max(len(r) for r in rows)
            for ci in range(ncols):
                w = max((len(str(rows[ri][ci])) if ci < len(rows[ri]) else 0) for ri in range(len(rows)))
                ws.column_dimensions[get_column_letter(ci + 1)].width = min(max(w + 2, 10), 60)
            ws.freeze_panes = "A2"
    wb.save(outfile); return outfile

def build(fmt, title, md, outfile, style="legal"):
    blocks = _parse_blocks(md or "")
    if fmt == "docx": return build_docx(title, blocks, outfile, style)
    if fmt == "xlsx": return build_xlsx(title, blocks, outfile, style)
    return build_pdf(title, blocks, outfile, style)
`;

const EXT_FOR: Record<string, string> = { docx: "docx", xlsx: "xlsx", pdf: "pdf" };
const MIME_FOR: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

function safeStem(s: string): string {
  return (s.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").replace(/\.(docx|xlsx|pdf)$/i, "").slice(0, 80)) || "document";
}

export type GeneratedDoc = { name: string; mime: string; dataB64: string; size: number };

/** Render markdown into a polished docx/xlsx/pdf in the sandbox; returns the
 *  file as base64 for the chat artifact pipeline. style = legal|modern|minimal. */
export async function generateDocument(
  format: string,
  title: string,
  markdown: string,
  filename?: string,
  style?: string,
): Promise<GeneratedDoc | { error: string }> {
  const fmt = EXT_FOR[format] ? format : "pdf";
  const sty = style === "modern" || style === "minimal" || style === "legal" ? style : "legal";
  const name = `${safeStem(filename || title || "document")}.${EXT_FOR[fmt]}`;
  try {
    await writeFile("docgen.py", DOCGEN_PY);
    const code = [
      "import importlib, docgen",
      "importlib.reload(docgen)",
      `out = docgen.build(${JSON.stringify(fmt)}, ${JSON.stringify(title || "Document")}, ${JSON.stringify(markdown || "")}, ${JSON.stringify(name)}, ${JSON.stringify(sty)})`,
      `import os; print('<<OK>>' + out + '|' + str(os.path.getsize(out)) + '<<END>>')`,
    ].join("\n");
    const res = await runPython(code);
    if (res.isError) return { error: res.text.slice(-400) || "document build failed" };
    const m = res.text.match(/<<OK>>(.+?)\|(\d+)<<END>>/);
    if (!m) return { error: `build produced no file: ${res.text.slice(-300)}` };
    const size = Number(m[2]) || 0;
    markSeen(name); // returned as an artifact directly — don't also surface via collectNewArtifacts
    const dataB64 = await getFile(name);
    if (!dataB64) return { error: "could not read generated file" };
    return { name, mime: MIME_FOR[fmt] ?? "application/octet-stream", dataB64, size };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "document generation failed" };
  }
}
