// Server-only pipeline observability helpers (corpus reads via service key).
import { restSelect } from "@/lib/ingest/store.server";

/** Exact-match owner allowlist. ADMIN_EMAILS may add addresses, never widen. */
export function adminEmails(): string[] {
  const extra = (process.env["ADMIN_EMAILS"] ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(["fshaher@seegerweiss.com", ...extra])];
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().includes(email.trim().toLowerCase());
}

export type BatchRow = {
  batch_id: string;
  matter_slug: string;
  status: string;
  stage: string | null;
  counts: Record<string, unknown> | null;
  error: string | null;
  submitted_by: string | null;
  created_at: string;
  updated_at: string | null;
  completed_at: string | null;
};

export type RejectRow = {
  batch_id: string;
  record_id: string | null;
  slot: string | null;
  code: string;
  message: string;
  created_at: string;
};

export type MatterHealth = Record<string, unknown> & { slug: string };

export async function listBatches(limit = 25): Promise<BatchRow[]> {
  return restSelect<BatchRow[]>(
    `corpus_ingest_batches?select=*&order=created_at.desc&limit=${limit}`,
  );
}

export async function listRecentRejects(limit = 50): Promise<RejectRow[]> {
  return restSelect<RejectRow[]>(
    `corpus_ingest_rejects?select=*&order=created_at.desc&limit=${limit}`,
  );
}

export async function matterHealth(): Promise<MatterHealth[]> {
  return restSelect<MatterHealth[]>(`corpus_matter_health?select=*`);
}

/** A queued batch older than this means no worker is attached. */
const QUEUED_STALL_MS = 15 * 60 * 1000;
/** A running batch silent this long means the worker died mid-run. */
const RUNNING_STALL_MS = 30 * 60 * 1000;

export function summarize(batches: BatchRow[]) {
  const by = (s: string) => batches.filter((b) => b.status === s).length;
  const now = Date.now();
  const age = (iso: string | null) => (iso ? now - new Date(iso).getTime() : 0);

  const queued = batches.filter((b) => b.status === "queued");
  const running = batches.filter((b) => b.status === "running");
  const oldestQueuedMs = Math.max(0, ...queued.map((b) => age(b.created_at)));
  const stalestRunningMs = Math.max(0, ...running.map((b) => age(b.updated_at ?? b.created_at)));

  const level: "ok" | "warn" | "bad" =
    stalestRunningMs > RUNNING_STALL_MS ? "bad" : oldestQueuedMs > QUEUED_STALL_MS ? "warn" : "ok";

  return {
    total: batches.length,
    queued: queued.length,
    running: running.length,
    completed: by("completed"),
    failed: by("failed"),
    validated: by("validated"),
    pending: queued.length + running.length,
    oldest_queued_ms: oldestQueuedMs,
    stalest_running_ms: stalestRunningMs,
    queue_level: level,
    queue_message:
      level === "bad"
        ? "A batch has been running with no progress for over 30 minutes — the worker likely crashed. Restart it: python3 scripts/pipeline/run_batch.py --poll 30"
        : level === "warn"
          ? "A batch has sat queued for over 15 minutes — no worker appears to be attached. Start one: python3 scripts/pipeline/run_batch.py --poll 30"
          : queued.length + running.length > 0
            ? "Work in flight; a worker is picking batches up."
            : "Queue is clear.",
  };
}

// -------------------------------------------------- docket auto-update ----
export type WatchSummaryRow = {
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
};

export type EventRow = {
  event_id: string;
  provider: string;
  matter_slug: string | null;
  status: string;
  attempts: number;
  batch_id: string | null;
  error: string | null;
  received_at: string;
  processed_at: string | null;
};

export async function docketWatchOverview() {
  const [watches, events, pending] = await Promise.all([
    restSelect<WatchSummaryRow[]>(
      `corpus_docket_watches?select=matter_slug,docket_source,court_id,docket_number,cl_docket_id,cl_alert_id,db_docket_id,status,last_event_at,last_sync_at,last_error&order=matter_slug`,
    ).catch(() => [] as WatchSummaryRow[]),
    restSelect<EventRow[]>(
      `corpus_docket_events?select=event_id,provider,matter_slug,status,attempts,batch_id,error,received_at,processed_at&order=received_at.desc&limit=40`,
    ).catch(() => [] as EventRow[]),
    restSelect<{ pending_id: number }[]>(
      `corpus_pdf_pending?select=pending_id&resolved_at=is.null&limit=1000`,
    ).catch(() => [] as { pending_id: number }[]),
  ]);

  const count = (rows: { status: string }[], s: string) => rows.filter((r) => r.status === s).length;
  return {
    watches,
    events,
    summary: {
      watches_total: watches.length,
      watches_active: count(watches, "active"),
      watches_unresolved: count(watches, "unresolved"),
      events_pending: count(events, "pending"),
      events_failed: count(events, "failed"),
      events_ingested: count(events, "ingested"),
      pdf_pending: pending.length,
    },
  };
}
