// Client-callable retrieval over a saved workspace, gated by requireAuth. The
// caller names the workspace by its DynamoDB item id; the KB workspace id and
// surface are resolved from the owner's own record, never taken from the body,
// and document ids are filtered to that workspace's manifest.
import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";
import type { SwUser } from "@/lib/auth/cognito.server";
import { isUuid } from "@/lib/kb/workspace-lifecycle";

function principalOf(context: unknown): string {
  return (context as { user: SwUser }).user.sub;
}

const MAX_DOCS_PER_CALL = 200;
const MAX_QUERY_CHARS = 2000;

/** Per-document page ranking for one question (Tabular Review retrieval). */
export const searchWorkspaceDocumentsFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(
    (d: { itemId: string; query: string; docIds: string[]; perDocPages?: number }) => {
      const itemId = String(d?.itemId ?? "").trim();
      if (!isUuid(itemId)) throw new Error("valid itemId required");
      const query = String(d?.query ?? "")
        .trim()
        .slice(0, MAX_QUERY_CHARS);
      if (!query) throw new Error("query required");
      const docIds = Array.isArray(d?.docIds)
        ? [...new Set(d.docIds.map((id) => String(id ?? "").trim()).filter(isUuid))]
        : [];
      if (!docIds.length) throw new Error("docIds required");
      if (docIds.length > MAX_DOCS_PER_CALL) throw new Error("too many documents in one call");
      const perDocPages = Number(d?.perDocPages);
      return {
        itemId,
        query,
        docIds,
        perDocPages: Number.isFinite(perDocPages)
          ? Math.max(1, Math.min(32, Math.floor(perDocPages)))
          : 12,
      };
    },
  )
  .handler(async ({ context, data }) => {
    const sub = principalOf(context);
    const [{ getWorkspace }, { kbConfigured }, { searchKbByDocuments }] = await Promise.all([
      import("@/lib/kb/workspace.server"),
      import("@/lib/kb/aurora.server"),
      import("@/lib/kb/search.server"),
    ]);
    if (!kbConfigured()) throw new Error("KB is not configured");
    const workspace = await getWorkspace(sub, data.itemId);
    if (!workspace) throw new Error("Saved documents were not found");
    if (workspace.status !== "ready") throw new Error("Saved documents are still indexing");
    const known = new Set(workspace.docs.map((doc) => doc.docId));
    const docIds = data.docIds.filter((id) => known.has(id));
    if (!docIds.length) return [];
    return searchKbByDocuments(sub, {
      workspaceId: workspace.kbWorkspaceId,
      surface: workspace.surface,
      query: data.query,
      docIds,
      perDocPages: data.perDocPages,
    });
  });
