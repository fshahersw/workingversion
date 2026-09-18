// Browser-only helpers for file drag-and-drop (Discovery intake).
//
// `hasFileDrag` tells a drop zone whether a drag carries files at all (text or
// link drags from inside the app must not light the zone up). `collectDroppedFiles`
// turns a drop's DataTransfer into a flat File[] — including the contents of
// dropped folders, walked breadth-first through the File System Access entry
// API where the browser supports it, with plain `files` as the fallback.

const MAX_DIRECTORY_FILES = 500;
const MAX_DIRECTORY_DEPTH = 6;

/** True when the drag payload includes at least one file. */
export function hasFileDrag(dt: Pick<DataTransfer, "types"> | null | undefined): boolean {
  if (!dt) return false;
  const types = dt.types;
  if (!types) return false;
  // `types` is a DOMStringList in some engines and an array in others.
  const list = Array.from(types as ArrayLike<string>);
  return list.includes("Files");
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  // readEntries returns at most ~100 entries per call; loop until empty.
  return new Promise((resolve) => {
    const out: FileSystemEntry[] = [];
    const step = () => {
      reader.readEntries(
        (batch) => {
          if (!batch.length) {
            resolve(out);
            return;
          }
          out.push(...batch);
          step();
        },
        () => resolve(out),
      );
    };
    step();
  });
}

function entryFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)));
}

async function walkEntry(entry: FileSystemEntry, depth: number, out: File[]): Promise<void> {
  if (out.length >= MAX_DIRECTORY_FILES) return;
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry);
    // Finder/Explorer metadata files are never documents.
    if (file && !/^(\.|~\$|thumbs\.db$)/i.test(file.name)) out.push(file);
    return;
  }
  if (entry.isDirectory && depth < MAX_DIRECTORY_DEPTH) {
    const entries = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const child of entries) {
      if (out.length >= MAX_DIRECTORY_FILES) break;
      await walkEntry(child, depth + 1, out);
    }
  }
}

/**
 * Every file in a drop, folders expanded. Order follows the drop order; the
 * caller applies type/size/count limits (the intake panels already do).
 */
export async function collectDroppedFiles(dt: DataTransfer): Promise<File[]> {
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items
    .filter((item) => item.kind === "file")
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null));
  const supportsEntries = entries.length > 0 && entries.every((e) => e !== null);
  if (!supportsEntries) return Array.from(dt.files ?? []);
  const out: File[] = [];
  for (const entry of entries as FileSystemEntry[]) {
    await walkEntry(entry, 0, out);
  }
  return out;
}
