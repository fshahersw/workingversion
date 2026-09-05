// Client state machine for the document summarizer: extract → upload → stream.
import { useCallback, useRef, useState } from "react";

import type { MatterScope } from "@/lib/chat-types";
import { streamSSE } from "@/lib/orchestrate";
import {
  extractFile,
  fileKind,
  mergeExtracted,
  MAX_PAGES,
  type ExtractedFile,
} from "@/lib/extract-text";
import { getSummaryUploadUrls, saveDocSummary } from "@/lib/summaries.functions";
import type { LedgerFact, SummarizeMode } from "@/lib/summarizer-config";

export type StepStatus = "running" | "done" | "error";

export type Step = {
  id: string;
  label: string;
  detail?: string;
  status: StepStatus;
  meta?: string;
};

export type FileState = {
  name: string;
  size: number;
  kind: string;
  status: "reading" | "ready" | "error";
  pages: number;
  done: number;
  error?: string;
};

export type Phase = "idle" | "reading" | "thinking" | "writing" | "done" | "error";

export type Conflict = { issue: string; detail?: string; pages: number[] };

export type Coverage = {
  critical: number;
  covered: number;
  anchors: number;
  bad_anchors: number;
  questions?: number;
  unsupported?: number;
};

export type Gap = { claim: string; page: number };

export type SummarizerState = {
  phase: Phase;
  files: FileState[];
  steps: Step[];
  summary: string;
  title: string;
  error: string | null;
  pageCount: number;
  savedId: string | null;
  durationMs: number | null;
  facts: LedgerFact[];
  conflicts: Conflict[];
  coverage: Coverage | null;
  questions: string[];
  gaps: Gap[];
};

const EMPTY: SummarizerState = {
  phase: "idle",
  files: [],
  steps: [],
  summary: "",
  title: "",
  error: null,
  pageCount: 0,
  savedId: null,
  durationMs: null,
  facts: [],
  conflicts: [],
  coverage: null,
  questions: [],
  gaps: [],
};

