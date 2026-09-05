/** pdf.js 5 throws "Invalid workerSrc type" unless this is a primitive string. */
export function pdfWorkerSrc(): string {
  if (typeof window === "undefined") return "/pdf.worker.min.mjs";
  return `${window.location.origin}/pdf.worker.min.mjs`;
}

export async function configurePdfjsWorker(pdfjs: {
  GlobalWorkerOptions: { workerSrc: string };
}): Promise<void> {
  const src = pdfWorkerSrc();
  if (pdfjs.GlobalWorkerOptions.workerSrc === src) return;
  pdfjs.GlobalWorkerOptions.workerSrc = src;
}
