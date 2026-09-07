// Library -> Discovery handoff for reopening a saved workspace. The Library
// stashes the workspace id under a surface-specific key and navigates to the
// Discovery tab for that surface; the tab's hook takes the id on mount. Keys
// are per surface so a deposition id can never be hydrated by the Working Set
// reader (or vice versa) if both tabs happen to mount.
// Relative .ts imports: this module runs under `node --test` without a bundler.
import type { WorkspaceSurface } from "./workspace.server.ts";

const KEYS: Record<WorkspaceSurface, string> = {
  workingset: "kb:reloadWorkspace",
  deposition: "kb:reloadDeposition",
  review: "kb:reloadReview",
};

export type DiscoveryTab = "search" | "deposition" | "review";

/** Discovery tab that owns a surface. */
export function discoveryTabFor(surface: WorkspaceSurface): DiscoveryTab {
  return surface === "workingset" ? "search" : surface;
}

export function workspaceHandoffKey(surface: WorkspaceSurface): string {
  return KEYS[surface];
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): StorageLike | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Stash a workspace id for the surface's tab. Silently no-ops without storage. */
export function stashWorkspaceHandoff(
  surface: WorkspaceSurface,
  itemId: string,
  store: StorageLike | null = storage(),
): void {
  if (!store) return;
  try {
    store.setItem(KEYS[surface], itemId);
  } catch {
    /* storage unavailable or full */
  }
}

/** Take (read and clear) the stashed id for a surface, if any. */
export function takeWorkspaceHandoff(
  surface: WorkspaceSurface,
  store: StorageLike | null = storage(),
): string | null {
  if (!store) return null;
  try {
    const id = store.getItem(KEYS[surface]);
    if (id) store.removeItem(KEYS[surface]);
    return id && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}
