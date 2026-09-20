// ============================================================================
// Legal Archive + Corpus Workbench client (server only).
//
// Reaches the archive through the platform's own distribution
// (LEGAL_ARCHIVE_URL + /archive-api, /workbench-api) carrying the gateway's
// app key. Every call is GET, bounded by a timeout, retried once on a network
// failure (never on an upstream 4xx/5xx), and returns the upstream JSON
// verbatim plus the archive's closed-layer signal. No caching here: the
// archive is local-disk fast and its answers carry validation state that a
// stale cache would hide.
// ============================================================================
import { buildUpstreamUrl, isAllowedArchivePath, isAllowedWorkbenchPath, isClosedLayer, type JsonValue } from "./policy";

export type ArchiveConfig = { baseUrl: string; appKey: string };

export function archiveConfig(): ArchiveConfig | null {
  const baseUrl = (process.env["LEGAL_ARCHIVE_URL"] ?? "").trim();
  const appKey = (process.env["ARCHIVE_APP_KEY"] ?? "").trim();
  if (!baseUrl || !appKey) return null;
  return { baseUrl, appKey };
}

export const archiveEnabled = (): boolean => archiveConfig() !== null;

export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly upstreamPath: string,
  ) {
    super(message);
    this.name = "ArchiveError";
  }
}

export type ArchiveResult<T = unknown> = { ok: true; data: T; closed: false } | { ok: true; data: { available: false; reason?: string }; closed: true };

type Query = URLSearchParams | Record<string, string | number | boolean | undefined>;

async function getJson<T>(prefix: "/archive-api" | "/workbench-api", path: string, query: Query | undefined, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ArchiveResult<T>> {
  const config = archiveConfig();
  if (!config) throw new ArchiveError("legal archive not configured", 503, path);
  const allowed = prefix === "/archive-api" ? isAllowedArchivePath(path) : isAllowedWorkbenchPath(path);
  if (!allowed) throw new ArchiveError(`path not allowed: ${path}`, 403, path);
  const params = query instanceof URLSearchParams ? query : Object.fromEntries(Object.entries(query ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  const url = buildUpstreamUrl(config.baseUrl, prefix, path, params);
  const timeoutMs = opts.timeoutMs ?? 20_000;

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { "X-Archive-App-Key": config.appKey, Accept: "application/json", "Accept-Encoding": "gzip" },
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = (await response.text().catch(() => "")).slice(0, 300);
        throw new ArchiveError(`archive ${response.status} on ${path}${text ? `: ${text}` : ""}`, response.status, path);
      }
      const data = (await response.json()) as T;
      if (isClosedLayer(data)) return { ok: true, data, closed: true };
      return { ok: true, data, closed: false };
    } catch (error) {
      lastError = error;
      // Upstream said no (or the caller cancelled): do not retry.
      if (error instanceof ArchiveError || opts.signal?.aborted) throw error;
      if (attempt === 1) break;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ArchiveError(`archive unreachable on ${path}: ${message}`, 502, path);
}

/** GET an archive endpoint (allow-listed in policy.ts). */
export const archiveGet = <T = unknown>(path: string, query?: Query, opts?: { timeoutMs?: number; signal?: AbortSignal }) => getJson<T>("/archive-api", path, query, opts);

/** GET a workbench endpoint (allow-listed in policy.ts). */
export const workbenchGet = <T = unknown>(path: string, query?: Query, opts?: { timeoutMs?: number; signal?: AbortSignal }) => getJson<T>("/workbench-api", path, query, opts);

// --- Health snapshot for the Sources & Coverage page ---------------------------------------

export type LayerStatus = { id: string; ready: boolean; label?: string; detail?: string };

export type ArchiveHealth = {
  configured: boolean;
  reachable: boolean;
  checkedAt: string;
  summary: JsonValue | null;
  supplements: LayerStatus[];
  workbench: { reachable: boolean; health: JsonValue | null };
  error: string | null;
};

function normalizeSupplements(payload: unknown): LayerStatus[] {
  const list = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>)["supplements"]) ? ((payload as Record<string, unknown>)["supplements"] as unknown[]) : [];
  return list
    .map((row) => {
      const o = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
      const id = String(o["id"] ?? o["name"] ?? o["layer"] ?? "");
      if (!id) return null;
      const ready = o["ready"] === true || o["available"] === true || o["status"] === "ready";
      const label = typeof o["title"] === "string" ? o["title"] : typeof o["label"] === "string" ? o["label"] : undefined;
      const detail = typeof o["reason"] === "string" ? o["reason"] : typeof o["hash"] === "string" ? `hash ${o["hash"].slice(0, 12)}` : undefined;
      return { id, ready, ...(label ? { label } : {}), ...(detail ? { detail } : {}) };
    })
    .filter((x): x is LayerStatus => x !== null);
}

/** One round trip each to the archive summary, the layer readiness list and the workbench health. Never throws. */
export async function archiveHealth(signal?: AbortSignal): Promise<ArchiveHealth> {
  const checkedAt = new Date().toISOString();
  if (!archiveEnabled()) {
    return { configured: false, reachable: false, checkedAt, summary: null, supplements: [], workbench: { reachable: false, health: null }, error: "LEGAL_ARCHIVE_URL / ARCHIVE_APP_KEY not set" };
  }
  const [summary, supplements, wb] = await Promise.allSettled([
    archiveGet<JsonValue>("/api/summary", undefined, { timeoutMs: 15_000, signal }),
    archiveGet("/api/supplements", undefined, { timeoutMs: 15_000, signal }),
    workbenchGet<JsonValue>("/api/health", undefined, { timeoutMs: 10_000, signal }),
  ]);
  const firstError = [summary, supplements].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  return {
    configured: true,
    reachable: summary.status === "fulfilled" || supplements.status === "fulfilled",
    checkedAt,
    summary: summary.status === "fulfilled" ? summary.value.data : null,
    supplements: supplements.status === "fulfilled" ? normalizeSupplements(supplements.value.data) : [],
    workbench: { reachable: wb.status === "fulfilled", health: wb.status === "fulfilled" ? wb.value.data : null },
    error: firstError ? (firstError.reason instanceof Error ? firstError.reason.message : String(firstError.reason)) : null,
  };
}
