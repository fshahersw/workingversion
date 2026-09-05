import { useCallback, useRef, useState } from "react";

import { extractFile, transcriptFileKind } from "@/lib/extract-text";
import { streamSSE } from "@/lib/orchestrate";
import { AdaptiveLimiter, mapPool, withRetry } from "@/lib/pile/async";
import { packAskHits, pagesForClientHits } from "@/lib/pile/client-search";
import {
  analysisToMarkdown,
  compactDepAnalysis,
  EMPTY_ANALYSIS,
  extractCaptionMeta,
  mergeDepAnalysis,
  parseCiteStart,
  parseDepAnalysis,
  verifyDepAnalysis,
  type DepAnalysis,
} from "@/lib/pile/deposition-analysis";
import {
  ANALYZE_WINDOW,
  ANALYZE_WINDOW_CONCURRENCY,
  DEP_MAX_BYTES,
  DEP_MAX_FILES,
  DEP_MAX_PAGES,
  DEP_OCR_ANALYZE_AFTER,
  FILE_EXTRACT_CONCURRENCY,
  OCR_CONCURRENCY,
  OCR_CONCURRENCY_MAX,
  OCR_CONCURRENCY_MIN,
  OCR_PAGE_CAP,
} from "@/lib/pile/limits";
import {
  looksLikeTranscript,
  pageNeedsDepOcr,
  transcriptFromPages,
  type TranscriptBlock,
  type TranscriptParse,
} from "@/lib/pile/transcript";
import { textQualityScore } from "@/lib/pile/text-quality";
import type { PileHit, PilePage } from "@/lib/pile/types";
import { forEachRenderedPdfPage } from "@/lib/pile-render";

export type DepPhase = "idle" | "reading" | "indexing" | "ready" | "analyzing" | "asking" | "error";
export type DepSpeakerFilter = "any" | "question" | "answer" | "objection";
export type DepPass = "case" | "record" | "connections" | "cross";
export type DepPassStatus = "idle" | "running" | "done" | "error";
export type DepStep = { id: string; label: string; detail?: string; status: "running" | "done" | "error" };
export type DepTranscript = TranscriptParse & { fileId: string };

export type DepState = {
  phase: DepPhase;
  files: { name: string; pages: number; empty: number; done: number; status: "reading" | "ready" | "error" }[];
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
};

const IDLE_PASSES: Record<DepPass, DepPassStatus> = {
  case: "idle",
  record: "idle",
  connections: "idle",
  cross: "idle",
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
};

const PASS_QUERY: Record<DepPass, string> = {
  case: "Build the trial-usable case layer: witness profile, admissions, impeachment, and objections.",
  record: "Build the record layer: chronology, exhibits, and case themes.",
  connections: "Map witnesses, material contradictions, and a knowledge graph of people, companies, documents, and themes.",
  cross: "Compare these depositions. Find only material conflicts or omissions across witnesses, and one shared knowledge graph.",
};

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

function chunkCover<T>(items: T[], size: number): T[][] {
  if (!items.length) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
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
        throw new Error(`HTTP ${res.status}: ${body.error || res.statusText}`);
      }
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body;
    },
    { tries: opts?.tries ?? 3, baseMs: 400, signal: init?.signal ?? undefined, retry429: (opts?.tries ?? 3) > 1 },
  );
}

