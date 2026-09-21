export type PdfImagePixels = { width: number; height: number; rgba: Uint8Array };
export function pdfImageMime(bytes: Uint8Array): "image/png" | "image/jpeg" {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  throw new Error("Use an actual PNG or JPEG image. Other formats are not accepted.");
}
export async function decodePdfImage(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfImagePixels> {
  signal?.throwIfAborted();
  if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) throw new Error("An attached image must be at most 10 MB.");
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: pdfImageMime(bytes) }));
  try {
    signal?.throwIfAborted();
    if (bitmap.width * bitmap.height > 16_000_000 || bitmap.width > 8192 || bitmap.height > 8192) throw new Error("An image must fit within 8192 pixels per side and 16 megapixels.");
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d");
    if (!context) throw new Error("Browser image decoding is unavailable.");
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, rgba: new Uint8Array(context.getImageData(0, 0, bitmap.width, bitmap.height).data) };
  } finally { bitmap.close(); }
}
