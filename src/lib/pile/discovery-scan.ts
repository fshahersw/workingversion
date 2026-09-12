import { HttpStatusError, isRetryableHttp, mapPool, parseRetryAfterMs, sleep } from "./async.ts";
import type { PilePage } from "./types.ts";

export type DiscoveryScope = "relevant" | "full";
export type ScanFile = { id: string; name: string; pageCount: number };
export type ScanWindow = { id: string; fileId: string; fileName: string; pages: PilePage[] };
export type ScanFinding = { finding: string; quote: string; page: number };
export type ScanWindowResult = { findings: ScanFinding[]; complete: boolean; note: string };
export type ScanCoverage = {
  mode: DiscoveryScope;
  totalWindows: number;
  completedWindows: number;
  failedWindows: number;
  reusedWindows: number;
  retrying: number;
  running: boolean;
  files: {
    id: string;
    name: string;
    totalPages: number;
    readPages: number;
    missingPages: number;
    failedWindows: number;
  }[];
};
export type ScanEvidence = ScanFinding & { fileId: string; fileName: string; ref: string };
export type ScanResult = { coverage: ScanCoverage; evidence: ScanEvidence[]; answer: string };
export const SCAN_WINDOW_CHARS = 32_000;
export const SCAN_WINDOW_PAGES = 16;

/** Orientation only; citations must still match a page in the actual scan window. */
export function documentOrientation(pages: { page: number; text: string }[]): string {
  return [...pages]
    .filter((p) => p.text.trim())
    .sort((a, b) => a.page - b.page)
    .slice(0, 2)
    .map((p) => `Page ${p.page} header excerpt:\n${p.text.slice(0, 2800)}`)
    .join("\n\n");
}

/** Every character is assigned to a window. Long pages overlap at the boundary. */
export function planScan(
  pages: PilePage[],
  files: ScanFile[],
  maxChars = SCAN_WINDOW_CHARS,
): ScanWindow[] {
  if (maxChars < 1000) throw new Error("Scan window is too small");
  const windows: ScanWindow[] = [];
  for (const file of files) {
    let batch: PilePage[] = [];
    let chars = 0;
    const flush = () => {
      if (!batch.length) return;
      windows.push({
        id: `${file.id}:${windows.length}`,
        fileId: file.id,
        fileName: file.name,
        pages: batch,
      });
      batch = [];
      chars = 0;
    };
    for (const page of pages.filter((p) => p.fileId === file.id).sort((a, b) => a.page - b.page)) {
      if (!page.text.trim()) continue;
      for (let start = 0; start < page.text.length; ) {
        const text = page.text.slice(start, start + maxChars);
        if (chars + text.length > maxChars || batch.length >= SCAN_WINDOW_PAGES) flush();
        batch.push({ ...page, text });
        chars += text.length;
        if (start + maxChars >= page.text.length) break;
        flush();
        start += maxChars - 300;
      }
    }
    flush();
  }
  return windows;
}

