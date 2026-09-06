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
  const mapped = session.files.map((file) => binding.docIdByFileId[file.id]);
  if (mapped.some((docId) => !docId)) return null;
  if (new Set(mapped).size !== mapped.length) return null;
  return binding;
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
  const docIds = selected.map((fileId) => binding.docIdByFileId[fileId]);
  return docIds.every(Boolean) ? docIds : null;
}

export function withoutSavedWorkspace(session: PileSession): PileSession {
  const { savedWorkspace: _savedWorkspace, ...local } = session;
  return local;
}
