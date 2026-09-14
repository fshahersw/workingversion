import type { PileAskEmit, PileAskFile, PileAskPage } from "@/lib/pile/ask.server";

import { fetchChunks, kbConfigured, type KbChunk } from "./aurora.server";
import {
  KbAskError,
  selectWorkspaceDocuments,
} from "./ask-selection";
import { searchKb, searchKbChunksByDocuments, type KbDocChunks } from "./search.server";
import { getWorkspace, type WorkspaceDoc } from "./workspace.server";
import {
  planRetrieval,
  RAG_GLOBAL_CHUNK_CAP,
  RAG_MAX_CHUNKS_PER_DOC,
  RAG_PACK_CHARS,
} from "./ask-budget";

/** Flat-retrieval cap when adaptive RAG is disabled (DISCOVERY_ADAPTIVE_RAG=0). */
const MAX_SOURCE_CHUNKS = 24;
/** Total retrieved chunks below this triggers one bounded widen of the retrieval. */
const RETRIEVAL_THIN_TOTAL = 8;

/** Union two per-document chunk sets, keeping the best score per chunk. */
function mergeDocChunks(a: KbDocChunks[], b: KbDocChunks[]): KbDocChunks[] {
  const byDoc = new Map<string, Map<number, number>>();
  for (const set of [a, b]) {
    for (const d of set) {
      const m = byDoc.get(d.docId) ?? new Map<number, number>();
      for (const h of d.hits) m.set(h.chunkId, Math.max(m.get(h.chunkId) ?? 0, h.score));
      byDoc.set(d.docId, m);
    }
  }
  return [...byDoc.entries()].map(([docId, m]) => ({
    docId,
    hits: [...m.entries()].map(([chunkId, score]) => ({ chunkId, score })),
  }));
}

/** Flatten per-document hits and keep the globally-highest-scoring `cap`. */
function topChunks(perDoc: KbDocChunks[], cap: number): { chunkId: number; score: number }[] {
  return perDoc
    .flatMap((d) => d.hits)
    .sort((x, y) => y.score - x.score)
    .slice(0, cap);
}

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
  // Working Set and Deposition workspaces share the same chunk index and the
  // same answer writer; review tables are queried through their own pipeline.
  if (
    (workspace.surface !== "workingset" && workspace.surface !== "deposition") ||
    !workspace.kbWorkspaceId
  ) {
    throw new KbAskError("Workspace is not searchable from Ask.", 400);
  }

  const documents = selectWorkspaceDocuments(workspace, input.docIds);
  if (!documents.length) throw new KbAskError("Workspace has no documents.", 404);
  if (!kbConfigured()) {
    throw new KbAskError("KB is not configured.", 503, true);
  }
  const allowedDocIds = new Set(documents.map((doc) => doc.docId));

  const adaptiveRag = process.env["DISCOVERY_ADAPTIVE_RAG"] !== "0";
  let chunkIds: number[];
  let scoreByChunk = new Map<number, number>();
  if (input.sourceChunkIds) {
    // Follow-up: reuse the passages the prior turn already retrieved.
    chunkIds = [
      ...new Set(input.sourceChunkIds.filter((id) => Number.isSafeInteger(id) && id > 0)),
    ].slice(0, RAG_GLOBAL_CHUNK_CAP);
    if (!chunkIds.length) throw new KbAskError("Follow-up sources are invalid.");
  } else if (adaptiveRag) {
    // Adaptive per-document retrieval: a floor of chunks per document, scaled by
    // document size/type, capped globally. One bounded widen if coverage is thin.
    const plan = planRetrieval(
      documents.map((doc) => ({
        docId: doc.docId,
        fileName: doc.fileName,
        pageCount: doc.pageCount,
        chunkCount: doc.chunkCount,
      })),
    );
    const retrieve = (docPlan: { docId: string; k: number }[]) =>
      searchKbChunksByDocuments(principal, {
        workspaceId: workspace.kbWorkspaceId!,
        surface: workspace.surface,
        query: input.query,
        docPlan,
        ...(signal ? { signal } : {}),
      });
    let perDoc = await retrieve(plan);
    const total = perDoc.reduce((sum, d) => sum + d.hits.length, 0);
    if (total < RETRIEVAL_THIN_TOTAL) {
      const widened = plan.map((p) => ({
        docId: p.docId,
        k: Math.min(p.k * 2, RAG_MAX_CHUNKS_PER_DOC),
      }));
      perDoc = mergeDocChunks(perDoc, await retrieve(widened));
    }
    const top = topChunks(perDoc, RAG_GLOBAL_CHUNK_CAP);
    chunkIds = top.map((h) => h.chunkId);
    scoreByChunk = new Map(top.map((h) => [h.chunkId, h.score]));
  } else {
    // Fallback (DISCOVERY_ADAPTIVE_RAG=0): the proven flat top-K retrieval.
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
        pack: { pages: RAG_GLOBAL_CHUNK_CAP },
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
      pack: { chars: RAG_PACK_CHARS, writerPack: sources.length },
    },
    emit,
    signal,
  );
}
