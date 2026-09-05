// ============================================================================
// Compact, greppable server-side logging for the agent loop.
// Every line: `[agent] key=value key=value ...` so worker logs can be filtered
// by run id, agent, or stage. Never log source bodies or credentials.
// Each line is also tapped into the in-memory run-trace ring (trace.server.ts)
// that backs the Run Inspector — dev-gated, bounded, never throws.
// ============================================================================
import { recordTrace } from "./trace.server";

export function trunc(value: unknown, max = 160): string {
  const s = typeof value === "string" ? value : String(value ?? "");
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = trunc(v);
  return /[\s"]/.test(s) ? JSON.stringify(s) : s || "-";
}

export type Fields = Record<string, unknown>;

/** One structured log line. Undefined fields are dropped. */
export function agentLog(stage: string, fields: Fields = {}): void {
  const parts = [`stage=${stage}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${fmt(v)}`);
  }
  console.log(`[agent] ${parts.join(" ")}`);
  recordTrace(stage, fields, "log");
}

/** Same shape, routed to console.error so failures stand out. */
export function agentError(stage: string, fields: Fields = {}): void {
  const parts = [`stage=${stage}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${fmt(v)}`);
  }
  console.error(`[agent] ${parts.join(" ")}`);
  recordTrace(stage, fields, "error");
}

/** Milliseconds since a start marker, rounded. */
export function since(startedAt: number): number {
  return Math.round(Date.now() - startedAt);
}
