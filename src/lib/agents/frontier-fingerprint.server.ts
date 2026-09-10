// ============================================================================
// §42 Duplicate-call prevention — deterministic tool-call fingerprints.
//
// Before executing a tool call the runtime computes
//   fingerprint = sha256(toolName + canonicalJson(args))
// If an identical fingerprint already completed this request, reuse the result;
// if one is in flight, await the same promise. This eliminates the most common
// agentic waste (re-running materially identical searches).
//
// canonicalJson gives args a stable string form regardless of key order, so
// {type:"r",query:"x"} and {query:"x",type:"r"} share a fingerprint.
//
// Server-only: uses node:crypto for the hash.
// ============================================================================
import { createHash } from "node:crypto";

/**
 * Deterministic JSON with recursively sorted object keys. Arrays keep their
 * order (order is meaningful); object key order is normalized (it is not).
 * undefined-valued keys are dropped (they carry no meaning in a tool call), and
 * non-finite numbers / unsupported types collapse to null.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "number") return Number.isFinite(value as number) ? String(value) : "null";
  if (t === "boolean") return (value as boolean) ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  // functions, symbols, bigint — not expected in tool args.
  return "null";
}

/** sha256 hex fingerprint of a tool call. Stable across arg key ordering. */
export function callFingerprint(tool: string, args: unknown): string {
  return createHash("sha256").update(`${tool}\n${canonicalJson(args)}`).digest("hex");
}
