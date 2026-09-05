// ============================================================================
// Server-only helpers for webhook-driven docket auto-updates.
//
// Webhook handlers do three things only: authenticate, deduplicate, persist.
// All heavy work (fetching PDFs, building ETL v1 batches, embedding) happens
// in scripts/pipeline/refresh_dockets.py, which drains corpus.docket_events.
// ============================================================================
import { restInsert, restPatch, restSelect } from "@/lib/ingest/store.server";

/** Shared secret used by both providers; sent as header or ?token=. */
function webhookSecret(): string | null {
  return process.env["DOCKET_WEBHOOK_SECRET"] ?? null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Returns an error Response when the caller is not our provider. */
export function requireWebhookAuth(request: Request): Response | null {
  const expected = webhookSecret();
  if (!expected) {
    return Response.json({ error: "webhook_disabled" }, { status: 503 });
  }
  const url = new URL(request.url);
  const got =
    request.headers.get("x-docket-webhook-secret") ??
    url.searchParams.get("token") ??
    "";
  if (!timingSafeEqual(got, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export type WatchRow = {
  watch_id: string;
  matter_id: string;
  matter_slug: string;
  docket_source: string;
  court_id: string;
  docket_number: string;
  cl_docket_id: number | null;
  cl_alert_id: number | null;
  db_docket_id: string | null;
  status: string;
  last_event_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  failure_count: number;
};

export async function findWatchByClDocket(id: number): Promise<WatchRow | null> {
  const rows = await restSelect<WatchRow[]>(
    `corpus_docket_watches?select=*&cl_docket_id=eq.${id}&limit=1`,
  );
  return rows[0] ?? null;
}

export async function findWatchByDbDocket(id: string): Promise<WatchRow | null> {
  const rows = await restSelect<WatchRow[]>(
    `corpus_docket_watches?select=*&db_docket_id=eq.${encodeURIComponent(id)}&limit=1`,
  );
  return rows[0] ?? null;
}

export type RecordedEvent = { event_id: string; duplicate: boolean };

/**
 * Idempotent event write. A repeat delivery (same provider + event id) is a
 * no-op — providers retry aggressively and must never double-ingest.
 */
export async function recordEvent(args: {
  provider: "courtlistener" | "docketbird" | "reconcile";
  providerEventId: string;
  watch: WatchRow | null;
  clDocketId?: number | null;
  dbDocketId?: string | null;
  payload: unknown;
}): Promise<RecordedEvent> {
  const existing = await restSelect<{ event_id: string }[]>(
    `corpus_docket_events?select=event_id&provider=eq.${args.provider}` +
      `&provider_event_id=eq.${encodeURIComponent(args.providerEventId)}&limit=1`,
  );
  if (existing[0]) return { event_id: existing[0].event_id, duplicate: true };

  const inserted = await restInsert<{ event_id: string }[]>("corpus_docket_events", {
    provider: args.provider,
    provider_event_id: args.providerEventId,
    watch_id: args.watch?.watch_id ?? null,
    matter_slug: args.watch?.matter_slug ?? null,
    cl_docket_id: args.clDocketId ?? args.watch?.cl_docket_id ?? null,
    db_docket_id: args.dbDocketId ?? args.watch?.db_docket_id ?? null,
    payload: args.payload,
    status: "pending",
  });

  if (args.watch) {
    await restPatch(`corpus_docket_watches?watch_id=eq.${args.watch.watch_id}`, {
      last_event_at: new Date().toISOString(),
    }).catch(() => undefined);
  }
  return { event_id: inserted[0]?.event_id ?? "", duplicate: false };
}

/** First non-empty value at any of the given dotted paths. */
export function pick(payload: unknown, paths: string[]): unknown {
  for (const path of paths) {
    let cur: unknown = payload;
    for (const part of path.split(".")) {
      if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        cur = undefined;
        break;
      }
    }
    if (cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return undefined;
}

export function asNumber(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}
