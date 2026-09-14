import { useCallback, useEffect, useRef, useState } from "react";
import {
  runDocumentScan,
  scanCacheKey,
  retryScan,
  type DiscoveryScope,
  type ScanCoverage,
  type ScanWindowResult,
} from "@/lib/pile/discovery-scan";

import { extractFile, transcriptFileKind } from "@/lib/extract-text";
import { abortableDelay, rawFileSha256, uploadOriginalBytes } from "@/lib/kb/client-upload";
import {
  buildDepositionRecord,
  depositionWorkspaceName,
  kbSourcesToDepositionHits,
  type DepositionRecord,
  type DepositionRecordPass,
  type DepositionRecordPassStatus,
} from "@/lib/kb/deposition-record";
import { planSaveLane } from "@/lib/kb/ingest-state";
import { streamSavedWorkspaceAsk, type KbAskSource } from "@/lib/kb/kb-client";
import {
  deleteWorkspaceFn,
  getWorkspaceAnalysisFn,
  getWorkspaceFn,
  getWorkspacePagesFn,
  getWorkspaceStatusFn,
  saveWorkspaceAnalysisFn,
  saveWorkspaceFn,
} from "@/lib/kb/workspace.functions";
import { streamSSE } from "@/lib/orchestrate";
import { AdaptiveLimiter, HttpStatusError, mapPool, withRetry } from "@/lib/pile/async";
import { packAskHits, pagesForClientHits } from "@/lib/pile/client-search";
import {
  analysisToMarkdown,
  matchDepEvidence,
  depositionFindingBatches,
  EMPTY_ANALYSIS,
  extractCaptionMeta,
  mergeDepAnalysis,
  parseCiteStart,
  parseDepAnalysis,
  verifyDepAnalysis,
  type DepAnalysis,
} from "@/lib/pile/deposition-analysis";
import {
  ANALYZE_WINDOW_CONCURRENCY,
  DEP_MAX_BYTES,
  DEP_MAX_FILES,
  DEP_MAX_PAGES,
  FILE_EXTRACT_CONCURRENCY,
  OCR_CONCURRENCY,
  OCR_CONCURRENCY_MAX,
  OCR_CONCURRENCY_MIN,
  OCR_PAGE_CAP,
} from "@/lib/pile/limits";
import {
  pageNeedsDepOcr,
  transcriptFromPages,
  type TranscriptBlock,
  type TranscriptParse,
} from "@/lib/pile/transcript";
import { textQualityScore } from "@/lib/pile/text-quality";
import { batchEvidence } from "@/lib/pile/deposition-context";
import type { PileHit, PilePage } from "@/lib/pile/types";
import { forEachRenderedPdfPage } from "@/lib/pile-render";

export type DepPhase = "idle" | "reading" | "indexing" | "ready" | "analyzing" | "asking" | "error";
export type DepSpeakerFilter = "any" | "question" | "answer" | "objection";
export type DepPass = DepositionRecordPass;
export type DepPassStatus = DepositionRecordPassStatus;
export type DepStep = {
  id: string;
  label: string;
  detail?: string;
  status: "running" | "done" | "error";
};
export type DepTranscript = TranscriptParse & { fileId: string };

/** Durable copy of this deposition set: transcript bytes, pages, chunk index, analysis. */
export type DepSaveStatus = "idle" | "saving" | "queued" | "embedding" | "ready" | "error";
export type DepAnalysisSaveStatus = "idle" | "pending" | "saving" | "saved" | "error";
export type DepSaved = {
  status: DepSaveStatus;
  itemId: string | null;
  kbWorkspaceId: string | null;
  name: string | null;
  /** Browser file id -> KB document id, complete only when status is "ready". */
  docIdByFileId: Record<string, string>;
  message: string | null;
  analysis: DepAnalysisSaveStatus;
  analysisError: string | null;
  analysisSavedAt: string | null;
  /** True when this session was rehydrated from the Library. */
  loaded: boolean;
  /** Ask is answered from the saved hybrid index rather than the in-tab BM25. */
  hybridAsk: boolean;
};

export type DepState = {
  phase: DepPhase;
  files: {
    name: string;
    pages: number;
    empty: number;
    done: number;
    status: "reading" | "ready" | "error";
  }[];
  steps: DepStep[];
  error: string | null;
  transcripts: DepTranscript[];
  activeFileId: string | null;
  analysis: DepAnalysis | null;
  passes: Record<DepPass, DepPassStatus>;
  selectedCite: string | null;
  search: string;
  regex: boolean;
  speaker: DepSpeakerFilter;
  query: string;
  answer: string;
  hits: PileHit[];
  asking: boolean;
  witness: string | null;
  role: string;
  mdl: string | null;
  taken: string | null;
  pageCount: number;
  citeReady: boolean;
  instructions: string;
  ocr: { done: number; total: number } | null;
  analyzeProgress: { done: number; total: number } | null;
  saved: DepSaved;
  scanCoverage?: ScanCoverage | null;
};

const IDLE_PASSES: Record<DepPass, DepPassStatus> = {
  case: "idle",
  record: "idle",
  connections: "idle",
  cross: "idle",
};

const EMPTY_SAVED: DepSaved = {
  status: "idle",
  itemId: null,
  kbWorkspaceId: null,
  name: null,
  docIdByFileId: {},
  message: null,
  analysis: "idle",
  analysisError: null,
  analysisSavedAt: null,
  loaded: false,
  hybridAsk: false,
};

const EMPTY: DepState = {
  phase: "idle",
  files: [],
  steps: [],
  error: null,
  transcripts: [],
  activeFileId: null,
  analysis: null,
  passes: IDLE_PASSES,
  selectedCite: null,
  search: "",
  regex: false,
  speaker: "any",
  query: "",
  answer: "",
  hits: [],
  asking: false,
  witness: null,
  role: "",
  mdl: null,
  taken: null,
  pageCount: 0,
  citeReady: false,
  instructions: "",
  ocr: null,
  analyzeProgress: null,
  saved: EMPTY_SAVED,
};

const PASS_QUERY: Record<DepPass, string> = {
  case: "Build the trial-usable case layer: witness profile, admissions, impeachment, and objections.",
  record: "Build the record layer: chronology, exhibits, and case themes.",
  connections:
    "Map witnesses, material contradictions, and a knowledge graph of people, companies, documents, and themes.",
  cross:
    "Compare these depositions. Identify potential conflicts supported by affirmative testimony about the same subject and time period, and one shared knowledge graph. Silence alone is not a conflict.",
};

/** Debounce for mid-analysis record writes; the final write is immediate. */
const ANALYSIS_PERSIST_DEBOUNCE_MS = 1_500;
const SAVE_POLL_MS = 5_000;
const SAVE_POLL_MAX = 180;

function newId(): string {
  return crypto.randomUUID();
}

function coverUnits(t: DepTranscript): (TranscriptBlock & { fileId: string; fileName: string })[] {
  if (t.blocks.length) {
    return t.blocks.map((b) => ({ ...b, fileId: t.fileId, fileName: t.fileName }));
  }
  const byPage = new Map<number, TranscriptBlock["lines"]>();
  for (const l of t.lines) {
    const cur = byPage.get(l.page) ?? [];
    cur.push(l);
    byPage.set(l.page, cur);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, lines]) => ({
      id: `${t.fileId}:${page}`,
      startPage: page,
      startLine: lines[0]?.line ?? 1,
      endPage: page,
      endLine: lines[lines.length - 1]?.line ?? 1,
      cite: `${page}:${lines[0]?.line ?? 1}`,
      question: "",
      answer: lines.map((l) => l.text).join("\n"),
      lines,
      fileId: t.fileId,
      fileName: t.fileName,
    }));
}

