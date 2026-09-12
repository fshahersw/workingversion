export const EXTRACTION_PAGE_CHARS = 64_000;
export const MAX_EXTRACTION_CHARS = 50_000_000;
export function splitExtraction(text: string): string[] {
  if (text.length > MAX_EXTRACTION_CHARS)
    throw new Error(
      "Extracted text exceeds 50 million characters. Split the file; no partial result was accepted.",
    );
  const pages: string[] = [];
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(text.length, offset + EXTRACTION_PAGE_CHARS);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    pages.push(text.slice(offset, end));
    offset = end;
  }
  return pages;
}
/** Reject missing/reordered/truncated pages instead of returning a plausible prefix. */
export function joinExtraction(pages: string[], totalChars: number, totalPages: number): string {
  const text = pages.join("");
  if (
    pages.length !== totalPages ||
    text.length !== totalChars ||
    totalChars > MAX_EXTRACTION_CHARS
  )
    throw new Error(
      "Attachment text is incomplete. Retry extraction; no partial text was accepted.",
    );
  return text;
}
