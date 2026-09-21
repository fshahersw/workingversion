// Browser-session store for files the Python sandbox writes (CSV, TSV, JSON,
// XLSX …), keyed by an opaque handle the model passes back to an editor tool
// (Sheets `import_file`). Same lifecycle as image-store.ts: bounded, in
// memory, gone on reload. Bytes never round-trip through the model.

export const PLATFORM_FILE_PREFIX = "platform-file:";

export type StoredFile = {
  id: string;
  name: string;
  /** bytes, decoded from the sandbox's base64 */
  size: number;
  base64: string;
  createdAt: number;
};

const MAX_FILES = 24;
/** total retained bytes; oldest handles are dropped first when exceeded */
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const store = new Map<string, StoredFile>();

export function isPlatformFile(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PLATFORM_FILE_PREFIX);
}

export function getPlatformFile(handle: string): StoredFile | null {
  return store.get(handle.replace(PLATFORM_FILE_PREFIX, "")) ?? null;
}

export function putPlatformFile(input: { name: string; base64: string; size?: number }): StoredFile {
  const id = crypto.randomUUID().slice(0, 8);
  const size = input.size ?? Math.floor((input.base64.length * 3) / 4);
  const file: StoredFile = {
    id,
    name: input.name.slice(0, 160),
    size,
    base64: input.base64,
    createdAt: Date.now(),
  };
  store.set(id, file);
  const total = () => [...store.values()].reduce((n, f) => n + f.size, 0);
  while (store.size > MAX_FILES || (store.size > 1 && total() > MAX_TOTAL_BYTES)) {
    const oldest = [...store.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    store.delete(oldest.id);
  }
  return file;
}

export function handleOf(file: StoredFile): string {
  return PLATFORM_FILE_PREFIX + file.id;
}

/** UTF-8 text of a stored file (BOM kept for the parser to strip). */
export function textOf(file: StoredFile): string {
  const bin = atob(file.base64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

export function describeFile(file: StoredFile): string {
  return `${file.name} (${file.size.toLocaleString("en-US")} bytes) → ${handleOf(file)}`;
}

/** True for the text formats import_file can read into cells. */
export function isImportableText(name: string): boolean {
  return /\.(csv|tsv|txt|tab|psv)$/i.test(name);
}