async function json<T>(url: string, init?: RequestInit, opts?: { tries?: number }): Promise<T> {
  return withRetry(
    async () => {
      const res = await fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      });
      const body = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}: ${body.error || res.statusText}`);
      }
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body;
    },
    {
      tries: opts?.tries ?? 3,
      baseMs: 400,
      signal: init?.signal ?? undefined,
      retry429: (opts?.tries ?? 3) > 1,
    },
  );
}

function seedWitnesses(list: DepTranscript[]): DepAnalysis["witnesses"] {
  return list.map((t, i) => ({
    id: `w-seed-${i}`,
    name: t.witness || t.fileName.replace(/\.[^.]+$/, ""),
    role: "",
    fileName: t.fileName,
    summary: t.caption.replace(/\s+/g, " ").trim().slice(0, 280),
    quote: "",
    cite: t.citeReady && t.lines[0] ? `${t.lines[0]!.page}:${t.lines[0]!.line}` : "",
  }));
}

type SaveAttempt = {
  requestId: string;
  bytesKeyByFileId: Record<string, string>;
  sha256ByFileId: Record<string, string>;
};

type AnalysisRun = { runId: string; startedAt: number };

export function useDeposition() {
  const [state, setState] = useState<DepState>(EMPTY);
  const ingestAbort = useRef<AbortController | null>(null);
  const analyzeAbort = useRef<AbortController | null>(null);
  const askAbort = useRef<AbortController | null>(null);
  const saveAbort = useRef<AbortController | null>(null);
  const filesRef = useRef<Map<string, File>>(new Map());
  const pdfFilesRef = useRef<Map<string, File>>(new Map());
  const pagesRef = useRef<PilePage[]>([]);
  const scanCache = useRef(new Map<string, ScanWindowResult>());
  const lastScan = useRef<{ query: string; fileIds?: string[] } | null>(null);
  const analysisCache = useRef(new Map<string, DepAnalysis>());
  const transcriptsRef = useRef<DepTranscript[]>([]);
  const instructionsRef = useRef("");
  const analysisRef = useRef<DepAnalysis>(EMPTY_ANALYSIS);
  const passesRef = useRef<Record<DepPass, DepPassStatus>>(IDLE_PASSES);
  const savedRef = useRef<DepSaved>(EMPTY_SAVED);
  const saveAttemptRef = useRef<SaveAttempt | null>(null);
  const runRef = useRef<AnalysisRun | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistInflight = useRef<Promise<void> | null>(null);
  const persistDirty = useRef<{ complete: boolean } | null>(null);
  const ocrActive = useRef(false);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!transcriptsRef.current.length) return;
      if (
        savedRef.current.analysis === "saved" &&
        !persistDirty.current &&
        !persistTimer.current &&
        !Object.values(passesRef.current).includes("running")
      )
        return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  useEffect(
    () => () => {
      ingestAbort.current?.abort();
      analyzeAbort.current?.abort();
      askAbort.current?.abort();
      saveAbort.current?.abort();
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistDirty.current = null;
      runRef.current = null;
    },
    [],
  );

  const step = useCallback((s: DepStep) => {
    setState((prev) => {
      const i = prev.steps.findIndex((x) => x.id === s.id);
      const steps =
        i === -1 ? [...prev.steps, s] : prev.steps.map((x, j) => (j === i ? { ...x, ...s } : x));
      return { ...prev, steps };
    });
  }, []);

  const setSaved = useCallback(
    (patch: Partial<DepSaved> | ((prev: DepSaved) => Partial<DepSaved>)) => {
      const next = {
        ...savedRef.current,
        ...(typeof patch === "function" ? patch(savedRef.current) : patch),
      };
      savedRef.current = next;
      setState((s) => ({ ...s, saved: next }));
    },
    [],
  );

  const setPasses = useCallback((patch: Partial<Record<DepPass, DepPassStatus>>) => {
    passesRef.current = { ...passesRef.current, ...patch };
    const next = passesRef.current;
    setState((s) => ({ ...s, passes: next }));
  }, []);

  const clearPersistTimer = () => {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
  };

  const reset = useCallback(() => {
    scanCache.current.clear();
    lastScan.current = null;
    analysisCache.current.clear();
    ingestAbort.current?.abort();
    analyzeAbort.current?.abort();
    askAbort.current?.abort();
    saveAbort.current?.abort();
    ingestAbort.current = null;
    analyzeAbort.current = null;
    askAbort.current = null;
    saveAbort.current = null;
    clearPersistTimer();
    persistDirty.current = null;
    filesRef.current = new Map();
    pdfFilesRef.current = new Map();
    pagesRef.current = [];
    transcriptsRef.current = [];
    instructionsRef.current = "";
    analysisRef.current = EMPTY_ANALYSIS;
    passesRef.current = IDLE_PASSES;
    savedRef.current = EMPTY_SAVED;
    saveAttemptRef.current = null;
    runRef.current = null;
    ocrActive.current = false;
    setState(EMPTY);
  }, []);

  const rebuildTranscripts = useCallback(() => {
    const byFile = new Map<string, { fileId: string; fileName: string; pages: PilePage[] }>();
    for (const p of pagesRef.current) {
      const cur = byFile.get(p.fileId) ?? { fileId: p.fileId, fileName: p.fileName, pages: [] };
      cur.pages.push(p);
      byFile.set(p.fileId, cur);
    }
    const transcripts: DepTranscript[] = [...byFile.values()].map((f) => ({
      ...transcriptFromPages(
        f.pages.map((p) => ({ page: p.page, text: p.text })),
        f.fileName,
      ),
      fileId: f.fileId,
    }));
    transcriptsRef.current = transcripts;
    return transcripts;
  }, []);

  // ---- Durable record -------------------------------------------------------

  const recordTranscripts = useCallback((): DepositionRecord["transcripts"] => {
    const map = savedRef.current.docIdByFileId;
    return transcriptsRef.current.map((t) => ({
      docId: map[t.fileId] ?? t.fileId,
      fileName: t.fileName,
      witness: t.witness ?? "",
      citeReady: t.citeReady,
      lineCount: t.lines.length,
    }));
  }, []);

  /**
   * Write the current analysis to the saved workspace. Serialized: one write in
   * flight at a time, and anything that changes meanwhile is written afterwards.
   * Until the workspace record exists the write is parked as "pending" and is
   * flushed as soon as the save completes.
   */
  const persistAnalysisNow = useCallback(
    async (complete: boolean): Promise<void> => {
      const run = runRef.current;
      const itemId = savedRef.current.itemId;
      if (!run || !transcriptsRef.current.length) return;
      if (!itemId) {
        persistDirty.current = { complete };
        if (savedRef.current.analysis !== "pending") setSaved({ analysis: "pending" });
        return;
      }
      if (persistInflight.current) {
        persistDirty.current = { complete: complete || (persistDirty.current?.complete ?? false) };
        return;
      }
      const record = buildDepositionRecord({
        runId: run.runId,
        runStartedAt: run.startedAt,
        complete,
        instructions: instructionsRef.current,
        transcripts: recordTranscripts(),
        passes: passesRef.current,
        analysis: analysisRef.current,
      });
      setSaved({ analysis: "saving", analysisError: null });
      const task = (async () => {
        try {
          const res = await withRetry(() => saveWorkspaceAnalysisFn({ data: { itemId, record } }), {
            tries: 3,
            baseMs: 500,
          });
          if (savedRef.current.itemId !== itemId || runRef.current !== run) return;
          if (res.ok) {
            setSaved({
              analysis: "saved",
              analysisSavedAt: res.analysis.updatedAt,
              analysisError: null,
            });
          } else {
            // A newer run owns the stored record; this run's output is superseded.
            setSaved({ analysis: "saved", analysisSavedAt: res.analysis.updatedAt });
          }
        } catch (e) {
          if (savedRef.current.itemId !== itemId || runRef.current !== run) return;
          setSaved({
            analysis: "error",
            analysisError: e instanceof Error ? e.message : "Could not save the analysis.",
          });
        } finally {
          persistInflight.current = null;
        }
      })();
      persistInflight.current = task;
      await task;
      const dirty = persistDirty.current;
      // A new workspace/run may have queued its first write while this request
      // was finishing. Drain the CURRENT dirty record, never the old snapshot.
      if (dirty) {
        persistDirty.current = null;
        await persistAnalysisNow(dirty.complete);
      }
    },
    [recordTranscripts, setSaved],
  );

  const persistAnalysis = useCallback(
    (complete: boolean) => {
      clearPersistTimer();
      if (complete) {
        void persistAnalysisNow(true);
        return;
      }
      persistTimer.current = setTimeout(() => {
        persistTimer.current = null;
        void persistAnalysisNow(false);
      }, ANALYSIS_PERSIST_DEBOUNCE_MS);
    },
    [persistAnalysisNow],
  );

  /** Read-only polling never resubmits conversion or embedding work. */
  const refreshSaveStatus = useCallback(
    async (
      initialStatus: NonNullable<Awaited<ReturnType<typeof getWorkspaceStatusFn>>>,
      signal: AbortSignal,
    ) => {
      let status = initialStatus;
      for (let poll = 0; status.status === "saving" && poll < SAVE_POLL_MAX; poll++) {
        setSaved({
          status: status.stage === "embedding" ? "embedding" : "queued",
          itemId: initialStatus.itemId,
          message: `${status.pendingCount} document${status.pendingCount === 1 ? "" : "s"} pending`,
        });
        await abortableDelay(SAVE_POLL_MS, signal);
        const polled = await withRetry(
          () => getWorkspaceStatusFn({ data: { itemId: initialStatus.itemId } }),
          {
            tries: 3,
            baseMs: 500,
            signal: signal,
          },
        );
        if (signal.aborted) return;
        if (!polled) throw new Error("Saved workspace status is unavailable.");
        status = polled;
      }
      if (signal.aborted) return;
      if (status.status === "saving") {
        setSaved({
          status: "queued",
          itemId: initialStatus.itemId,
          message: "Indexing is continuing in the background.",
        });
        step({
          id: "save",
          label: "Indexing is pending",
          status: "running",
          detail: "Use Check status to refresh.",
        });
        return;
      }
      if (status.status === "error") {
        saveAttemptRef.current = null;
        setSaved({
          status: "error",
          itemId: initialStatus.itemId,
          message: status.errorSummary ?? "Some transcripts could not be indexed.",
        });
        step({
          id: "save",
          label: "Saving to your library",
          status: "error",
          ...(status.errorSummary ? { detail: status.errorSummary } : {}),
        });
        return;
      }
      const docIdByFileId = Object.fromEntries(
        status.documents.flatMap((doc) =>
          doc.status === "ready" && doc.docId ? [[doc.clientFileId, doc.docId]] : [],
        ),
      );
      const readyCount = transcriptsRef.current.filter((t) => Boolean(docIdByFileId[t.fileId])).length;
      const bound = readyCount === transcriptsRef.current.length;
      setSaved({
        status: "ready",
        itemId: initialStatus.itemId,
        docIdByFileId,
        // Partial binding: hybrid Ask runs whenever at least one transcript is
        // indexed; the ready subset answers via RAG and the rest via in-tab
        // retrieval, instead of the whole set falling back until all are ready.
        hybridAsk: readyCount > 0,
        message: bound
          ? transcriptsRef.current.some(
              (t) =>
                filesRef.current.has(t.fileId) &&
                !saveAttemptRef.current?.bytesKeyByFileId[t.fileId],
            )
            ? "Transcript text and analysis can be saved, but an original file upload failed. Keep your original files."
            : null
          : readyCount > 0
            ? `Ask covers the ${readyCount} indexed transcript${readyCount === 1 ? "" : "s"} so far; the rest are still indexing.`
            : "Saved, but not indexed yet. Ask uses in-tab retrieval.",
      });
      step({
        id: "save",
        label: "Saved to your library",
        status: "done",
        detail: `${status.docCount} transcript${status.docCount === 1 ? "" : "s"} · ${status.chunkCount} passages`,
      });
      const dirty = persistDirty.current as { complete: boolean } | null;
      persistDirty.current = null;
      // Re-save the manifest with stable KB document IDs, even if the analysis
      // itself was already saved while indexing was in progress.
      void persistAnalysisNow(
        dirty?.complete ??
          Object.values(passesRef.current).every((p) => p === "done" || p === "error"),
      );
    },
    [persistAnalysisNow, setSaved, step],
  );

  /**
   * Save this deposition set as a workspace: original bytes (best-effort),
   * parsed pages, and the chunk index (BM25 + embeddings) so Ask can use the
   * hybrid retriever and the Library can reopen the set without re-reading.
   * Runs automatically once reading and OCR settle; retry reuses the request id.
   */
  const saveWorkspace = useCallback(async (): Promise<void> => {
    const transcripts = transcriptsRef.current;
    if (!transcripts.length) return;
    if (savedRef.current.loaded || savedRef.current.status === "ready") {
      await persistAnalysisNow(
        Object.values(passesRef.current).every((p) => p === "done" || p === "error"),
      );
      return;
    }
    if (saveAbort.current) return;
    const pendingItemId =
      savedRef.current.status === "queued" || savedRef.current.status === "embedding"
        ? savedRef.current.itemId
        : null;
    const controller = new AbortController();
    saveAbort.current = controller;
    let attempt = saveAttemptRef.current;
    if (!attempt) {
      attempt = { requestId: newId(), bytesKeyByFileId: {}, sha256ByFileId: {} };
      saveAttemptRef.current = attempt;
    }
    const name = depositionWorkspaceName(transcripts);
    setSaved({ status: "saving", name, message: null });
    step({
      id: "save",
      label: "Saving to your library",
      status: "running",
      detail: "transcripts, pages, index",
    });
    try {
      if (pendingItemId) {
        const progress = await getWorkspaceStatusFn({ data: { itemId: pendingItemId } });
        if (!progress) throw new Error("Saved workspace status is unavailable.");
        await refreshSaveStatus(progress, controller.signal);
        return;
      }
      const byFile = new Map<string, { page: number; text: string }[]>();
      for (const p of pagesRef.current) {
        if (!p.text.trim()) continue;
        const arr = byFile.get(p.fileId) ?? [];
        arr.push({ page: p.page, text: p.text });
        byFile.set(p.fileId, arr);
      }
      const files = await mapPool(transcripts, 3, async (t) => {
        const blob = filesRef.current.get(t.fileId);
        const fp = byFile.get(t.fileId) ?? [];
        let sha256 = attempt!.sha256ByFileId[t.fileId];
        if (blob && !sha256) {
          sha256 = await rawFileSha256(blob);
          attempt!.sha256ByFileId[t.fileId] = sha256;
        }
        let bytesKey: string | undefined = attempt!.bytesKeyByFileId[t.fileId];
        if (blob && !bytesKey) {
          bytesKey = await uploadOriginalBytes(
            { name: t.fileName, blob, ...(sha256 ? { sha256 } : {}) },
            controller.signal,
          );
          if (bytesKey) attempt!.bytesKeyByFileId[t.fileId] = bytesKey;
        }
        const totalChars = fp.reduce((total, page) => total + page.text.length, 0);
        // Transcripts are indexed from the text the reader shows (including OCR
        // repairs) so chunk cites line up with the transcript. Only oversize or
        // textless files fall back to the asynchronous lane over the original
        // bytes; reject unsavable sources explicitly instead of dropping a file.
        const plan = planSaveLane({
          readablePages: fp.length,
          totalChars,
          lowQuality: false,
          hasBytes: Boolean(bytesKey && sha256),
        });
        if (plan === "skip")
          throw new Error(
            `The transcript “${t.fileName}” could not be saved. Its readable text or original file is unavailable. Your analysis remains in this tab; download it before closing.`,
          );
        return {
          clientFileId: t.fileId,
          fileName: t.fileName,
          ...(blob?.type ? { mime: blob.type } : {}),
          ...(sha256 ? { sha256 } : {}),
          ...(blob ? { byteSize: blob.size } : {}),
          ...(bytesKey ? { bytesKey } : {}),
          pages: plan === "async" ? [] : fp,
        };
      });
      if (controller.signal.aborted) return;
      const submitted = files.filter((file): file is NonNullable<typeof file> => file !== null);
      if (!submitted.length) {
        throw new Error(
          "No transcript could be saved: no readable text and the original files are not in this session.",
        );
      }
      const payload = {
        requestId: attempt.requestId,
        name,
        surface: "deposition" as const,
        files: submitted,
      };
      const reservation = await saveWorkspaceFn({ data: { ...payload, prepareOnly: true } });
      if (controller.signal.aborted) return;
      setSaved({ itemId: reservation.itemId, kbWorkspaceId: reservation.kbWorkspaceId });
      const checkpoint = persistDirty.current;
      persistDirty.current = null;
      void persistAnalysisNow(checkpoint?.complete ?? false);
      // If transport times out after reservation, recover status rather than
      // treating the completed analysis as lost or creating another workspace.
      const res = await saveWorkspaceFn({ data: payload }).catch(async (error) => {
        if (controller.signal.aborted) throw error;
        const status = await getWorkspaceStatusFn({ data: { itemId: reservation.itemId } });
        if (!status) throw error;
        return { ...status, kbWorkspaceId: reservation.kbWorkspaceId };
      });
      if (controller.signal.aborted) return;
      setSaved({ itemId: res.itemId, kbWorkspaceId: res.kbWorkspaceId });
      // Preserve the analysis independently of index completion/failure.
      const pendingAnalysis = persistDirty.current as { complete: boolean } | null;
      persistDirty.current = null;
      void persistAnalysisNow(pendingAnalysis?.complete ?? false);
      await refreshSaveStatus(res, controller.signal);
    } catch (e) {
      if (controller.signal.aborted) return;
      const message = e instanceof Error ? e.message : "Save failed";
      if (message.includes("does not match its reservation")) saveAttemptRef.current = null;
      setSaved({ status: "error", message });
      step({ id: "save", label: "Saving to your library", status: "error", detail: message });
    } finally {
      if (saveAbort.current === controller) saveAbort.current = null;
    }
  }, [persistAnalysisNow, refreshSaveStatus, setSaved, step]);

  /** Remove the saved copy (bytes, pages, index, analysis) and clear this tab. */
  const deleteSaved = useCallback(async (): Promise<boolean> => {
    const itemId = savedRef.current.itemId;
    if (!itemId) {
      reset();
      return true;
    }
    saveAbort.current?.abort();
    analyzeAbort.current?.abort();
    clearPersistTimer();
    persistDirty.current = null;
    runRef.current = null;
    await persistInflight.current;
    setSaved({ status: "saving", message: "Deleting saved copy…" });
    try {
      await deleteWorkspaceFn({ data: { itemId } });
      reset();
      return true;
    } catch (e) {
      setSaved({
        status: "error",
        message: e instanceof Error ? e.message : "Could not delete the saved copy.",
      });
      return false;
    }
  }, [reset, setSaved]);

  // ---- Analysis -------------------------------------------------------------

  const analyze = useCallback(
    async (fresh = false) => {
      if (fresh) analysisCache.current.clear();
      if (ocrActive.current) return;
      const transcripts = transcriptsRef.current;
      if (!transcripts.length) {
        setState((s) => ({ ...s, phase: "error", error: "Drop deposition files first." }));
        return;
      }
      analyzeAbort.current?.abort();
      const controller = new AbortController();
      analyzeAbort.current = controller;
      clearPersistTimer();
      persistDirty.current = null;
      const run: AnalysisRun = { runId: newId(), startedAt: Date.now() };
      runRef.current = run;
      const focus = instructionsRef.current;
      analysisRef.current = { ...EMPTY_ANALYSIS, witnesses: seedWitnesses(transcripts) };
      passesRef.current = {
        case: "running",
        record: "running",
        connections: "running",
        cross: transcripts.length > 1 ? "idle" : "done",
      };
      setState((s) => ({
        ...s,
        phase: "analyzing",
        analysis: { ...analysisRef.current },
        error: null,
        passes: passesRef.current,
        analyzeProgress: { done: 0, total: 1 },
      }));

      type Packed = {
        hits: PileHit[];
        pages: { fileName: string; page: number; text: string; cite: string }[];
      };
      const packUnits = (units: ReturnType<typeof coverUnits>): Packed => {
        const hits: PileHit[] = units.map((b, i) => ({
          fileId: b.fileId,
          fileName: b.fileName,
          page: b.startPage,
          score: 1 / (i + 1),
          snippet: (b.question || b.answer).replace(/\s+/g, " ").slice(0, 220),
          cite: b.cite,
          startLine: b.startLine,
          endLine: b.endLine,
        }));
        const pages = units.map((b) => ({
          fileName: b.fileName,
          page: b.startPage,
          text:
            b.lines
              .map((l) => `${l.page}:${l.line} ${l.speakerLabel || l.speaker}. ${l.text}`)
              .join("\n") || `Q. ${b.question}\nA. ${b.answer}`,
          cite: b.cite,
        }));
        return { hits, pages };
      };

      const runPass = async (
        pass: DepPass | "cover" | "synth",
        list: DepTranscript[],
        hits: PileHit[],
        pages: Packed["pages"],
        mark = false,
      ) => {
        const key = await scanCacheKey([
          "dep-pass-v2",
          pass,
          focus,
          pages,
          list.map((t) => [t.fileId, t.witness, t.caption]),
        ]);
        const verified =
          analysisCache.current.get(key) ??
          (await retryScan(async () => {
            let raw = "";
            let completed = false;
            await streamSSE(
              "/api/pile/ask",
              {
                query:
                  pass === "cover"
                    ? focus
                      ? `Extract every trial-usable finding from this window. Focus: ${focus}`
                      : "Extract every trial-usable finding from this window of testimony."
                    : pass === "synth"
                      ? focus
                        ? `Synthesize the full record. Focus: ${focus}`
                        : "Synthesize the full covering analysis into one trial-usable record."
                      : focus
                        ? `${PASS_QUERY[pass]} Focus: ${focus}`
                        : PASS_QUERY[pass],
                mode: "analyze",
                pass,
                pages,
                hits,
                files: list.map((t) => ({
                  name: t.fileName,
                  pageCount: new Set(t.lines.map((line) => line.page)).size,
                })),
                instructions: focus || null,
                caption: list
                  .map((t) => t.caption)
                  .filter(Boolean)
                  .join("\n---\n")
                  .slice(0, 2000),
                citeReady: list.some((t) => t.citeReady),
                witness:
                  list
                    .map((t) => t.witness)
                    .filter(Boolean)
                    .join("; ") || list[0]?.witness,
              },
              (evt) => {
                const d = (evt.data ?? {}) as Record<string, unknown>;
                if (evt.event === "delta") raw += String(d["text"] ?? "");
                else if (evt.event === "done") completed = true;
                else if (evt.event === "error")
                  throw new HttpStatusError(
                    typeof d["status"] === "number" ? d["status"] : 502,
                    String(d["message"] ?? "Analysis failed"),
                  );
              },
              controller.signal,
            );
            controller.signal.throwIfAborted();
            if (!completed)
              throw new HttpStatusError(
                502,
                "Analysis stream ended before completing this section",
              );
            try {
              return verifyDepAnalysis(parseDepAnalysis(raw, true), list);
            } catch {
              throw new HttpStatusError(502, "Incomplete analysis output; retrying this section");
            }
          }, controller.signal));
        if (controller.signal.aborted || runRef.current !== run) return;
        if (analysisCache.current.size >= 2500)
          analysisCache.current.delete(analysisCache.current.keys().next().value!);
        analysisCache.current.set(key, verified);
        analysisRef.current = mergeDepAnalysis(analysisRef.current, verified);
        if (mark && pass !== "cover" && pass !== "synth")
          passesRef.current = { ...passesRef.current, [pass]: "done" };
        const passes = passesRef.current;
        setState((s) => ({
          ...s,
          analysis: analysisRef.current,
          role: analysisRef.current.role || s.role,
          passes,
        }));
        persistAnalysis(false);
        return verified;
      };

      const windows = transcripts.flatMap((t) =>
        batchEvidence(packUnits(coverUnits(t)).pages, 80_000, 16).map((pages) => ({
          t,
          pack: { hits: [], pages },
        })),
      );
      let extra = 1;
      if (!windows.length) {
        setState((s) => ({
          ...s,
          phase: "error",
          error: "No testimony blocks to analyze.",
          analyzeProgress: null,
        }));
        return;
      }
      let done = 0;
      const bump = () => {
        done += 1;
        setState((s) => ({ ...s, analyzeProgress: { done, total: windows.length + extra } }));
      };
      setState((s) => ({
        ...s,
        analyzeProgress: { done: 0, total: Math.max(1, windows.length + extra) },
      }));

      try {
        await mapPool(
          windows,
          ANALYZE_WINDOW_CONCURRENCY,
          async (w) => {
            await runPass("cover", [w.t], w.pack.hits, w.pack.pages);
            bump();
          },
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) {
          setState((s) =>
            s.phase === "analyzing" ? { ...s, phase: "ready", analyzeProgress: null } : s,
          );
          return;
        }
        setPasses({ case: "error", record: "error", connections: "error" });
        setState((s) => ({
          ...s,
          phase: "error",
          error: error instanceof Error ? error.message : "Analysis failed",
          analyzeProgress: null,
        }));
        persistAnalysis(true);
        return;
      }
      if (controller.signal.aborted) return;

      setPasses({ case: "running", record: "done", connections: "done" });
      try {
        const batches = depositionFindingBatches(analysisRef.current).map((batch) =>
          batch.map((p) => ({ ...p, cite: "" })),
        );
        // Compare each pair of evidence batches, so no late batch is silently excluded.
        const comparisons =
          transcripts.length > 1
            ? batches.flatMap((a, i) =>
                batches.slice(i).map((b, j) => (j === 0 ? a : [...a, ...b])),
              )
            : [];
        extra = batches.length + (batches.length > 1 ? 1 : 0) + comparisons.length;
        setState((s) => ({ ...s, analyzeProgress: { done, total: windows.length + extra } }));
        const syntheses = await mapPool(
          batches,
          2,
          async (pages) => {
            const result = await runPass("synth", transcripts, [], pages);
            bump();
            return result;
          },
          controller.signal,
        );
        if (batches.length > 1) {
          await runPass(
            "synth",
            transcripts,
            [],
            syntheses.flatMap((a, i) =>
              a?.summary
                ? [{ fileName: `Synthesis ${i + 1}`, page: i + 1, text: a.summary, cite: "" }]
                : [],
            ),
          );
          bump();
        }
        setPasses({ case: "done" });
        if (comparisons.length) {
          setPasses({ cross: "running" });
          await mapPool(
            comparisons,
            2,
            async (pages) => {
              await runPass("cross", transcripts, [], pages);
              bump();
            },
            controller.signal,
          );
          setPasses({ cross: "done" });
        }
      } catch (error) {
        if (controller.signal.aborted || runRef.current !== run) return;
        setPasses({
          ...(passesRef.current.case === "running" ? { case: "error" } : {}),
          ...(transcripts.length > 1 ? { cross: "error" } : {}),
        });
        setState((s) => ({
          ...s,
          error: `Covering results are retained. Synthesis or cross-review is incomplete: ${error instanceof Error ? error.message : "request failed"}`,
        }));
      }
      if (controller.signal.aborted || runRef.current !== run) return;

      if (!analysisRef.current.admissions.length && !analysisRef.current.summary) {
        setState((s) => ({
          ...s,
          phase: "error",
          error: "Analysis failed",
          analyzeProgress: null,
        }));
        return;
      }
      setState((s) => ({
        ...s,
        phase: "ready",
        analysis: analysisRef.current,
        analyzeProgress: null,
      }));
      persistAnalysis(true);
    },
    [persistAnalysis, setPasses],
  );

  // ---- Upload -> read -> OCR -> save -> analyze -------------------------------

  const start = useCallback(
    async (incoming: File[], instructions?: string) => {
      const files = incoming.filter((f) => transcriptFileKind(f) !== null);
      if (files.length > DEP_MAX_FILES) {
        setState((s) => ({
          ...s,
          error: `Choose up to ${DEP_MAX_FILES} deposition files per set. No files were processed.`,
        }));
        return;
      }
      if (new Set(files.map((f) => f.name.toLowerCase())).size !== files.length) {
        setState((s) => ({
          ...s,
          error:
            "Two transcripts have the same filename. Rename them before uploading so every citation has an unambiguous source.",
        }));
        return;
      }
      if (!files.length) {
        setState({ ...EMPTY, phase: "error", error: "Drop depositions as PDF, Word, or TXT." });
        return;
      }
      ingestAbort.current?.abort();
      askAbort.current?.abort();
      saveAbort.current?.abort();
      analyzeAbort.current?.abort();
      clearPersistTimer();
      persistDirty.current = null;
      const controller = new AbortController();
      ingestAbort.current = controller;
      filesRef.current = new Map();
      pdfFilesRef.current = new Map(
        files.filter((f) => transcriptFileKind(f) === "pdf").map((f) => [f.name, f]),
      );
      pagesRef.current = [];
      transcriptsRef.current = [];
      instructionsRef.current = instructions?.trim() || "";
      analysisRef.current = EMPTY_ANALYSIS;
      passesRef.current = IDLE_PASSES;
      savedRef.current = EMPTY_SAVED;
      saveAttemptRef.current = null;
      runRef.current = null;
      ocrActive.current = false;
      setState({
        ...EMPTY,
        phase: "reading",
        instructions: instructionsRef.current,
        files: files.map((f) => ({ name: f.name, pages: 0, empty: 0, done: 0, status: "reading" })),
      });
      step({ id: "read", label: "Reading files", status: "running" });

      const extracted: { file: File; res: Awaited<ReturnType<typeof extractFile>> }[] = new Array(
        files.length,
      );
      try {
        await mapPool(
          files,
          FILE_EXTRACT_CONCURRENCY,
          async (f, i) => {
            const res = await extractFile(
              f,
              (done, total) =>
                setState((s) => ({
                  ...s,
                  files: s.files.map((x, j) =>
                    j === i ? { ...x, done, pages: total, status: "reading" } : x,
                  ),
                })),
              controller.signal,
              {
                maxPages: DEP_MAX_PAGES,
                maxBytes: DEP_MAX_BYTES,
                layout: "transcript",
                requireComplete: true,
              },
            );
            extracted[i] = { file: f, res };
            setState((s) => ({
              ...s,
              files: s.files.map((x, j) =>
                j === i
                  ? {
                      name: f.name,
                      pages: res.pageCount,
                      empty: res.emptyPages,
                      done: res.pageCount,
                      status: "ready",
                    }
                  : x,
              ),
            }));
          },
          controller.signal,
        );
      } catch (e) {
        if (controller.signal.aborted) return;
        const msg = e instanceof Error ? e.message : "Could not read the files.";
        step({ id: "read", label: "Reading files", status: "error", detail: msg });
        setState((s) => ({ ...s, phase: "error", error: msg }));
        return;
      }

      if (controller.signal.aborted) return;
      const totalPages = extracted.reduce((count, item) => count + item.res.pageCount, 0);
      if (totalPages > DEP_MAX_PAGES) {
        const message = `This set has ${totalPages.toLocaleString()} pages. Split it into sets of at most ${DEP_MAX_PAGES.toLocaleString()} pages so no testimony is omitted.`;
        step({ id: "read", label: "Reading files", status: "error", detail: message });
        setState((s) => ({ ...s, phase: "error", error: message }));
        return;
      }
      const pages: PilePage[] = [];
      for (const item of extracted) {
        if (!item) continue;
        const fileId = newId();
        filesRef.current.set(fileId, item.file);
        for (const p of item.res.pages) {
          const text = (p.text ?? "").trim();
          pages.push({ fileId, fileName: item.res.name, page: p.page, text, ocr: false });
        }
      }
      pagesRef.current = pages;
      const pageTotal = pages.length;
      step({ id: "read", label: "Reading files", status: "done", detail: `${pageTotal} pages` });

      const publish = (list: DepTranscript[], ocr?: DepState["ocr"]) => {
        if (!list.length) return;
        const primary = list[0]!;
        const meta = extractCaptionMeta(list.map((t) => t.caption).join(" "));
        if (!analysisRef.current.witnesses.length) {
          analysisRef.current = { ...EMPTY_ANALYSIS, witnesses: seedWitnesses(list) };
        }
        setState((s) => ({
          ...s,
          phase: ocrActive.current
            ? "reading"
            : s.phase === "asking" || s.phase === "analyzing"
              ? s.phase
              : "ready",
          transcripts: list,
          activeFileId: s.activeFileId ?? primary.fileId,
          analysis: s.analysis ?? analysisRef.current,
          witness: list.length === 1 ? primary.witness : `${list.length} witnesses`,
          citeReady: list.some((t) => t.citeReady),
          pageCount: pageTotal,
          mdl: meta.mdl ?? s.mdl,
          taken: meta.taken ?? s.taken,
          ocr: ocr === undefined ? s.ocr : ocr,
        }));
      };

      let transcripts = rebuildTranscripts();
      if (!transcripts.length) {
        setState((s) => ({ ...s, phase: "error", error: "No readable pages in these files." }));
        return;
      }
      publish(transcripts);

      const ocrJobs: { file: File; name: string; page: number; score: number }[] = [];
      for (const item of extracted) {
        if (!item || transcriptFileKind(item.file) !== "pdf") continue;
        for (const p of item.res.pages) {
          if (
            pagesRef.current.some(
              (saved) => saved.fileName === item.res.name && saved.page === p.page,
            ) &&
            pageNeedsDepOcr(p.text)
          ) {
            ocrJobs.push({
              file: item.file,
              name: item.res.name,
              page: p.page,
              score: textQualityScore(p.text),
            });
          }
        }
      }
      ocrJobs.sort((a, b) => a.score - b.score);
      const ocrPick = ocrJobs.slice(0, OCR_PAGE_CAP);
      if (!ocrPick.length) {
        void analyze();
        // The transcript text is final; index and store it now.
        void saveWorkspace();
        return;
      }

      step({
        id: "ocr",
        label: "OCR on scanned / noisy pages (Nano VL)",
        status: "running",
        detail: `${ocrPick.length} pages`,
      });
      ocrActive.current = true;
      setState((s) => ({ ...s, phase: "reading", ocr: { done: 0, total: ocrPick.length } }));
      let ocrN = 0;
      try {
        const limiter = new AdaptiveLimiter(
          OCR_CONCURRENCY_MIN,
          OCR_CONCURRENCY,
          OCR_CONCURRENCY_MAX,
        );
        const byFile = new Map<string, number[]>();
        for (const job of ocrPick) {
          const cur = byFile.get(job.name) ?? [];
          cur.push(job.page);
          byFile.set(job.name, cur);
        }
        await mapPool(
          [...byFile.entries()],
          2,
          async ([fileName, pageNums]) => {
            const file = pdfFilesRef.current.get(fileName);
            if (!file) return;
            await forEachRenderedPdfPage(
              file,
              pageNums,
              async (page, imageBase64) => {
                await limiter.run(async () => {
                  const ocrRes = await json<{ text?: string }>(
                    "/api/pile/ocr",
                    {
                      method: "POST",
                      body: JSON.stringify({ imageBase64 }),
                      signal: controller.signal,
                    },
                    { tries: 1 },
                  );
                  if (ocrRes.text) {
                    const idx = pagesRef.current.findIndex(
                      (p) => p.fileName === fileName && p.page === page,
                    );
                    if (idx >= 0) {
                      const prev = pagesRef.current[idx]!;
                      pagesRef.current[idx] = { ...prev, text: ocrRes.text, ocr: true };
                    }
                    ocrN += 1;
                    if (ocrN % 8 === 0 || ocrN === ocrPick.length) {
                      transcripts = rebuildTranscripts();
                      publish(transcripts, { done: ocrN, total: ocrPick.length });
                    } else {
                      setState((s) => ({ ...s, ocr: { done: ocrN, total: ocrPick.length } }));
                    }
                  }
                }, controller.signal);
              },
              controller.signal,
            );
          },
          controller.signal,
        );
        step({
          id: "ocr",
          label: "OCR on scanned / noisy pages (Nano VL)",
          status: "done",
          detail: ocrN ? `${ocrN} page${ocrN === 1 ? "" : "s"} re-read` : "No OCR text returned",
        });
      } catch (e) {
        if (controller.signal.aborted) return;
        step({
          id: "ocr",
          label: "OCR on scanned / noisy pages (Nano VL)",
          status: "error",
          detail: e instanceof Error ? e.message : "OCR failed — using text layer",
        });
      }

      if (controller.signal.aborted) return;
      ocrActive.current = false;
      transcripts = rebuildTranscripts();
      publish(transcripts, null);
      void analyze();
      if (ocrN < ocrJobs.length) {
        setState((s) => ({
          ...s,
          error: `${ocrJobs.length - ocrN} pages still need OCR review. Analysis covers the readable text only.`,
        }));
      }
      // Save after OCR so the stored pages and chunks match what the reader shows.
      void saveWorkspace();
    },
    [analyze, rebuildTranscripts, saveWorkspace, step],
  );

  // ---- Reopen from the Library ------------------------------------------------

  const reloadWorkspace = useCallback(
    async (itemId: string) => {
      ingestAbort.current?.abort();
      analyzeAbort.current?.abort();
      askAbort.current?.abort();
      saveAbort.current?.abort();
      clearPersistTimer();
      persistDirty.current = null;
      filesRef.current = new Map();
      pdfFilesRef.current = new Map();
      pagesRef.current = [];
      transcriptsRef.current = [];
      analysisRef.current = EMPTY_ANALYSIS;
      passesRef.current = IDLE_PASSES;
      savedRef.current = EMPTY_SAVED;
      saveAttemptRef.current = null;
      runRef.current = null;
      setState({ ...EMPTY, phase: "reading" });
      step({ id: "read", label: "Opening saved deposition", status: "running" });
      try {
        const ws = await getWorkspaceFn({ data: { itemId } });
        if (!ws) throw new Error("Saved deposition was not found.");
        if (ws.surface !== "deposition") throw new Error("That workspace is not a deposition set.");
        const docs = [
          ...new Map(
            [...ws.docs, ...(ws.recoverableDocs ?? [])].map((doc) => [doc.docId, doc]),
          ).values(),
        ];
        if (!docs.length)
          throw new Error(
            "Transcript pages are not available yet. Indexing may still be in progress; try opening this set again shortly.",
          );
        const loaded = await mapPool(docs, 4, async (doc) => {
          const pg = await getWorkspacePagesFn({ data: { itemId, docId: doc.docId } });
          if (!pg?.length) throw new Error(`Stored pages are missing for ${doc.fileName}`);
          return {
            doc,
            pages: pg.map(
              (page): PilePage => ({
                fileId: doc.docId,
                fileName: doc.fileName,
                page: page.page,
                text: page.text,
                ocr: false,
              }),
            ),
          };
        });
        const pages = loaded.flatMap((entry) => entry.pages);
        if (!pages.length) throw new Error("Nothing to load in that deposition set.");
        pagesRef.current = pages;
        const transcripts = rebuildTranscripts();
        if (!transcripts.length) throw new Error("No readable pages in that deposition set.");
        const primary = transcripts[0]!;
        const meta = extractCaptionMeta(transcripts.map((t) => t.caption).join(" "));
        savedRef.current = {
          status: ws.status === "ready" ? "ready" : "error",
          itemId,
          kbWorkspaceId: ws.kbWorkspaceId,
          name: ws.name,
          docIdByFileId: Object.fromEntries(transcripts.map((t) => [t.fileId, t.fileId])),
          message:
            ws.status === "ready"
              ? null
              : "Stored transcripts and analysis are available. The search index is not ready; Ask will use the loaded text.",
          analysis: "idle",
          analysisError: null,
          analysisSavedAt: null,
          loaded: true,
          hybridAsk: ws.status === "ready",
        };
        step({
          id: "read",
          label: "Opened saved deposition",
          status: "done",
          detail: `${pages.length} pages`,
        });

        const record = await getWorkspaceAnalysisFn({ data: { itemId } });
        if (record) {
          analysisRef.current = record.analysis.witnesses.length
            ? verifyDepAnalysis(record.analysis, transcripts)
            : {
                ...verifyDepAnalysis(record.analysis, transcripts),
                witnesses: seedWitnesses(transcripts),
              };
          instructionsRef.current = record.instructions;
          runRef.current = { runId: record.runId, startedAt: record.runStartedAt };
          // A run interrupted by a refresh is shown as it was left; the user can Re-run.
          passesRef.current = Object.fromEntries(
            (Object.keys(record.passes) as DepPass[]).map((pass) => [
              pass,
              record.passes[pass] === "running" ? "error" : record.passes[pass],
            ]),
          ) as Record<DepPass, DepPassStatus>;
          savedRef.current = {
            ...savedRef.current,
            analysis: "saved",
            analysisSavedAt: record.savedAt,
            message: record.complete
              ? savedRef.current.message
              : "Analysis was interrupted before it finished. Re-run to complete it.",
          };
        } else {
          analysisRef.current = { ...EMPTY_ANALYSIS, witnesses: seedWitnesses(transcripts) };
        }
        setState({
          ...EMPTY,
          phase: "ready",
          files: loaded.map((entry) => ({
            name: entry.doc.fileName,
            pages: entry.pages.length,
            empty: 0,
            done: entry.pages.length,
            status: "ready",
          })),
          transcripts,
          activeFileId: primary.fileId,
          analysis: analysisRef.current,
          passes: passesRef.current,
          role: analysisRef.current.role,
          witness: transcripts.length === 1 ? primary.witness : `${transcripts.length} witnesses`,
          citeReady: transcripts.some((t) => t.citeReady),
          pageCount: pages.length,
          mdl: meta.mdl,
          taken: meta.taken,
          instructions: instructionsRef.current,
          saved: savedRef.current,
        });
        if (!record) void analyze();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Could not open the saved deposition.";
        step({ id: "read", label: "Opening saved deposition", status: "error", detail: msg });
        setState((s) => ({ ...s, phase: "error", error: msg }));
      }
    },
    [analyze, rebuildTranscripts, step],
  );

  // ---- Ask ------------------------------------------------------------------

  const ask = useCallback(
    async (query: string, opts: { scope?: DiscoveryScope; fileIds?: string[] } = {}) => {
      if (!pagesRef.current.length || !query.trim()) return;
      askAbort.current?.abort();
      const controller = new AbortController();
      askAbort.current = controller;
      setState((s) => ({
        ...s,
        phase: "asking",
        query,
        answer: "",
        hits: [],
        asking: true,
        scanCoverage: null,
        error: null,
      }));
      step({ id: "ask", label: "Retrieving testimony and drafting", status: "running" });

      const finish = () => {
        step({ id: "ask", label: "Retrieving testimony and drafting", status: "done" });
        setState((s) =>
          s.phase === "asking" ? { ...s, phase: "ready", asking: false } : { ...s, asking: false },
        );
      };
      const fail = (msg: string) => {
        step({
          id: "ask",
          label: "Retrieving testimony and drafting",
          status: "error",
          detail: msg,
        });
        setState((s) => ({
          ...s,
          phase: "error",
          error: msg,
          asking: false,
          scanCoverage: s.scanCoverage ? { ...s.scanCoverage, running: false } : null,
        }));
      };

      const askLocal = async () => {
        const scopedPages = pagesRef.current.filter(
          (p) => !opts.fileIds || opts.fileIds.includes(p.fileId),
        );
        const hits = packAskHits(scopedPages, query);
        const packed = pagesForClientHits(scopedPages, hits);
        let completed = false;
        await streamSSE(
          "/api/pile/ask",
          {
            query,
            mode: "ask",
            pages: packed.map((p) => {
              const hit = hits.find((h) => h.fileName === p.fileName && h.page === p.page);
              return {
                fileName: p.fileName,
                page: p.page,
                text: p.text,
                ocr: p.ocr,
                cite: hit?.cite,
              };
            }),
            hits,
            files: transcriptsRef.current
              .filter((t) => !opts.fileIds || opts.fileIds.includes(t.fileId))
              .map((t) => ({
                name: t.fileName,
                pageCount: new Set(t.lines.map((line) => line.page)).size,
              })),
            instructions: instructionsRef.current || null,
            citeReady: transcriptsRef.current.some((t) => t.citeReady),
          },
          (evt) => {
            const d = (evt.data ?? {}) as Record<string, unknown>;
            if (evt.event === "delta")
              setState((s) => ({ ...s, answer: s.answer + String(d["text"] ?? "") }));
            else if (evt.event === "done") completed = true;
            else if (evt.event === "retrieve" && d["status"] === "done") {
              const next = Array.isArray(d["hits"]) ? (d["hits"] as PileHit[]) : [];
              if (next.length) setState((s) => ({ ...s, hits: next }));
            } else if (evt.event === "error") {
              throw new Error(String(d["message"] ?? "Ask failed"));
            }
          },
          controller.signal,
        );
        if (!completed) throw new Error("The answer stream ended early. Retry your question.");
      };

      // Saved sets answer from the hybrid index (BM25 + embeddings + rerank) over
      // the stored chunks. Any failure before the first token falls back to the
      // in-tab retriever so Ask never dead-ends on a backend hiccup.
      const askSaved = async (): Promise<boolean> => {
        const saved = savedRef.current;
        if (saved.status !== "ready" || !saved.itemId || !saved.hybridAsk) return false;
        const transcripts = transcriptsRef.current.filter(
          (t) => !opts.fileIds || opts.fileIds.includes(t.fileId),
        );
        // Partial binding: RAG the transcripts that ARE indexed; if none are
        // ready yet, fall back to the in-tab retriever.
        const docIds = transcripts.map((t) => saved.docIdByFileId[t.fileId]).filter(Boolean);
        if (!docIds.length) return false;
        const outcome: { streamed: boolean; completed: boolean; softError: string | null } = {
          streamed: false,
          completed: false,
          softError: null,
        };
        try {
          await streamSavedWorkspaceAsk(
            {
              itemId: saved.itemId,
              query,
              docIds,
              instructions: instructionsRef.current || null,
            },
            (evt) => {
              const d = (evt.data ?? {}) as Record<string, unknown>;
              if (evt.event === "delta") {
                outcome.streamed = true;
                setState((s) => ({ ...s, answer: s.answer + String(d["text"] ?? "") }));
              } else if (evt.event === "done") outcome.completed = true;
              else if (evt.event === "retrieve" && d["status"] === "done") {
                const sources = Array.isArray(d["sources"]) ? (d["sources"] as KbAskSource[]) : [];
                const hits = kbSourcesToDepositionHits(
                  sources,
                  transcripts.map((t) => ({
                    fileId: t.fileId,
                    docId: saved.docIdByFileId[t.fileId]!,
                    fileName: t.fileName,
                    lines: t.lines,
                  })),
                );
                if (hits.length) setState((s) => ({ ...s, hits }));
              } else if (evt.event === "error") {
                outcome.softError = String(d["message"] ?? "Saved deposition Ask failed");
              }
            },
            controller.signal,
          );
        } catch (e) {
          if (controller.signal.aborted) throw e;
          if (outcome.streamed) throw e;
          return false;
        }
        if (outcome.softError && !outcome.streamed) return false;
        if (outcome.softError) throw new Error(outcome.softError);
        if (!outcome.completed) {
          if (outcome.streamed)
            throw new Error("The answer stream ended early. Retry your question.");
          return false;
        }
        return true;
      };

      try {
        // "auto" (the default) resolves here: a saved deposition set with a
        // hybrid index answers from the KB (adaptive RAG); otherwise the
        // in-browser full-text scan runs, unchanged. Explicit scopes override.
        const resolvedScope: DiscoveryScope =
          opts.scope === "full" || opts.scope === "relevant"
            ? opts.scope
            : savedRef.current.status === "ready" && savedRef.current.hybridAsk
              ? "relevant"
              : "full";
        if (resolvedScope === "full") {
          lastScan.current = { query, fileIds: opts.fileIds ? [...opts.fileIds] : undefined };
          const selected = transcriptsRef.current.filter(
            (t) => !opts.fileIds || opts.fileIds.includes(t.fileId),
          );
          if (!selected.length) throw new Error("Select at least one transcript");
          const result = await runDocumentScan({
            query,
            instructions: instructionsRef.current,
            pages: pagesRef.current,
            files: selected.map((t) => ({
              id: t.fileId,
              name: t.fileName,
              pageCount: new Set(
                pagesRef.current.filter((p) => p.fileId === t.fileId).map((p) => p.page),
              ).size,
            })),
            signal: controller.signal,
            cache: scanCache.current,
            onProgress: (scanCoverage) => {
              if (!controller.signal.aborted) setState((s) => ({ ...s, scanCoverage }));
            },
          });
          controller.signal.throwIfAborted();
          const hits = result.evidence.map((e) => {
            const matched = matchDepEvidence(
              { quote: e.quote, fileName: e.fileName, cite: "" },
              selected,
            );
            return {
              fileId: e.fileId,
              fileName: e.fileName,
              page: e.page,
              score: 1,
              snippet: e.quote,
              cite: matched?.cite || "",
            };
          });
          setState((s) => ({ ...s, answer: result.answer, hits, scanCoverage: result.coverage }));
          finish();
          return;
        }
        const answered = await askSaved();
        if (controller.signal.aborted) {
          setState((s) => ({ ...s, phase: "ready", asking: false }));
          return;
        }
        if (!answered) {
          step({
            id: "ask",
            label: "Retrieving testimony and drafting",
            status: "running",
            detail: "in-tab retrieval",
          });
          await askLocal();
        }
      } catch (e) {
        if (controller.signal.aborted) {
          setState((s) => ({ ...s, phase: "ready", asking: false }));
          return;
        }
        fail(e instanceof Error ? e.message : "Ask failed");
        return;
      }
      finish();
    },
    [step],
  );

  const exportMemo = useCallback(() => {
    const analysis = state.analysis;
    if (!analysis) return;
    const label = transcriptsRef.current.map((t) => t.witness || t.fileName).join(", ");
    const md = analysisToMarkdown(label || "Depositions", analysis);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "deposition-analysis.md";
    a.click();
    URL.revokeObjectURL(url);
  }, [state.analysis]);

  const active =
    state.transcripts.find((t) => t.fileId === state.activeFileId) ?? state.transcripts[0] ?? null;

  return {
    state,
    retryQueryScan: () => {
      const previous = lastScan.current;
      if (previous) void ask(previous.query, { scope: "full", fileIds: previous.fileIds });
    },
    cancelAsk: () => {
      askAbort.current?.abort();
      setState((s) => ({
        ...s,
        asking: false,
        phase: s.phase === "asking" ? "ready" : s.phase,
        scanCoverage: s.scanCoverage ? { ...s.scanCoverage, running: false } : null,
      }));
    },
    active,
    start,
    analyze,
    ask,
    reset,
    exportMemo,
    saveWorkspace,
    reloadWorkspace,
    deleteSaved,
    setSearch: (search: string) => setState((s) => ({ ...s, search })),
    setRegex: (regex: boolean) => setState((s) => ({ ...s, regex })),
    setSpeaker: (speaker: DepSpeakerFilter) => setState((s) => ({ ...s, speaker })),
    setQuery: (query: string) => setState((s) => ({ ...s, query })),
    setActiveFile: (fileId: string) =>
      setState((s) => ({ ...s, activeFileId: fileId, selectedCite: null })),
    selectCite: (cite: string | null, fileName?: string) => {
      const startCite = cite ? parseCiteStart(cite) : null;
      setState((s) => {
        let activeFileId = s.activeFileId;
        if (startCite) {
          const candidates = s.transcripts.filter(
            (t) =>
              (!fileName || t.fileName === fileName) &&
              t.lines.some((l) => l.page === startCite.page && l.line === startCite.line),
          );
          if (candidates.length !== 1)
            return {
              ...s,
              error:
                "This citation cannot be resolved to one transcript. Select its source from the evidence panel.",
            };
          activeFileId = candidates[0]!.fileId;
        }
        return {
          ...s,
          activeFileId,
          selectedCite: startCite ? `${startCite.page}:${startCite.line}` : cite,
        };
      });
    },
  };
}
