// Server-only storage for document summaries (corpus bridge view + S3 uploads).
import { corpusUrl, MATTERS_BUCKET } from "@/lib/corpus";
import type { SectionDigest } from "@/lib/agents/summarizer.server";

const VIEW = "corpus_doc_summaries";

export type SummaryRecord = {
  summary_id: string;
  matter_id: string | null;
  matter_slug: string | null;
  matter_label: string | null;
  title: string;
  source_kind: string | null;
  file_names: string[];
  page_count: number;
  char_count: number;
  section_count: number;
  model: string | null;
  summary_md: string;
  section_digests: SectionDigest[];
  source_keys: string[];
  owner_email: string | null;
  duration_ms: number | null;
  created_at: string;
};

function key(): string {
  const k = process.env["CORPUS_SERVICE_KEY"];
  if (!k) throw new Error("Corpus key not configured");
  return k;
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const k = key();
  return fetch(`${corpusUrl()}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: k,
      Authorization: `Bearer ${k}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

const LIST_COLS =
  "summary_id,title,matter_slug,matter_label,source_kind,file_names,page_count,section_count,model,created_at,duration_ms";

export async function listSummaries(limit = 30): Promise<Partial<SummaryRecord>[]> {
  const res = await rest(
    `${VIEW}?select=${LIST_COLS}&order=created_at.desc&limit=${Math.min(limit, 100)}`,
  );
  if (!res.ok) throw new Error(`summaries list failed: ${res.status}`);
  return (await res.json()) as Partial<SummaryRecord>[];
}

export async function getSummary(id: string): Promise<SummaryRecord | null> {
  const res = await rest(`${VIEW}?select=*&summary_id=eq.${encodeURIComponent(id)}&limit=1`);
  if (!res.ok) throw new Error(`summary read failed: ${res.status}`);
  const rows = (await res.json()) as SummaryRecord[];
  return rows[0] ?? null;
}

export async function deleteSummary(id: string): Promise<void> {
  const res = await rest(`${VIEW}?summary_id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`summary delete failed: ${res.status}`);
}

export type SaveSummaryInput = {
  title: string;
  matterId?: string | null;
  matterSlug?: string | null;
  matterLabel?: string | null;
  sourceKind: string;
  fileNames: string[];
  pageCount: number;
  charCount: number;
  sectionCount: number;
  model: string;
  summaryMd: string;
  sectionDigests: SectionDigest[];
  sourceKeys: string[];
  ownerEmail?: string | null;
  durationMs?: number | null;
};

export async function saveSummary(input: SaveSummaryInput): Promise<{ summary_id: string }> {
  const res = await rest(VIEW, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      title: input.title.slice(0, 300),
      matter_id: input.matterId ?? null,
      matter_slug: input.matterSlug ?? null,
      matter_label: input.matterLabel ?? null,
      source_kind: input.sourceKind,
      file_names: input.fileNames,
      page_count: input.pageCount,
      char_count: input.charCount,
      section_count: input.sectionCount,
      model: input.model,
      summary_md: input.summaryMd,
      section_digests: input.sectionDigests,
      source_keys: input.sourceKeys,
      owner_email: input.ownerEmail ?? null,
      duration_ms: input.durationMs ?? null,
    }),
  });
  if (!res.ok) throw new Error(`summary save failed: ${res.status} ${await res.text()}`);
  const [row] = (await res.json()) as { summary_id: string }[];
  return row!;
}

/** Presigned PUTs for the original files, kept under _summaries/<runId>/. */
export async function summaryUploadUrls(
  runId: string,
  files: { name: string }[],
): Promise<{ name: string; key: string; url: string }[]> {
  const { presignS3Put } = await import("./s3.server");
  const safe = (n: string) => n.replace(/[^A-Za-z0-9._()\- ]/g, "_").replace(/^\/+/, "");
  const clean = runId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) || "run";
  const out: { name: string; key: string; url: string }[] = [];
  for (const f of files.slice(0, 50)) {
    const objectKey = `_summaries/${clean}/${safe(f.name)}`;
    out.push({
      name: f.name,
      key: objectKey,
      url: await presignS3Put(MATTERS_BUCKET, objectKey, 3600),
    });
  }
  return out;
}

/** Signed GET for a stored source file. */
export async function summaryFileUrl(objectKey: string): Promise<string> {
  const { presignS3Get } = await import("./s3.server");
  return presignS3Get(MATTERS_BUCKET, objectKey, 3600);
}
