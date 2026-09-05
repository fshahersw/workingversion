// ============================================================================
// Exports carry their citations. A review table that leaves the app as bare
// answers is unusable in a brief, so every export ships a companion citation
// column (CSV) or a Citations sheet (XLSX) with document, page and quote.
// ============================================================================
import type { ReviewCell, ReviewColumn, ReviewRow, ReviewTable } from "./types";
import { statusLabel } from "./types";

type CellLookup = (rowId: string, columnId: string) => ReviewCell | null;

function citeText(cell: ReviewCell | null): string {
  if (!cell?.citations?.length) return "";
  return cell.citations.map((c) => `p.${c.page}: “${c.quote}”`).join(" | ");
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(
  rows: ReviewRow[],
  columns: ReviewColumn[],
  cellAt: CellLookup,
): string {
  const header = ["Document", "Pages"];
  for (const c of columns) header.push(c.name, `${c.name} — citations`, `${c.name} — status`);

  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) {
    const line = [row.label, String(row.pageCount)];
    for (const col of columns) {
      const cell = cellAt(row.id, col.id);
      line.push(cell?.display ?? "", citeText(cell), cell ? statusLabel(cell.status) : "");
    }
    lines.push(line.map(csvEscape).join(","));
  }
  return lines.join("\n");
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFileName(name: string): string {
  return (name.trim() || "review-table").replace(/[^\w.-]+/g, "-").slice(0, 80);
}

export function exportCsv(
  table: ReviewTable,
  rows: ReviewRow[],
  columns: ReviewColumn[],
  cellAt: CellLookup,
): void {
  const csv = toCsv(rows, columns, cellAt);
  downloadBlob(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), `${safeFileName(table.name)}.csv`);
}

export async function exportXlsx(
  table: ReviewTable,
  rows: ReviewRow[],
  columns: ReviewColumn[],
  cellAt: CellLookup,
): Promise<void> {
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  const sheet = wb.addWorksheet("Review");
  sheet.columns = [
    { header: "Document", key: "doc", width: 44 },
    { header: "Pages", key: "pages", width: 8 },
    ...columns.map((c) => ({ header: c.name, key: c.id, width: 34 })),
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];

  for (const row of rows) {
    const record: Record<string, string | number> = { doc: row.label, pages: row.pageCount };
    for (const col of columns) record[col.id] = cellAt(row.id, col.id)?.display ?? "";
    const added = sheet.addRow(record);
    added.alignment = { vertical: "top", wrapText: true };
  }

  const cites = wb.addWorksheet("Citations");
  cites.columns = [
    { header: "Document", key: "doc", width: 40 },
    { header: "Column", key: "col", width: 26 },
    { header: "Answer", key: "answer", width: 34 },
    { header: "Status", key: "status", width: 14 },
    { header: "Confidence", key: "conf", width: 12 },
    { header: "Page", key: "page", width: 8 },
    { header: "Quote", key: "quote", width: 80 },
  ];
  cites.getRow(1).font = { bold: true };
  for (const row of rows) {
    for (const col of columns) {
      const cell = cellAt(row.id, col.id);
      if (!cell) continue;
      const base = {
        doc: row.label,
        col: col.name,
        answer: cell.display,
        status: statusLabel(cell.status),
        conf: cell.confidence ?? "",
      };
      if (!cell.citations.length) {
        cites.addRow({ ...base, page: "", quote: "" }).alignment = { vertical: "top", wrapText: true };
        continue;
      }
      for (const c of cell.citations) {
        cites.addRow({ ...base, page: c.page, quote: c.quote }).alignment = {
          vertical: "top",
          wrapText: true,
        };
      }
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    `${safeFileName(table.name)}.xlsx`,
  );
}
