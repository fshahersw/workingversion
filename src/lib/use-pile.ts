import { useCallback, useEffect, useRef, useState } from "react";

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
import { isLowQualityText } from "@/lib/pile/text-quality";
import {
  pagesFromPack,
  verifyAnswerCites,
  type CitePage,
  type CiteReport,
} from "@/lib/pile/cite-trust";
import { pileJob, type PileJobId } from "@/lib/pile/jobs";
import {
  clearLocalPile,
  loadLocalPile,
  purgeLegacyPile,
  saveLocalPile,
} from "@/lib/pile/local-store";
import { useAuth } from "@/lib/use-auth";
import { ingestFileToKb } from "@/lib/kb/kb-client";
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
};

export type KbSaveState = {
  status: "idle" | "saving" | "saved" | "error";
  message?: string;
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
): { files: PileSession["files"]; pages: PilePage[] } {
  const pages: PilePage[] = [];
  let remaining = remainingPages;
  const files = extracted.slice(0, remainingFiles).map((x) => {
    const fileId = newId();
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
  return { files, pages };
}

function buildLocalPile(
  extracted: Extracted[],
  instructions?: string,
): { session: PileSession; pages: PilePage[] } {
  const now = Date.now();
  const { files, pages } = pagesFromExtracted(extracted, MAX_PAGES, MAX_FILES);
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
      .filter((p) => p.text.trim().length < OCR_EMPTY_CHARS)
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
  const [state, setState] = useState<PileState>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;
  const ingestAbort = useRef<AbortController | null>(null);
  const askAbort = useRef<AbortController | null>(null);
  const pagesRef = useRef<PilePage[]>([]);
  const sessionRef = useRef<PileSession | null>(null);
  const structureRef = useRef<PileStructure | null>(null);
  const pileRef = useRef<PileClient | null>(null);
  const lastPackRef = useRef<{
    packs: PileFilePack[];
    texts: Record<string, string>;
    hits: PileHit[];
  } | null>(null);

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
    ingestAbort.current?.abort();
    askAbort.current?.abort();
    ingestAbort.current = null;
    askAbort.current = null;
    pagesRef.current = [];
    sessionRef.current = null;
    structureRef.current = null;
    pileRef.current?.dispose();
    pileRef.current = null;
    lastPackRef.current = null;
    if (ownerRef.current) void clearLocalPile(ownerRef.current).catch(() => undefined);
    setState(EMPTY);
  }, []);

  const start = useCallback(
    async (incoming: File[], instructions?: string) => {
      const files = incoming.filter((f) => fileKind(f) !== null).slice(0, MAX_FILES);
      if (!files.length) {
        setState({
          ...EMPTY,
          phase: "error",
          error: "Only PDF, Word, Excel, PowerPoint or TXT files are supported.",
        });
        return;
      }
      const controller = new AbortController();
      ingestAbort.current = controller;
      pagesRef.current = [];
      sessionRef.current = null;
      structureRef.current = null;
      pileRef.current?.dispose();
      pileRef.current = null;
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
          failures.length ? `${failures.length} file${failures.length === 1 ? "" : "s"} skipped` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });

      setState((s) => ({ ...s, phase: "indexing" }));
      step({ id: "index", label: "Indexing the pile", status: "running" });
      const built = buildLocalPile(ok, instructions);
      pagesRef.current = built.pages;
      sessionRef.current = built.session;
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

      try {
        const next = await recoverScannedPages({
          extracted: ok,
          pages: pagesRef.current,
          session: built.session,
          pile: pile(),
          signal: controller.signal,
          step,
        });
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
    async (incoming: File[]) => {
      const sess = sessionRef.current;
      if (!sess || !pagesRef.current.length) {
        await start(incoming);
        return;
      }

      const have = new Set(sess.files.map((f) => f.name.toLowerCase()));
      const unique = incoming.filter((f) => fileKind(f) !== null && !have.has(f.name.toLowerCase()));
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

      const controller = new AbortController();
      ingestAbort.current = controller;
      setState((s) => ({
        ...s,
        adding: true,
        error: null,
        files: [
          ...s.files,
          ...files.map((f) => ({ name: f.name, pages: 0, empty: 0, done: 0, status: "reading" as const })),
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
        step({ id: "add", label: "Adding files", status: "error", detail: "None of the new files could be read." });
        setState((s) => ({ ...s, adding: false }));
        return;
      }

      const room = Math.max(0, MAX_PAGES - pagesRef.current.length);
      const appended = pagesFromExtracted(ok, room, slots);
      pagesRef.current = [...pagesRef.current, ...appended.pages];
      const nextSession: PileSession = {
        ...sess,
        files: [...sess.files, ...appended.files],
        pageCount: pagesRef.current.length,
        structure: null,
      };
      sessionRef.current = nextSession;
      for (let i = 0; i < appended.pages.length; i += 500) {
        await pile().addPages(appended.pages.slice(i, i + 500));
        if (controller.signal.aborted) return;
      }
      setState((s) => ({ ...s, session: nextSession, adding: false, structure: null }));
      persistPile(ownerRef.current, nextSession, pagesRef.current);
      step({
        id: "add",
        label: `Added ${appended.files.length} file${appended.files.length === 1 ? "" : "s"}`,
        status: "done",
        detail: `${appended.pages.length} pages · kept on this device`,
      });

      try {
        const afterOcr = await recoverScannedPages({
          extracted: ok,
          pages: pagesRef.current,
          session: nextSession,
          pile: pile(),
          signal: controller.signal,
          step,
        });
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
      await pile().addPages(newPages.length ? newPages : pages);
      pagesRef.current = [...pagesRef.current, ...newPages];
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
        ...sess,
        files: [...sess.files, ...newFiles],
        pageCount: pagesRef.current.length,
      };
      sessionRef.current = next;
      persistPile(ownerRef.current, next, pagesRef.current);
      setState((s) => ({
        ...s,
        session: next,
        phase: s.phase === "idle" ? "ready" : s.phase,
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
        turns:
          s.answer.trim() && s.query.trim()
            ? [...s.turns, { id: newId(), query: s.query, answer: s.answer }]
            : s.turns,
      }));
      step({ id: "ask", label: "Retrieving pages and drafting", status: "running" });
      try {
        const sess = sessionRef.current;
        const fileCount = sess?.files.length ?? 0;
        const budget = askBudget(Math.max(fileCount, 1));
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
            fileCount > 1
              ? budget.perFilePages
              : Math.max(budget.perFilePages, ASK_MIN_HITS),
          );
          packs = filterGroups(packed.groups.filter((g) => g.pages.length), opts.fileIds);
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
        const instructions = [sess?.instructions, job?.instructions, prior].filter(Boolean).join("\n\n");

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
                  .then(({ texts: t }) => setState((s) => ({ ...s, pageTexts: { ...s.pageTexts, ...t } })))
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
      } catch (e) {
        if (controller.signal.aborted) {
          setState((s) => (s.phase === "asking" ? { ...s, phase: "ready" } : s));
          return;
        }
        const msg = e instanceof Error ? e.message : "Ask failed";
        step({ id: "ask", label: "Retrieving pages and drafting", status: "error", detail: msg });
        setState((s) => ({ ...s, phase: "error", error: msg }));
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

  // Explicit write-through of the current working set to the durable per-user KB.
  // The local pile stays the fast default; this persists it (cross-device, and
  // the basis for shared workspaces). One ingest call per file.
  const saveToKb = useCallback(async () => {
    const pages = pagesRef.current;
    const session = sessionRef.current;
    if (!session?.files.length || !pages.length) return;
    setState((s) => ({ ...s, kbSave: { status: "saving" } }));
    try {
      const byFile = new Map<string, { page: number; text: string }[]>();
      for (const p of pages) {
        if (!p.text.trim()) continue;
        const arr = byFile.get(p.fileId) ?? [];
        arr.push({ page: p.page, text: p.text });
        byFile.set(p.fileId, arr);
      }
      let saved = 0;
      let chunks = 0;
      for (const file of session.files) {
        const fp = byFile.get(file.id);
        if (!fp?.length) continue;
        const r = await ingestFileToKb({ fileName: file.name, pages: fp });
        saved += 1;
        chunks += r.chunkCount;
      }
      setState((s) => ({
        ...s,
        kbSave: {
          status: "saved",
          message: `Saved ${saved} file${saved === 1 ? "" : "s"} · ${chunks} passage${chunks === 1 ? "" : "s"} indexed`,
        },
      }));
    } catch (e) {
      setState((s) => ({
        ...s,
        kbSave: { status: "error", message: e instanceof Error ? e.message : "Save failed" },
      }));
    }
  }, []);

  return {
    state,
    start,
    addFiles,
    ingestPages,
    search,
    ask,
    reset,
    loadPage,
    saveToKb,
    client: pile,
    setQuery: (query: string) => setState((s) => ({ ...s, query })),
    selectHit: (selected: string | null) => setState((s) => ({ ...s, selected })),
  };
}

export type PileApi = ReturnType<typeof usePile>;
