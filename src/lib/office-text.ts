import JSZip from "jszip";

import { XLSX_ROWS_PER_PAGE } from "@/lib/pile/limits";

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function tagTexts(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => decodeXml(m[1] ?? "").trim()).filter(Boolean);
}

export type OfficePages = { pages: { page: number; text: string }[]; charCount: number };

/**
 * Sheets are chunked into row blocks with the header row repeated on every block,
 * so a large workbook stays citable and rankable instead of collapsing into one page.
 */
export async function extractXlsx(file: File, maxPages: number): Promise<OfficePages> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const ssXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  const shared: string[] = [];
  if (ssXml) {
    for (const si of ssXml.split(/<si[ >]/).slice(1)) {
      shared.push(tagTexts(si.split("</si>")[0] ?? "", "t").join(""));
    }
  }
  const sheetNames = await readSheetNames(zip);
  const sheets = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(n))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0));
  const pages: { page: number; text: string }[] = [];
  for (const path of sheets) {
    if (pages.length >= maxPages) break;
    const xml = (await zip.file(path)?.async("string")) ?? "";
    const rows = new Map<number, string[]>();
    for (const m of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = m[1] ?? "";
      const inner = m[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+)(\d+)"/);
      if (!ref) continue;
      const row = Number(ref[2]);
      const t = attrs.match(/\bt="([^"]+)"/)?.[1];
      let val = "";
      if (t === "s") {
        const v = inner.match(/<v>([^<]*)<\/v>/)?.[1];
        val = shared[Number(v)] ?? "";
      } else if (t === "inlineStr") {
        val = tagTexts(inner, "t").join(" ");
      } else {
        val = inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? "";
      }
      if (!val.trim()) continue;
      const list = rows.get(row) ?? [];
      list.push(val.trim());
      rows.set(row, list);
    }
    const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
    if (!ordered.length) continue;
    const sheetNo = Number(path.match(/sheet(\d+)/i)?.[1] ?? pages.length + 1);
    const name = sheetNames[sheetNo - 1] ?? path.split("/").pop() ?? path;
    const header = ordered[0]![1].join("\t");
    const body = ordered.slice(1);
    if (!body.length) {
      pages.push({ page: pages.length + 1, text: `[${name}]\n${header}` });
      continue;
    }
    for (let i = 0; i < body.length; i += XLSX_ROWS_PER_PAGE) {
      if (pages.length >= maxPages) break;
      const block = body.slice(i, i + XLSX_ROWS_PER_PAGE);
      const from = block[0]![0];
      const to = block[block.length - 1]![0];
      const text = [
        `[${name} · rows ${from}–${to}]`,
        header,
        ...block.map(([, cells]) => cells.join("\t")),
      ]
        .join("\n")
        .trim();
      pages.push({ page: pages.length + 1, text });
    }
  }
  return {
    pages: pages.length ? pages : [{ page: 1, text: "" }],
    charCount: pages.reduce((n, p) => n + p.text.length, 0),
  };
}

async function readSheetNames(zip: JSZip): Promise<string[]> {
  const xml = await zip.file("xl/workbook.xml")?.async("string");
  if (!xml) return [];
  return [...xml.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((m) => decodeXml(m[1] ?? ""));
}

/** One page per slide, with speaker notes appended so the deck's argument is searchable. */
export async function extractPptx(file: File, maxPages: number): Promise<OfficePages> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort(
      (a, b) => Number(a.match(/slide(\d+)/i)?.[1] ?? 0) - Number(b.match(/slide(\d+)/i)?.[1] ?? 0),
    )
    .slice(0, maxPages);
  const pages: { page: number; text: string }[] = [];
  for (const path of slides) {
    const xml = (await zip.file(path)?.async("string")) ?? "";
    const body = tagTexts(xml, "a:t").join(" ").replace(/\s+/g, " ").trim();
    const n = path.match(/slide(\d+)/i)?.[1] ?? "";
    const notesXml = await zip.file(`ppt/notesSlides/notesSlide${n}.xml`)?.async("string");
    const notes = notesXml
      ? tagTexts(notesXml, "a:t").join(" ").replace(/\s+/g, " ").trim()
      : "";
    const text = notes ? `${body}\n\n[Speaker notes] ${notes}` : body;
    pages.push({ page: pages.length + 1, text });
  }
  return {
    pages: pages.length ? pages : [{ page: 1, text: "" }],
    charCount: pages.reduce((n, p) => n + p.text.length, 0),
  };
}
