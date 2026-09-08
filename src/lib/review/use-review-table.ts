// ============================================================================
// Tabular Review orchestration.
//
// Documents are read in the browser into the shared PileIndex for retrieval,
// and saved to the owner's KB (S3 bytes + pages, Aurora chunks + embeddings)
// as `review` workspaces the table references. Rows bind to their KB document
// once ingest lands, so reopening a table rehydrates its pages from storage
// instead of asking for the files again. The table — columns, rows, cells,
// citations, overrides — lives in DynamoDB. One index call per column fans the
// question out to every document, then each document's own pages are sent for
// its own cell answer. No cross-document lumping.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { extractFile, fileKind } from "@/lib/extract-text";
import { abortableDelay, rawFileSha256, uploadOriginalBytes } from "@/lib/kb/client-upload";
import { SYNC_INGEST_MAX_CHARS, SYNC_INGEST_MAX_PAGES } from "@/lib/kb/ingest-state";
import {
  deleteWorkspaceFn,
  getWorkspaceFn,
  getWorkspacePagesFn,
  getWorkspaceStatusFn,
  saveWorkspaceFn,
} from "@/lib/kb/workspace.functions";
import { mapPool, sleep, withRetry } from "@/lib/pile/async";
import { MAX_FILES, MAX_PAGES } from "@/lib/pile/limits";
import { PileClient } from "@/lib/pile/pile-client";
import type { PileFile, PilePage, SavedWorkspaceBinding } from "@/lib/pile/types";

import { recoverScannedPages } from "./ocr-pages";
import * as db from "./review-db";
import {
  bindingsFromSave,
  hydrationPlan,
  reviewBatchName,
  upsertSource,
  type RowBinding,
} from "./review-sources";
import {
  REVIEW_CELL_CONCURRENCY,
  REVIEW_CELL_PAGES,
  REVIEW_MAX_COLUMNS,
  REVIEW_PIPELINE_ENABLED,
  REVIEW_PIPELINE_VERSION,
  REVIEW_SAMPLE_ROWS,
  cellCacheKey,
  displayValue,
  documentRowFingerprint,
  type CellAnswer,
  type ColumnKind,
  type ReviewCell,
  type ReviewColumn,
  type ReviewRow,
  type ReviewTable,
} from "./types";

/** How the table's documents stand in the owner's account. */
export type DocSaveState = {
  status: "idle" | "saving" | "indexing" | "saved" | "error";
  message: string | null;
};

const SAVE_POLL_MS = 2_000;
/** ~3 minutes of polling before the tab stops waiting on a slow async ingest. */
const SAVE_POLL_MAX = 90;

export type ReviewFileState = {
  /** Matches ReviewRow.fileIds[0] once the row is persisted. */
  fileId: string;
  name: string;
  pages: number;
  status: "reading" | "ocr" | "ready" | "error";
  ocrPages?: number;
  error?: string;
};

export type RunProgress = {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  label: string;
};

const IDLE_RUN: RunProgress = {
  running: false,
  total: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  label: "",
};

export type SampleResult = {
  rowId: string;
  label: string;
  answer: CellAnswer | null;
  error: string | null;
};

type CellKey = string;
const key = (rowId: string, columnId: string): CellKey => `${rowId}:${columnId}`;

function findDocumentRow(
  rows: readonly ReviewRow[],
  name: string,
  pageCount: number,
): ReviewRow | undefined {
  const fingerprint = documentRowFingerprint(name, pageCount);
  const legacyUploadPrefix = `${fingerprint}|`;
  return (
    rows.find((row) => row.fingerprint === fingerprint) ??
    rows.find((row) => row.fingerprint?.startsWith(legacyUploadPrefix)) ??
    rows.find(
      (row) => documentRowFingerprint(row.label, row.pageCount) === fingerprint,
    )
  );
}

async function requestCell(input: {
  column: { name: string; question: string; kind: ColumnKind; options: string[] };
  instructions: string | null;
  fileName: string;
  pages: { page: number; text: string; ocr?: boolean }[];
  signal?: AbortSignal;
}): Promise<CellAnswer> {
  const payload = {
    columnName: input.column.name,
    question: input.column.question,
    kind: input.column.kind,
    options: input.column.options,
    instructions: input.instructions,
    fileName: input.fileName,
    pages: input.pages,
  };

  let last: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const res = await fetch("/api/review/cell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as CellAnswer & { error?: string };
      if (res.ok) return body;
      const retryable = res.status === 429 || res.status >= 500;
      last = new Error(body.error || `Cell failed (HTTP ${res.status})`);
      if (!retryable || attempt === 2) throw last;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      last = err instanceof Error ? err : new Error(String(err));
      const msg = last.message;
      const retryable = /HTTP 429|HTTP 5\d\d|Failed to fetch|network|fetch/i.test(msg);
      if (!retryable || attempt === 2) throw last;
    }
    await sleep(400 * 2 ** attempt, input.signal);
  }
  throw last ?? new Error("Cell failed");
}

export type SharedPileBridge = {
  getClient: () => PileClient;
  ingestPages: (files: PileFile[], pages: PilePage[]) => Promise<void>;
  /** File ids currently indexed in the shared pile. */
  liveFileIds: () => Set<string>;
};

