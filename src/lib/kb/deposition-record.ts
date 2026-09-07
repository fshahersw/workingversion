// Durable deposition record: the verified analysis (findings, contradictions,
// graph) plus the transcript manifest it was computed over. Stored as one
// versioned JSON object next to the workspace's pages in S3 and referenced from
// the DynamoDB workspace item. Pure module: shared by the browser hook (build,
// hydrate) and the server function (validate, accept/reject stale writes).
// Relative .ts imports: this module runs under `node --test` without a bundler.
import { EMPTY_ANALYSIS, parseDepAnalysis, type DepAnalysis } from "../pile/deposition-analysis.ts";
import type { TranscriptLine } from "../pile/transcript.ts";
import type { PileHit } from "../pile/types.ts";
import type { KbAskSource } from "./kb-client.ts";

export const DEPOSITION_RECORD_VERSION = 1;

/** Hard cap on the serialized record. Analyses are tens to hundreds of KB. */
export const DEPOSITION_RECORD_MAX_BYTES = 8 * 1024 * 1024;

export type DepositionRecordPass = "case" | "record" | "connections" | "cross";
export type DepositionRecordPassStatus = "idle" | "running" | "done" | "error";

export type DepositionRecordTranscript = {
  /** KB document id once bound; the browser file id before that. */
  docId: string;
  fileName: string;
  witness: string;
  citeReady: boolean;
  lineCount: number;
};

export type DepositionRecord = {
  version: typeof DEPOSITION_RECORD_VERSION;
  /** One analyze() invocation. A newer run must never be overwritten by an older one. */
  runId: string;
  runStartedAt: number;
  savedAt: string;
  /** True once every pass for this run has settled (done or error). */
  complete: boolean;
  instructions: string;
  transcripts: DepositionRecordTranscript[];
  passes: Record<DepositionRecordPass, DepositionRecordPassStatus>;
  analysis: DepAnalysis;
};

const PASSES: DepositionRecordPass[] = ["case", "record", "connections", "cross"];
const PASS_STATUSES = new Set<DepositionRecordPassStatus>(["idle", "running", "done", "error"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // Drop control characters (newlines survive), then collapse runs of spaces.
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]+/g, " ")
    .replace(/[^\S\n]{2,}/g, " ")
    .trim()
    .slice(0, max);
}

function passesFrom(raw: unknown): Record<DepositionRecordPass, DepositionRecordPassStatus> {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<DepositionRecordPass, DepositionRecordPassStatus>;
  for (const pass of PASSES) {
    const status = source[pass];
    out[pass] = PASS_STATUSES.has(status as DepositionRecordPassStatus)
      ? (status as DepositionRecordPassStatus)
      : "idle";
  }
  return out;
}

function transcriptsFrom(raw: unknown): DepositionRecordTranscript[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) return null;
  const out: DepositionRecordTranscript[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const o = entry as Record<string, unknown>;
    const docId = cleanString(o.docId, 128);
    const fileName = cleanString(o.fileName, 256);
    if (!docId || !fileName) return null;
    out.push({
      docId,
      fileName,
      witness: cleanString(o.witness, 200),
      citeReady: o.citeReady === true,
      lineCount:
        typeof o.lineCount === "number" && Number.isSafeInteger(o.lineCount) && o.lineCount >= 0
          ? o.lineCount
          : 0,
    });
  }
  return out;
}

/**
 * Validate an untrusted record. Returns null when the envelope is malformed.
 * The analysis body is normalized through the same parser the model output
 * goes through, so unknown or malformed fields are dropped rather than stored.
 */
export function parseDepositionRecord(raw: unknown): DepositionRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== DEPOSITION_RECORD_VERSION) return null;
  const runId = cleanString(o.runId, 64);
  if (!UUID.test(runId)) return null;
  const runStartedAt = o.runStartedAt;
  if (typeof runStartedAt !== "number" || !Number.isSafeInteger(runStartedAt) || runStartedAt <= 0) {
    return null;
  }
  const transcripts = transcriptsFrom(o.transcripts);
  if (!transcripts) return null;
  if (!o.analysis || typeof o.analysis !== "object") return null;
  const analysisRaw = o.analysis as Record<string, unknown>;
  const analysis = parseDepAnalysis(JSON.stringify(analysisRaw));
  const dropped =
    typeof analysisRaw.dropped === "number" && analysisRaw.dropped >= 0
      ? Math.floor(analysisRaw.dropped)
      : 0;
  const savedAtRaw = cleanString(o.savedAt, 40);
  const savedAt = Number.isNaN(Date.parse(savedAtRaw)) ? new Date().toISOString() : savedAtRaw;
  return {
    version: DEPOSITION_RECORD_VERSION,
    runId,
    runStartedAt,
    savedAt,
    complete: o.complete === true,
    instructions: cleanString(o.instructions, 5000),
    transcripts,
    passes: passesFrom(o.passes),
    analysis: { ...analysis, dropped },
  };
}

