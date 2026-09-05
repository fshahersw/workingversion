// ============================================================================
// Minimal, dependency-free PDF reader for the ETL self-test.
//
// Scope on purpose: page count + per-page text for the contract fixture and
// other simple, text-based filings. The production runner uses pypdf; this
// exists so the in-app self-test can verify the extract/chunk/embed stages
// inside the Worker runtime, which has no native PDF library.
// ============================================================================

const latin1 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  for (const fmt of ["deflate", "deflate-raw"] as const) {
    try {
      const ds = new DecompressionStream(fmt);
      const buf = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(ds)).arrayBuffer();
      return new Uint8Array(buf);
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Raw object bodies keyed by object number. */
function indexObjects(src: string): Map<number, { start: number; end: number }> {
  const out = new Map<number, { start: number; end: number }>();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = src.indexOf("endobj", start);
    if (end > 0) out.set(num, { start, end });
  }
  return out;
}

function decodeTextOps(content: string): string {
  const out: string[] = [];
  // (literal) Tj  |  [(a) -2 (b)] TJ  |  (literal) '
  const re = /\((?:\\.|[^\\)])*\)/g;
  const blocks = content.split(/\bBT\b/).slice(1);
  const scan = blocks.length ? blocks : [content];
  for (const block of scan) {
    const body = block.split(/\bET\b/)[0] ?? block;
    let m: RegExpExecArray | null;
    const parts: string[] = [];
    while ((m = re.exec(body))) {
      parts.push(
        m[0]
          .slice(1, -1)
          .replace(/\\([nrtbf()\\])/g, (_s, c: string) =>
            ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" })[c] ?? c,
          )
          .replace(/\\(\d{1,3})/g, (_s, o: string) => String.fromCharCode(parseInt(o, 8))),
      );
    }
    if (parts.length) out.push(parts.join(""));
  }
  return out.join("\n").replace(/[ \t]+\n/g, "\n").trim();
}

export type PdfText = { pageCount: number; pages: string[] };

/**
 * Extracts page text. Falls back to an empty string per page when a stream
 * uses a filter we cannot decode (image-only scans, exotic encodings).
 */
export async function extractPdf(bytes: Uint8Array): Promise<PdfText> {
  const src = latin1(bytes);
  const objects = indexObjects(src);

  const pageObjs: { contents: number[] }[] = [];
  for (const [, span] of objects) {
    const body = src.slice(span.start, span.end);
    if (!/\/Type\s*\/Page\b/.test(body) || /\/Type\s*\/Pages\b/.test(body)) continue;
    const refs: number[] = [];
    const single = body.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
    if (single) refs.push(Number(single[1]));
    const arr = body.match(/\/Contents\s*\[([^\]]*)\]/);
    if (arr) {
      for (const r of arr[1]!.matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(r[1]));
    }
    pageObjs.push({ contents: refs });
  }

  const streamBody = async (objNum: number): Promise<string> => {
    const span = objects.get(objNum);
    if (!span) return "";
    const body = src.slice(span.start, span.end);
    const sIdx = body.indexOf("stream");
    if (sIdx < 0) return "";
    let dataStart = sIdx + "stream".length;
    if (body[dataStart] === "\r") dataStart++;
    if (body[dataStart] === "\n") dataStart++;
    const eIdx = body.lastIndexOf("endstream");
    const raw = body.slice(dataStart, eIdx < 0 ? undefined : eIdx);
    if (/\/Filter\s*\/FlateDecode/.test(body)) {
      const abs = span.start + dataStart;
      const inflated = await inflate(bytes.slice(abs, span.start + (eIdx < 0 ? body.length : eIdx)));
      return inflated ? latin1(inflated) : "";
    }
    return raw;
  };

  const pages: string[] = [];
  for (const p of pageObjs) {
    const chunks: string[] = [];
    for (const ref of p.contents) chunks.push(await streamBody(ref));
    pages.push(decodeTextOps(chunks.join("\n")));
  }

  return { pageCount: pageObjs.length, pages };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const isPdf = (bytes: Uint8Array) =>
  bytes.length > 5 && latin1(bytes.slice(0, 5)) === "%PDF-";

/** Same page-aware chunking the production runner uses (~3600 chars). */
export function chunkPages(pages: string[], target = 3600): {
  chunk_index: number;
  page_start: number;
  page_end: number;
  content: string;
  token_count: number;
}[] {
  const out: { chunk_index: number; page_start: number; page_end: number; content: string; token_count: number }[] = [];
  let buf = "";
  let start = 1;
  const flush = (end: number) => {
    const content = buf.trim();
    if (content) {
      out.push({
        chunk_index: out.length,
        page_start: start,
        page_end: end,
        content,
        token_count: Math.ceil(content.length / 4),
      });
    }
    buf = "";
  };
  pages.forEach((text, i) => {
    const pageNo = i + 1;
    if (!buf) start = pageNo;
    buf += (buf ? "\n\n" : "") + text;
    if (buf.length >= target) flush(pageNo);
  });
  flush(pages.length);
  return out;
}