export function useReviewTable(
  owner: string | null,
  actorEmail: string | null,
  shared?: SharedPileBridge | null,
) {
  const pileRef = useRef<PileClient | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sharedRef = useRef(shared);
  sharedRef.current = shared;

  const [tables, setTables] = useState<ReviewTable[]>([]);
  const [table, setTable] = useState<ReviewTable | null>(null);
  const [columns, setColumns] = useState<ReviewColumn[]>([]);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [cells, setCells] = useState<Record<CellKey, ReviewCell>>({});
  const [files, setFiles] = useState<ReviewFileState[]>([]);
  const [pageTexts, setPageTexts] = useState<Record<string, string>>({});
  const [run, setRun] = useState<RunProgress>(IDLE_RUN);
  /** Cells queued or in flight for the current run — drives the grid skeletons. */
  const [pending, setPending] = useState<Set<CellKey>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docSave, setDocSave] = useState<DocSaveState>({ status: "idle", message: null });
  const [hydrating, setHydrating] = useState(false);

  // Background save/bind tasks read the latest table and rows, not a snapshot.
  const tableRef = useRef<ReviewTable | null>(null);
  tableRef.current = table;
  const rowsRef = useRef<ReviewRow[]>([]);
  rowsRef.current = rows;
  /** In-flight document saves, keyed by table id; aborted when the table closes. */
  const saveTasks = useRef(new Map<string, AbortController>());

  const pile = useCallback((): PileClient => {
    if (sharedRef.current) return sharedRef.current.getClient();
    if (!pileRef.current) pileRef.current = new PileClient();
    return pileRef.current;
  }, []);

  const liveFileIds = useCallback((): Set<string> => {
    if (sharedRef.current) return sharedRef.current.liveFileIds();
    return new Set(files.filter((f) => f.status === "ready").map((f) => f.fileId));
  }, [files]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      for (const controller of saveTasks.current.values()) controller.abort();
      saveTasks.current.clear();
      if (sharedRef.current) return;
      pileRef.current?.dispose();
      pileRef.current = null;
    },
    [],
  );

  const refreshTables = useCallback(async () => {
    if (!owner) return;
    try {
      setTables(await db.listReviewTables());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your tables");
    }
  }, [owner]);

  useEffect(() => {
    void refreshTables();
  }, [refreshTables]);

  /**
   * Pull pages for rows bound to saved documents that are not in the pile yet,
   * index them under the KB doc id, and point the rows at that id. Rows whose
   * save landed after the tab closed are bound first through the workspace's
   * own `sourceFileId` manifest, so nothing depends on the browser having
   * stayed open.
   */
  const hydrateRows = useCallback(
    async (tableId: string, current: ReviewRow[], sources: ReviewTable["sources"]) => {
      let working = current;
      const live = liveFileIds();

      // Late binding: rows still carrying only a browser file id whose batch
      // finished indexing after the session ended.
      const unbound = working.filter((row) => !row.docId);
      if (unbound.length && sources.length) {
        for (const source of sources) {
          if (!source.owned) continue;
          const ws = await getWorkspaceFn({ data: { itemId: source.workspaceItemId } }).catch(
            () => null,
          );
          if (!ws || ws.status !== "ready") continue;
          const docIdByFileId: Record<string, string> = {};
          for (const doc of ws.docs) if (doc.sourceFileId) docIdByFileId[doc.sourceFileId] = doc.docId;
          const bindings = bindingsFromSave(working, source.workspaceItemId, docIdByFileId);
          if (!bindings.length) continue;
          const bound = await db.bindRowDocuments(tableId, source.workspaceItemId, bindings);
          const byId = new Map(bound.map((row) => [row.id, row]));
          working = working.map((row) => byId.get(row.id) ?? row);
        }
      }

      const plan = hydrationPlan(working, live);
      if (!plan.size) {
        return working;
      }
      setHydrating(true);
      const hydratedFiles: ReviewFileState[] = [];
      const missing: string[] = [];
      try {
        for (const [workspaceItemId, bindings] of plan) {
          const ws = await getWorkspaceFn({ data: { itemId: workspaceItemId } }).catch(() => null);
          if (!ws || ws.status !== "ready") {
            missing.push(...bindings.map((b) => b.rowId));
            continue;
          }
          const docsById = new Map(ws.docs.map((doc) => [doc.docId, doc]));
          const loaded = await mapPool(bindings, 4, async (binding: RowBinding) => {
            const doc = docsById.get(binding.docId);
            if (!doc) return null;
            const pg = await getWorkspacePagesFn({
              data: { itemId: workspaceItemId, docId: binding.docId },
            }).catch(() => null);
            if (!pg?.length) return null;
            const pages: PilePage[] = pg.map((page) => ({
              fileId: binding.docId,
              fileName: doc.fileName,
              page: page.page,
              text: page.text,
              ocr: false,
            }));
            return { binding, doc, pages };
          });
          const ok = loaded.filter((entry): entry is NonNullable<typeof entry> => !!entry);
          missing.push(
            ...bindings
              .filter((b) => !ok.some((entry) => entry.binding.rowId === b.rowId))
              .map((b) => b.rowId),
          );
          if (!ok.length) continue;
          const allPages = ok.flatMap((entry) => entry.pages);
          const pileFiles: PileFile[] = ok.map((entry) => ({
            id: entry.binding.docId,
            name: entry.doc.fileName,
            pageCount: entry.pages.length,
            emptyPages: entry.pages.filter((p) => !p.text.trim()).length,
            ocrPages: 0,
          }));
          if (sharedRef.current) await sharedRef.current.ingestPages(pileFiles, allPages);
          else await pile().addPages(allPages);
          setPageTexts((prev) => {
            const next = { ...prev };
            for (const p of allPages) next[`${p.fileId}:${p.page}`] = p.text;
            return next;
          });
          const byRow = new Map(ok.map((entry) => [entry.binding.rowId, entry]));
          working = working.map((row) => {
            const entry = byRow.get(row.id);
            return entry ? { ...row, fileIds: [entry.binding.docId] } : row;
          });
          hydratedFiles.push(
            ...ok.map((entry) => ({
              fileId: entry.binding.docId,
              name: entry.doc.fileName,
              pages: entry.pages.length,
              status: "ready" as const,
            })),
          );
          if (tableRef.current?.id === tableId) setRows(working);
        }
        if (hydratedFiles.length && tableRef.current?.id === tableId) {
          setFiles((prev) => {
            const seen = new Set(prev.map((f) => f.fileId));
            return [...prev, ...hydratedFiles.filter((f) => !seen.has(f.fileId))];
          });
        }
        if (missing.length && tableRef.current?.id === tableId) {
          setDocSave({
            status: "error",
            message: `${missing.length} saved document${missing.length === 1 ? "" : "s"} could not be loaded. Re-add ${missing.length === 1 ? "it" : "them"} to run those rows.`,
          });
        }
      } finally {
        setHydrating(false);
      }
      return working;
    },
    [liveFileIds, pile],
  );

  const loadTable = useCallback(
    async (next: ReviewTable) => {
      setBusy(true);
      setError(null);
      setDocSave({ status: "idle", message: null });
      try {
        const [cols, rws, cls] = await Promise.all([
          db.listColumns(next.id),
          db.listRows(next.id),
          db.listCells(next.id),
        ]);
        setTable(next);
        tableRef.current = next;
        setColumns(cols);
        setRows(rws);
        rowsRef.current = rws;
        setCells(Object.fromEntries(cls.map((c) => [key(c.rowId, c.columnId), c])));
        // Documents already in the pile from this session stay linked; the rest
        // come back from storage.
        const live = liveFileIds();
        setFiles(
          rws
            .filter((row) => row.fileIds.some((id) => live.has(id)))
            .map((row) => ({
              fileId: row.fileIds.find((id) => live.has(id))!,
              name: row.label,
              pages: row.pageCount,
              status: "ready" as const,
            })),
        );
        setBusy(false);
        const hydrated = await hydrateRows(next.id, rws, next.sources);
        if (tableRef.current?.id === next.id) {
          setRows(hydrated);
          if (hydrated.some((row) => row.docId)) {
            setDocSave((prev) =>
              prev.status === "error"
                ? prev
                : { status: "saved", message: null },
            );
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not open that table");
      } finally {
        setBusy(false);
      }
    },
    [hydrateRows, liveFileIds],
  );

  const newTable = useCallback(
    async (name: string, instructions?: string | null) => {
      if (!owner) return null;
      setBusy(true);
      try {
        const created = await db.createReviewTable({ owner, name, instructions: instructions ?? null });
        setTable(created);
        setColumns([]);
        setRows([]);
        setCells({});
        setFiles([]);
        setDocSave({ status: "idle", message: null });
        if (!sharedRef.current) await pile().clear();
        void refreshTables();
        return created;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not create the table");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [owner, pile, refreshTables],
  );

  const removeTable = useCallback(
    async (id: string) => {
      for (const [taskKey, controller] of saveTasks.current) {
        if (taskKey.startsWith(`${id}:`)) {
          controller.abort();
          saveTasks.current.delete(taskKey);
        }
      }
      try {
        await db.deleteReviewTable(id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not delete the table");
        return;
      }
      if (table?.id === id) {
        setTable(null);
        setColumns([]);
        setRows([]);
        setCells({});
        setFiles([]);
        setDocSave({ status: "idle", message: null });
        if (!sharedRef.current) await pile().clear();
      }
      void refreshTables();
    },
    [pile, refreshTables, table?.id],
  );

  const closeTable = useCallback(async () => {
    abortRef.current?.abort();
    // Document saves keep running: the server binds rows when ingest lands and
    // the next open picks them up through the workspace manifest.
    setTable(null);
    setColumns([]);
    setRows([]);
    setCells({});
    setFiles([]);
    setRun(IDLE_RUN);
    setDocSave({ status: "idle", message: null });
    if (!sharedRef.current) await pile().clear();
    void refreshTables();
  }, [pile, refreshTables]);

  const rename = useCallback(
    async (name: string) => {
      if (!table) return;
      await db.renameReviewTable(table.id, name);
      setTable({ ...table, name });
      void refreshTables();
    },
    [refreshTables, table],
  );

  // --- documents -------------------------------------------------------------

  type SaveStatus = {
    status: "saving" | "ready" | "error";
    pendingCount: number;
    documents: { clientFileId: string; status: string; docId?: string }[];
    errorSummary?: string;
  };

  /**
   * Save one drop batch to the owner's account as a `review` workspace
   * (original bytes best-effort, pages, chunk index) and bind its rows to the
   * KB documents that come back. Runs in the background: the grid is usable
   * as soon as extraction finishes, and a table closed mid-save is bound on
   * its next open through the workspace manifest.
   */
  const saveBatch = useCallback(
    async (
      target: { id: string; name: string },
      docs: { fileId: string; name: string; file: File; pages: PilePage[] }[],
      batchRows: ReviewRow[],
    ) => {
      if (!docs.length) return;
      const controller = new AbortController();
      const signal = controller.signal;
      const requestId = crypto.randomUUID();
      const taskKey = `${target.id}:${requestId}`;
      saveTasks.current.set(taskKey, controller);
      const forThisTable = () => tableRef.current?.id === target.id;
      const plural = docs.length === 1 ? "" : "s";
      if (forThisTable()) {
        setDocSave({ status: "saving", message: `Saving ${docs.length} document${plural} to your account…` });
      }
      let itemId: string | null = null;
      let attached = false;
      try {
        const files = await mapPool(docs, 3, async (doc) => {
          const sha256 = await rawFileSha256(doc.file).catch(() => undefined);
          const bytesKey = await uploadOriginalBytes(
            { name: doc.name, blob: doc.file, ...(sha256 ? { sha256 } : {}) },
            signal,
          );
          const pages = doc.pages
            .filter((p) => p.text.trim())
            .map((p) => ({ page: p.page, text: p.text }));
          const totalChars = pages.reduce((n, p) => n + p.text.length, 0);
          // Oversize documents take the asynchronous lane over the original
          // bytes; everything else is indexed from the text the grid reads.
          const oversize = pages.length > SYNC_INGEST_MAX_PAGES || totalChars > SYNC_INGEST_MAX_CHARS;
          return {
            clientFileId: doc.fileId,
            fileName: doc.name,
            ...(doc.file.type ? { mime: doc.file.type } : {}),
            ...(sha256 ? { sha256 } : {}),
            byteSize: doc.file.size,
            ...(bytesKey ? { bytesKey } : {}),
            pages: oversize ? [] : pages,
          };
        });
        if (signal.aborted) return;
        const res = await saveWorkspaceFn({
          data: {
            requestId,
            name: reviewBatchName(target.name, docs.map((d) => d.name)),
            surface: "review",
            files,
          },
        });
        itemId = res.itemId;
        let status: SaveStatus = res;
        for (let poll = 0; status.status === "saving" && poll < SAVE_POLL_MAX; poll++) {
          if (forThisTable()) {
            setDocSave({
              status: "indexing",
              message: `${status.pendingCount} document${status.pendingCount === 1 ? "" : "s"} still indexing…`,
            });
          }
          await abortableDelay(SAVE_POLL_MS, signal);
          const polled = await withRetry(() => getWorkspaceStatusFn({ data: { itemId: res.itemId } }), {
            tries: 3,
            baseMs: 500,
            signal,
          });
          if (!polled) throw new Error("Saved document status is unavailable.");
          status = polled;
        }
        if (signal.aborted) {
          // The table was deleted while its documents were saving.
          await deleteWorkspaceFn({ data: { itemId: res.itemId } }).catch(() => undefined);
          return;
        }

        let sources: ReviewTable["sources"];
        try {
          sources = await db.attachSource(target.id, res.itemId, true);
          attached = true;
        } catch {
          // Table gone: do not leave storage the user cannot see.
          await deleteWorkspaceFn({ data: { itemId: res.itemId } }).catch(() => undefined);
          return;
        }
        if (forThisTable()) {
          setTable((t) => (t && t.id === target.id ? { ...t, sources } : t));
        }

        const docIdByFileId = Object.fromEntries(
          status.documents.flatMap((doc) =>
            doc.status === "ready" && doc.docId ? [[doc.clientFileId, doc.docId]] : [],
          ),
        );
        const known = new Map(batchRows.map((row) => [row.id, row]));
        for (const row of rowsRef.current) if (row.tableId === target.id) known.set(row.id, row);
        const bindings = bindingsFromSave([...known.values()], res.itemId, docIdByFileId);
        if (bindings.length) {
          const bound = await db.bindRowDocuments(target.id, res.itemId, bindings);
          if (forThisTable()) {
            setRows((prev) => {
              const byId = new Map(bound.map((row) => [row.id, row]));
              return prev.map((row) => byId.get(row.id) ?? row);
            });
          }
        }
        if (forThisTable()) {
          if (status.status === "error") {
            setDocSave({
              status: "error",
              message: status.errorSummary ?? "Some documents could not be saved to your account.",
            });
          } else if (status.status === "saving") {
            setDocSave({
              status: "indexing",
              message: "Large documents are still indexing; they finish binding when you reopen this table.",
            });
          } else {
            setDocSave({ status: "saved", message: null });
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        if (itemId && !attached) {
          // Reserved but never attached; a retry on the next drop starts clean.
          await deleteWorkspaceFn({ data: { itemId } }).catch(() => undefined);
        }
        if (forThisTable()) {
          setDocSave({
            status: "error",
            message: `${docs.length} document${plural} stayed in this tab only: ${
              err instanceof Error ? err.message : "save failed"
            }`,
          });
        }
      } finally {
        saveTasks.current.delete(taskKey);
      }
    },
    [],
  );

  /**
   * Extract dropped files in the browser, add their pages to the index, and
   * persist one row per document. A document already in the table (same name
   * and page count) is re-linked instead of duplicated, so reopening a saved
   * table and re-dropping the files restores the reader without new rows.
   * The batch is then saved to the owner's account in the background.
   */
  const addFiles = useCallback(
    async (incoming: File[]) => {
      if (!owner || !table) return;
      const accepted = incoming.filter((f) => fileKind(f));
      if (!accepted.length) {
        setError("Supported files: PDF, Word, Excel, PowerPoint or TXT.");
        return;
      }
      const roomForRows = Math.max(0, MAX_FILES - rows.length);
      const batch = accepted.slice(0, roomForRows);
      if (!batch.length) {
        setError(`This table already holds the maximum of ${MAX_FILES} documents.`);
        return;
      }

      setError(null);
      setBusy(true);
      setFiles((prev) => [
        ...prev,
        ...batch.map((f) => ({
          fileId: `pending:${f.name}`,
          name: f.name,
          pages: 0,
          status: "reading" as const,
        })),
      ]);

      let pageBudget = MAX_PAGES - rows.reduce((n, r) => n + r.pageCount, 0);
      const fresh: {
        fileId: string;
        name: string;
        file: File;
        pages: PilePage[];
        fingerprint: string;
      }[] = [];

      await mapPool(batch, 3, async (file) => {
        try {
          const res = await extractFile(file);
          const fileId = crypto.randomUUID();
          const take = res.pages.slice(0, Math.max(0, pageBudget));
          pageBudget -= take.length;
          let pages: PilePage[] = take.map((p) => ({
            fileId,
            fileName: res.name,
            page: p.page,
            text: (p.text ?? "").trim(),
            ocr: false,
          }));

          if (fileKind(file) === "pdf") {
            setFiles((prev) =>
              prev.map((f) =>
                f.fileId === `pending:${file.name}`
                  ? { fileId, name: res.name, pages: pages.length, status: "ocr" as const }
                  : f,
              ),
            );
            const recovered = await recoverScannedPages(file, pages);
            pages = recovered.pages;
            fresh.push({
              fileId,
              name: res.name,
              file,
              pages,
              fingerprint: documentRowFingerprint(res.name, pages.length),
            });
            setFiles((prev) =>
              prev.map((f) =>
                f.fileId === fileId || f.fileId === `pending:${file.name}`
                  ? {
                      fileId,
                      name: res.name,
                      pages: pages.length,
                      status: "ready" as const,
                      ocrPages: recovered.recovered,
                      error: recovered.failed
                        ? `${recovered.failed} scanned page${recovered.failed === 1 ? "" : "s"} could not be read`
                        : undefined,
                    }
                  : f,
              ),
            );
            return;
          }

          fresh.push({
            fileId,
            name: res.name,
            file,
            pages,
            fingerprint: documentRowFingerprint(res.name, pages.length),
          });
          setFiles((prev) =>
            prev.map((f) =>
              f.fileId === `pending:${file.name}`
                ? { fileId, name: res.name, pages: pages.length, status: "ready" as const }
                : f,
            ),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : "Could not read this file";
          setFiles((prev) =>
            prev.map((f) =>
              f.fileId === `pending:${file.name}`
                ? { ...f, status: "error" as const, error: message }
                : f,
            ),
          );
        }
      });

      try {
        const allPages = fresh.flatMap((f) => f.pages);
        if (sharedRef.current) {
          await sharedRef.current.ingestPages(
            fresh.map((f) => ({
              id: f.fileId,
              name: f.name,
              pageCount: f.pages.length,
              emptyPages: f.pages.filter((p) => !p.text.trim()).length,
              ocrPages: f.pages.filter((p) => p.ocr).length,
            })),
            allPages,
          );
        } else if (allPages.length) {
          await pile().addPages(allPages);
        }
        setPageTexts((prev) => {
          const next = { ...prev };
          for (const p of allPages) next[`${p.fileId}:${p.page}`] = p.text;
          return next;
        });

        // Re-link rows that already exist for this document; insert the rest.
        const toInsert: typeof fresh = [];
        const batchRows: ReviewRow[] = [];
        /** Documents whose row is already bound to a saved copy need no new save. */
        const toSave: typeof fresh = [];
        for (const f of fresh) {
          const match = findDocumentRow(rows, f.name, f.pages.length);
          if (match) {
            await db.relinkRow(match.id, [f.fileId]);
            const relinked = { ...match, fileIds: [f.fileId] };
            batchRows.push(relinked);
            setRows((prev) => prev.map((r) => (r.id === match.id ? relinked : r)));
            if (!match.docId) toSave.push(f);
          } else {
            toInsert.push(f);
            toSave.push(f);
          }
        }
        if (toInsert.length) {
          const inserted = await db.upsertRows(
            owner,
            table.id,
            toInsert.map((f) => ({
              label: f.name,
              fileIds: [f.fileId],
              fingerprint: f.fingerprint,
              pageCount: f.pages.length,
            })),
            rows.length,
          );
          batchRows.push(...inserted);
          setRows((prev) => [...prev, ...inserted]);
        }
        if (toSave.length) {
          void saveBatch(
            { id: table.id, name: table.name },
            toSave.map((f) => ({ fileId: f.fileId, name: f.name, file: f.file, pages: f.pages })),
            batchRows,
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save these documents");
      } finally {
        setBusy(false);
      }
    },
    [owner, pile, rows, saveBatch, table],
  );

  /**
   * Add the open Working Set's documents as rows. When that Working Set is
   * saved, rows bind straight to its KB documents and the workspace becomes a
   * referenced (not owned) source; otherwise the rows are session-only until
   * the Working Set is saved.
   */
  const useWorkingSet = useCallback(
    async (files: PileFile[], saved?: SavedWorkspaceBinding | null) => {
      if (!owner || !table) return;
      if (!files.length) {
        setError("Open a working set first, then use it here.");
        return;
      }
      setError(null);
      setBusy(true);
      const binding = saved && saved.surface === "workingset" ? saved : null;
      try {
        const toInsert: db.RowInsert[] = [];
        const toBind: { rowId: string; docId: string }[] = [];
        for (const f of files) {
          const fingerprint = documentRowFingerprint(f.name, f.pageCount);
          const docId = binding?.docIdByFileId[f.id] ?? null;
          const match = findDocumentRow(rows, f.name, f.pageCount);
          if (match) {
            await db.relinkRow(match.id, [f.id]);
            setRows((prev) =>
              prev.map((r) => (r.id === match.id ? { ...r, fileIds: [f.id] } : r)),
            );
            if (docId && !match.docId) toBind.push({ rowId: match.id, docId });
          } else {
            toInsert.push({
              label: f.name,
              fileIds: [f.id],
              fingerprint,
              pageCount: f.pageCount,
              ...(docId && binding
                ? { docId, workspaceItemId: binding.itemId }
                : {}),
            });
          }
        }
        if (toInsert.length) {
          const inserted = await db.upsertRows(owner, table.id, toInsert, rows.length);
          setRows((prev) => [...prev, ...inserted]);
        }
        if (binding) {
          const sources = await db.attachSource(table.id, binding.itemId, false);
          setTable((t) => (t && t.id === table.id ? { ...t, sources } : t));
          if (toBind.length) {
            const bound = await db.bindRowDocuments(table.id, binding.itemId, toBind);
            setRows((prev) => {
              const byId = new Map(bound.map((row) => [row.id, row]));
              return prev.map((row) => byId.get(row.id) ?? row);
            });
          }
          setDocSave({ status: "saved", message: null });
        } else {
          setDocSave({
            status: "error",
            message:
              "This Working Set is not saved, so these rows live in this tab only. Save the Working Set to keep them with the table.",
          });
        }
        setFiles(
          files.map((f) => ({
            fileId: f.id,
            name: f.name,
            pages: f.pageCount,
            status: "ready" as const,
            ocrPages: f.ocrPages,
          })),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not use the working set");
      } finally {
        setBusy(false);
      }
    },
    [owner, rows, table],
  );

  const removeRow = useCallback(async (rowId: string) => {
    await db.deleteRow(rowId).catch(() => undefined);
    setRows((prev) => prev.filter((r) => r.id !== rowId));
    setCells((prev) => {
      const next: Record<CellKey, ReviewCell> = {};
      for (const [k, v] of Object.entries(prev)) if (v.rowId !== rowId) next[k] = v;
      return next;
    });
  }, []);

  // --- columns ---------------------------------------------------------------

  const addColumn = useCallback(
    async (input: { name: string; kind: ColumnKind; question: string; options: string[] }) => {
      if (!owner || !table) return null;
      const created = await db.createColumn({
        owner,
        tableId: table.id,
        position: columns.length,
        ...input,
      });
      setColumns((prev) => [...prev, created]);
      return created;
    },
    [columns.length, owner, table],
  );

  /** Append a whole template pack. Existing names are skipped, cap respected. */
  const addColumns = useCallback(
    async (drafts: { name: string; kind: ColumnKind; question: string; options?: string[] }[]) => {
      if (!owner || !table) return [];
      const taken = new Set(columns.map((c) => c.name.trim().toLowerCase()));
      let position = columns.length;
      const created: ReviewColumn[] = [];
      for (const draft of drafts) {
        const nameKey = draft.name.trim().toLowerCase();
        if (!nameKey || taken.has(nameKey)) continue;
        if (position >= REVIEW_MAX_COLUMNS) break;
        try {
          const column = await db.createColumn({
            owner,
            tableId: table.id,
            position,
            name: draft.name,
            kind: draft.kind,
            question: draft.question,
            options: draft.options ?? [],
          });
          created.push(column);
          taken.add(nameKey);
          position++;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not add a column");
          break;
        }
      }
      if (created.length) setColumns((prev) => [...prev, ...created]);
      return created;
    },
    [columns, owner, table],
  );

  const editColumn = useCallback(
    async (
      column: ReviewColumn,
      patch: { name?: string; kind?: ColumnKind; question?: string; options?: string[] },
    ) => {
      const updated = await db.updateColumn(column, patch);
      setColumns((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      return updated;
    },
    [],
  );

  const removeColumn = useCallback(async (columnId: string) => {
    await db.deleteColumn(columnId).catch(() => undefined);
    setColumns((prev) => prev.filter((c) => c.id !== columnId));
    setCells((prev) => {
      const next: Record<CellKey, ReviewCell> = {};
      for (const [k, v] of Object.entries(prev)) if (v.columnId !== columnId) next[k] = v;
      return next;
    });
  }, []);

  // --- retrieval -------------------------------------------------------------

  /** Per-document evidence packs for one question, keyed by file id. */
  const packsFor = useCallback(
    async (question: string) => {
      const { groups, texts } = await pile().packAskByFile(question, null, REVIEW_CELL_PAGES);
      setPageTexts((prev) => ({ ...prev, ...texts }));
      return new Map(groups.map((g) => [g.fileId, g]));
    },
    [pile],
  );

  // --- runs ------------------------------------------------------------------

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRun((r) => ({ ...r, running: false, label: "Cancelled" }));
  }, []);

  /**
   * Fill cells. Verified and overridden cells are never touched; cells whose
   * cache key still matches are skipped unless `force` is set.
   */
  const runCells = useCallback(
    async (opts: {
      columnIds?: string[];
      rowIds?: string[];
      force?: boolean;
      onlyFailed?: boolean;
    } = {}) => {
      if (!owner || !table) return;
      const targetColumns = columns.filter(
        (c) => (!opts.columnIds || opts.columnIds.includes(c.id)) && c.question.trim(),
      );
      const targetRows = rows.filter((r) => !opts.rowIds || opts.rowIds.includes(r.id));
      if (!targetColumns.length || !targetRows.length) {
        setError("Add at least one document and one column with a question first.");
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      const model = REVIEW_PIPELINE_ENABLED ? REVIEW_PIPELINE_VERSION : "review-cell";

      type Job = {
        row: ReviewRow;
        column: ReviewColumn;
        cacheKey: string;
      };
      const jobs: Job[] = [];
      let skipped = 0;
      for (const column of targetColumns) {
        for (const row of targetRows) {
          const existing = cells[key(row.id, column.id)];
          const ck = cellCacheKey({
            rowFingerprint: row.fingerprint,
            columnId: column.id,
            columnVersion: column.version,
            model,
          });
          if (existing && (existing.verifiedAt || existing.overridden)) {
            skipped++;
            continue;
          }
          if (opts.onlyFailed && existing?.status !== "error") {
            skipped++;
            continue;
          }
          if (!opts.force && !opts.onlyFailed && existing && existing.cacheKey === ck) {
            skipped++;
            continue;
          }
          jobs.push({ row, column, cacheKey: ck });
        }
      }

      if (!jobs.length) {
        setRun({ ...IDLE_RUN, skipped, label: "Everything is already up to date" });
        return;
      }

      setPending(new Set(jobs.map((j) => key(j.row.id, j.column.id))));
      setRun({
        running: true,
        total: jobs.length,
        done: 0,
        failed: 0,
        skipped,
        label: "Retrieving evidence",
      });

      const runId = await db.startRun({
        owner,
        tableId: table.id,
        columnIds: targetColumns.map((c) => c.id),
        snapshot: {
          columns: targetColumns.map((c) => ({
            id: c.id,
            name: c.name,
            kind: c.kind,
            version: c.version,
            question: c.question,
          })),
          pagesPerCell: REVIEW_CELL_PAGES,
          startedAt: new Date().toISOString(),
        },
        cellsTotal: jobs.length,
      });

      let done = 0;
      let failed = 0;

      try {
        for (const column of targetColumns) {
          if (controller.signal.aborted) break;
          const columnJobs = jobs.filter((j) => j.column.id === column.id);
          if (!columnJobs.length) continue;

          setRun((r) => ({ ...r, label: `Reading for “${column.name}”` }));
          const packs = await packsFor(column.question);

          const writes: db.CellWrite[] = [];
          await mapPool(columnJobs, REVIEW_CELL_CONCURRENCY, async (job) => {
            const settle = () =>
              setPending((prev) => {
                const next = new Set(prev);
                next.delete(key(job.row.id, column.id));
                return next;
              });
            if (controller.signal.aborted) return settle();
            const fileId = job.row.fileIds[0] ?? "";
            const pack = packs.get(fileId);
            const pages = (pack?.pages ?? []).map((p) => ({
              page: p.page,
              text: p.text,
              ocr: p.ocr,
            }));
            const base = {
              owner,
              tableId: table.id,
              rowId: job.row.id,
              columnId: column.id,
              cacheKey: job.cacheKey,
              runId,
            };
            if (!fileId) {
              writes.push({
                ...base,
                value: null,
                display: "",
                status: "error",
                confidence: null,
                citations: [],
                rationale: null,
                pagesSearched: [],
                error: "Re-upload this document to run it",
              });
              failed++;
              setRun((r) => ({ ...r, failed }));
              settle();
              return;
            }

            try {
              const answer = await requestCell({
                column,
                instructions: table.instructions,
                fileName: job.row.label,
                pages,
                signal: controller.signal,
              });
              writes.push({
                ...base,
                value: answer.value ?? null,
                display: answer.display || displayValue(answer.value),
                status: answer.status,
                confidence: answer.confidence,
                citations: answer.citations ?? [],
                rationale: answer.rationale ?? null,
                pagesSearched: pages.map((p) => p.page),
                error: null,
              });
              done++;
              setRun((r) => ({ ...r, done }));
              settle();
            } catch (err) {
              settle();
              if (controller.signal.aborted) return;
              writes.push({
                ...base,
                value: null,
                display: "",
                status: "error",
                confidence: null,
                citations: [],
                rationale: null,
                pagesSearched: pages.map((p) => p.page),
                error: err instanceof Error ? err.message : "Cell failed",
              });
              failed++;
              setRun((r) => ({ ...r, failed }));
            }
          });

          if (writes.length) {
            const saved = await db.saveCells(writes);
            setCells((prev) => {
              const next = { ...prev };
              for (const c of saved) next[key(c.rowId, c.columnId)] = c;
              return next;
            });
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "The run stopped early");
      }

      const cancelled = controller.signal.aborted;
      await db.finishRun(runId, {
        done,
        failed,
        status: cancelled ? "cancelled" : failed && !done ? "failed" : "complete",
      });
      abortRef.current = null;
      setPending(new Set());
      setRun({
        running: false,
        total: jobs.length,
        done,
        failed,
        skipped,
        label: cancelled ? "Cancelled" : failed ? `${failed} cell(s) failed` : "Run complete",
      });
    },
    [cells, columns, owner, packsFor, rows, table],
  );

  /**
   * Sample a draft column against the first documents without writing
   * anything — read the answers, fix the question, then commit the column.
   */
  const testColumn = useCallback(
    async (draft: {
      name: string;
      kind: ColumnKind;
      question: string;
      options: string[];
    }): Promise<SampleResult[]> => {
      if (!draft.question.trim()) throw new Error("Write the question first");
      const sample = rows.filter((r) => r.fileIds[0]).slice(0, REVIEW_SAMPLE_ROWS);
      if (!sample.length) throw new Error("Add documents to this table first");
      const packs = await packsFor(draft.question);

      const results: SampleResult[] = [];
      await mapPool(sample, REVIEW_CELL_CONCURRENCY, async (row) => {
        const pack = packs.get(row.fileIds[0] ?? "");
        try {
          const answer = await requestCell({
            column: draft,
            instructions: table?.instructions ?? null,
            fileName: row.label,
            pages: (pack?.pages ?? []).map((p) => ({ page: p.page, text: p.text, ocr: p.ocr })),
          });
          results.push({ rowId: row.id, label: row.label, answer, error: null });
        } catch (err) {
          results.push({
            rowId: row.id,
            label: row.label,
            answer: null,
            error: err instanceof Error ? err.message : "Failed",
          });
        }
      });
      const order = new Map(sample.map((r, i) => [r.id, i]));
      return results.sort((a, b) => (order.get(a.rowId) ?? 0) - (order.get(b.rowId) ?? 0));
    },
    [packsFor, rows, table?.instructions],
  );

  // --- cell edits ------------------------------------------------------------

  const override = useCallback(
    async (cell: ReviewCell, value: string) => {
      const updated = await db.overrideCell(cell, value, actorEmail);
      setCells((prev) => ({ ...prev, [key(updated.rowId, updated.columnId)]: updated }));
      return updated;
    },
    [actorEmail],
  );

  const setVerified = useCallback(
    async (cell: ReviewCell, verified: boolean) => {
      const updated = await db.setCellVerified(cell, verified, actorEmail);
      setCells((prev) => ({ ...prev, [key(updated.rowId, updated.columnId)]: updated }));
      return updated;
    },
    [actorEmail],
  );

  const cellAt = useCallback(
    (rowId: string, columnId: string): ReviewCell | null => cells[key(rowId, columnId)] ?? null,
    [cells],
  );

  const pageText = useCallback(
    (fileId: string, page: number): string => pageTexts[`${fileId}:${page}`] ?? "",
    [pageTexts],
  );

  const stats = useMemo(() => {
    const rowIds = new Set(rows.map((row) => row.id));
    const columnIds = new Set(columns.map((column) => column.id));
    const list = Object.values(cells).filter(
      (cell) => rowIds.has(cell.rowId) && columnIds.has(cell.columnId),
    );
    return {
      total: rows.length * columns.length,
      filled: list.filter((c) => c.status !== "pending").length,
      needsReview: list.filter((c) => c.status === "needs_review").length,
      notFound: list.filter((c) => c.status === "not_found").length,
      errors: list.filter((c) => c.status === "error").length,
      verified: list.filter((c) => !!c.verifiedAt).length,
      pages: rows.reduce((n, r) => n + r.pageCount, 0),
    };
  }, [cells, columns, rows]);

  /** A row whose document is not in this browser session cannot be re-run. */
  const linkedRowIds = useMemo(() => {
    const live = new Set(files.filter((f) => f.status === "ready").map((f) => f.fileId));
    return new Set(rows.filter((r) => live.has(r.fileIds[0] ?? "")).map((r) => r.id));
  }, [files, rows]);

  return {
    tables,
    table,
    columns,
    rows,
    cells,
    files,
    run,
    busy,
    error,
    stats,
    linkedRowIds,
    docSave,
    hydrating,
    setError,
    refreshTables,
    loadTable,
    closeTable,
    newTable,
    removeTable,
    rename,
    addFiles,
    useWorkingSet,
    removeRow,
    addColumn,
    addColumns,
    editColumn,
    removeColumn,
    runCells,
    cancel,
    testColumn,
    override,
    setVerified,
    cellAt,
    pageText,
    pending,
  };
}

export type ReviewController = ReturnType<typeof useReviewTable>;
