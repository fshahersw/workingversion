/** The text actually reviewed, including page boundaries and OCR repairs, defines cache identity. */
export async function evidenceDigest(pages: { page: number; text: string }[]): Promise<string> {
  const canonical = JSON.stringify(
    [...pages]
      .sort((a, b) => a.page - b.page)
      .map((p) => [p.page, p.text.replace(/\r\n/g, "\n").trim()]),
  );
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Legacy name/page-count identities do not prove that a new upload is the same document. */
export function sameReviewDocument(
  row: { fingerprint: string | null; docId: string | null },
  fingerprint: string,
  docId?: string | null,
): boolean {
  return row.fingerprint === fingerprint || Boolean(docId && row.docId === docId);
}
