import type { AnalysisReport, Artifact, SourceFile } from "./types";
import { SOURCE_LIMITS } from "./source-policy";
export async function readSourceFile(file: File): Promise<SourceFile> {
  if (file.size > SOURCE_LIMITS.fileBytes)
    throw new Error(`${file.name} exceeds the 20 MB file limit.`);
  let text: string;
  const metadata: NonNullable<SourceFile["metadata"]> = {
    format: file.name.split(".").at(-1)?.toLowerCase() || "text",
    warnings: [],
    extractedAt: new Date().toISOString(),
  };
  if (/\.pdf$/i.test(file.name)) {
    const { readPdf } = await import("./pdf-parser");
    const parsed = await readPdf(file);
    text = parsed.text;
    metadata.pages = parsed.pages;
    metadata.warnings = parsed.warnings;
  } else if (/\.docx$/i.test(file.name)) {
    const mammoth = await import("mammoth");
    const parsed = await mammoth.extractRawText({
      arrayBuffer: await file.arrayBuffer(),
    });
    text = parsed.value;
    metadata.warnings = parsed.messages.map((m) => m.message);
  } else if (/\.eml$/i.test(file.name)) {
    const { default: PostalMime } = await import("postal-mime");
    const email = await PostalMime.parse(await file.arrayBuffer());
    if (email.attachments?.length)
      metadata.warnings.push(
        `${email.attachments.length} email attachment(s) were not opened. Upload attachments separately for analysis.`,
      );
    const plain =
      email.text ||
      (email.html
        ? new DOMParser().parseFromString(email.html, "text/html").body.textContent || ""
        : "");
    text = [
      "From: " + (email.from?.name || "") + " <" + (email.from?.address || "") + ">",
      "Date: " + (email.date || "Unknown"),
      "Subject: " + (email.subject || "(no subject)"),
      "",
      plain,
    ].join("\n");
  } else if (/\.(txt|md|csv|tsv|json)$/i.test(file.name)) text = await file.text();
  else
    throw new Error(
      "Use PDF, DOCX, EML, TXT, Markdown, CSV, TSV, or JSON. Scans need an OCR service.",
    );
  if (!text.trim())
    throw new Error(`${file.name} has no readable text. No empty source was accepted.`);
  if (text.length > SOURCE_LIMITS.fileCharacters)
    throw new Error(
      `${file.name} contains more than 500,000 characters. Split the document into identified volumes; no partial source was accepted.`,
    );
  metadata.sha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return {
    id: crypto.randomUUID(),
    name: file.name,
    text,
    size: file.size,
    metadata,
  };
}
/** Bounded parsing avoids starting a PDF worker for every document at once. */
export async function readSourceBatch(files: File[]): Promise<SourceFile[]> {
  if (files.length > SOURCE_LIMITS.files)
    throw new Error(`Choose up to ${SOURCE_LIMITS.files} files at a time.`);
  const output: SourceFile[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, files.length) }, async () => {
      while (cursor < files.length) {
        const index = cursor++;
        output[index] = await readSourceFile(files[index]);
      }
    }),
  );
  return output;
}
export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function artifactBlob(artifact: Artifact): Promise<Blob> {
  if (artifact.format === "docx") {
    const { Document, Packer, Paragraph, TextRun } = await import("docx");
    const doc = new Document({
      sections: [
        {
          children: artifact.content.split("\n").map(
            (line, index) =>
              new Paragraph({
                spacing: { after: 120 },
                children: [
                  new TextRun({
                    text: line,
                    bold: index === 0,
                    size: index === 0 ? 30 : 22,
                    font: "Calibri",
                  }),
                ],
              }),
          ),
        },
      ],
    });
    return Packer.toBlob(doc);
  } else if (artifact.format === "pdf") {
    const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.Helvetica);
    let page = doc.addPage([612, 792]),
      y = 735;
    for (const line of artifact.content.split("\n")) {
      const safe = line.replace(/\t/g, "    ");
      try {
        font.encodeText(safe);
      } catch {
        throw new Error(
          "This PDF font cannot represent all source characters. Export Word to preserve the full text; no characters were silently removed.",
        );
      }
      let current = "";
      const lines: string[] = [];
      for (const word of safe.split(" ")) {
        if (font.widthOfTextAtSize(current + " " + word, 10) > 500 && current) {
          lines.push(current);
          current = word;
        } else current += (current ? " " : "") + word;
      }
      lines.push(current);
      for (const wrapped of lines) {
        if (y < 55) {
          page = doc.addPage([612, 792]);
          y = 735;
        }
        page.drawText(wrapped, {
          x: 55,
          y,
          size: 10,
          font,
          color: rgb(0.13, 0.16, 0.18),
        });
        y -= 15;
      }
    }
    return new Blob([(await doc.save()) as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
  } else
    return new Blob([artifact.content], {
      type: artifact.format === "csv" ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8",
    });
}
export async function reportDocumentBlob(report: AnalysisReport) {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    Table,
    TableRow,
    TableCell,
    WidthType,
    HeadingLevel,
    PageOrientation,
  } = await import("docx");
  const paragraph = (text: string, bold = false) =>
    new Paragraph({
      children: [new TextRun({ text, bold, size: 20, font: "Calibri" })],
      spacing: { after: 80 },
    });
  const columns = [...report.columns, "Source / evidence"];
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: columns.map((c) => new TableCell({ children: [paragraph(c, true)] })),
      }),
      ...report.rows.map(
        (r) =>
          new TableRow({
            children: [
              ...report.columns.map((c) => r.cells[c] || "Not found"),
              `${r.source}${r.page ? ` · page ${r.page}` : ""} · ${r.line > 0 ? `extracted line ${r.line}${r.endLine ? `–${r.endLine}` : ""}` : "document check"}\n${r.excerpt || "No matching excerpt"}${r.references?.map((ref) => `\n${ref.source}, line ${ref.line}: ${ref.excerpt}`).join("") || ""}`,
            ].map(
              (value) =>
                new TableCell({
                  children: value.split("\n").map((v) => paragraph(v)),
                }),
            ),
          }),
      ),
    ],
  });
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE },
            margin: { top: 720, bottom: 720, left: 720, right: 720 },
          },
        },
        children: [
          new Paragraph({
            text: report.title,
            heading: HeadingLevel.HEADING_1,
          }),
          paragraph("Working paper · verify against original sources"),
          paragraph(report.summary),
          ...(report.text.includes("EDITED DRAFT")
            ? report.text
                .split("EDITED DRAFT\n")[1]
                .split("\n\nCHANGE LOG")[0]
                .split("\n")
                .map((line) => paragraph(line))
            : []),
          table,
          new Paragraph({
            text: "Scope and review notes",
            heading: HeadingLevel.HEADING_2,
          }),
          ...report.notes.map((n) => paragraph(n)),
        ],
      },
    ],
  });
  return Packer.toBlob(doc);
}

export async function downloadArtifact(artifact: Artifact) {
  downloadBlob(artifact.name, await artifactBlob(artifact));
}
export async function downloadReportDocument(report: AnalysisReport) {
  downloadBlob(report.title + ".docx", await reportDocumentBlob(report));
}
export async function saveToOffice(name: string, body: Blob): Promise<string> {
  const response = await fetch("/api/office/docs", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "X-Office-Kind": "docx",
      "X-Office-Filename": encodeURIComponent(name.endsWith(".docx") ? name : name + ".docx"),
    },
    body,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Office could not save this document.");
  return "/office/drafts/" + encodeURIComponent(result.draftId);
}
