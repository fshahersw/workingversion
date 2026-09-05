// Recover text from scanned / garbage PDF pages via Nemotron VL.
// Same path the Summarize pile uses — review tables were skipping it.
import { withRetry } from "@/lib/pile/async";
import { OCR_CONCURRENCY, OCR_PAGE_CAP } from "@/lib/pile/limits";
import { ocrPageImage } from "@/lib/pile/ocr-client";
import { pageNeedsOcr } from "@/lib/pile/text-quality";
import type { PilePage } from "@/lib/pile/types";
import { forEachRenderedPdfPage } from "@/lib/pile-render";

export async function recoverScannedPages(
  file: File,
  pages: PilePage[],
  signal?: AbortSignal,
): Promise<{ pages: PilePage[]; recovered: number; failed: number; needed: number }> {
  const need = pages.filter((p) => pageNeedsOcr(p.text)).map((p) => p.page);
  if (!need.length) return { pages, recovered: 0, failed: 0, needed: 0 };

  const byPage = new Map(pages.map((p) => [p.page, { ...p }]));
  let recovered = 0;
  let failed = 0;

  await forEachRenderedPdfPage(
    file,
    need.slice(0, OCR_PAGE_CAP),
    async (pageNum, imageBase64) => {
      try {
        const text = (
          await withRetry(() => ocrPageImage(imageBase64, signal), {
            tries: 3,
            baseMs: 600,
            signal,
          })
        ).trim();
        const prev = byPage.get(pageNum);
        if (prev && text && text.length > prev.text.length) {
          byPage.set(pageNum, { ...prev, text, ocr: true });
          recovered += 1;
        }
      } catch {
        failed += 1;
      }
    },
    signal,
    OCR_CONCURRENCY,
  );

  return {
    pages: pages.map((p) => byPage.get(p.page) ?? p),
    recovered,
    failed,
    needed: need.length,
  };
}
