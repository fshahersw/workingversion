import { useCallback, useEffect, useRef, useState } from "react";
import {
  runDocumentScan,
  type DiscoveryScope,
  type ScanCoverage,
  type ScanWindowResult,
} from "@/lib/pile/discovery-scan";

import { extractFile, fileKind } from "@/lib/extract-text";
import { streamSSE } from "@/lib/orchestrate";
import { mapPool, withRetry } from "@/lib/pile/async";
import { PileClient } from "@/lib/pile/pile-client";
import { forEachRenderedPdfPage } from "@/lib/pile-render";
import { ocrPageImage } from "@/lib/pile/ocr-client";
import {
  ASK_MIN_HITS,
  FILE_EXTRACT_CONCURRENCY,
  MAX_FILES,
  MAX_PAGES,
  OCR_CONCURRENCY,
  OCR_EMPTY_CHARS,
  OCR_MAX_PER_FILE,
  OCR_PAGE_CAP,
  askBudget,
  perFileHits,
} from "@/lib/pile/limits";
import { isLowQualityText, pageNeedsOcr } from "@/lib/pile/text-quality";
import {
  pagesFromPack,
  verifyAnswerCites,
  type CitePage,
  type CiteReport,
} from "@/lib/pile/cite-trust";
import { pileJob, type PileJobId } from "@/lib/pile/jobs";
import {
  completeSavedWorkspace,
  selectedWorkspaceDocIds,
  withoutSavedWorkspace,
} from "@/lib/pile/kb-binding";
import {
  clearLocalPile,
  loadLocalPile,
  purgeLegacyPile,
  saveLocalPile,
} from "@/lib/pile/local-store";
import { useAuth } from "@/lib/use-auth";
import {
  saveWorkspaceFn,
  getWorkspaceFn,
  getWorkspacePagesFn,
  getWorkspaceStatusFn,
} from "@/lib/kb/workspace.functions";
import { abortableDelay, rawFileSha256 } from "@/lib/kb/client-upload";
import { planSaveLane } from "@/lib/kb/ingest-state";
import { streamSavedWorkspaceAsk, type KbAskSource } from "@/lib/kb/kb-client";
import { createUploadFn } from "@/lib/library/library.functions";
import {
  PILE_TTL_MS,
  type PileFile,
  type PileFileHits,
  type PileFilePack,
  type PileHit,
  type PilePage,
  type PileSession,
  type PileStructure,
} from "@/lib/pile/types";

export type PilePhase = "idle" | "reading" | "indexing" | "ready" | "asking" | "error";

export type PileStep = {
  id: string;
  label: string;
  detail?: string;
  status: "running" | "done" | "error";
};

export type PileFileState = {
  name: string;
  pages: number;
  empty: number;
  done: number;
  status: "reading" | "ready" | "error";
  error?: string;
};

export type AskTurn = {
  id: string;
  query: string;
  answer: string;
  citePages: CitePage[];
};

export type KbSaveState = {
  status: "idle" | "saving" | "queued" | "converting" | "embedding" | "saved" | "error";
  message?: string;
};

type PendingWorkspaceSave = {
  key: string;
  requestId: string;
  bytesKeyByFileId: Record<string, string>;
  sha256ByFileId: Record<string, string>;
  uploadByFileId: Map<string, Promise<string | undefined>>;
  submitted: boolean;
};

export type PileState = {
  phase: PilePhase;
  session: PileSession | null;
  files: PileFileState[];
  steps: PileStep[];
  hits: PileHit[];
  /** Same hits, grouped per document — every file reports, even with no match. */
  groups: PileFileHits[];
  answer: string;
  turns: AskTurn[];
  structure: PileStructure | null;
  error: string | null;
  query: string;
  searching: boolean;
  adding: boolean;
  /** Only the pages currently on screen — never the whole corpus. */
  pageTexts: Record<string, string>;
  selected: string | null;
  citeReport: CiteReport | null;
  citePages: CitePage[];
  hasPack: boolean;
  kbSave: KbSaveState;
  scanCoverage?: ScanCoverage | null;
};

const EMPTY: PileState = {
  phase: "idle",
  session: null,
  files: [],
  steps: [],
  hits: [],
  groups: [],
  answer: "",
  turns: [],
  structure: null,
  error: null,
  query: "",
  searching: false,
  adding: false,
  pageTexts: {},
  selected: null,
  citeReport: null,
  citePages: [],
  hasPack: false,
  kbSave: { status: "idle" },
};

export type AskOpts = {
  scope?: DiscoveryScope;
  followUp?: boolean;
  fileIds?: string[];
  job?: PileJobId | null;
};

function newId(): string {
  return crypto.randomUUID();
}

type Extracted = { file: File; res: Awaited<ReturnType<typeof extractFile>> };

function pagesFromExtracted(
  extracted: Extracted[],
  remainingPages: number,
  remainingFiles: number,
): {
  files: PileSession["files"];
  pages: PilePage[];
  sourceFiles: Map<string, File>;
} {
  const pages: PilePage[] = [];
  const sourceFiles = new Map<string, File>();
  let remaining = remainingPages;
  const files = extracted.slice(0, remainingFiles).map((x) => {
    const fileId = newId();
    sourceFiles.set(fileId, x.file);
    const take = x.res.pages.slice(0, Math.max(0, remaining));
    remaining -= take.length;
    let emptyPages = 0;
    for (const p of take) {
      const text = (p.text ?? "").trim();
      if (isLowQualityText(text)) emptyPages += 1;
      pages.push({ fileId, fileName: x.res.name, page: p.page, text, ocr: false });
    }
    return { id: fileId, name: x.res.name, pageCount: take.length, emptyPages, ocrPages: 0 };
  });
  return { files, pages, sourceFiles };
}

function buildLocalPile(
  extracted: Extracted[],
  instructions?: string,
): { session: PileSession; pages: PilePage[]; sourceFiles: Map<string, File> } {
  const now = Date.now();
  const { files, pages, sourceFiles } = pagesFromExtracted(extracted, MAX_PAGES, MAX_FILES);
  return {
    session: {
      id: `local-${newId()}`,
      createdAt: now,
      expiresAt: now + PILE_TTL_MS,
      matterLabel: null,
      instructions: instructions?.trim() || null,
      files,
      pageCount: pages.length,
      structure: null,
    },
    pages,
    sourceFiles,
  };
}

/**
 * Split the OCR budget fairly: every file gets an equal share of what is left,
 * capped per file, so the first PDF in the pile cannot starve the last one.
 */
