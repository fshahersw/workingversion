// ============================================================================
// Amazon Bedrock Data Automation (BDA) client — server-only.
//
// Routes an uploaded document through the firm's `text-extraction` BDA project:
// OCR + whole-document Markdown (PAGE+ELEMENT granularity) + an AI-generated
// summary + per-table CSVs. This is the primary file-ingestion path (handles
// scanned PDFs and long docs); the code-interpreter extractor is the fast
// fallback for tiny/plain files.
//
// Flow: put bytes to S3 -> InvokeDataAutomationAsync -> poll GetDataAutomation-
// Status -> read the standard_output result.json from the output S3 prefix.
// Async by nature (seconds to minutes), so callers poll rather than block.
// ============================================================================
import {
  BedrockDataAutomationRuntimeClient,
  InvokeDataAutomationAsyncCommand,
  GetDataAutomationStatusCommand,
} from "@aws-sdk/client-bedrock-data-automation-runtime";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { BUCKET, s3 } from "@/lib/data/s3.server";

const REGION = process.env["BEDROCK_REGION"] ?? process.env["AWS_REGION"] ?? "us-east-1";
const ACCOUNT = process.env["AWS_ACCOUNT_ID"] ?? "475976462949";
const PROJECT_ARN =
  process.env["BDA_PROJECT_ARN"] ??
  "arn:aws:bedrock:us-east-1:475976462949:data-automation-project/7df322dd90ae";
// BDA requires a cross-region data-automation profile ARN.
const PROFILE_ARN =
  process.env["BDA_PROFILE_ARN"] ??
  `arn:aws:bedrock:${REGION}:${ACCOUNT}:data-automation-profile/us.data-automation-v1`;

let _client: BedrockDataAutomationRuntimeClient | null = null;
function client(): BedrockDataAutomationRuntimeClient {
  return (_client ??= new BedrockDataAutomationRuntimeClient({ region: REGION }));
}

function s3Uri(key: string): string {
  return `s3://${BUCKET}/${key}`;
}

/** Upload raw bytes to the S3 input area. */
export async function putObject(key: string, body: Uint8Array, contentType?: string): Promise<void> {
  await s3().send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ...(contentType ? { ContentType: contentType } : {}) }),
  );
}

async function getJson(key: string): Promise<unknown> {
  const r = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const text = await r.Body?.transformToString();
  return text ? JSON.parse(text) : null;
}

async function getText(key: string): Promise<string> {
  const r = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return (await r.Body?.transformToString()) ?? "";
}

/** s3://bucket/key -> key (this bucket only). */
function keyOf(uri: string): string {
  const m = uri.match(/^s3:\/\/[^/]+\/(.+)$/);
  return m?.[1] ?? uri;
}

export type BdaJob = { invocationArn: string; outputPrefix: string };

/** Kick off async extraction of an S3 object. Returns the invocation ARN + the
 *  output prefix to read once complete. */
export async function startExtraction(inputKey: string, outputPrefix: string): Promise<BdaJob> {
  const res = await client().send(
    new InvokeDataAutomationAsyncCommand({
      inputConfiguration: { s3Uri: s3Uri(inputKey) },
      outputConfiguration: { s3Uri: s3Uri(outputPrefix) },
      dataAutomationConfiguration: { dataAutomationProjectArn: PROJECT_ARN, stage: "LIVE" },
      dataAutomationProfileArn: PROFILE_ARN,
    }),
  );
  return { invocationArn: res.invocationArn ?? "", outputPrefix };
}

export type BdaStatus = "Created" | "InProgress" | "Success" | "ServiceError" | "ClientError" | string;

export async function getStatus(invocationArn: string): Promise<{ status: BdaStatus; outputS3Uri?: string; error?: string }> {
  const r = await client().send(new GetDataAutomationStatusCommand({ invocationArn }));
  return {
    status: (r.status as BdaStatus) ?? "InProgress",
    ...(r.outputConfiguration?.s3Uri ? { outputS3Uri: r.outputConfiguration.s3Uri } : {}),
    ...(r.errorType || r.errorMessage ? { error: `${r.errorType ?? ""} ${r.errorMessage ?? ""}`.trim() } : {}),
  };
}

