import { mapPool } from "@/lib/pile/async";
import { OCR_PAGE_CAP, RENDER_CONCURRENCY } from "@/lib/pile/limits";
import { ensurePromiseWithResolvers } from "@/lib/pdf-compat";

async function openPdf(file: File) {
  ensurePromiseWithResolvers();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { configurePdfjsWorker } = await import("./pdf-worker");
  await configurePdfjsWorker(pdfjs);
  const data = new Uint8Array(await file.arrayBuffer());
  return pdfjs.getDocument({ data, verbosity: 0 }).promise;
}

async function renderPage(doc: Awaited<ReturnType<typeof openPdf>>, num: number): Promise<string | null> {
  const page = await doc.getPage(num);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(1536 / base.width, 2048 / base.height, 2.4);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    page.cleanup();
    return null;
  }
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  page.cleanup();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  return dataUrl.replace(/^data:image\/jpeg;base64,/, "");
}

/** Open once, render a page, immediately hand it off — VL can start before the rest of the file is rasterized. */
export async function forEachRenderedPdfPage(
  file: File,
  pageNums: number[],
  onPage: (page: number, imageBase64: string) => Promise<void>,
  signal?: AbortSignal,
  concurrency = RENDER_CONCURRENCY,
): Promise<void> {
  const nums = [...new Set(pageNums)].filter((n) => n > 0);
  if (!nums.length) return;
  const doc = await openPdf(file);
  try {
    await mapPool(
      nums.slice(0, OCR_PAGE_CAP),
      concurrency,
      async (num) => {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const imageBase64 = await renderPage(doc, num);
        if (imageBase64) await onPage(num, imageBase64);
      },
      signal,
    );
  } finally {
    await doc.destroy();
  }
}

/** Browser-only: rasterize empty / noisy PDF pages for Nano VL OCR. */
export async function renderPdfEmptyPages(
  file: File,
  emptyPages: number[],
  signal?: AbortSignal,
): Promise<{ page: number; imageBase64: string }[]> {
  const out: { page: number; imageBase64: string }[] = [];
  await forEachRenderedPdfPage(
    file,
    emptyPages,
    async (page, imageBase64) => {
      out.push({ page, imageBase64 });
    },
    signal,
  );
  return out;
}
