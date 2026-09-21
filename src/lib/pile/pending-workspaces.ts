// Cross-navigation tracking for workspaces that are still saving/indexing in the
// background. When a large save is handed to the ingest worker, the Discovery
// view records it here; if the user stays, the view's own poll clears it, but if
// they navigate away the entry survives so an app-level watcher can notify them
// when it becomes ready. localStorage (not session) so it also survives a reload.
// Relative-safe: pure module, guarded for SSR / storage-disabled.
import type { WorkspaceSurface } from "@/lib/kb/workspace.server";

export type PendingWorkspace = {
  itemId: string;
  name: string;
  surface: WorkspaceSurface;
  startedAt: number;
};

const KEY = "kb:pendingWorkspaces";
// Stop watching after this long: the worker + SQS redrive are bounded well under
// it, so a still-pending entry past this is a dead end, not worth polling forever.
const MAX_AGE_MS = 30 * 60_000;

function read(): PendingWorkspace[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    const now = Date.now();
    return list.filter(
      (p): p is PendingWorkspace =>
        !!p &&
        typeof p.itemId === "string" &&
        typeof p.name === "string" &&
        typeof p.surface === "string" &&
        typeof p.startedAt === "number" &&
        now - p.startedAt < MAX_AGE_MS,
    );
  } catch {
    return [];
  }
}

function write(list: PendingWorkspace[]): void {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage full or unavailable */
  }
}

export function listPendingWorkspaces(): PendingWorkspace[] {
  return read();
}

/** Record (or refresh) a workspace as pending. Deduped by itemId. */
export function addPendingWorkspace(entry: Omit<PendingWorkspace, "startedAt">): void {
  if (!entry.itemId) return;
  const list = read().filter((p) => p.itemId !== entry.itemId);
  list.push({ ...entry, startedAt: Date.now() });
  write(list);
}

export function removePendingWorkspace(itemId: string): void {
  const list = read();
  const next = list.filter((p) => p.itemId !== itemId);
  if (next.length !== list.length) write(next);
}