export function normalizedSource(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Quote presence is provenance, not proof of the model's interpretation. Fail closed. */
export function validateScanResult(
  raw: unknown,
  pages: { page: number; text: string }[],
): ScanWindowResult {
  if (!raw || typeof raw !== "object") throw new Error("Invalid scan response");
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.findings) || typeof obj.complete !== "boolean" || obj.findings.length > 80)
    throw new Error("Incomplete or invalid scan response; retry this section");
  const findings: ScanFinding[] = [];
  let rejected = 0;
  for (const value of obj.findings) {
    const item = value as Partial<ScanFinding> | null;
    const quote = typeof item?.quote === "string" ? item.quote.trim() : "";
    const finding = typeof item?.finding === "string" ? item.finding.trim() : "";
    if (
      !finding ||
      finding.length > 2000 ||
      quote.length < 8 ||
      quote.length > 4000 ||
      !pages.some(
        (p) => p.page === item?.page && normalizedSource(p.text).includes(normalizedSource(quote)),
      )
    ) {
      rejected++;
      continue;
    }
    findings.push({ finding, quote, page: item!.page! });
  }
  return {
    findings,
    complete: obj.complete && rejected === 0,
    note: [
      typeof obj.note === "string" ? obj.note.slice(0, 600) : "",
      rejected ? `${rejected} unsupported source reference(s) omitted; section needs review.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

export async function discoveryRequest<T>(body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/discovery/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await response
    .json()
    .catch(() => ({ error: "The server returned an unreadable response" }));
  if (!response.ok)
    throw new HttpStatusError(
      response.status,
      data.error || `HTTP ${response.status}`,
      parseRetryAfterMs(response.headers.get("Retry-After")),
    );
  return data as T;
}

export async function scanCacheKey(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function retryScan<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  onRetry?: () => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (error) {
      if (
        signal?.aborted ||
        attempt >= 2 ||
        !(isRetryableHttp(error) || error instanceof TypeError)
      )
        throw error;
      onRetry?.();
      await sleep(
        error instanceof HttpStatusError && error.retryAfterMs
          ? error.retryAfterMs
          : 600 * 2 ** attempt,
        signal,
      );
    }
  }
}

export async function runDocumentScan(opts: {
  query: string;
  instructions?: string;
  pages: PilePage[];
  files: ScanFile[];
  signal?: AbortSignal;
  cache: Map<string, ScanWindowResult>;
  onProgress?: (coverage: ScanCoverage) => void;
  request?: (window: ScanWindow) => Promise<unknown>;
  synthesize?: boolean;
}): Promise<ScanResult> {
  if (!opts.query.trim()) throw new Error("Enter a question to scan");
  const windows = planScan(opts.pages, opts.files);
  const orientation = new Map(
    opts.files.map((file) => [
      file.id,
      documentOrientation(opts.pages.filter((p) => p.fileId === file.id)),
    ]),
  );
  const results = new Map<string, ScanWindowResult>();
  // Build the page-to-window index once. Progress updates must stay responsive
  // on thousands of pages rather than repeatedly scanning every window per page.
  const byFile = new Map<string, ScanWindow[]>();
  const pageWindows = new Map<string, Map<number, Set<string>>>();
  for (const window of windows) {
    const own = byFile.get(window.fileId) ?? [];
    own.push(window);
    byFile.set(window.fileId, own);
    const pages = pageWindows.get(window.fileId) ?? new Map<number, Set<string>>();
    for (const page of window.pages) {
      const ids = pages.get(page.page) ?? new Set<string>();
      ids.add(window.id);
      pages.set(page.page, ids);
    }
    pageWindows.set(window.fileId, pages);
  }
  let reusedWindows = 0;
  let retrying = 0;
  let finished = false;
  const coverage = (): ScanCoverage => ({
    mode: "full",
    totalWindows: windows.length,
    completedWindows: [...results.values()].filter((r) => r.complete).length,
    failedWindows: [...results.values()].filter((r) => !r.complete).length,
    reusedWindows,
    retrying,
    running: !finished,
    files: opts.files.map((file) => {
      const own = byFile.get(file.id) ?? [];
      const readable = pageWindows.get(file.id) ?? new Map<number, Set<string>>();
      const read = [...readable.values()].filter((ids) =>
        [...ids].every((id) => results.get(id)?.complete),
      );
      return {
        id: file.id,
        name: file.name,
        totalPages: file.pageCount,
        readPages: read.length,
        missingPages: Math.max(0, file.pageCount - readable.size),
        failedWindows: own.filter((w) => results.has(w.id) && !results.get(w.id)!.complete).length,
      };
    }),
  });
  const emit = () => opts.onProgress?.(coverage());
  emit();
  await mapPool(
    windows,
    3,
    async (window) => {
      const key = await scanCacheKey([
        "scan-v2",
        opts.query,
        opts.instructions,
        window.fileId,
        orientation.get(window.fileId),
        window.pages,
      ]);
      const cached = opts.cache.get(key);
      opts.signal?.throwIfAborted();
      if (cached?.complete) {
        reusedWindows++;
        results.set(window.id, cached);
        emit();
        return;
      }
      try {
        const raw = await retryScan(
          () =>
            opts.request
              ? opts.request(window)
              : discoveryRequest(
                  {
                    action: "scan",
                    query: opts.query,
                    instructions: opts.instructions,
                    fileName: window.fileName,
                    documentContext: orientation.get(window.fileId),
                    pages: window.pages.map(({ page, text }) => ({ page, text })),
                  },
                  opts.signal,
                ),
          opts.signal,
          () => {
            retrying++;
            emit();
          },
        );
        opts.signal?.throwIfAborted();
        const result = validateScanResult(raw, window.pages);
        results.set(window.id, result);
        if (result.complete) {
          if (opts.cache.size >= 2500) opts.cache.delete(opts.cache.keys().next().value!);
          opts.cache.set(key, result);
        }
      } catch (error) {
        opts.signal?.throwIfAborted();
        // Authentication and invalid requests need action, not a request storm across the corpus.
        if (error instanceof HttpStatusError && error.status < 500 && error.status !== 429)
          throw error;
        results.set(window.id, {
          findings: [],
          complete: false,
          note: error instanceof Error ? error.message : "Scan failed",
        });
      }
      emit();
    },
    opts.signal,
  );
  const evidence: ScanEvidence[] = [];
  const seen = new Set<string>();
  for (const window of windows)
    for (const finding of results.get(window.id)?.findings ?? []) {
      const key = `${window.fileId}:${finding.page}:${normalizedSource(finding.quote)}:${normalizedSource(finding.finding)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push({
        ...finding,
        fileId: window.fileId,
        fileName: window.fileName,
        ref: `S${evidence.length + 1}`,
      });
    }
  const report = coverage();
  const allCovered =
    report.files.every((f) => f.totalPages > 0 && f.readPages === f.totalPages) &&
    report.failedWindows === 0;
  const preface = allCovered
    ? "All available text pages were scanned. Findings are source-linked leads for review, not a guarantee that every relevant fact was identified."
    : "Partial coverage: unreadable, missing, or unsuccessful sections remain. Do not infer absence from these results. Retry the same question to reuse completed sections.";
  let synthesis = "";
  if (opts.synthesize !== false && evidence.length) {
    try {
      // Multi-stage reduction preserves all evidence in the report below even when the synthesis must be batched.
      let chunks: string[] = [];
      let current = "";
      for (const finding of evidence) {
        const line = JSON.stringify(finding) + "\n";
        if (current.length + line.length > 32_000) {
          chunks.push(current);
          current = "";
        }
        current += line;
      }
      if (current) chunks.push(current);
      while (chunks.length > 1) {
        const summaries = await mapPool(
          chunks,
          2,
          async (context) => {
            const value = await retryScan(
              () =>
                discoveryRequest<{ answer: string }>(
                  {
                    action: "synthesize",
                    query: opts.query,
                    instructions: opts.instructions,
                    context,
                    partial: true,
                  },
                  opts.signal,
                ),
              opts.signal,
            );
            return value.answer;
          },
          opts.signal,
        );
        chunks = [];
        current = "";
        for (const summary of summaries) {
          if (current.length + summary.length > 64_000) {
            chunks.push(current);
            current = "";
          }
          current += summary + "\n\n";
        }
        if (current) chunks.push(current);
        if (chunks.length >= summaries.length)
          throw new Error("Use the complete evidence list to review this large result");
      }
      const value = await retryScan(
        () =>
          discoveryRequest<{ answer: string }>(
            {
              action: "synthesize",
              query: opts.query,
              instructions: opts.instructions,
              context: chunks[0],
              partial: !allCovered,
            },
            opts.signal,
          ),
        opts.signal,
      );
      const validRefs = new Set(evidence.map((e) => e.ref));
      if ([...value.answer.matchAll(/\[(S\d+)\]/g)].some((m) => !validRefs.has(m[1]!)))
        throw new Error("Synthesis contained an unknown source reference");
      synthesis = `### Draft synthesis\n\n${value.answer}\n\n`;
    } catch (error) {
      opts.signal?.throwIfAborted();
      synthesis =
        "Synthesis unavailable. The source-linked findings below are retained; retry to rebuild the synthesis.\n\n";
    }
  }
  const blocks = report.files.map((file) => {
    const findings = evidence.filter((e) => e.fileId === file.id);
    const notes = windows
      .filter((w) => w.fileId === file.id && !results.get(w.id)?.complete)
      .map((w) => results.get(w.id)?.note)
      .filter(Boolean);
    return (
      `### ${file.name.replace(/[\r\n#]/g, " ")}\n\n${file.readPages}/${file.totalPages} pages scanned${file.missingPages ? ` · ${file.missingPages} pages without available text` : ""}.\n\n` +
      (findings.length
        ? findings
            .map(
              (f) =>
                `- ${f.finding.replace(/\[S\d+\]/g, "")} [${f.ref}]\n  > ${f.quote.replace(/\n/g, " ")}`,
            )
            .join("\n\n")
        : "No source-linked findings returned in the successfully scanned text.") +
      (notes.length ? `\n\nReview needed: ${[...new Set(notes)].join("; ")}` : "")
    );
  });
  finished = true;
  emit();
  return {
    coverage: coverage(),
    evidence,
    answer: `${preface}\n\n${synthesis}${blocks.join("\n\n")}`,
  };
}
