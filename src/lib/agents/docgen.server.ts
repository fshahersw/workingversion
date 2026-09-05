// ============================================================================
// Native document generation via the AgentCore code interpreter (server-only).
//
// Turns markdown into a polished DOCX / XLSX / PDF: cover page, heading styles,
// markdown tables -> native tables (sized, styled header), bullet/number lists,
// page numbers, and diagrams (```dot / ```graphviz fenced blocks rendered with
// graphviz). reportlab / python-docx / openpyxl / graphviz(+dot) are all
// preinstalled in the sandbox. The rendered file is returned as base64 for the
// chat artifact pipeline (download).
// ============================================================================
import { runPython, writeFile, markSeen } from "./code-interpreter.server";
import { getFile } from "./code-interpreter.server";

// One String.raw literal (keeps Python \n \d \s escapes). Backticks are built
// with chr(96) so no ` breaks the template literal.
const DOCGEN_PY = String.raw`
import re, os, datetime
BT = chr(96); FENCE = BT * 3
_OPEN = r'^\s*' + FENCE + r'(\w+)?\s*$'
_CLOSE = r'^\s*' + FENCE + r'\s*$'
_STOP = r'^(#{1,6}\s|\s*' + FENCE + r'|\s*[-*+]\s|\s*\d+[.)]\s)'

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
            tbl = [line]; i += 2  # skip header sep
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

def build_docx(title, blocks, outfile):
    import docx
    from docx.shared import Pt, Inches, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    d = docx.Document()
    d.add_paragraph(); d.add_paragraph()
    t = d.add_paragraph(); t.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = t.add_run(title); r.bold = True; r.font.size = Pt(26)
    sub = d.add_paragraph(); sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    sr = sub.add_run("Seeger Weiss LLP  |  " + datetime.date.today().isoformat())
    sr.font.size = Pt(11); sr.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
    d.add_page_break()
    fp = d.sections[0].footer.paragraphs[0]; fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = fp.add_run(); fld = OxmlElement('w:fldSimple'); fld.set(qn('w:instr'), 'PAGE'); run._r.append(fld)
    dn = 0
    for kind, meta, val in blocks:
        if kind == "heading": d.add_heading(_inline(val), level=min(meta, 4))
        elif kind == "para": d.add_paragraph(_inline(val))
        elif kind == "bullets":
            for it in val: d.add_paragraph(_inline(it), style="List Bullet")
        elif kind == "numbers":
            for it in val: d.add_paragraph(_inline(it), style="List Number")
        elif kind == "table":
            rows = val
            if not rows: continue
            cols = max(len(r) for r in rows)
            tbl = d.add_table(rows=len(rows), cols=cols)
            try: tbl.style = "Light Grid Accent 1"
            except Exception: tbl.style = "Table Grid"
            for ri, row in enumerate(rows):
                for ci in range(cols):
                    cell = tbl.cell(ri, ci); cell.text = _inline(row[ci]) if ci < len(row) else ""
                    if ri == 0:
                        for p in cell.paragraphs:
                            for rr in p.runs: rr.bold = True
        elif kind == "code":
            if meta in ("dot", "graphviz"):
                png = _render_dot(val, "dgx_%d" % dn); dn += 1
                if png: d.add_picture(png, width=Inches(6.0))
                else:
                    p = d.add_paragraph(); rr = p.add_run(val); rr.font.name = "Consolas"; rr.font.size = Pt(9)
            else:
                p = d.add_paragraph(); rr = p.add_run(val); rr.font.name = "Consolas"; rr.font.size = Pt(9)
    d.save(outfile); return outfile

def build_pdf(title, blocks, outfile):
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                    PageBreak, Image, ListFlowable, ListItem)
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="CoverTitle", fontSize=26, leading=32, alignment=TA_CENTER, fontName="Helvetica-Bold"))
    styles.add(ParagraphStyle(name="CoverSub", fontSize=11, alignment=TA_CENTER, textColor=colors.grey))
    def _footer(canvas, doc):
        canvas.saveState(); canvas.setFont("Helvetica", 8); canvas.setFillColor(colors.grey)
        canvas.drawCentredString(letter[0] / 2.0, 0.5 * inch, "Page %d" % doc.page); canvas.restoreState()
    doc = SimpleDocTemplate(outfile, pagesize=letter, topMargin=0.9*inch, bottomMargin=0.9*inch, leftMargin=0.9*inch, rightMargin=0.9*inch)
    avail = letter[0] - 1.8 * inch
    story = [Spacer(1, 2.4 * inch), Paragraph(_esc(title), styles["CoverTitle"]), Spacer(1, 10),
             Paragraph("Seeger Weiss LLP &nbsp;|&nbsp; " + datetime.date.today().isoformat(), styles["CoverSub"]), PageBreak()]
    dn = 0
    for kind, meta, val in blocks:
        if kind == "heading": story.append(Paragraph(_esc(_inline(val)), styles["Heading%d" % min(meta, 3)]))
        elif kind == "para": story += [Paragraph(_esc(_inline(val)), styles["BodyText"]), Spacer(1, 4)]
        elif kind == "bullets":
            story.append(ListFlowable([ListItem(Paragraph(_esc(_inline(it)), styles["BodyText"])) for it in val], bulletType="bullet")); story.append(Spacer(1, 4))
        elif kind == "numbers":
            story.append(ListFlowable([ListItem(Paragraph(_esc(_inline(it)), styles["BodyText"])) for it in val], bulletType="1")); story.append(Spacer(1, 4))
        elif kind == "table":
            rows = [[Paragraph(_esc(_inline(c)), styles["BodyText"]) for c in r] for r in val]
            cols = max(len(r) for r in val); cw = avail / cols
            t = Table(rows, colWidths=[cw] * cols, repeatRows=1)
            t.setStyle(TableStyle([
                ("GRID", (0,0), (-1,-1), 0.5, colors.HexColor("#BBBBBB")),
                ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#1F2A5E")),
                ("TEXTCOLOR", (0,0), (-1,0), colors.white),
                ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
                ("VALIGN", (0,0), (-1,-1), "TOP"),
                ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.white, colors.HexColor("#F2F4FA")]),
                ("LEFTPADDING",(0,0),(-1,-1),5), ("RIGHTPADDING",(0,0),(-1,-1),5),
                ("TOPPADDING",(0,0),(-1,-1),3), ("BOTTOMPADDING",(0,0),(-1,-1),3),
            ]))
            story += [t, Spacer(1, 8)]
        elif kind == "code":
            if meta in ("dot", "graphviz"):
                png = _render_dot(val, "pdg_%d" % dn); dn += 1
                if png:
                    iw, ih = ImageReader(png).getSize(); w = min(avail, iw); h = w * ih / iw
                    story += [Image(png, width=w, height=h), Spacer(1, 8)]
                else:
                    story.append(Paragraph("<font face='Courier' size=8>%s</font>" % _esc(val).replace("\n", "<br/>"), styles["BodyText"]))
            else:
                story.append(Paragraph("<font face='Courier' size=8>%s</font>" % _esc(val).replace("\n", "<br/>"), styles["BodyText"]))
    doc.build(story, onFirstPage=_footer, onLaterPages=_footer); return outfile

def _esc(t):
    return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def build_xlsx(title, blocks, outfile):
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
    wb = openpyxl.Workbook(); wb.remove(wb.active)
    hdr_fill = PatternFill("solid", fgColor="1F2A5E"); hdr_font = Font(bold=True, color="FFFFFF")
    thin = Side(style="thin", color="BBBBBB"); border = Border(left=thin, right=thin, top=thin, bottom=thin)
    tables = [b for b in blocks if b[0] == "table"]
    if not tables:
        ws = wb.create_sheet("Document"); ws["A1"] = title; ws["A1"].font = Font(bold=True, size=14); r = 3
        for kind, meta, val in blocks:
            if kind in ("bullets", "numbers"):
                for it in val: ws.cell(row=r, column=1, value=("- " if kind == "bullets" else "") + _inline(it)); r += 1
            elif kind in ("heading", "para"):
                c = ws.cell(row=r, column=1, value=_inline(val))
                if kind == "heading": c.font = Font(bold=True, size=12)
                r += 1
        ws.column_dimensions["A"].width = 100
    else:
        for ti, (_, _, rows) in enumerate(tables):
            ws = wb.create_sheet(("Data" if len(tables) == 1 else "Table %d" % (ti + 1)))
            for ri, row in enumerate(rows):
                for ci, c in enumerate(row):
                    cell = ws.cell(row=ri + 1, column=ci + 1, value=(_num(c) if ri > 0 else str(c))); cell.border = border
                    if ri == 0: cell.fill = hdr_fill; cell.font = hdr_font; cell.alignment = Alignment(horizontal="center")
            ncols = max(len(r) for r in rows)
            for ci in range(ncols):
                w = max((len(str(rows[ri][ci])) if ci < len(rows[ri]) else 0) for ri in range(len(rows)))
                ws.column_dimensions[get_column_letter(ci + 1)].width = min(max(w + 2, 10), 60)
            ws.freeze_panes = "A2"
    wb.save(outfile); return outfile

def build(fmt, title, md, outfile):
    blocks = _parse_blocks(md or "")
    if fmt == "docx": return build_docx(title, blocks, outfile)
    if fmt == "xlsx": return build_xlsx(title, blocks, outfile)
    return build_pdf(title, blocks, outfile)
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
 *  file as base64 for the chat artifact pipeline. */
export async function generateDocument(
  format: string,
  title: string,
  markdown: string,
  filename?: string,
): Promise<GeneratedDoc | { error: string }> {
  const fmt = EXT_FOR[format] ? format : "pdf";
  const name = `${safeStem(filename || title || "document")}.${EXT_FOR[fmt]}`;
  try {
    await writeFile("docgen.py", DOCGEN_PY);
    const code = [
      "import importlib, docgen",
      "importlib.reload(docgen)",
      `out = docgen.build(${JSON.stringify(fmt)}, ${JSON.stringify(title || "Document")}, ${JSON.stringify(markdown || "")}, ${JSON.stringify(name)})`,
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
