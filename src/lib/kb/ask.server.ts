import type { PileAskEmit, PileAskFile, PileAskPage } from "@/lib/pile/ask.server";

import { fetchChunks, kbConfigured, type KbChunk } from "./aurora.server";
import {
  KbAskError,
  selectWorkspaceDocuments,
} from "./ask-selection";
import { searchKb } from "./search.server";
import { getWorkspace, type WorkspaceDoc } from "./workspace.server";

const MAX_SOURCE_CHUNKS = 24;

export type KbAskRequest = {
  itemId: string;
  query: string;
  docIds?: string[];
  sourceChunkIds?: number[];
  instructions?: string | null;
  prior?: { query: string; answer: string };
};

export type KbAskSource = {
  ref: string;
  chunkId: number;
  docId: string;
  fileName: string;
  page: number;
  pageEnd: number | null;
  kind: string | null;
  text: string;
  conf: number | null;
  score: number;
};

function orderedChunks(
  documents: WorkspaceDoc[],
  chunks: KbChunk[],
): KbChunk[] {
  const order = new Map(documents.map((doc, index) => [doc.docId, index]));
  return chunks
    .map((chunk, index) => ({ chunk, index }))
    .sort(
      (a, b) =>
        (order.get(a.chunk.doc_id) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.chunk.doc_id) ?? Number.MAX_SAFE_INTEGER) ||
        a.index - b.index,
    )
    .map(({ chunk }) => chunk);
}

function priorInstructions(input: KbAskRequest): string | null {
  const blocks = [input.instructions?.trim()];
  if (input.prior?.query.trim() && input.prior.answer.trim()) {
    blocks.push(
      `Prior question: ${input.prior.query.slice(0, 1000)}\nPrior answer:\n${input.prior.answer.slice(0, 2500)}`,
    );
  }
  return blocks.filter(Boolean).join("\n\n") || null;
}

export async function askSavedWorkspace(
  principal: string,
  input: KbAskRequest,
  emit: PileAskEmit,
  signal?: AbortSignal,
): Promise<void> {
  const workspace = await getWorkspace(principal, input.itemId);
  if (!workspace) throw new KbAskError("Workspace not found.", 404, true);
  if (workspace.status !== "ready") {
    throw new KbAskError("Workspace is not ready to search.", 409, true);
  }
  if (workspace.surface !== "workingset" || !workspace.kbWorkspaceId) {
    throw new KbAskError("Workspace is not a searchable Working Set.", 400);
  }

  const documents = selectWorkspaceDocuments(workspace, input.docIds);
  if (!documents.length) throw new KbAskError("Workspace has no documents.", 404);
  if (!kbConfigured()) {
    throw new KbAskError("KB is not configured.", 503, true);
  }
  const allowedDocIds = new Set(documents.map((doc) => doc.docId));

  let chunkIds: number[];
  let scoreByChunk = new Map<number, number>();
  if (input.sourceChunkIds) {
    chunkIds = [
      ...new Set(
        input.sourceChunkIds.filter(
          (id) => Number.isSafeInteger(id) && id > 0,
        ),
      ),
    ].slice(0, MAX_SOURCE_CHUNKS);
    if (!chunkIds.length) throw new KbAskError("Follow-up sources are invalid.");
  } else {
    const hits = await searchKb(principal, {
      workspaceId: workspace.kbWorkspaceId,
      surface: workspace.surface,
      query: input.query,
      topK: MAX_SOURCE_CHUNKS,
      docIds: documents.map((doc) => doc.docId),
      ...(signal ? { signal } : {}),
    });
    chunkIds = hits.map((hit) => hit.chunk_id);
    scoreByChunk = new Map(hits.map((hit) => [hit.chunk_id, hit.score]));
  }
  if (!chunkIds.length) {
    throw new KbAskError(
      "No relevant passages were found in this workspace.",
      404,
      true,
    );
  }

  const fetched = await fetchChunks(
    principal,
    workspace.kbWorkspaceId,
    workspace.surface,
    chunkIds,
  );
  if (fetched.length !== chunkIds.length) {
    throw new KbAskError(
      "The saved source set is no longer available.",
      409,
      true,
    );
  }
  if (fetched.some((chunk) => !allowedDocIds.has(chunk.doc_id))) {
    throw new KbAskError("A source is outside the selected documents.", 403);
  }

  const chunks = orderedChunks(documents, fetched);
  const docById = new Map(documents.map((doc) => [doc.docId, doc]));
  const sources: KbAskSource[] = chunks.map((chunk, index) => {
    const doc = docById.get(chunk.doc_id)!;
    return {
      ref: `S${index + 1}`,
      chunkId: chunk.chunk_id,
      docId: chunk.doc_id,
      fileName: doc.fileName,
      page: chunk.page_start ?? 1,
      pageEnd: chunk.page_end,
      kind: chunk.kind,
      text: chunk.content,
      conf: chunk.conf,
      score: scoreByChunk.get(chunk.chunk_id) ?? 0,
    };
  });

  emit("retrieve", {
    status: "done",
    backend: "kb",
    sources,
    documents: documents.map((doc) => {
      const matched = sources.filter((source) => source.docId === doc.docId);
      return {
        docId: doc.docId,
        fileName: doc.fileName,
        pageCount: doc.pageCount,
        matched: matched.length > 0,
        topScore: matched.reduce(
          (best, source) => Math.max(best, source.score),
          0,
        ),
      };
    }),
  });

  const pagesByDoc = new Map<string, PileAskPage[]>();
  for (const source of sources) {
    const pages = pagesByDoc.get(source.docId) ?? [];
    pages.push({
      fileName: source.fileName,
      page: source.page,
      text: source.text,
    });
    pagesByDoc.set(source.docId, pages);
  }
  const instructions = priorInstructions(input);
  const writers = await import("@/lib/pile/ask.server");
  if (documents.length === 1) {
    const doc = documents[0]!;
    await writers.writePileAnswer(
      {
        query: input.query,
        pages: pagesByDoc.get(doc.docId) ?? [],
        files: [{ name: doc.fileName, pageCount: doc.pageCount }],
        instructions,
      },
      emit,
      signal,
    );
    return;
  }

  const fileGroups: PileAskFile[] = documents.map((doc) => {
    const pages = pagesByDoc.get(doc.docId) ?? [];
    const matchedSources = sources.filter((source) => source.docId === doc.docId);
    return {
      fileId: doc.docId,
      fileName: doc.fileName,
      pageCount: doc.pageCount,
      matched: pages.length > 0,
      topScore: matchedSources.reduce(
        (best, source) => Math.max(best, source.score),
        0,
      ),
      pages,
    };
  });
  await writers.writeMultiFileAnswer(
    {
      query: input.query,
      files: fileGroups,
      instructions,
    },
    emit,
    signal,
  );
}