export function useDeposition() {
  const [state, setState] = useState<DepState>(EMPTY);
  const ingestAbort = useRef<AbortController | null>(null);
  const analyzeAbort = useRef<AbortController | null>(null);
  const askAbort = useRef<AbortController | null>(null);
  const pdfFilesRef = useRef<Map<string, File>>(new Map());
  const pagesRef = useRef<PilePage[]>([]);
  const transcriptsRef = useRef<DepTranscript[]>([]);
  const instructionsRef = useRef("");
  const analysisRef = useRef<DepAnalysis>(EMPTY_ANALYSIS);

  const step = useCallback((s: DepStep) => {
    setState((prev) => {
      const i = prev.steps.findIndex((x) => x.id === s.id);
      const steps = i === -1 ? [...prev.steps, s] : prev.steps.map((x, j) => (j === i ? { ...x, ...s } : x));
      return { ...prev, steps };
    });
  }, []);

  const reset = useCallback(() => {
    ingestAbort.current?.abort();
    analyzeAbort.current?.abort();
    askAbort.current?.abort();
    ingestAbort.current = null;
    analyzeAbort.current = null;
    askAbort.current = null;
    pdfFilesRef.current = new Map();
    pagesRef.current = [];
    transcriptsRef.current = [];
    instructionsRef.current = "";
    analysisRef.current = EMPTY_ANALYSIS;
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

  const analyze = useCallback(async () => {
    const transcripts = transcriptsRef.current;
    if (!transcripts.length) {
      setState((s) => ({ ...s, phase: "error", error: "Drop deposition files first." }));
      return;
    }
    analyzeAbort.current?.abort();
    const controller = new AbortController();
    analyzeAbort.current = controller;
    const focus = instructionsRef.current;
    analysisRef.current = {
      ...EMPTY_ANALYSIS,
      witnesses: transcripts.map((t, i) => ({
        id: `w-seed-${i}`,
        name: t.witness || t.fileName.replace(/\.[^.]+$/, ""),
        role: "",
        fileName: t.fileName,
        summary: t.caption.replace(/\s+/g, " ").trim().slice(0, 280),
        quote: "",
        cite: t.citeReady && t.lines[0] ? `${t.lines[0]!.page}:${t.lines[0]!.line}` : "",
      })),
    };
    setState((s) => ({
      ...s,
      phase: "analyzing",
      analysis: { ...analysisRef.current },
      error: null,
      passes: {
        case: "running",
        record: "running",
        connections: "running",
        cross: transcripts.length > 1 ? "idle" : "done",
      },
      analyzeProgress: { done: 0, total: 1 },
    }));

    type Packed = { hits: PileHit[]; pages: { fileName: string; page: number; text: string; cite: string }[] };
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
        text: `Q. ${b.question}\nA. ${b.answer}`.trim() || b.answer,
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
      let raw = "";
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
          files: list.map((t) => ({ name: t.fileName, pageCount: t.blocks.length || t.lines.length })),
          instructions: focus || null,
          caption: list.map((t) => t.caption).filter(Boolean).join("\n---\n").slice(0, 2000),
          citeReady: list.some((t) => t.citeReady),
          witness: list.map((t) => t.witness).filter(Boolean).join("; ") || list[0]?.witness,
        },
        (evt) => {
          const d = (evt.data ?? {}) as Record<string, unknown>;
          if (evt.event === "delta") raw += String(d["text"] ?? "");
          else if (evt.event === "error") throw new Error(String(d["message"] ?? "Analysis failed"));
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const verified = verifyDepAnalysis(parseDepAnalysis(raw), list);
      analysisRef.current = mergeDepAnalysis(analysisRef.current, verified);
      setState((s) => ({
        ...s,
        analysis: analysisRef.current,
        role: analysisRef.current.role || s.role,
        passes: mark && pass !== "cover" && pass !== "synth" ? { ...s.passes, [pass]: "done" } : s.passes,
      }));
    };

    const windows = transcripts.flatMap((t) =>
      chunkCover(coverUnits(t), ANALYZE_WINDOW).map((units) => ({ t, pack: packUnits(units) })),
    );
    const extra = 1 + (transcripts.length > 1 ? 1 : 0);
    if (!windows.length) {
      setState((s) => ({ ...s, phase: "error", error: "No testimony blocks to analyze.", analyzeProgress: null }));
      return;
    }
    let done = 0;
    const bump = () => {
      done += 1;
      setState((s) => ({ ...s, analyzeProgress: { done, total: windows.length + extra } }));
    };
    setState((s) => ({ ...s, analyzeProgress: { done: 0, total: Math.max(1, windows.length + extra) } }));

    try {
      if (windows.length) {
        await mapPool(
          windows,
          ANALYZE_WINDOW_CONCURRENCY,
          async (w) => {
            await runPass("cover", [w.t], w.pack.hits, w.pack.pages);
            bump();
          },
          controller.signal,
        );
      }
    } catch {
      if (controller.signal.aborted) {
        setState((s) => (s.phase === "analyzing" ? { ...s, phase: "ready", analyzeProgress: null } : s));
        return;
      }
      setState((s) => ({ ...s, phase: "error", error: "Analysis failed", analyzeProgress: null }));
      return;
    }

    setState((s) => ({
      ...s,
      passes: { ...s.passes, case: "running", record: "done", connections: "done" },
    }));
    try {
      const findings = compactDepAnalysis(analysisRef.current);
      await runPass(
        "synth",
        transcripts,
        [],
        [{ fileName: "findings.json", page: 1, text: `FINDINGS\n${findings}`, cite: "" }],
      );
    } catch {
      /* covering windows still stand */
    }
    bump();
    setState((s) => ({ ...s, passes: { ...s.passes, case: "done" } }));

    if (transcripts.length > 1) {
      setState((s) => ({ ...s, passes: { ...s.passes, cross: "running" } }));
      const findings = compactDepAnalysis(analysisRef.current);
      try {
        await runPass(
          "cross",
          transcripts,
          [],
          [{ fileName: "findings.json", page: 1, text: `FINDINGS\n${findings}`, cite: "" }],
          true,
        );
      } catch {
        /* per-window results still usable */
      }
      bump();
    }

    if (!analysisRef.current.admissions.length && !analysisRef.current.summary && !windows.length) {
      setState((s) => ({ ...s, phase: "error", error: "Analysis failed", analyzeProgress: null }));
      return;
    }
    setState((s) => ({ ...s, phase: "ready", analysis: analysisRef.current, analyzeProgress: null }));
  }, []);

  const start = useCallback(
    async (incoming: File[], instructions?: string) => {
      const files = incoming.filter((f) => transcriptFileKind(f) !== null).slice(0, DEP_MAX_FILES);
      if (!files.length) {
        setState({ ...EMPTY, phase: "error", error: "Drop depositions as PDF, Word, or TXT." });
        return;
      }
      const controller = new AbortController();
      ingestAbort.current = controller;
      pdfFilesRef.current = new Map(files.filter((f) => transcriptFileKind(f) === "pdf").map((f) => [f.name, f]));
      pagesRef.current = [];
      transcriptsRef.current = [];
      instructionsRef.current = instructions?.trim() || "";
      analysisRef.current = EMPTY_ANALYSIS;
      setState({
        ...EMPTY,
        phase: "reading",
        instructions: instructionsRef.current,
        files: files.map((f) => ({ name: f.name, pages: 0, empty: 0, done: 0, status: "reading" })),
      });
      step({ id: "read", label: "Reading files", status: "running" });

      const extracted: { file: File; res: Awaited<ReturnType<typeof extractFile>> }[] = new Array(files.length);
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
                  files: s.files.map((x, j) => (j === i ? { ...x, done, pages: total, status: "reading" } : x)),
                })),
              controller.signal,
              { maxPages: DEP_MAX_PAGES, maxBytes: DEP_MAX_BYTES, layout: "transcript" },
            );
            extracted[i] = { file: f, res };
            setState((s) => ({
              ...s,
              files: s.files.map((x, j) =>
                j === i
                  ? { name: f.name, pages: res.pageCount, empty: res.emptyPages, done: res.pageCount, status: "ready" }
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

      let remaining = DEP_MAX_PAGES;
      const pages: PilePage[] = [];
      const pageTexts: Record<string, string> = {};
      for (const item of extracted) {
        if (!item) continue;
        const fileId = newId();
        const take = item.res.pages.slice(0, Math.max(0, remaining));
        remaining -= take.length;
        for (const p of take) {
          const text = (p.text ?? "").trim();
          const page: PilePage = { fileId, fileName: item.res.name, page: p.page, text, ocr: false };
          pages.push(page);
          pageTexts[`${item.res.name}:${p.page}`] = text;
          pageTexts[`${fileId}:${p.page}`] = text;
        }
      }
      pagesRef.current = pages;
      const pageTotal = pages.length;
      step({
        id: "read",
        label: "Reading files",
        status: "done",
        detail: `${pageTotal} pages — kept in this tab only`,
      });

      const seedWitnesses = (list: DepTranscript[]) =>
        list.map((t, i) => ({
          id: `w-seed-${i}`,
          name: t.witness || t.fileName.replace(/\.[^.]+$/, ""),
          role: "",
          fileName: t.fileName,
          summary: t.caption.replace(/\s+/g, " ").trim().slice(0, 280),
          quote: "",
          cite: t.citeReady && t.lines[0] ? `${t.lines[0]!.page}:${t.lines[0]!.line}` : "",
        }));

      const publish = (list: DepTranscript[], ocr?: DepState["ocr"]) => {
        if (!list.length) return;
        const primary = list[0]!;
        const meta = extractCaptionMeta(list.map((t) => t.caption).join(" "));
        if (!analysisRef.current.witnesses.length) {
          analysisRef.current = { ...EMPTY_ANALYSIS, witnesses: seedWitnesses(list) };
        }
        setState((s) => ({
          ...s,
          phase: s.phase === "asking" || s.phase === "analyzing" ? s.phase : "ready",
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
      const fileReady = (t: DepTranscript, pages: { text: string }[]) =>
        t.citeReady ||
        t.blocks.length >= 3 ||
        t.lines.filter((l) => l.speaker === "Q").length >= 4 ||
        looksLikeTranscript(pages.map((p) => p.text).join("\n"));
      const usable = (list: DepTranscript[]) =>
        list.some((t) => fileReady(t, pagesRef.current.filter((p) => p.fileId === t.fileId)));
      publish(transcripts);
      let startedAnalyze = false;
      if (usable(transcripts)) {
        startedAnalyze = true;
        void analyze();
      }

      const ocrJobs: { file: File; name: string; page: number; score: number }[] = [];
      for (const item of extracted) {
        if (!item || transcriptFileKind(item.file) !== "pdf") continue;
        const t = transcripts.find((x) => x.fileName === item.res.name);
        if (t && fileReady(t, item.res.pages)) continue;
        for (const p of item.res.pages) {
          if (pageNeedsDepOcr(p.text)) {
            ocrJobs.push({ file: item.file, name: item.res.name, page: p.page, score: textQualityScore(p.text) });
          }
        }
      }
      ocrJobs.sort((a, b) => a.score - b.score);
      const ocrPick = ocrJobs.slice(0, OCR_PAGE_CAP);
      if (!ocrPick.length) {
        if (!startedAnalyze) void analyze();
        return;
      }

      step({ id: "ocr", label: "OCR on scanned / noisy pages (Nano VL)", status: "running", detail: `${ocrPick.length} pages` });
      setState((s) => ({ ...s, ocr: { done: 0, total: ocrPick.length } }));
      let ocrN = 0;
      try {
        const limiter = new AdaptiveLimiter(OCR_CONCURRENCY_MIN, OCR_CONCURRENCY, OCR_CONCURRENCY_MAX);
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
                    { method: "POST", body: JSON.stringify({ imageBase64 }), signal: controller.signal },
                    { tries: 1 },
                  );
                  if (ocrRes.text) {
                    const idx = pagesRef.current.findIndex((p) => p.fileName === fileName && p.page === page);
                    if (idx >= 0) {
                      const prev = pagesRef.current[idx]!;
                      pagesRef.current[idx] = { ...prev, text: ocrRes.text, ocr: true };
                    }
                    ocrN += 1;
                    if (ocrN % 8 === 0 || ocrN === ocrPick.length || (!startedAnalyze && ocrN >= DEP_OCR_ANALYZE_AFTER)) {
                      transcripts = rebuildTranscripts();
                      publish(transcripts, { done: ocrN, total: ocrPick.length });
                      if (!startedAnalyze && usable(transcripts)) {
                        startedAnalyze = true;
                        void analyze();
                      }
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
      transcripts = rebuildTranscripts();
      publish(transcripts, null);
      if (!startedAnalyze) void analyze();
    },
    [analyze, rebuildTranscripts, step],
  );

  const ask = useCallback(async (query: string) => {
    if (!pagesRef.current.length || !query.trim()) return;
    askAbort.current?.abort();
    const controller = new AbortController();
    askAbort.current = controller;
    setState((s) => ({ ...s, phase: "asking", query, answer: "", hits: [], asking: true, error: null }));
    step({ id: "ask", label: "Retrieving testimony and drafting", status: "running" });
    try {
      const hits = packAskHits(pagesRef.current, query);
      const packed = pagesForClientHits(pagesRef.current, hits);
      await streamSSE(
        "/api/pile/ask",
        {
          query,
          mode: "ask",
          pages: packed.map((p) => {
            const hit = hits.find((h) => h.fileName === p.fileName && h.page === p.page);
            return { fileName: p.fileName, page: p.page, text: p.text, ocr: p.ocr, cite: hit?.cite };
          }),
          hits,
          files: transcriptsRef.current.map((t) => ({ name: t.fileName, pageCount: t.lines.length })),
          instructions: instructionsRef.current || null,
          citeReady: transcriptsRef.current.some((t) => t.citeReady),
        },
        (evt) => {
          const d = (evt.data ?? {}) as Record<string, unknown>;
          if (evt.event === "delta") setState((s) => ({ ...s, answer: s.answer + String(d["text"] ?? "") }));
          else if (evt.event === "retrieve" && d["status"] === "done") {
            const next = Array.isArray(d["hits"]) ? (d["hits"] as PileHit[]) : [];
            if (next.length) setState((s) => ({ ...s, hits: next }));
          } else if (evt.event === "error") {
            const msg = String(d["message"] ?? "Ask failed");
            step({ id: "ask", label: "Retrieving testimony and drafting", status: "error", detail: msg });
            setState((s) => ({ ...s, phase: "error", error: msg, asking: false }));
          } else if (evt.event === "done") {
            step({ id: "ask", label: "Retrieving testimony and drafting", status: "done" });
            setState((s) => ({ ...s, phase: "ready", asking: false }));
          }
        },
        controller.signal,
      );
    } catch (e) {
      if (controller.signal.aborted) {
        setState((s) => ({ ...s, phase: "ready", asking: false }));
        return;
      }
      const msg = e instanceof Error ? e.message : "Ask failed";
      step({ id: "ask", label: "Retrieving testimony and drafting", status: "error", detail: msg });
      setState((s) => ({ ...s, phase: "error", error: msg, asking: false }));
      return;
    }
    setState((s) => (s.phase === "asking" ? { ...s, phase: "ready", asking: false } : { ...s, asking: false }));
  }, [step]);

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

  const active = state.transcripts.find((t) => t.fileId === state.activeFileId) ?? state.transcripts[0] ?? null;

  return {
    state,
    active,
    start,
    analyze,
    ask,
    reset,
    exportMemo,
    setSearch: (search: string) => setState((s) => ({ ...s, search })),
    setRegex: (regex: boolean) => setState((s) => ({ ...s, regex })),
    setSpeaker: (speaker: DepSpeakerFilter) => setState((s) => ({ ...s, speaker })),
    setQuery: (query: string) => setState((s) => ({ ...s, query })),
    setActiveFile: (fileId: string) => setState((s) => ({ ...s, activeFileId: fileId, selectedCite: null })),
    selectCite: (cite: string | null, fileName?: string) => {
      const startCite = cite ? parseCiteStart(cite) : null;
      setState((s) => {
        let activeFileId = s.activeFileId;
        if (fileName) {
          const match = s.transcripts.find((t) => t.fileName === fileName);
          if (match) activeFileId = match.fileId;
        } else if (startCite) {
          const match = s.transcripts.find((t) =>
            t.lines.some((l) => l.page === startCite.page && l.line === startCite.line),
          );
          if (match) activeFileId = match.fileId;
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