/**
 * Whether an incoming write may replace the stored record. A newer run always
 * wins; the same run may keep updating; an older run is ignored so a slow
 * request from a superseded analyze() cannot clobber a Re-run.
 */
export function acceptDepositionRecordWrite(
  existing: { runId: string; runStartedAt: number; complete: boolean } | null,
  incoming: { runId: string; runStartedAt: number },
): boolean {
  if (!existing) return true;
  if (existing.runId === incoming.runId) return true;
  return incoming.runStartedAt >= existing.runStartedAt;
}

export function buildDepositionRecord(input: {
  runId: string;
  runStartedAt: number;
  complete: boolean;
  instructions: string;
  transcripts: DepositionRecordTranscript[];
  passes: Record<DepositionRecordPass, DepositionRecordPassStatus>;
  analysis: DepAnalysis | null;
}): DepositionRecord {
  return {
    version: DEPOSITION_RECORD_VERSION,
    runId: input.runId,
    runStartedAt: input.runStartedAt,
    savedAt: new Date().toISOString(),
    complete: input.complete,
    instructions: input.instructions,
    transcripts: input.transcripts,
    passes: input.passes,
    analysis: input.analysis ?? EMPTY_ANALYSIS,
  };
}

/** Human-readable workspace name from the witnesses or file stems. */
export function depositionWorkspaceName(
  transcripts: { fileName: string; witness: string | null }[],
): string {
  const labels = transcripts
    .map((t) => (t.witness || t.fileName.replace(/\.[^.]+$/, "")).trim())
    .filter(Boolean);
  if (!labels.length) return "Deposition";
  const head = labels.slice(0, 3).join(", ");
  const rest = labels.length - 3;
  const joined = rest > 0 ? `${head} +${rest}` : head;
  return `${joined} · Deposition${labels.length > 1 ? "s" : ""}`.slice(0, 120);
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map KB sources back onto transcript hits so the deposition Ask panel keeps
 * its page:line cites. The chunk's first sentence is located within the
 * transcript's lines for that page; when it cannot be located the cite falls
 * back to the page's first line rather than inventing a line number.
 */
export function kbSourcesToDepositionHits(
  sources: KbAskSource[],
  transcripts: { fileId: string; docId: string; fileName: string; lines: TranscriptLine[] }[],
): PileHit[] {
  const byDoc = new Map(transcripts.map((t) => [t.docId, t]));
  const out: PileHit[] = [];
  for (const source of sources) {
    const transcript = byDoc.get(source.docId);
    if (!transcript) continue;
    const pageLines = transcript.lines.filter((line) => line.page === source.page);
    const probe = normalizeForMatch(source.text).split(" ").slice(0, 8).join(" ");
    let startLine = pageLines[0]?.line ?? 1;
    let endLine = pageLines[pageLines.length - 1]?.line ?? startLine;
    if (probe.length >= 12) {
      const idx = pageLines.findIndex((line) => {
        const n = normalizeForMatch(line.text);
        return n.length >= 6 && (probe.startsWith(n.slice(0, 24)) || n.includes(probe.slice(0, 24)));
      });
      if (idx >= 0) {
        startLine = pageLines[idx]!.line;
        endLine = pageLines[Math.min(pageLines.length - 1, idx + 6)]!.line;
      }
    }
    out.push({
      fileId: transcript.fileId,
      fileName: transcript.fileName,
      page: source.page,
      score: source.score,
      snippet: source.text.replace(/\s+/g, " ").slice(0, 220),
      cite: `${source.page}:${startLine}`,
      startLine,
      endLine,
    });
  }
  return out;
}
