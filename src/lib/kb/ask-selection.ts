import type {
  WorkspaceDetail,
  WorkspaceDoc,
} from "./workspace.server";

export class KbAskError extends Error {
  readonly status: number;
  readonly recoverable: boolean;

  constructor(message: string, status = 400, recoverable = false) {
    super(message);
    this.name = "KbAskError";
    this.status = status;
    this.recoverable = recoverable;
  }
}

export function selectWorkspaceDocuments(
  workspace: WorkspaceDetail,
  requested?: string[],
): WorkspaceDoc[] {
  if (!requested) return workspace.docs;
  const ids = [...new Set(requested.filter(Boolean))];
  if (!ids.length) throw new KbAskError("At least one document must be selected.");
  const byId = new Map(workspace.docs.map((doc) => [doc.docId, doc]));
  const selected = ids.map((id) => byId.get(id));
  if (selected.some((doc) => !doc)) {
    throw new KbAskError("A selected document is not part of this workspace.", 403);
  }
  return selected as WorkspaceDoc[];
}
