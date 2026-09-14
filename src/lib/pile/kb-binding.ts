import type {
  PileSession,
  SavedWorkspaceBinding,
} from "./types";

export function completeSavedWorkspace(
  session: PileSession | null,
): SavedWorkspaceBinding | null {
  const binding = session?.savedWorkspace;
  if (
    !session ||
    !binding?.itemId ||
    !binding.kbWorkspaceId ||
    binding.surface !== "workingset" ||
    !session.files.length
  ) {
    return null;
  }
  // Partial binding: at least ONE session file must map to a ready Aurora doc.
  // `docIdByFileId` only ever contains READY docs, so a set with some documents
  // still indexing (or failed) still answers from the ready subset via RAG
  // instead of the whole set silently dropping to a full-text scan. The Ask
  // sends only the mapped doc ids; unmapped files are excluded from retrieval
  // (surfaced to the user via `savedCoverage`).
  const mapped = session.files.map((file) => binding.docIdByFileId[file.id]).filter(Boolean);
  if (!mapped.length) return null;
  if (new Set(mapped).size !== mapped.length) return null;
  return binding;
}

/** Ready (indexed) vs total documents for a saved set — drives the coverage note. */
export function savedCoverage(session: PileSession | null): { ready: number; total: number } {
  const total = session?.files.length ?? 0;
  const binding = session?.savedWorkspace;
  if (!session || !binding) return { ready: 0, total };
  const ready = session.files.filter((file) => Boolean(binding.docIdByFileId[file.id])).length;
  return { ready, total };
}

export function selectedWorkspaceDocIds(
  session: PileSession,
  fileIds?: string[],
): string[] | null {
  const binding = completeSavedWorkspace(session);
  if (!binding) return null;
  const selected = fileIds?.length ? fileIds : session.files.map((file) => file.id);
  const allowed = new Set(session.files.map((file) => file.id));
  if (!selected.length || selected.some((fileId) => !allowed.has(fileId))) return null;
  // Only the READY (mapped) docs among the selection; unmapped files are still
  // indexing or failed and are excluded from RAG (never fabricated).
  const docIds = selected.map((fileId) => binding.docIdByFileId[fileId]).filter(Boolean);
  return docIds.length ? docIds : null;
}

export function withoutSavedWorkspace(session: PileSession): PileSession {
  const { savedWorkspace: _savedWorkspace, ...local } = session;
  return local;
}
