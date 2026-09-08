// ============================================================================
// Library folders — pure tree helpers shared by the server (validation) and
// the page (breadcrumbs, pickers). A folder belongs to one category (the
// Library tab it appears under) and has at most one parent in that category.
// No `@/` imports: runs under the Node test runner.
// ============================================================================

export const ROOT_FOLDER = "ROOT";
export const MAX_FOLDER_DEPTH = 4;
export const MAX_FOLDER_NAME = 60;

export type FolderCategory =
  | "workingset"
  | "deposition"
  | "review"
  | "chats"
  | "draft"
  | "output"
  | "prompt"
  | "file";

export const FOLDER_CATEGORIES: readonly FolderCategory[] = [
  "workingset",
  "deposition",
  "review",
  "chats",
  "draft",
  "output",
  "prompt",
  "file",
];

export function isFolderCategory(value: unknown): value is FolderCategory {
  return typeof value === "string" && (FOLDER_CATEGORIES as readonly string[]).includes(value);
}

export type LibraryFolder = {
  folderId: string;
  category: FolderCategory;
  name: string;
  /** ROOT_FOLDER for top-level folders. */
  parentId: string;
  createdAt: string;
  updatedAt: string;
};

export type FolderNode = LibraryFolder & { children: FolderNode[]; depth: number };

/** Trim, collapse whitespace, strip control characters, cap length. */
export function cleanFolderName(raw: unknown): string {
  return (
    String(raw ?? "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_FOLDER_NAME)
  );
}

/** Children of `parentId`, sorted by name. Orphans (missing parent) attach to ROOT. */
export function buildFolderTree(folders: readonly LibraryFolder[]): FolderNode[] {
  const ids = new Set(folders.map((f) => f.folderId));
  const byParent = new Map<string, LibraryFolder[]>();
  for (const folder of folders) {
    const parent = ids.has(folder.parentId) ? folder.parentId : ROOT_FOLDER;
    const list = byParent.get(parent) ?? [];
    list.push(folder);
    byParent.set(parent, list);
  }
  const seen = new Set<string>();
  const build = (parentId: string, depth: number): FolderNode[] =>
    (byParent.get(parentId) ?? [])
      .filter((folder) => !seen.has(folder.folderId) && seen.add(folder.folderId))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((folder) => ({
        ...folder,
        depth,
        children: depth + 1 >= MAX_FOLDER_DEPTH ? [] : build(folder.folderId, depth + 1),
      }));
  return build(ROOT_FOLDER, 0);
}

/** Root-to-folder chain for a breadcrumb; empty for ROOT or unknown ids. */
export function folderPath(folders: readonly LibraryFolder[], folderId: string): LibraryFolder[] {
  const byId = new Map(folders.map((f) => [f.folderId, f]));
  const out: LibraryFolder[] = [];
  let current = byId.get(folderId);
  const guard = new Set<string>();
  while (current && !guard.has(current.folderId)) {
    guard.add(current.folderId);
    out.unshift(current);
    current = current.parentId === ROOT_FOLDER ? undefined : byId.get(current.parentId);
  }
  return out;
}

/** Depth of a folder (ROOT = 0, a top-level folder = 1). */
export function folderDepth(folders: readonly LibraryFolder[], folderId: string): number {
  return folderId === ROOT_FOLDER ? 0 : folderPath(folders, folderId).length;
}

/**
 * Whether `candidateParent` is a valid parent for `folderId`: exists in the
 * same category (or is ROOT), is not the folder itself or one of its
 * descendants, and keeps the subtree inside MAX_FOLDER_DEPTH.
 */
export function canReparent(
  folders: readonly LibraryFolder[],
  folderId: string,
  candidateParent: string,
): boolean {
  if (candidateParent === folderId) return false;
  if (candidateParent !== ROOT_FOLDER && !folders.some((f) => f.folderId === candidateParent)) {
    return false;
  }
  const ancestors = folderPath(folders, candidateParent).map((f) => f.folderId);
  if (ancestors.includes(folderId)) return false;
  const subtreeDepth = deepestBelow(folders, folderId);
  return folderDepth(folders, candidateParent) + 1 + subtreeDepth <= MAX_FOLDER_DEPTH;
}

/** How many levels of folders hang under `folderId` (0 when it has none). */
export function deepestBelow(folders: readonly LibraryFolder[], folderId: string): number {
  const children = folders.filter((f) => f.parentId === folderId);
  if (!children.length) return 0;
  return 1 + Math.max(...children.map((child) => deepestBelow(folders, child.folderId)));
}

/** Flattened tree for a picker: every folder with its depth, in tree order. */
export function flattenFolders(
  folders: readonly LibraryFolder[],
): { folder: LibraryFolder; depth: number }[] {
  const out: { folder: LibraryFolder; depth: number }[] = [];
  const walk = (nodes: FolderNode[]) => {
    for (const node of nodes) {
      out.push({ folder: node, depth: node.depth });
      walk(node.children);
    }
  };
  walk(buildFolderTree(folders));
  return out;
}