export function useSummarizer(matter: MatterScope | null, ownerEmail?: string | null, mode: SummarizeMode = "standard") {
  const [state, setState] = useState<SummarizerState>(EMPTY);
  const abortRef = useRef<AbortController | null>(null);

  const patch = useCallback((p: Partial<SummarizerState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  const step = useCallback((s: Step) => {
    setState((prev) => {
      const i = prev.steps.findIndex((x) => x.id === s.id);
      const steps = i === -1 ? [...prev.steps, s] : prev.steps.map((x, j) => (j === i ? { ...x, ...s } : x));
      return { ...prev, steps };
    });
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(EMPTY);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((s) => ({ ...s, phase: s.summary ? "done" : "idle" }));
  }, []);

  const start = useCallback(
    async (incoming: File[], instructions?: string) => {
      const files = incoming.filter((f) => fileKind(f) !== null);
      if (!files.length) {
        patch({ error: "Only PDF, DOCX and TXT files are supported.", phase: "error" });
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;

      const title =
        files.length === 1
          ? files[0]!.name.replace(/\.[^.]+$/, "")
          : `${files[0]!.name.replace(/\.[^.]+$/, "")} + ${files.length - 1} more`;

      setState({
        ...EMPTY,
        phase: "reading",
        title,
        files: files.map((f) => ({
          name: f.name,
          size: f.size,
          kind: fileKind(f) ?? "pdf",
          status: "reading",
          pages: 0,
          done: 0,
        })),
      });

      // ------------------------------------------------------------ extract --
      step({ id: "read", label: "Reading files", status: "running" });
      const extracted: ExtractedFile[] = [];
      try {
        for (let i = 0; i < files.length; i++) {
          const f = files[i]!;
          const res = await extractFile(
            f,
            (done, total) =>
              setState((s) => ({
                ...s,
                files: s.files.map((x, j) => (j === i ? { ...x, done, pages: total } : x)),
              })),
            controller.signal,
          );
          extracted.push(res);
          setState((s) => ({
            ...s,
            files: s.files.map((x, j) =>
              j === i ? { ...x, status: "ready", pages: res.pageCount, done: res.pageCount } : x,
            ),
          }));
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        const msg = e instanceof Error ? e.message : "Could not read the file.";
        step({ id: "read", label: "Reading files", status: "error", detail: msg });
        patch({ phase: "error", error: msg });
        return;
      }

      const merged = mergeExtracted(extracted);
      const totalPages = merged.pages.length;
      const emptyPages = extracted.reduce((n, f) => n + f.emptyPages, 0);
      if (totalPages > MAX_PAGES) {
        const msg = `That's ${totalPages} pages — the limit is ${MAX_PAGES} per run.`;
        step({ id: "read", label: "Reading files", status: "error", detail: msg });
        patch({ phase: "error", error: msg });
        return;
      }
      const usable = merged.pages.filter((p) => p.text.trim().length > 0);
      if (!usable.length) {
        const msg = "No selectable text — these look like scanned images, which need OCR first.";
        step({ id: "read", label: "Reading files", status: "error", detail: msg });
        patch({ phase: "error", error: msg });
        return;
      }

      step({
        id: "read",
        label: "Reading files",
        status: "done",
        detail: `${totalPages} page${totalPages === 1 ? "" : "s"} across ${files.length} file${
          files.length === 1 ? "" : "s"
        }${emptyPages ? ` · ${emptyPages} page${emptyPages === 1 ? "" : "s"} without text` : ""}`,
      });
      if (emptyPages / Math.max(1, totalPages) > 0.3) {
        step({
          id: "scan-warning",
          label: "Partially scanned document",
          status: "done",
          detail: `${emptyPages} of ${totalPages} pages have no selectable text and will not be summarized — they likely need OCR.`,
        });
      }
      patch({ phase: "thinking", pageCount: totalPages });


      // ------------------------------------------------------------- upload --
      const runId = crypto.randomUUID();
      const sourceKeys: string[] = [];
      step({ id: "upload", label: "Filing the originals", status: "running" });
      try {
        const urls = await getSummaryUploadUrls({
          data: { runId, files: files.map((f) => ({ name: f.name })) },
        });
        await Promise.all(
          urls.map(async (u, i) => {
            const res = await fetch(u.url, { method: "PUT", body: files[i]! });
            if (res.ok) sourceKeys.push(u.key);
          }),
        );
        step({
          id: "upload",
          label: "Filing the originals",
          status: "done",
          detail: `${sourceKeys.length} file${sourceKeys.length === 1 ? "" : "s"} stored`,
        });
      } catch {
        step({
          id: "upload",
          label: "Filing the originals",
          status: "done",
          detail: "Skipped — summary will still be saved",
        });
      }

      // ------------------------------------------------------------- stream --
      let model = "";
      let sectionCount = 0;
      let durationMs: number | null = null;
      let summaryText = "";
      let failed = false;

      await streamSSE(
        "/api/summarize",
        {
          title,
          pages: merged.pages,
          ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
          ...(matter ? { matter_label: matter.label } : {}),
          mode,
        },
        (evt) => {
          const d = (evt.data ?? {}) as Record<string, unknown>;
          switch (evt.event) {
            case "run":
              model = String(d["model"] ?? "");
              break;
            case "engine":
              // consumed silently — the rail shows work steps, not provider commentary
              break;
            case "plan":
              sectionCount = Number(d["sections"] ?? 0);
              step({
                id: "plan",
                label: "Planning the read",
                status: "done",
                detail: String(d["note"] ?? ""),
                meta: `${sectionCount} pass${sectionCount === 1 ? "" : "es"}`,
              });
              break;
            case "section":
              step({
                id: `sec-${d["index"]}`,
                label: `Pass ${d["index"]} · pages ${d["from_page"]}–${d["to_page"]}`,
                status: "running",
              });
              break;
            case "section_done":
              step({
                id: `sec-${d["index"]}`,
                label: `Pass ${d["index"]} · pages ${d["from_page"]}–${d["to_page"]}`,
                status: "done",
                ...(d["tier"] ? { meta: String(d["tier"]) } : {}),
              });
              break;
            case "scan":
              step({
                id: "scan",
                label: "Scanning the page map",
                status: "done",
                detail: `${d["pages"]} pages profiled — ${d["critical"]} dense section${
                  d["critical"] === 1 ? "" : "s"
                }, ${d["skim"]} low-signal`,
              });
              break;
            case "route": {
              const qs = Array.isArray(d["questions"]) ? (d["questions"] as string[]) : [];
              setState((s2) => ({ ...s2, questions: qs }));
              step({
                id: "route",
                label: "Routing the read",
                status: "done",
                detail: `${String(d["doc_type"] ?? "Document")} — ${qs.length} question${
                  qs.length === 1 ? "" : "s"
                } to answer`,
                ...(d["routed"] === false ? { meta: "local" } : {}),
              });
              break;
            }
            case "verify":
              step({
                id: "verify",
                label: "Verifying facts against the source pages",
                status: String(d["status"]) === "done" ? "done" : "running",
                detail:
                  String(d["status"]) === "done"
                    ? `${d["confirmed"]} confirmed · ${d["reanchored"]} re-anchored · ${d["unsupported"]} dropped`
                    : `${d["claims"]} claim${d["claims"] === 1 ? "" : "s"} re-checked`,
              });
              break;
            case "gaps": {
              const list = Array.isArray(d["unsupported"]) ? (d["unsupported"] as Gap[]) : [];
              setState((s2) => ({ ...s2, gaps: list }));
              break;
            }
            case "prune":
              step({
                id: "prune",
                label: "Skipping boilerplate",
                status: "done",
                detail: String(d["note"] ?? ""),
              });
              break;
            case "sweep":
              step({
                id: "sweep",
                label: "Sweeping high-value pages",
                status: String(d["status"]) === "done" ? "done" : "running",
                detail:
                  String(d["status"]) === "done"
                    ? `${d["found"]} extra fact${d["found"] === 1 ? "" : "s"} recovered`
                    : `${d["pages"]} page${d["pages"] === 1 ? "" : "s"} re-read`,
              });
              break;
            case "ledger":
              step({
                id: "ledger",
                label: "Building the fact ledger",
                status: "done",
                meta: `${d["total"]} facts`,
              });
              break;
            case "facts": {
              const list = Array.isArray(d["facts"]) ? (d["facts"] as LedgerFact[]) : [];
              setState((s) => ({ ...s, facts: list }));
              break;
            }
            case "conflict": {
              const list = Array.isArray(d["conflicts"]) ? (d["conflicts"] as Conflict[]) : [];
              setState((s) => ({ ...s, conflicts: list }));
              if (list.length) {
                step({
                  id: "conflict",
                  label: "Auditing for contradictions",
                  status: "done",
                  meta: `${list.length} flagged`,
                });
              }
              break;
            }
            case "coverage": {
              const cov = {
                critical: Number(d["critical"] ?? 0),
                covered: Number(d["covered"] ?? 0),
                anchors: Number(d["anchors"] ?? 0),
                bad_anchors: Number(d["bad_anchors"] ?? 0),
              };
              setState((s) => ({ ...s, coverage: cov }));
              step({
                id: "coverage",
                label: "Coverage check",
                status: "done",
                detail: `${cov.covered}/${cov.critical} critical facts carried into the memo · ${cov.anchors} page citations${
                  cov.bad_anchors ? ` · ${cov.bad_anchors} out of range` : ""
                }`,
              });
              break;
            }
            case "reduce":
              step({
                id: `reduce-${d["level"]}`,
                label: `Consolidating ${d["from"]} digests`,
                status: "done",
                detail: `Folded into ${d["groups"]} group${d["groups"] === 1 ? "" : "s"}`,
              });
              break;
            case "writer_start":
              step({ id: "write", label: "Drafting the summary", status: "running" });
              setState((s) => ({ ...s, phase: "writing" }));
              break;
            case "delta":
              summaryText += String(d["text"] ?? "");
              setState((s) => ({ ...s, summary: s.summary + String(d["text"] ?? "") }));
              break;
            case "done":
              durationMs = Number(d["duration_ms"] ?? 0);
              step({
                id: "write",
                label: "Drafting the summary",
                status: "done",
                detail: `${Math.round((Number(d["duration_ms"] ?? 0) / 1000) * 10) / 10}s · ${d["pages"]} pages read`,
              });
              break;
            case "error": {
              failed = true;
              const msg = String(d["message"] ?? "Summarization failed.");
              setState((s) => ({ ...s, phase: "error", error: msg }));
              step({ id: "write", label: "Drafting the summary", status: "error", detail: msg });
              break;
            }
            default:
              break;
          }
        },
        controller.signal,
      );

      if (failed || controller.signal.aborted) return;

      setState((s) => ({ ...s, phase: "done", durationMs }));

      // --------------------------------------------------------------- save --
      try {
        const saved = await saveDocSummary({
          data: {
            title,
            matterId: null,
            matterSlug: null,
            matterLabel: matter?.label ?? null,
            sourceKind: extracted.length === 1 ? extracted[0]!.kind : "mixed",
            fileNames: files.map((f) => f.name),
            pageCount: totalPages,
            charCount: extracted.reduce((n, f) => n + f.charCount, 0),
            sectionCount,
            model,
            summaryMd: summaryText,
            sectionDigests: [],
            sourceKeys,
            ownerEmail: ownerEmail ?? null,
            durationMs,
          },
        });
        setState((s) => ({ ...s, savedId: saved.summary_id }));
      } catch {
        /* the summary is on screen either way */
      }
    },
    [matter, ownerEmail, mode, patch, step],
  );

  return { state, start, cancel, reset, setState };
}