function ocrBudgets(scanned: Map<string, number[]>, total: number): Map<string, number> {
  const out = new Map<string, number>();
  const names = [...scanned.keys()];
  let left = total;
  let round = 0;
  while (left > 0 && round < 1000) {
    let progressed = false;
    for (const name of names) {
      if (left <= 0) break;
      const want = scanned.get(name)?.length ?? 0;
      const have = out.get(name) ?? 0;
      if (have >= Math.min(want, OCR_MAX_PER_FILE)) continue;
      const grant = Math.min(64, Math.min(want, OCR_MAX_PER_FILE) - have, left);
      out.set(name, have + grant);
      left -= grant;
      progressed = true;
    }
    if (!progressed) break;
    round += 1;
  }
  return out;
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
        const ra = res.headers.get("retry-after");
        throw new Error(
          `HTTP ${res.status}: ${body.error || res.statusText}${ra ? ` retry-after=${ra}` : ""}`,
        );
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

async function rerankHits(
  query: string,
  hits: PileHit[],
  structure: PileStructure | null,
  k: number,
  signal?: AbortSignal,
): Promise<PileHit[]> {
  if (hits.length <= 4) return hits.slice(0, k);
  try {
    const res = await fetch("/api/pile/rerank", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, hits: hits.slice(0, 32), k, structure }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return hits.slice(0, k);
    const body = (await res.json()) as { hits?: PileHit[] };
    return Array.isArray(body.hits) && body.hits.length ? body.hits : hits.slice(0, k);
  } catch {
    return hits.slice(0, k);
  }
}

function filterGroups<T extends { fileId: string }>(groups: T[], fileIds?: string[]): T[] {
  if (!fileIds?.length) return groups;
  const allow = new Set(fileIds);
  return groups.filter((g) => allow.has(g.fileId));
}

function persistPile(owner: string | null, session: PileSession | null, pages: PilePage[]) {
  if (!owner || !session || !pages.length || typeof indexedDB === "undefined") return;
  void saveLocalPile(owner, session, pages).catch(() => undefined);
}

async function recoverScannedPages(args: {
  extracted: Extracted[];
  pages: PilePage[];
  session: PileSession;
  pile: PileClient;
  signal: AbortSignal;
  step: (s: PileStep) => void;
}): Promise<PileSession> {
  const scanned = new Map<string, number[]>();
  for (const item of args.extracted) {
    if (fileKind(item.file) !== "pdf") continue;
    const pages = item.res.pages
      .filter((p) => pageNeedsOcr(p.text, OCR_EMPTY_CHARS))
      .map((p) => p.page);
    if (pages.length) scanned.set(item.res.name, pages);
  }

  const scannedTotal = [...scanned.values()].reduce((n, p) => n + p.length, 0);
  if (!scannedTotal) return args.session;

  const label = "Reading scanned pages";
  const budgets = ocrBudgets(scanned, Math.min(scannedTotal, OCR_PAGE_CAP));
  const total = [...budgets.values()].reduce((n, v) => n + v, 0);
  const skipped = scannedTotal - total;
  let done = 0;
  let recovered = 0;
  let failed = 0;
  const tick = () =>
    args.step({
      id: "ocr",
      label,
      status: "running",
      detail: `${done} / ${total} converted${failed ? ` · ${failed} unreadable` : ""}`,
    });
  args.step({ id: "ocr", label, status: "running", detail: `0 / ${total} converted` });

  for (const item of args.extracted) {
    if (args.signal.aborted) return args.session;
    const pages = scanned.get(item.res.name);
    const budget = budgets.get(item.res.name) ?? 0;
    if (!pages || !budget || fileKind(item.file) !== "pdf") continue;
    const fileMeta = args.session.files.find((f) => f.name === item.res.name);
    await forEachRenderedPdfPage(
      item.file,
      pages.slice(0, budget),
      async (pageNum, imageBase64) => {
        let text = "";
        try {
          text = await withRetry(() => ocrPageImage(imageBase64, args.signal), {
            tries: 3,
            baseMs: 600,
            signal: args.signal,
          });
        } catch {
          failed += 1;
        }
        done += 1;
        const clean = text.trim();
        if (clean && fileMeta) {
          const idx = args.pages.findIndex((x) => x.fileId === fileMeta.id && x.page === pageNum);
          const prev = idx >= 0 ? args.pages[idx] : undefined;
          if (prev && clean.length > prev.text.length) {
            args.pages[idx] = { ...prev, text: clean, ocr: true };
            await args.pile.updatePageText(fileMeta.id, pageNum, clean);
            fileMeta.ocrPages += 1;
            fileMeta.emptyPages = Math.max(0, fileMeta.emptyPages - 1);
            recovered += 1;
          }
        }
        tick();
      },
      args.signal,
      OCR_CONCURRENCY,
    );
  }

  args.step({
    id: "ocr",
    label,
    status: "done",
    detail: [
      recovered
        ? `${recovered} page${recovered === 1 ? "" : "s"} recovered`
        : "No additional text recovered",
      failed ? `${failed} unreadable` : "",
      skipped ? `${skipped} over the ${OCR_PAGE_CAP}-page inline limit` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  });
  return { ...args.session, files: [...args.session.files] };
}

async function refreshStructure(
  pile: PileClient,
  sess: PileSession | null,
  step: (s: PileStep) => void,
  apply: (structure: PileStructure) => void,
): Promise<void> {
  if (!sess) return;
  const sample = await pile
    .structureSample(8)
    .catch(() => ({ pages: [] as { fileName: string; page: number; text: string }[] }));
  try {
    const structure = await json<PileStructure>("/api/pile/structure", {
      method: "POST",
      body: JSON.stringify({
        files: sess.files.map((f) => ({ name: f.name, pageCount: f.pageCount })),
        pages: sample.pages,
      }),
    });
    if (
      !structure ||
      !Array.isArray(structure.inventory) ||
      ![structure.parties, structure.dates, structure.issues].every(
        (items) => Array.isArray(items) && items.every((item) => typeof item === "string"),
      ) ||
      structure.inventory.some(
        (row) =>
          !row ||
          typeof row.file !== "string" ||
          typeof row.docType !== "string" ||
          !Number.isFinite(row.pages),
      )
    )
      throw new Error(
        "Document classification returned incomplete metadata; source documents remain available.",
      );
    apply(structure);
    step({ id: "structure", label: "Structure rail", status: "done" });
  } catch (e) {
    step({
      id: "structure",
      label: "Structure rail",
      status: "error",
      detail: e instanceof Error ? e.message : "skipped",
    });
  }
}

export function usePile() {
  const { user } = useAuth();
  const ownerRef = useRef<string | null>(null);
  ownerRef.current = user?.sub ?? null;
  // Original File blobs keyed by generated pile id, so duplicate filenames
  // cannot attach the wrong bytes to a saved workspace document.
  const filesByIdRef = useRef<Map<string, File>>(new Map());
  const [state, setState] = useState<PileState>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;
  const ingestAbort = useRef<AbortController | null>(null);
  const askAbort = useRef<AbortController | null>(null);
  const saveAbort = useRef<AbortController | null>(null);
  const pagesRef = useRef<PilePage[]>([]);
  const scanCache = useRef(new Map<string, ScanWindowResult>());
  const lastScan = useRef<{ query: string; opts: AskOpts } | null>(null);
  useEffect(() => {
    scanCache.current.clear();
  }, [user?.sub]);
  const sessionRef = useRef<PileSession | null>(null);
  const structureRef = useRef<PileStructure | null>(null);
  const pileRef = useRef<PileClient | null>(null);
  const lastPackRef = useRef<{
    packs: PileFilePack[];
    texts: Record<string, string>;
    hits: PileHit[];
    kbChunkIds?: number[];
    kbDocIds?: string[];
    citePages?: CitePage[];
  } | null>(null);
  const pendingWorkspaceSaveRef = useRef<PendingWorkspaceSave | null>(null);
  /** Increments whenever the local document/page snapshot changes. */
  const contentRevisionRef = useRef(0);

  const pile = useCallback((): PileClient => {
    if (!pileRef.current) pileRef.current = new PileClient();
    return pileRef.current;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const owner = user?.sub ?? null;
    void (async () => {
      if (typeof indexedDB === "undefined") return;
      void purgeLegacyPile().catch(() => undefined);
      if (!owner) return;
      const saved = await loadLocalPile(owner).catch(() => null);
      if (cancelled || !saved || pagesRef.current.length) return;
      pagesRef.current = saved.pages;
      sessionRef.current = saved.session;
      contentRevisionRef.current += 1;
      structureRef.current = saved.session.structure;
      await pile().clear();
      for (let i = 0; i < saved.pages.length; i += 500) {
        await pile().addPages(saved.pages.slice(i, i + 500));
        if (cancelled) return;
      }
      if (cancelled) return;
      setState({
        ...EMPTY,
        phase: "ready",
        session: saved.session,
        structure: saved.session.structure,
        files: saved.session.files.map((f) => ({
          name: f.name,
          pages: f.pageCount,
          empty: f.emptyPages,
          done: f.pageCount,
          status: "ready",
        })),
      });
    })();
    return () => {
      cancelled = true;
      saveAbort.current?.abort();
      pileRef.current?.dispose();
      pileRef.current = null;
    };
  }, [pile, user?.sub]);

  const step = useCallback((s: PileStep) => {
    setState((prev) => {
      const i = prev.steps.findIndex((x) => x.id === s.id);
      const steps =
        i === -1 ? [...prev.steps, s] : prev.steps.map((x, j) => (j === i ? { ...x, ...s } : x));
      return { ...prev, steps };
    });
  }, []);

  const reset = useCallback(() => {
    scanCache.current.clear();
    lastScan.current = null;
    ingestAbort.current?.abort();
    askAbort.current?.abort();
    saveAbort.current?.abort();
    ingestAbort.current = null;
    askAbort.current = null;
    saveAbort.current = null;
    pagesRef.current = [];
    sessionRef.current = null;
    contentRevisionRef.current += 1;
    structureRef.current = null;
    pileRef.current?.dispose();
    pileRef.current = null;
    lastPackRef.current = null;
    pendingWorkspaceSaveRef.current = null;
    filesByIdRef.current.clear();
    if (ownerRef.current) void clearLocalPile(ownerRef.current).catch(() => undefined);
    setState(EMPTY);
  }, []);

  const start = useCallback(
    async (incoming: File[], instructions?: string, opts?: { skipOcr?: boolean }) => {
      const files = incoming.filter((f) => fileKind(f) !== null).slice(0, MAX_FILES);
      if (!files.length) {
        setState({
          ...EMPTY,
          phase: "error",
          error: "Only PDF, Word, Excel, PowerPoint or TXT files are supported.",
        });
        return;
      }
      saveAbort.current?.abort();
      const controller = new AbortController();
      ingestAbort.current = controller;
      pagesRef.current = [];
      sessionRef.current = null;
      contentRevisionRef.current += 1;
      structureRef.current = null;
      pileRef.current?.dispose();
      pileRef.current = null;
      pendingWorkspaceSaveRef.current = null;
      filesByIdRef.current.clear();
      setState({
        ...EMPTY,
        phase: "reading",
        files: files.map((f) => ({ name: f.name, pages: 0, empty: 0, done: 0, status: "reading" })),
      });
      step({ id: "read", label: "Reading files", status: "running" });

      // Each file succeeds or fails on its own; one bad upload never kills the pile.
      const extracted: (Extracted | null)[] = new Array(files.length).fill(null);
      const failures: { name: string; error: string }[] = [];
      await mapPool(
        files,
        FILE_EXTRACT_CONCURRENCY,
        async (f, i) => {
          try {
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
          } catch (e) {
            if (controller.signal.aborted) throw e;
            const msg = e instanceof Error ? e.message : "Could not read the file.";
            failures.push({ name: f.name, error: msg });
            setState((s) => ({
              ...s,
              files: s.files.map((x, j) => (j === i ? { ...x, status: "error", error: msg } : x)),
            }));
          }
        },
        controller.signal,
      ).catch(() => undefined);
      if (controller.signal.aborted) return;

      const ok = extracted.filter((x): x is Extracted => !!x);
      if (!ok.length) {
        const msg = failures[0]?.error ?? "None of these files could be read.";
        step({ id: "read", label: "Reading files", status: "error", detail: msg });
        setState((s) => ({ ...s, phase: "error", error: msg }));
        return;
      }
      const pageTotal = ok.reduce((n, x) => n + x.res.pageCount, 0);
      const overBudget = Math.max(0, pageTotal - MAX_PAGES);
      step({
        id: "read",
        label: "Reading files",
        status: failures.length ? "error" : "done",
        detail: [
          `${Math.min(pageTotal, MAX_PAGES)} pages from ${ok.length} file${ok.length === 1 ? "" : "s"} — kept in this tab only`,
          overBudget ? `${overBudget} pages over the ${MAX_PAGES}-page session budget` : "",
          failures.length
            ? `${failures.length} file${failures.length === 1 ? "" : "s"} skipped`
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });

      setState((s) => ({ ...s, phase: "indexing" }));
      step({ id: "index", label: "Indexing the pile", status: "running" });
      const built = buildLocalPile(ok, instructions);
      pagesRef.current = built.pages;
      sessionRef.current = built.session;
      filesByIdRef.current = built.sourceFiles;
      await pile().clear();
      // Feed the worker in slices so the index is usable while the tail is still loading.
      for (let i = 0; i < built.pages.length; i += 500) {
        await pile().addPages(built.pages.slice(i, i + 500));
        if (controller.signal.aborted) return;
      }
      step({
        id: "index",
        label: "Indexing the pile",
        status: "done",
        detail: `${built.pages.length} pages indexed off the main thread — nothing is saved to the server`,
      });
      setState((s) => ({ ...s, session: built.session, phase: "ready" }));
      persistPile(ownerRef.current, built.session, pagesRef.current);
      step({ id: "structure", label: "Structure rail", status: "running" });

      // On-device OCR of scanned pages, skipped when the caller routes OCR to
      // the server (BDA) so the capped inline OCR never runs redundantly.
      if (!opts?.skipOcr) {
        try {
          const next = await recoverScannedPages({
            extracted: ok,
            pages: pagesRef.current,
            session: built.session,
            pile: pile(),
            signal: controller.signal,
            step,
          });
          contentRevisionRef.current += 1;
          sessionRef.current = next;
          persistPile(ownerRef.current, next, pagesRef.current);
          setState((s) => ({ ...s, session: next }));
        } catch (e) {
          if (controller.signal.aborted) return;
          step({
            id: "ocr",
            label: "Reading scanned pages",
            status: "error",
            detail: e instanceof Error ? e.message : "Scanned pages could not be converted",
          });
        }
      }

      void refreshStructure(pile(), sessionRef.current, step, (structure) => {
        structureRef.current = structure;
        if (sessionRef.current) sessionRef.current = { ...sessionRef.current, structure };
        persistPile(ownerRef.current, sessionRef.current, pagesRef.current);
        setState((s) => ({ ...s, structure, session: sessionRef.current }));
      });
    },
    [pile, step],
  );

  const addFiles = useCallback(
    async (incoming: File[], opts?: { skipOcr?: boolean }) => {
      const sess = sessionRef.current;
      if (!sess || !pagesRef.current.length) {
        await start(incoming, undefined, opts);
        return;
      }

      const have = new Set(sess.files.map((f) => f.name.toLowerCase()));
      const unique = incoming.filter(
        (f) => fileKind(f) !== null && !have.has(f.name.toLowerCase()),
      );
      const slots = Math.max(0, MAX_FILES - sess.files.length);
      const files = unique.slice(0, slots);
      if (!files.length) {
        setState((s) => ({
          ...s,
          error: unique.length
            ? `Working set is at the ${MAX_FILES}-file limit.`
            : "Those files are already in this working set.",
        }));
        return;
      }

      saveAbort.current?.abort();
      const controller = new AbortController();
      ingestAbort.current = controller;
      setState((s) => ({
        ...s,
        adding: true,
        error: null,
        files: [
          ...s.files,
          ...files.map((f) => ({
            name: f.name,
            pages: 0,
            empty: 0,
            done: 0,
            status: "reading" as const,
          })),
        ],
      }));
      step({
        id: "add",
        label: `Adding ${files.length} file${files.length === 1 ? "" : "s"}`,
        status: "running",
      });

      const extracted: (Extracted | null)[] = new Array(files.length).fill(null);
      const offset = sess.files.length;
      await mapPool(
        files,
        FILE_EXTRACT_CONCURRENCY,
        async (f, i) => {
          try {
            const res = await extractFile(
              f,
              (done, total) =>
                setState((s) => ({
                  ...s,
                  files: s.files.map((x, j) =>
                    j === offset + i ? { ...x, done, pages: total, status: "reading" } : x,
                  ),
                })),
              controller.signal,
            );
            extracted[i] = { file: f, res };
            setState((s) => ({
              ...s,
              files: s.files.map((x, j) =>
                j === offset + i
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
          } catch (e) {
            if (controller.signal.aborted) throw e;
            const msg = e instanceof Error ? e.message : "Could not read the file.";
            setState((s) => ({
              ...s,
              files: s.files.map((x, j) =>
                j === offset + i ? { ...x, status: "error", error: msg } : x,
              ),
            }));
          }
        },
        controller.signal,
      ).catch(() => undefined);
      if (controller.signal.aborted) return;

      const ok = extracted.filter((x): x is Extracted => !!x);
      if (!ok.length) {
        step({
          id: "add",
          label: "Adding files",
          status: "error",
          detail: "None of the new files could be read.",
        });
        setState((s) => ({ ...s, adding: false }));
        return;
      }

      const room = Math.max(0, MAX_PAGES - pagesRef.current.length);
      const appended = pagesFromExtracted(ok, room, slots);
      pagesRef.current = [...pagesRef.current, ...appended.pages];
      contentRevisionRef.current += 1;
      for (const [fileId, source] of appended.sourceFiles) {
        filesByIdRef.current.set(fileId, source);
      }
      const nextSession: PileSession = {
        ...withoutSavedWorkspace(sess),
        files: [...sess.files, ...appended.files],
        pageCount: pagesRef.current.length,
        structure: null,
      };
      sessionRef.current = nextSession;
      for (let i = 0; i < appended.pages.length; i += 500) {
        await pile().addPages(appended.pages.slice(i, i + 500));
        if (controller.signal.aborted) return;
      }
      setState((s) => ({
        ...s,
        session: nextSession,
        adding: false,
        structure: null,
        kbSave: { status: "idle" },
      }));
      persistPile(ownerRef.current, nextSession, pagesRef.current);
      step({
        id: "add",
        label: `Added ${appended.files.length} file${appended.files.length === 1 ? "" : "s"}`,
        status: "done",
        detail: `${appended.pages.length} pages · kept on this device`,
      });

      // On-device OCR of scanned pages, skipped when the caller routes OCR to
      // the server (BDA) so the capped inline OCR never runs redundantly.
      if (!opts?.skipOcr) {
        try {
          const afterOcr = await recoverScannedPages({
            extracted: ok,
            pages: pagesRef.current,
            session: nextSession,
            pile: pile(),
            signal: controller.signal,
            step,
          });
          contentRevisionRef.current += 1;
          sessionRef.current = afterOcr;
          persistPile(ownerRef.current, afterOcr, pagesRef.current);
          setState((s) => ({ ...s, session: afterOcr }));
        } catch (e) {
          if (controller.signal.aborted) return;
          step({
            id: "ocr",
            label: "Reading scanned pages",
            status: "error",
            detail: e instanceof Error ? e.message : "Scanned pages could not be converted",
          });
        }
      }

      step({ id: "structure", label: "Structure rail", status: "running" });
      void refreshStructure(pile(), sessionRef.current, step, (structure) => {
        structureRef.current = structure;
        if (sessionRef.current) sessionRef.current = { ...sessionRef.current, structure };
        persistPile(ownerRef.current, sessionRef.current, pagesRef.current);
        setState((s) => ({ ...s, structure, session: sessionRef.current }));
      });
    },
    [pile, start, step],
  );

  const loadPage = useCallback(
    async (fileId: string, page: number) => {
      try {
        const { texts } = await pile().textsFor([{ fileId, page }]);
        setState((s) => ({ ...s, pageTexts: { ...s.pageTexts, ...texts } }));
      } catch {
        /* reader stays on the empty-page state */
      }
    },
    [pile],
  );

  const ingestPages = useCallback(
    async (files: PileFile[], pages: PilePage[]) => {
      if (!pages.length) return;
      const have = new Set((sessionRef.current?.files ?? []).map((f) => f.name.toLowerCase()));
      const newFiles = files.filter((f) => !have.has(f.name.toLowerCase()));
      const havePage = new Set(pagesRef.current.map((p) => `${p.fileId}:${p.page}`));
      const newPages = pages.filter((p) => !havePage.has(`${p.fileId}:${p.page}`));
      if (!newFiles.length && !newPages.length) return;
      saveAbort.current?.abort();
      await pile().addPages(newPages.length ? newPages : pages);
      pagesRef.current = [...pagesRef.current, ...newPages];
      contentRevisionRef.current += 1;
      const now = Date.now();
      const sess = sessionRef.current ?? {
        id: `local-${newId()}`,
        createdAt: now,
        expiresAt: now + PILE_TTL_MS,
        matterLabel: null,
        instructions: null,
        files: [],
        pageCount: 0,
        structure: null,
      };
      const next: PileSession = {
        ...withoutSavedWorkspace(sess),
        files: [...sess.files, ...newFiles],
        pageCount: pagesRef.current.length,
      };
      sessionRef.current = next;
      persistPile(ownerRef.current, next, pagesRef.current);
      setState((s) => ({
        ...s,
        session: next,
        phase: s.phase === "idle" ? "ready" : s.phase,
        kbSave: { status: "idle" },
        files: [
          ...s.files,
          ...newFiles.map((f) => ({
            name: f.name,
            pages: f.pageCount,
            empty: f.emptyPages,
            done: f.pageCount,
            status: "ready" as const,
          })),
        ],
      }));
    },
    [pile],
  );

  const search = useCallback(
    async (query: string, opts: { fileIds?: string[] } = {}) => {
      if (!pagesRef.current.length || !query.trim()) return;
      setState((s) => ({ ...s, query, searching: true, error: null }));
      try {
        const { groups, texts } = await pile().searchByFile(
          query,
          perFileHits(sessionRef.current?.files.length ?? 1),
          structureRef.current,
        );
        let visible = filterGroups(groups, opts.fileIds);
        const flat = visible.flatMap((g) => g.hits);
        const ranked = await rerankHits(
          query,
          flat,
          structureRef.current,
          Math.min(24, Math.max(8, flat.length)),
        );
        const rank = new Map(ranked.map((h, i) => [`${h.fileId}:${h.page}`, i]));
        visible = [...visible].sort(
          (a, b) =>
            (rank.get(`${a.hits[0]?.fileId}:${a.hits[0]?.page}`) ?? 999) -
            (rank.get(`${b.hits[0]?.fileId}:${b.hits[0]?.page}`) ?? 999),
        );
        const hits = ranked.length ? ranked : visible.flatMap((g) => g.hits);
        setState((s) => ({
          ...s,
          hits,
          groups: visible,
          pageTexts: { ...s.pageTexts, ...texts },
          searching: false,
        }));
      } catch (e) {
        setState((s) => ({
          ...s,
          searching: false,
          error: e instanceof Error ? e.message : "Search failed",
        }));
      }
    },
    [pile],
  );

  const ask = useCallback(
    async (query: string, opts: AskOpts = {}) => {
      const job = pileJob(opts.job);
      const q = (job?.query ?? query).trim();
      if (!pagesRef.current.length || !q) return;
      const prev = stateRef.current;
      askAbort.current?.abort();
      const controller = new AbortController();
      askAbort.current = controller;
      setState((s) => ({
        ...s,
        phase: "asking",
        query: q,
        answer: "",
        error: null,
        citeReport: null,
        scanCoverage: null,
        turns:
          s.answer.trim() && s.query.trim()
            ? [
                ...s.turns,
                {
                  id: newId(),
                  query: s.query,
                  answer: s.answer,
                  citePages: s.citePages,
                },
              ]
            : s.turns,
      }));
      step({ id: "ask", label: "Retrieving pages and drafting", status: "running" });
      try {
        const sess = sessionRef.current;
        // "auto" (the default) resolves here: a saved/indexed set answers from the
        // KB (adaptive RAG); an unsaved pile keeps the in-browser full-text scan,
        // byte-for-byte unchanged. Explicit "full"/"relevant" still override.
        // Full-text scan is retired: uploads auto-save + index, so Ask is
        // RAG-only. The in-browser scan stays behind this flag as a dormant
        // emergency fallback (off), to be deleted once auto-index is proven.
        const FULL_TEXT_SCAN_ENABLED = false;
        const resolvedScope: DiscoveryScope =
          opts.scope === "full" || opts.scope === "relevant"
            ? opts.scope
            : completeSavedWorkspace(sess)
              ? "relevant"
              : "full";
        if (resolvedScope === "full") {
          if (!FULL_TEXT_SCAN_ENABLED) {
            // No indexed documents yet -> the set is still processing. Never
            // fall back to scanning every page.
            throw new Error(
              "These documents are still indexing — Ask will be ready in a moment. Uploads now index automatically for retrieval.",
            );
          }
          lastScan.current = {
            query: q,
            opts: { ...opts, fileIds: opts.fileIds ? [...opts.fileIds] : undefined },
          };
          const selectedFiles = (sess?.files ?? []).filter(
            (file) => !opts.fileIds || opts.fileIds.includes(file.id),
          );
          if (!selectedFiles.length) throw new Error("Select at least one document to scan");
          lastPackRef.current = null;
          const result = await runDocumentScan({
            query: q,
            instructions: [sess?.instructions, job?.instructions].filter(Boolean).join("\n\n"),
            pages: pagesRef.current,
            files: selectedFiles,
            signal: controller.signal,
            cache: scanCache.current,
            onProgress: (scanCoverage) => {
              if (!controller.signal.aborted) setState((s) => ({ ...s, scanCoverage }));
            },
          });
          controller.signal.throwIfAborted();
          const sourcePages = new Map(pagesRef.current.map((p) => [`${p.fileId}:${p.page}`, p]));
          const citePages: CitePage[] = result.evidence.map((e) => ({
            ref: e.ref,
            fileId: e.fileId,
            fileName: e.fileName,
            page: e.page,
            text: sourcePages.get(`${e.fileId}:${e.page}`)?.text ?? e.quote,
            ocr: sourcePages.get(`${e.fileId}:${e.page}`)?.ocr ?? false,
          }));
          const hits: PileHit[] = result.evidence.map((e) => ({
            fileId: e.fileId,
            fileName: e.fileName,
            page: e.page,
            score: 1,
            snippet: e.quote,
          }));
          const groups = selectedFiles.map((f) => ({
            fileId: f.id,
            fileName: f.name,
            pageCount: f.pageCount,
            matched: hits.some((h) => h.fileId === f.id),
            topScore: 1,
            hits: hits.filter((h) => h.fileId === f.id),
          }));
          setState((s) => ({
            ...s,
            answer: result.answer,
            phase: "ready",
            scanCoverage: result.coverage,
            citePages,
            hits,
            groups,
            hasPack: false,
            citeReport: {
              ...verifyAnswerCites(result.answer, citePages),
              cites: result.evidence.map((e) => ({
                ref: e.ref,
                fileId: e.fileId,
                fileName: e.fileName,
                page: e.page,
                label: `${e.fileName} p. ${e.page}`,
                quote: e.quote,
                match: "normalized" as const,
                ocr: sourcePages.get(`${e.fileId}:${e.page}`)?.ocr ?? false,
                garbled: false,
              })),
              verified: result.evidence.length,
              unverified: 0,
              pagesRead: result.coverage.files.reduce((sum, file) => sum + file.readPages, 0),
              filesRead: result.coverage.files.filter((file) => file.readPages > 0).length,
              filesTotal: selectedFiles.length,
            },
            pageTexts: Object.fromEntries(citePages.map((p) => [`${p.fileId}:${p.page}`, p.text])),
          }));
          step({ id: "ask", label: "Full text scan finished", status: "done" });
          return;
        }
        const fileCount = sess?.files.length ?? 0;
        const budget = askBudget(Math.max(fileCount, 1));

        const binding = completeSavedWorkspace(sess);
        const kbDocIds = sess ? selectedWorkspaceDocIds(sess, opts.fileIds) : null;
        if (sess && binding && kbDocIds) {
          let kbDeltaStarted = false;
          let kbDone = false;
          let kbError: { message: string; status: number; recoverable: boolean } | undefined;
          let kbCitePages: CitePage[] = [];
          const selectedDocSet = new Set(kbDocIds);
          const reusableChunks =
            opts.followUp && lastPackRef.current?.kbChunkIds && lastPackRef.current.kbDocIds
              ? lastPackRef.current.kbChunkIds.filter((_chunkId, index) =>
                  selectedDocSet.has(lastPackRef.current!.kbDocIds![index]!),
                )
              : [];
          if (reusableChunks.length) {
            step({ id: "ask", label: "Follow-up on the same saved passages", status: "running" });
          }
          const instructions = [sess.instructions, job?.instructions].filter(Boolean).join("\n\n");
          await streamSavedWorkspaceAsk(
            {
              itemId: binding.itemId,
              query: q,
              docIds: kbDocIds,
              ...(reusableChunks.length ? { sourceChunkIds: reusableChunks } : {}),
              ...(instructions ? { instructions } : {}),
              ...(opts.followUp && prev.query && prev.answer
                ? {
                    prior: {
                      query: prev.query,
                      answer: prev.answer.replace(/\[S\d+\]/g, ""),
                    },
                  }
                : {}),
            },
            (evt) => {
              const data = (evt.data ?? {}) as Record<string, unknown>;
              if (evt.event === "delta") {
                kbDeltaStarted = true;
                setState((state) => ({
                  ...state,
                  answer: state.answer + String(data["text"] ?? ""),
                }));
                return;
              }
              if (evt.event === "retrieve" && data["status"] === "done") {
                const rawSources = Array.isArray(data["sources"])
                  ? (data["sources"] as KbAskSource[])
                  : [];
                const fileIdByDocId = new Map(
                  Object.entries(binding.docIdByFileId).map(([fileId, docId]) => [docId, fileId]),
                );
                const sources = rawSources.filter(
                  (source) =>
                    source &&
                    Number.isSafeInteger(source.chunkId) &&
                    fileIdByDocId.has(source.docId) &&
                    typeof source.text === "string",
                );
                kbCitePages = sources.map((source) => ({
                  ref: source.ref,
                  fileId: fileIdByDocId.get(source.docId)!,
                  fileName: source.fileName,
                  page: source.page,
                  text: source.text,
                  garbled: (source.conf ?? 1) < 0.5,
                }));
                const kbHits: PileHit[] = sources.map((source) => ({
                  fileId: fileIdByDocId.get(source.docId)!,
                  fileName: source.fileName,
                  page: source.page,
                  score: source.score,
                  snippet: source.text.slice(0, 700),
                  garbled: (source.conf ?? 1) < 0.5,
                }));
                const pagesByFile = new Map<string, PilePage[]>();
                const hitsByFile = new Map<string, PileHit[]>();
                const texts: Record<string, string> = {};
                for (let index = 0; index < sources.length; index++) {
                  const source = sources[index]!;
                  const fileId = fileIdByDocId.get(source.docId)!;
                  const page: PilePage = {
                    fileId,
                    fileName: source.fileName,
                    page: source.page,
                    text: source.text,
                    ocr: false,
                  };
                  pagesByFile.set(fileId, [...(pagesByFile.get(fileId) ?? []), page]);
                  hitsByFile.set(fileId, [...(hitsByFile.get(fileId) ?? []), kbHits[index]!]);
                  texts[`${fileId}:${source.page}`] = source.text;
                }
                const selectedFiles = sess.files.filter((file) =>
                  selectedDocSet.has(binding.docIdByFileId[file.id]!),
                );
                const kbPacks: PileFilePack[] = selectedFiles.map((file) => {
                  const fileHits = hitsByFile.get(file.id) ?? [];
                  return {
                    fileId: file.id,
                    fileName: file.name,
                    pageCount: file.pageCount,
                    matched: fileHits.length > 0,
                    topScore: fileHits.reduce((best, hit) => Math.max(best, hit.score), 0),
                    hits: fileHits,
                    pages: pagesByFile.get(file.id) ?? [],
                  };
                });
                lastPackRef.current = {
                  packs: kbPacks,
                  texts,
                  hits: kbHits,
                  kbChunkIds: sources.map((source) => source.chunkId),
                  kbDocIds: sources.map((source) => source.docId),
                  citePages: kbCitePages,
                };
                setState((state) => ({
                  ...state,
                  hits: kbHits,
                  groups: kbPacks,
                  pageTexts: { ...state.pageTexts, ...texts },
                  citePages: kbCitePages,
                  hasPack: true,
                }));
                return;
              }
              if (evt.event === "fanout") {
                const list = Array.isArray(data["files"]) ? data["files"] : [];
                const total = Number(data["total"]) || list.length;
                const pagesRead = Number(data["pages"]) || 0;
                step({
                  id: "fanout",
                  label:
                    total > list.length
                      ? `Reading ${list.length} of ${total} documents (${pagesRead} passages)`
                      : `Reading ${list.length} document${list.length === 1 ? "" : "s"} in parallel (${pagesRead} passages)`,
                  status: "running",
                });
                return;
              }
              if (evt.event === "file_read") {
                const name = String(data["fileName"] ?? "document");
                const status = String(data["status"] ?? "running");
                step({
                  id: `file-${String(data["fileId"] ?? name)}`,
                  label: name,
                  status: status === "error" ? "error" : status === "done" ? "done" : "running",
                  detail:
                    status === "done"
                      ? data["matched"]
                        ? "Digest ready"
                        : "Does not address the question"
                      : status === "error"
                        ? String(data["detail"] ?? "read failed")
                        : "Reading this file on its own",
                });
                return;
              }
              if (evt.event === "writer_start" && kbDocIds.length > 1) {
                step({ id: "fanout", label: "Per-document read", status: "done" });
                step({
                  id: "synthesis",
                  label: "Cross-analyzing the documents",
                  status: "running",
                });
                return;
              }
              if (evt.event === "error") {
                const message = String(data["message"] ?? "Saved workspace Ask failed");
                const match = message.match(/HTTP\s+(\d{3})/i);
                const status = Number(data["status"]) || Number(match?.[1]) || 500;
                kbError = {
                  message,
                  status,
                  recoverable: data["recoverable"] === true || status >= 500,
                };
                return;
              }
              if (evt.event === "done") {
                kbDone = true;
                if (kbDocIds.length > 1) {
                  step({
                    id: "synthesis",
                    label: "Cross-analyzing the documents",
                    status: "done",
                  });
                }
                step({
                  id: "ask",
                  label: "Retrieving saved passages and drafting",
                  status: "done",
                });
                setState((state) => {
                  const report = verifyAnswerCites(state.answer, kbCitePages);
                  return {
                    ...state,
                    phase: "ready",
                    citeReport: {
                      ...report,
                      filesTotal: sess.files.length,
                    },
                  };
                });
              }
            },
            controller.signal,
          );
          if (kbDone) return;
          const failure = kbError ?? {
            message: "Saved workspace Ask ended before completion.",
            status: 500,
            recoverable: true,
          };
          if (!kbDeltaStarted && failure.recoverable) {
            lastPackRef.current = null;
            step({
              id: "ask",
              label: "Saved retrieval unavailable; using the local index",
              status: "running",
              detail: failure.message,
            });
            setState((state) => ({
              ...state,
              answer: "",
              error: null,
              citePages: [],
              citeReport: null,
            }));
          } else {
            step({
              id: "ask",
              label: "Retrieving saved passages and drafting",
              status: "error",
              detail: failure.message,
            });
            setState((state) => ({
              ...state,
              phase: "error",
              error: failure.message,
            }));
            return;
          }
        }

        let packs: PileFilePack[] = [];
        let texts: Record<string, string> = {};
        let hits: PileHit[] = [];

        if (opts.followUp && lastPackRef.current) {
          packs = filterGroups(lastPackRef.current.packs, opts.fileIds);
          texts = lastPackRef.current.texts;
          hits = lastPackRef.current.hits.filter(
            (h) => !opts.fileIds?.length || opts.fileIds.includes(h.fileId),
          );
          step({ id: "ask", label: "Follow-up on the same pages", status: "running" });
        } else {
          const packed = await pile().packAskByFile(
            q,
            structureRef.current,
            fileCount > 1 ? budget.perFilePages : Math.max(budget.perFilePages, ASK_MIN_HITS),
          );
          packs = filterGroups(
            packed.groups.filter((g) => g.pages.length),
            opts.fileIds,
          );
          texts = packed.texts;
          const flat = packs.flatMap((g) => g.hits);
          hits = await rerankHits(
            q,
            flat,
            structureRef.current,
            Math.min(24, Math.max(8, flat.length)),
            controller.signal,
          );
          const rank = new Map(hits.map((h, i) => [`${h.fileId}:${h.page}`, i]));
          packs = [...packs]
            .map((g) => ({
              ...g,
              pages: [...g.pages].sort(
                (a, b) =>
                  (rank.get(`${a.fileId}:${a.page}`) ?? 999) -
                  (rank.get(`${b.fileId}:${b.page}`) ?? 999),
              ),
              hits: [...g.hits].sort(
                (a, b) =>
                  (rank.get(`${a.fileId}:${a.page}`) ?? 999) -
                  (rank.get(`${b.fileId}:${b.page}`) ?? 999),
              ),
            }))
            .sort(
              (a, b) =>
                (rank.get(`${a.hits[0]?.fileId}:${a.hits[0]?.page}`) ?? 999) -
                (rank.get(`${b.hits[0]?.fileId}:${b.hits[0]?.page}`) ?? 999),
            );
        }

        const allPages = packs.flatMap((g) => g.pages);
        if (!allPages.length) {
          step({
            id: "ask",
            label: "Retrieving pages and drafting",
            status: "error",
            detail: "No pages in the selected files.",
          });
          setState((s) => ({ ...s, phase: "ready", error: "No pages in the selected files." }));
          return;
        }
        const citePages = pagesFromPack(allPages, hits);
        lastPackRef.current = { packs, texts, hits };
        setState((s) => ({
          ...s,
          hits,
          groups: packs,
          pageTexts: { ...s.pageTexts, ...texts },
          citePages,
          hasPack: true,
        }));

        const prior =
          opts.followUp && prev.query
            ? `Prior question: ${prev.query}\nPrior answer:\n${prev.answer.slice(0, 2500)}`
            : "";
        const instructions = [sess?.instructions, job?.instructions, prior]
          .filter(Boolean)
          .join("\n\n");

        let localDone = false;
        await streamSSE(
          "/api/pile/ask",
          {
            query: q,
            pages: allPages.map((p) => ({
              fileName: p.fileName,
              page: p.page,
              text: p.text,
              ocr: p.ocr,
            })),
            fileGroups: packs.map((g) => ({
              fileId: g.fileId,
              fileName: g.fileName,
              pageCount: g.pageCount,
              matched: g.matched,
              topScore: g.topScore,
              pages: g.pages.map((p) => ({
                fileName: p.fileName,
                page: p.page,
                text: p.text,
                ocr: p.ocr,
              })),
            })),
            hits,
            files: sess?.files.map((f) => ({ name: f.name, pageCount: f.pageCount })),
            structure: structureRef.current,
            instructions,
          },
          (evt) => {
            const d = (evt.data ?? {}) as Record<string, unknown>;
            if (evt.event === "delta") {
              setState((s) => ({ ...s, answer: s.answer + String(d["text"] ?? "") }));
            } else if (evt.event === "retrieve" && d["status"] === "done") {
              const nextHits = Array.isArray(d["hits"]) ? (d["hits"] as PileHit[]) : [];
              if (nextHits.length) {
                setState((s) => ({ ...s, hits: nextHits }));
                void pile()
                  .textsFor(nextHits)
                  .then(({ texts: t }) =>
                    setState((s) => ({ ...s, pageTexts: { ...s.pageTexts, ...t } })),
                  )
                  .catch(() => undefined);
              }
            } else if (evt.event === "fanout") {
              const list = Array.isArray(d["files"]) ? d["files"] : [];
              const total = Number(d["total"]) || list.length;
              const pagesRead = Number(d["pages"]) || 0;
              step({
                id: "fanout",
                label:
                  total > list.length
                    ? `Reading ${list.length} of ${total} documents (${pagesRead} pages)`
                    : `Reading ${list.length} document${list.length === 1 ? "" : "s"} in parallel (${pagesRead} pages)`,
                status: "running",
              });
            } else if (evt.event === "file_read") {
              const name = String(d["fileName"] ?? "document");
              const status = String(d["status"] ?? "running");
              step({
                id: `file-${String(d["fileId"] ?? name)}`,
                label: name,
                status: status === "error" ? "error" : status === "done" ? "done" : "running",
                detail:
                  status === "done"
                    ? d["matched"]
                      ? "Digest ready"
                      : "Does not address the question"
                    : status === "error"
                      ? String(d["detail"] ?? "read failed")
                      : "Reading this file on its own",
              });
            } else if (evt.event === "writer_start") {
              if (packs.length > 1) {
                step({ id: "fanout", label: "Per-document read", status: "done" });
                step({
                  id: "synthesis",
                  label: "Cross-analyzing the documents",
                  status: "running",
                });
              }
            } else if (evt.event === "error") {
              const msg = String(d["message"] ?? "Ask failed");
              step({
                id: "ask",
                label: "Retrieving pages and drafting",
                status: "error",
                detail: msg,
              });
              setState((s) => ({ ...s, phase: "error", error: msg }));
            } else if (evt.event === "done") {
              localDone = true;
              if (packs.length > 1) {
                step({ id: "synthesis", label: "Cross-analyzing the documents", status: "done" });
              }
              step({ id: "ask", label: "Retrieving pages and drafting", status: "done" });
              setState((s) => {
                const report = verifyAnswerCites(s.answer, citePages);
                return {
                  ...s,
                  phase: "ready",
                  citeReport: { ...report, filesTotal: sess?.files.length ?? report.filesTotal },
                };
              });
            }
          },
          controller.signal,
        );
        if (!localDone)
          throw new Error("The answer stream ended before completion. Retry your question.");
      } catch (e) {
        if (controller.signal.aborted) {
          setState((s) => (s.phase === "asking" ? { ...s, phase: "ready" } : s));
          return;
        }
        const msg = e instanceof Error ? e.message : "Ask failed";
        step({ id: "ask", label: "Retrieving pages and drafting", status: "error", detail: msg });
        setState((s) => ({
          ...s,
          phase: "error",
          error: msg,
          scanCoverage: s.scanCoverage ? { ...s.scanCoverage, running: false } : null,
        }));
        return;
      }
      setState((s) => {
        if (s.phase !== "asking") return s;
        const report = s.citeReport ?? verifyAnswerCites(s.answer, s.citePages);
        return { ...s, phase: "ready", citeReport: report };
      });
    },
    [pile, step],
  );

  // Save the working set as a durable, reloadable workspace: persist each file's
  // chunks+embeddings (Aurora), its extracted pages (S3, for one-click reload),
  // and its original bytes (S3, best-effort), plus the workspace record.
  const saveWorkspace = useCallback(async (opts: { name: string; folderId?: string }) => {
    const pages = pagesRef.current;
    const session = sessionRef.current;
    if (!session?.files.length) return;
    saveAbort.current?.abort();
    const controller = new AbortController();
    saveAbort.current = controller;
    const snapshotRevision = contentRevisionRef.current;
    const attemptKey = JSON.stringify({
      sessionId: session.id,
      revision: snapshotRevision,
      name: opts.name,
      folderId: opts.folderId ?? "ROOT",
      files: session.files.map((file) => [file.id, file.name, file.pageCount]),
      pages: pages.length,
    });
    let attempt = pendingWorkspaceSaveRef.current;
    if (!attempt || attempt.key !== attemptKey) {
      attempt = {
        key: attemptKey,
        requestId: crypto.randomUUID(),
        bytesKeyByFileId: {},
        sha256ByFileId: {},
        uploadByFileId: new Map(),
        submitted: false,
      };
      pendingWorkspaceSaveRef.current = attempt;
    }
    setState((s) => ({ ...s, kbSave: { status: "saving" } }));
    try {
      const byFile = new Map<string, { page: number; text: string }[]>();
      for (const p of pages) {
        if (!p.text.trim()) continue;
        const arr = byFile.get(p.fileId) ?? [];
        arr.push({ page: p.page, text: p.text });
        byFile.set(p.fileId, arr);
      }
      const files: {
        clientFileId: string;
        fileName: string;
        mime?: string;
        sha256?: string;
        byteSize?: number;
        bytesKey?: string;
        pages: { page: number; text: string }[];
      }[] = [];
      /** Documents left out: no readable text and no original bytes to convert. */
      const skipped: string[] = [];
      /** Documents indexed from imperfect browser text because bytes were unavailable. */
      const degraded: string[] = [];
      for (const file of session.files) {
        const fp = byFile.get(file.id) ?? [];
        let bytesKey: string | undefined = attempt.bytesKeyByFileId[file.id];
        let sha256 = attempt.sha256ByFileId[file.id];
        const blob = filesByIdRef.current.get(file.id);
        if (blob && !sha256) {
          sha256 = await rawFileSha256(blob);
          attempt.sha256ByFileId[file.id] = sha256;
        }
        if (blob && !bytesKey) {
          let upload = attempt.uploadByFileId.get(file.id);
          if (!upload) {
            upload = (async () => {
              try {
                const up = await createUploadFn({
                  data: {
                    name: file.name,
                    size: blob.size,
                    ...(sha256 ? { sha256 } : {}),
                  },
                });
                const put = await fetch(up.uploadUrl, {
                  method: "PUT",
                  body: blob,
                  signal: controller.signal,
                  ...(up.uploadHeaders ? { headers: up.uploadHeaders } : {}),
                });
                if (put.ok) {
                  attempt.bytesKeyByFileId[file.id] = up.s3Key;
                  return up.s3Key;
                }
              } catch {
                /* best-effort byte preservation; pages+chunks still save */
              }
              return undefined;
            })();
            attempt.uploadByFileId.set(file.id, upload);
            void upload.then((key) => {
              if (!key && attempt.uploadByFileId.get(file.id) === upload) {
                attempt.uploadByFileId.delete(file.id);
              }
            });
          }
          // A document with extractable text takes the text/sync lane, which
          // never reads the original bytes -- so don't block the save on the
          // upload. Let it finish in the background (recorded for reload / a
          // true-scan fallback). Only a text-less scan must wait, since BDA
          // converts from the bytes.
          if (fp.length === 0) {
            bytesKey = await upload;
            if (controller.signal.aborted) return;
          }
        }
        const totalChars = fp.reduce((total, page) => total + page.text.length, 0);
        const hasLowQualityExtraction =
          file.emptyPages > 0 || fp.some((page) => isLowQualityText(page.text));
        // The server rejects a document that needs conversion without its
        // bytes; decide here so one such file cannot sink the whole save.
        const plan = planSaveLane({
          readablePages: fp.length,
          totalChars,
          lowQuality: hasLowQualityExtraction,
          hasBytes: Boolean(bytesKey && sha256),
        });
        if (plan === "skip") {
          skipped.push(file.name);
          continue;
        }
        if (plan === "sync-degraded") degraded.push(file.name);
        files.push({
          clientFileId: file.id,
          fileName: file.name,
          ...(blob?.type ? { mime: blob.type } : {}),
          ...(sha256 ? { sha256 } : {}),
          ...(blob ? { byteSize: blob.size } : {}),
          ...(bytesKey ? { bytesKey } : {}),
          // Always send the extracted page text when there is any: the server's
          // text-background lane indexes it directly (no BDA round-trip) and
          // only falls back to BDA when a document has no extractable text.
          // Bytes are still uploaded above so a true scan can OCR.
          pages: fp,
        });
      }
      if (controller.signal.aborted) return;
      if (!files.length) {
        throw new Error(
          "None of these documents can be saved: no readable text was extracted and the original files are no longer in this session. Re-add them and save again.",
        );
      }
      attempt.submitted = true;
      // Idempotent auto-retry: the save keys on a stable requestId, so retrying a
      // transient failure (network / throttle) is a no-op if the first attempt
      // actually landed, and recovers the set instead of leaving it unindexed.
      const res = await withRetry(
        () =>
          saveWorkspaceFn({
            data: {
              requestId: attempt.requestId,
              name: opts.name,
              surface: "workingset",
              folderId: opts.folderId,
              files,
            },
          }),
        { tries: 3, baseMs: 800, signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      let status: {
        status: "saving" | "ready" | "error";
        stage: "queued" | "converting" | "embedding" | "ready" | "error";
        pendingCount: number;
        docCount: number;
        chunkCount: number;
        documents: {
          clientFileId: string;
          fileName: string;
          status: "queued" | "converting" | "embedding" | "ready" | "error";
          docId?: string;
          pageCount: number;
          chunkCount: number;
          errorSummary?: string;
        }[];
        errorSummary?: string;
      } = {
        status: res.status,
        stage: res.stage,
        pendingCount: res.pendingCount,
        docCount: res.docCount,
        chunkCount: res.chunkCount,
        documents: res.documents,
        ...(res.errorSummary ? { errorSummary: res.errorSummary } : {}),
      };
      for (let poll = 0; status.status === "saving" && poll < 180; poll++) {
        const activeStage =
          status.stage === "embedding"
            ? "embedding"
            : status.stage === "converting"
              ? "converting"
              : "queued";
        setState((current) => ({
          ...current,
          kbSave: {
            status: activeStage,
            message: `${status.pendingCount} document${status.pendingCount === 1 ? "" : "s"} pending`,
          },
        }));
        // Poll fast at first so a quick index (small docs, warm worker) flips to
        // ready in ~1s instead of a fixed 5s floor; back off for long jobs.
        await abortableDelay(poll < 4 ? 1_000 : 5_000, controller.signal);
        const polled = await withRetry(
          () => getWorkspaceStatusFn({ data: { itemId: res.itemId } }),
          { tries: 3, baseMs: 500, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!polled) throw new Error("Saved workspace status is unavailable.");
        status = polled;
      }
      if (controller.signal.aborted) return;
      // Bind the READY documents up front (partial binding): even while the rest
      // of the set is still ingesting, or after a per-document failure, the ready
      // docs answer via RAG. Only docs the server reports ready (with a docId)
      // are bound; unmapped files stay on the full-text scan and the coverage is
      // surfaced to the user (savedCoverage). This runs regardless of the overall
      // workspace status so a slow/failed sibling never blocks the ready subset.
      const docIdByFileId = Object.fromEntries(
        status.documents.flatMap((doc) =>
          doc.status === "ready" && doc.docId ? [[doc.clientFileId, doc.docId]] : [],
        ),
      );
      const readyCount = Object.keys(docIdByFileId).length;
      const total = session.files.length;
      const bindingComplete = session.files.every((file) => Boolean(docIdByFileId[file.id]));
      const snapshotStillCurrent =
        contentRevisionRef.current === snapshotRevision && sessionRef.current?.id === session.id;
      if (readyCount > 0 && snapshotStillCurrent) {
        const savedSession: PileSession = {
          ...session,
          savedWorkspace: {
            itemId: res.itemId,
            kbWorkspaceId: res.kbWorkspaceId,
            surface: "workingset",
            docIdByFileId,
          },
        };
        sessionRef.current = savedSession;
        persistPile(ownerRef.current, savedSession, pagesRef.current);
        setState((state) => ({ ...state, session: savedSession }));
      }
      if (status.status === "saving") {
        setState((current) => ({
          ...current,
          kbSave: {
            status:
              status.stage === "embedding"
                ? "embedding"
                : status.stage === "converting"
                  ? "converting"
                  : "queued",
            message:
              readyCount > 0
                ? `Indexing — ${readyCount} of ${total} ready; Ask uses the ready documents so far.`
                : "Workspace ingest is continuing in the background.",
          },
        }));
        return;
      }
      if (status.status === "error") {
        pendingWorkspaceSaveRef.current = null;
        setState((current) => ({
          ...current,
          kbSave:
            readyCount > 0
              ? {
                  status: "saved",
                  message: `Indexed ${readyCount} of ${total} — some documents failed and are excluded from Ask; re-save to retry them.`,
                }
              : {
                  status: "error",
                  message: status.errorSummary ?? "Workspace ingest did not complete.",
                },
        }));
        return;
      }
      pendingWorkspaceSaveRef.current = null;
      const caveats = [
        skipped.length
          ? `${skipped.length} left out (no readable text and the original file is not in this session): ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}`
          : "",
        degraded.length
          ? `${degraded.length} indexed from browser text only (original file unavailable for conversion)`
          : "",
      ].filter(Boolean);
      const headline = `Saved “${opts.name}” · ${status.docCount} doc${status.docCount === 1 ? "" : "s"} · ${status.chunkCount} passages`;
      setState((s) => ({
        ...s,
        kbSave: {
          status: "saved",
          message:
            bindingComplete && snapshotStillCurrent
              ? [headline, ...caveats].join(" · ")
              : skipped.length
                ? [headline, ...caveats, "Hybrid Ask covers the saved documents only."].join(" · ")
                : bindingComplete
                  ? `Saved “${opts.name}”, but this Working Set changed during save. Save it again to use hybrid Ask.`
                  : `Saved “${opts.name}”, but the current pile could not be bound. Reload it from the Library to use hybrid Ask.`,
        },
      }));
    } catch (e) {
      if (controller.signal.aborted) return;
      const message = e instanceof Error ? e.message : "Save failed";
      if (message.includes("does not match its reservation")) {
        pendingWorkspaceSaveRef.current = null;
      }
      setState((s) => ({
        ...s,
        kbSave: { status: "error", message },
      }));
    } finally {
      if (saveAbort.current === controller) {
        saveAbort.current = null;
      }
    }
  }, []);

  // One-click reload replaces the active pile atomically. An explicit merge
  // action can be added later; implicit merging would make the saved KB binding
  // incomplete and could silently omit locally added documents from retrieval.
  const reloadWorkspace = useCallback(async (itemId: string) => {
    saveAbort.current?.abort();
    setState((s) => ({ ...s, phase: "reading", error: null }));
    try {
      const ws = await getWorkspaceFn({ data: { itemId } });
      if (!ws || ws.status !== "ready") {
        setState((s) => ({ ...s, phase: "error", error: "Workspace not found" }));
        return;
      }
      if (ws.surface !== "workingset") {
        setState((s) => ({
          ...s,
          phase: "error",
          error: "That saved item is not a working set. Open it from its own Discovery tab.",
        }));
        return;
      }
      const loaded = await mapPool(ws.docs, 6, async (doc) => {
        const d = doc;
        const pg = await getWorkspacePagesFn({ data: { itemId, docId: d.docId } });
        if (!pg?.length) throw new Error(`Stored pages are missing for ${d.fileName}`);
        return {
          file: {
            id: d.docId,
            name: d.fileName,
            pageCount: pg.length,
            emptyPages: 0,
            ocrPages: 0,
          } satisfies PileFile,
          pages: pg.map(
            (page): PilePage => ({
              fileId: d.docId,
              fileName: d.fileName,
              page: page.page,
              text: page.text,
              ocr: false,
            }),
          ),
        };
      });
      const files = loaded.map((entry) => entry.file);
      const pages = loaded.flatMap((entry) => entry.pages);
      if (!files.length || files.length !== ws.docs.length) {
        setState((s) => ({ ...s, phase: "error", error: "Nothing to load in that workspace" }));
        return;
      }
      const replacement = new PileClient();
      for (let index = 0; index < pages.length; index += 500) {
        await replacement.addPages(pages.slice(index, index + 500));
      }
      const now = Date.now();
      const session: PileSession = {
        id: `workspace-${itemId}`,
        createdAt: now,
        expiresAt: now + PILE_TTL_MS,
        matterLabel: null,
        instructions: null,
        files,
        pageCount: pages.length,
        structure: null,
        savedWorkspace: {
          itemId,
          kbWorkspaceId: ws.kbWorkspaceId,
          surface: ws.surface,
          docIdByFileId: Object.fromEntries(files.map((file) => [file.id, file.id])),
        },
      };
      ingestAbort.current?.abort();
      askAbort.current?.abort();
      pileRef.current?.dispose();
      pileRef.current = replacement;
      pagesRef.current = pages;
      sessionRef.current = session;
      contentRevisionRef.current += 1;
      structureRef.current = null;
      lastPackRef.current = null;
      pendingWorkspaceSaveRef.current = null;
      filesByIdRef.current.clear();
      persistPile(ownerRef.current, session, pages);
      setState({
        ...EMPTY,
        phase: "ready",
        session,
        files: files.map((file) => ({
          name: file.name,
          pages: file.pageCount,
          empty: 0,
          done: file.pageCount,
          status: "ready",
        })),
        kbSave: {
          status: "saved",
          message: `Loaded “${ws.name}” · ${files.length} doc${files.length === 1 ? "" : "s"}`,
        },
      });
    } catch (e) {
      setState((s) => ({
        ...s,
        phase: "error",
        error: e instanceof Error ? e.message : "Could not reload workspace",
      }));
    }
  }, []);

  return {
    state,
    retryScan: () => {
      const previous = lastScan.current;
      if (previous) void ask(previous.query, previous.opts);
    },
    cancelAsk: () => {
      askAbort.current?.abort();
      setState((s) => ({
        ...s,
        phase: s.phase === "asking" ? "ready" : s.phase,
        scanCoverage: s.scanCoverage ? { ...s.scanCoverage, running: false } : null,
      }));
    },
    start,
    addFiles,
    ingestPages,
    search,
    ask,
    reset,
    loadPage,
    saveWorkspace,
    reloadWorkspace,
    client: pile,
    setQuery: (query: string) => setState((s) => ({ ...s, query })),
    selectHit: (selected: string | null) => setState((s) => ({ ...s, selected })),
  };
}

export type PileApi = ReturnType<typeof usePile>;