export type BdaResult = {
  markdown: string;
  summary: string;
  pages: number;
  tablesCsv: string[];
  raw?: unknown;
};

/** Read + parse the standard_output for a completed job. `outputS3Uri` is the
 *  job root returned by GetDataAutomationStatus; it contains job_metadata.json
 *  which points at the per-segment standard_output/result.json. */
export async function readResult(outputS3Uri: string, opts?: { includeRaw?: boolean }): Promise<BdaResult> {
  // GetDataAutomationStatus returns the job_metadata.json key directly.
  const metaKey = keyOf(outputS3Uri);
  const meta = (await getJson(metaKey).catch(() => null)) as
    | { output_metadata?: { segment_metadata?: { standard_output_path?: string }[] }[] }
    | null;

  // Collect every segment's standard_output result.json (usually one).
  const resultKeys: string[] = [];
  for (const om of meta?.output_metadata ?? []) {
    for (const seg of om.segment_metadata ?? []) {
      if (seg.standard_output_path) resultKeys.push(keyOf(seg.standard_output_path));
    }
  }
  if (!resultKeys.length) {
    // Fallback: derive from the metadata's own directory.
    const dir = metaKey.replace(/job_metadata\.json$/, "").replace(/\/$/, "");
    resultKeys.push(`${dir}/0/standard_output/0/result.json`);
  }

  let markdown = "";
  let summary = "";
  let pages = 0;
  const tablesCsv: string[] = [];
  let raw: unknown = null;

  for (const k of resultKeys) {
    const doc = (await getJson(k).catch(() => null)) as Record<string, unknown> | null;
    if (!doc) continue;
    if (opts?.includeRaw && !raw) raw = doc;
    markdown += extractMarkdown(doc);
    summary = summary || extractSummary(doc);
    pages += countPages(doc);
    for (const t of extractTables(doc)) tablesCsv.push(t);
  }

  return { markdown: markdown.trim(), summary: summary.trim(), pages, tablesCsv, ...(opts?.includeRaw ? { raw } : {}) };
}

// --- tolerant extractors (BDA result shape varies by version; keep defensive) ---
function extractMarkdown(doc: Record<string, unknown>): string {
  // Whole-doc markdown representation, else concatenate page markdown/text.
  const docRep = (doc["document"] as { representation?: { markdown?: string; text?: string } } | undefined)?.representation;
  if (docRep?.markdown) return docRep.markdown + "\n\n";
  const pages = (doc["pages"] as { representation?: { markdown?: string; text?: string } }[] | undefined) ?? [];
  const parts = pages.map((p, i) => {
    const rep = p.representation;
    const body = rep?.markdown ?? rep?.text ?? "";
    return body ? `\n\n[page ${i + 1}]\n${body}` : "";
  });
  if (parts.some(Boolean)) return parts.join("");
  if (docRep?.text) return docRep.text + "\n\n";
  return "";
}
function extractSummary(doc: Record<string, unknown>): string {
  const d = doc["document"] as Record<string, unknown> | undefined;
  const s = (d?.["summary"] ?? d?.["description"] ?? doc["summary"]) as unknown;
  return typeof s === "string" ? s : "";
}
function countPages(doc: Record<string, unknown>): number {
  const n = (doc["metadata"] as { number_of_pages?: number } | undefined)?.number_of_pages;
  if (typeof n === "number" && n > 0) return n;
  const pages = doc["pages"];
  return Array.isArray(pages) ? pages.length : 0;
}
function extractTables(doc: Record<string, unknown>): string[] {
  const out: string[] = [];
  const els = (doc["elements"] as { type?: string; representation?: { csv?: string; text?: string } }[] | undefined) ?? [];
  for (const e of els) {
    if ((e.type ?? "").toLowerCase() === "table") {
      const csv = e.representation?.csv ?? e.representation?.text;
      if (csv) out.push(csv);
    }
  }
  return out;
}

export function bdaEnabled(): boolean {
  return true;
}

export { keyOf as _keyOf, getText as _getText };
