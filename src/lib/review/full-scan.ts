import {
  documentOrientation,
  normalizedSource,
  planScan,
  scanCacheKey,
} from "../pile/discovery-scan.ts";
import { HttpStatusError } from "../pile/async.ts";
import { displayValue, type CellAnswer, type CellRequest, type ColumnKind } from "./types.ts";

export type CellScanResult = { answer: CellAnswer; pagesSearched: number[] };
export function combineCellSections(
  kind: ColumnKind,
  sections: CellAnswer[],
  complete: boolean,
  coverage: string,
): CellAnswer {
  const positives = sections.filter(
    (a) => a.value !== null && a.display.trim() && a.status !== "not_found" && a.status !== "error",
  );
  const citations = sections
    .flatMap((a) => a.citations)
    .filter((c, i, list) => list.findIndex((x) => x.page === c.page && x.quote === c.quote) === i);
  const uncertain =
    !complete ||
    sections.some(
      (a) => a.status === "needs_review" || a.status === "error" || a.confidence === "low",
    );
  if (!positives.length)
    return {
      value: null,
      display: "",
      status: complete && !uncertain ? "not_found" : "needs_review",
      confidence: "low",
      citations,
      rationale: `${coverage} No supported answer returned. ${complete ? "Review the source before relying on absence." : "Coverage is incomplete; absence cannot be inferred."}`,
    };
  const unique = [...new Map(positives.map((a) => [JSON.stringify(a.value), a])).values()];
  const listKind = kind === "list" || kind === "multi_select";
  const value = listKind
    ? [
        ...new Map(
          unique
            .flatMap((a) => (Array.isArray(a.value) ? a.value : [a.value]))
            .map((v) => [JSON.stringify(v), v]),
        ).values(),
      ]
    : unique.length === 1
      ? unique[0]!.value
      : null;
  const conflict = !listKind && unique.length > 1;
  return {
    value,
    display: conflict ? unique.map((a) => a.display).join(" | ") : displayValue(value),
    status: uncertain || conflict ? "needs_review" : "answered",
    confidence:
      uncertain || conflict
        ? "low"
        : positives.every((a) => a.confidence === "high")
          ? "high"
          : "medium",
    citations,
    rationale: `${coverage} ${conflict ? "Different values occur across sections; resolve them against the cited context. No automatic scalar aggregation was applied. " : ""}${[...new Set(positives.map((a) => a.rationale))].join("\n")}`,
  };
}

/** No section is discarded; failed sections remain retryable in this tab. */
export async function scanReviewCell(opts: {
  input: CellRequest;
  totalPages: number;
  fileId: string;
  signal: AbortSignal;
  cache: Map<string, CellAnswer>;
  request: (input: CellRequest) => Promise<CellAnswer>;
  onProgress?: (done: number, total: number) => void;
}): Promise<CellScanResult> {
  const pages = opts.input.pages.map((p) => ({
    ...p,
    fileId: opts.fileId,
    fileName: opts.input.fileName,
    ocr: !!p.ocr,
  }));
  const windows = planScan(pages, [
    { id: opts.fileId, name: opts.input.fileName, pageCount: opts.totalPages },
  ]);
  const sections: CellAnswer[] = [];
  const orientation = documentOrientation(opts.input.pages);
  const completed = new Set<string>();
  let failures = 0;
  // Row concurrency is bounded by the caller. Within a cell, preserve source order.
  for (const window of windows) {
    opts.signal.throwIfAborted();
    const input = {
      ...opts.input,
      documentContext: orientation,
      pages: window.pages,
      images: undefined,
    };
    const key = await scanCacheKey(["review-full-v1", input]);
    let answer = opts.cache.get(key);
    try {
      if (!answer) {
        answer = await opts.request(input);
        opts.signal.throwIfAborted();
        const validCitations = answer.citations.filter(
          (c) =>
            !c.fromImage &&
            normalizedSource(c.quote).length >= 8 &&
            window.pages.some(
              (p) =>
                p.page === c.page && normalizedSource(p.text).includes(normalizedSource(c.quote)),
            ),
        );
        if (
          answer.status === "answered" &&
          (!validCitations.length || validCitations.length !== answer.citations.length)
        )
          answer = {
            ...answer,
            citations: validCitations,
            status: "needs_review",
            confidence: "low",
            rationale: `${answer.rationale} Some source quotes could not be matched exactly; verify the source.`,
          };
        if (answer.status !== "error") {
          if (opts.cache.size >= 2500) opts.cache.delete(opts.cache.keys().next().value!);
          opts.cache.set(key, answer);
        }
      }
      if (answer.status === "error") throw new Error(answer.rationale || "Section failed");
      sections.push(answer);
      completed.add(window.id);
    } catch (error) {
      opts.signal.throwIfAborted();
      if (error instanceof HttpStatusError && error.status < 500 && error.status !== 429)
        throw error;
      failures++;
      sections.push({
        value: null,
        display: "",
        status: "error",
        confidence: "low",
        citations: [],
        rationale: error instanceof Error ? error.message : "Section failed",
      });
    }
    opts.onProgress?.(completed.size, windows.length);
  }
  const readable = [...new Set(pages.filter((p) => p.text.trim()).map((p) => p.page))];
  const pagesSearched = readable.filter((page) =>
    windows.filter((w) => w.pages.some((p) => p.page === page)).every((w) => completed.has(w.id)),
  );
  const complete =
    opts.totalPages > 0 && pagesSearched.length === opts.totalPages && failures === 0;
  const coverage = `[Full text scan: ${pagesSearched.length}/${opts.totalPages} pages; ${completed.size}/${windows.length} sections. ${failures ? `${failures} sections failed; retry reuses completed sections. ` : ""}${Math.max(0, opts.totalPages - readable.length)} pages without available text.]`;
  const answer = combineCellSections(opts.input.kind, sections, complete, coverage);
  if (failures) {
    answer.status = "error";
    answer.rationale += " Partial findings retained. Retry failed cells to complete the scan.";
  }
  return { answer, pagesSearched };
}
