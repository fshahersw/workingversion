import { createHash } from "node:crypto";

export type WorkspaceFingerprintPage = {
  page: number;
  text: string;
};

export type WorkspaceFingerprintFile = {
  clientFileId?: string;
  fileName: string;
  mime?: string;
  byteSize?: number;
  sha256?: string;
  pages: WorkspaceFingerprintPage[];
};

function field(hash: ReturnType<typeof createHash>, value: string | number | undefined): void {
  const text = value === undefined ? "" : String(value);
  hash.update(String(Buffer.byteLength(text, "utf8")));
  hash.update(":");
  hash.update(text);
  hash.update("|");
}

export function workspaceFileFingerprint(
  file: WorkspaceFingerprintFile,
  index: number,
): string {
  const hash = createHash("sha256");
  field(hash, index);
  field(hash, file.clientFileId);
  field(hash, file.fileName);
  field(hash, file.mime);
  field(hash, file.byteSize);
  field(hash, file.sha256?.toLowerCase());
  const pages = file.pages
    .filter((page) => Number.isFinite(page.page) && page.page > 0 && page.text.trim())
    .slice()
    .sort((a, b) => a.page - b.page);
  field(hash, pages.length);
  for (const page of pages) {
    field(hash, page.page);
    field(hash, page.text);
  }
  return hash.digest("hex");
}

export function workspaceSaveFingerprint(args: {
  name: string;
  surface: string;
  folderId: string;
  files: WorkspaceFingerprintFile[];
}): { requestFingerprint: string; fileFingerprints: string[] } {
  const fileFingerprints = args.files.map(workspaceFileFingerprint);
  const hash = createHash("sha256");
  field(hash, args.name);
  field(hash, args.surface);
  field(hash, args.folderId);
  field(hash, fileFingerprints.length);
  for (const fingerprint of fileFingerprints) field(hash, fingerprint);
  return { requestFingerprint: hash.digest("hex"), fileFingerprints };
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
