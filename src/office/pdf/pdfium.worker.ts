import wasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import { executePdfiumTransaction, initializePdfium, type PdfiumRequest } from "./pdfium-core";
self.onmessage = async (event: MessageEvent<PdfiumRequest>) => {
  try {
    const response = await fetch(wasmUrl); if (!response.ok) throw new Error("The locally hosted PDF engine asset is unavailable.");
    const module = await initializePdfium(await response.arrayBuffer());
    const result = await executePdfiumTransaction(module, event.data);
    self.postMessage({ ok: true, result }, result.bytes ? [result.bytes.buffer] : []);
  } catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : "The native PDF operation failed." }); }
};
