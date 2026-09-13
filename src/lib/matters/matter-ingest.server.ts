// ============================================================================
// Auto-refresh a matter's Bedrock MANAGED knowledge base after the docket sync
// lands new PDFs in S3. Without this, files keep flowing to the corpus bucket
// but the vector index the agent queries (matter_corpus_search) stays frozen at
// the last manual ingestion.
//
// Control-plane StartIngestionJob on bedrock-agent (SigV4 service "bedrock",
// same signing name as the runtime endpoints). Incremental: Bedrock re-scans the
// data source's S3 prefix and only indexes new/changed objects. Best-effort — a
// matter with no KB link is skipped, and a 409 (a job already running for that
// data source) is a no-op, so the sync never fails on ingestion.
// ============================================================================
import { signedAwsFetch } from "@/lib/agents/bedrock-sign.server";
import { queryJson } from "@/lib/kb/aurora.server";

const REGION = process.env["BEDROCK_REGION"] ?? process.env["AWS_REGION"] ?? "us-east-1";

type MatterKbRef = { matterId: string; kbId: string; dataSourceId: string };

/** KB + data-source ids for the given matters that are linked and ingestable. */
async function kbRefsFor(matterIds: string[]): Promise<MatterKbRef[]> {
  const ids = new Set(matterIds.filter(Boolean));
  if (!ids.size) return [];
  const rows = await queryJson<MatterKbRef>(
    `SELECT matter_id AS "matterId", kb_id AS "kbId", kb_data_source_id AS "dataSourceId"
       FROM corpus.matters
      WHERE kb_id IS NOT NULL AND kb_id <> ''
        AND kb_data_source_id IS NOT NULL AND kb_data_source_id <> ''`,
  ).catch(() => [] as MatterKbRef[]);
  return rows.filter((r) => ids.has(r.matterId));
}

type IngestOutcome = { ok: boolean; status?: string; skipped?: boolean; error?: string };

/** Start one incremental ingestion job. 409 = a job is already running (no-op). */
async function startIngestionJob(kbId: string, dsId: string): Promise<IngestOutcome> {
  const url = `https://bedrock-agent.${REGION}.amazonaws.com/knowledgebases/${encodeURIComponent(
    kbId,
  )}/datasources/${encodeURIComponent(dsId)}/ingestionjobs/`;
  const res = await signedAwsFetch("bedrock", url, {
    method: "PUT",
    body: JSON.stringify({ description: `docket-sync auto-refresh ${new Date().toISOString()}` }),
  });
  if (res.ok) {
    const json = (await res.json().catch(() => ({}))) as {
      ingestionJob?: { status?: string };
    };
    return { ok: true, status: json.ingestionJob?.status };
  }
  const detail = await res.text().catch(() => "");
  if (res.status === 409 || /ConflictException|already\s+in\s+progress|ongoing/i.test(detail)) {
    return { ok: false, skipped: true };
  }
  return { ok: false, error: `[${res.status}] ${detail.slice(0, 200)}` };
}

/**
 * Kick off KB ingestion for each of `matterIds` that got new files. Deduped and
 * best-effort: logs each outcome, never throws. One job per data source; Bedrock
 * rejects a second concurrent job on the same source, which we treat as a no-op.
 */
export async function triggerMatterIngestion(matterIds: string[]): Promise<void> {
  const refs = await kbRefsFor(matterIds);
  for (const r of refs) {
    try {
      const out = await startIngestionJob(r.kbId, r.dataSourceId);
      if (out.ok) {
        console.error(
          `[matter-ingest] started matter=${r.matterId} kb=${r.kbId} status=${out.status ?? "?"}`,
        );
      } else if (out.skipped) {
        console.error(`[matter-ingest] skip matter=${r.matterId} kb=${r.kbId} (job already running)`);
      } else {
        console.error(`[matter-ingest] FAILED matter=${r.matterId} kb=${r.kbId}: ${out.error}`);
      }
    } catch (e) {
      console.error(
        `[matter-ingest] error matter=${r.matterId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
