import * as pdfjs from "pdfjs-dist";
import { SOURCE_LIMITS } from "./source-policy";

// Keep the PDF runtime and worker in a separate chunk for both website and library builds.
export async function readPdf(
  file: File,
): Promise<{ text: string; pages: number; warnings: string[] }> {
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const doc = await task.promise;
  try {
    if (doc.numPages > SOURCE_LIMITS.pdfPages)
      throw new Error(
        `This PDF has ${doc.numPages} pages; the local parser supports ${SOURCE_LIMITS.pdfPages}. Split it into identified volumes or use the host document service.`,
      );
    const pages = [];
    const unreadable: number[] = [];
    let characters = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
        .join("");
      if (pageText.trim().length < 10) unreadable.push(i);
      characters += pageText.length;
      if (characters > SOURCE_LIMITS.fileCharacters)
        throw new Error(
          `${file.name} exceeds ${SOURCE_LIMITS.fileCharacters.toLocaleString()} extracted characters. No partial document was accepted.`,
        );
      pages.push(`[Page ${i}]\n` + pageText);
      page.cleanup();
    }
    const text = pages.join("\n\n");
    if (text.replace(/\[Page \d+\]/g, "").trim().length < 10)
      throw new Error("This PDF has no readable text. OCR requires a connected document parser.");
    return {
      text,
      pages: doc.numPages,
      warnings: unreadable.length
        ? [
            `Little or no readable text on PDF page(s) ${unreadable.join(", ")}. Inspect the originals; scanned or image-only content needs OCR.`,
          ]
        : [],
    };
  } finally {
    await task.destroy();
  }
}
