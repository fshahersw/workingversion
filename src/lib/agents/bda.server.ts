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
import { loadBdaConfig } from "@/lib/config.server";
import { bucketName, s3 } from "@/lib/data/s3.server";
import { localSyntheticEnabled } from "../local-development";

let _client: BedrockDataAutomationRuntimeClient | null = null;
let _clientRegion = "";
function client(): BedrockDataAutomationRuntimeClient {
  if (localSyntheticEnabled()) throw new Error("AWS document extraction is unavailable in the local synthetic workspace.");
  const { region } = loadBdaConfig();
  if (!_client || _clientRegion !== region) {
    _client = new BedrockDataAutomationRuntimeClient({ region });
    _clientRegion = region;
  }
  return _client;
}

function s3Uri(key: string): string {
  return `s3://${bucketName()}/${key}`;
}

/** Upload raw bytes to the S3 input area. */
export async function putObject(
  key: string,
  body: Uint8Array,
  contentType?: string,
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: body,
      ...(contentType ? { ContentType: contentType } : {}),
    }),
  );
}

const MAX_RESULT_OBJECT_BYTES = 32 * 1024 * 1024;

async function getJson(key: string): Promise<unknown> {
  const r = await s3().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
  if (typeof r.ContentLength === "number" && r.ContentLength > MAX_RESULT_OBJECT_BYTES) {
    throw new Error("BDA result object exceeds the processing limit");
  }
  const text = await r.Body?.transformToString();
  return text ? JSON.parse(text) : null;
}

async function getText(key: string): Promise<string> {
  const r = await s3().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
  return (await r.Body?.transformToString()) ?? "";
}

/** Store a text blob (e.g. consolidated markdown) in S3. */
export async function putText(key: string, text: string): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: text,
      ContentType: "text/markdown; charset=utf-8",
    }),
  );
}

/** Keyword retrieval over a stored markdown doc in S3. Returns the best-matching
 *  passages (chunked by blank line / heading) so a long doc answers a query
 *  without injecting the whole thing into context. Runs server-side (durable;
 *  no sandbox dependency). */
export async function searchMarkdownKey(
  key: string,
  query: string,
  maxChars = 4000,
): Promise<string> {
  const text = await getText(key).catch(() => "");
  if (!text) return "";
  return searchText(text, query, maxChars);
}

export function searchText(text: string, query: string, maxChars = 4000): string {
  const q = (query || "").trim();
  if (!q) return text.slice(0, maxChars);
  const terms = Array.from(
    new Set((q.toLowerCase().match(/\w+/g) ?? []).filter((t) => t.length > 2)),
  );
  if (!terms.length) return text.slice(0, maxChars);
  const chunks = text
    .split(/\n\s*\n/)
    .map((c) => c.trim())
    .filter(Boolean);
  const scored = chunks
    .map((c) => {
      const cl = c.toLowerCase();
      const distinct = terms.reduce((n, t) => (cl.includes(t) ? n + 1 : n), 0);
      const total = terms.reduce((n, t) => n + cl.split(t).length - 1, 0);
      return { c, distinct, total };
    })
    .filter((s) => s.distinct > 0)
    .sort((a, b) => b.distinct - a.distinct || b.total - a.total);
  const picked: string[] = [];
  let used = 0;
  for (const s of scored) {
    const seg = s.c.slice(0, 1500);
    if (used + seg.length > maxChars) break;
    picked.push(seg);
    used += seg.length;
  }
  return picked.join("\n\n---\n\n");
}

/** s3://bucket/key -> key, rejecting any cross-bucket result pointer. */
function keyOf(uri: string): string {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return uri;
  if (match[1] !== bucketName()) {
    throw new Error("BDA result points outside the configured bucket");
  }
  return match[2]!;
}

export type BdaJob = { invocationArn: string; outputPrefix: string };
export type StartExtractionOptions = {
  /** Stable idempotency token. Supplying it enables EventBridge notifications. */
  clientToken?: string;
  eventBridgeEnabled?: boolean;
};

function requireClientToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{33,256}$/.test(token)) {
    throw new Error("invalid BDA client token");
  }
  return token;
}

/** Kick off async extraction of an S3 object. Returns the invocation ARN + the
 *  output prefix to read once complete. */
export async function startExtraction(
  inputKey: string,
  outputPrefix: string,
  options: StartExtractionOptions = {},
): Promise<BdaJob> {
  const config = loadBdaConfig();
  const eventBridgeEnabled = options.eventBridgeEnabled ?? Boolean(options.clientToken);
  if (eventBridgeEnabled && !options.clientToken) {
    throw new Error("EventBridge BDA jobs require a deterministic client token");
  }
  const res = await client().send(
    new InvokeDataAutomationAsyncCommand({
      inputConfiguration: { s3Uri: s3Uri(inputKey) },
      outputConfiguration: { s3Uri: s3Uri(outputPrefix) },
      dataAutomationConfiguration: {
        dataAutomationProjectArn: config.projectArn,
        stage: "LIVE",
      },
      dataAutomationProfileArn: config.profileArn,
      ...(options.clientToken ? { clientToken: requireClientToken(options.clientToken) } : {}),
      ...(eventBridgeEnabled
        ? {
            notificationConfiguration: {
              eventBridgeConfiguration: { eventBridgeEnabled: true },
            },
          }
        : {}),
    }),
  );
  return { invocationArn: res.invocationArn ?? "", outputPrefix };
}

export type BdaStatus =
  | "Created"
  | "InProgress"
  | "Success"
  | "ServiceError"
  | "ClientError"
  | string;

export async function getStatus(
  invocationArn: string,
): Promise<{ status: BdaStatus; outputS3Uri?: string; error?: string }> {
  const r = await client().send(new GetDataAutomationStatusCommand({ invocationArn }));
  const status = (r.status as BdaStatus) ?? "InProgress";
  return {
    status,
    ...(r.outputConfiguration?.s3Uri ? { outputS3Uri: r.outputConfiguration.s3Uri } : {}),
    ...(status === "ClientError" || status === "ServiceError"
      ? { error: "Document conversion failed." }
      : {}),
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
export async function readResult(
  outputS3Uri: string,
  opts?: { includeRaw?: boolean; expectedOutputPrefix?: string },
): Promise<BdaResult> {
  const requireExpectedPrefix = (key: string): string => {
    if (opts?.expectedOutputPrefix && !key.startsWith(opts.expectedOutputPrefix)) {
      throw new Error("BDA result points outside the owned output prefix");
    }
    return key;
  };
  // GetDataAutomationStatus returns the job_metadata.json key directly.
  const metaKey = requireExpectedPrefix(keyOf(outputS3Uri));
  const meta = (await getJson(metaKey).catch(() => null)) as {
    output_metadata?: { segment_metadata?: { standard_output_path?: string }[] }[];
  } | null;

  // Collect every segment's standard_output result.json (usually one).
  const resultKeys: string[] = [];
  for (const om of meta?.output_metadata ?? []) {
    for (const seg of om.segment_metadata ?? []) {
      if (seg.standard_output_path) {
        resultKeys.push(requireExpectedPrefix(keyOf(seg.standard_output_path)));
      }
    }
  }
  if (!resultKeys.length) {
    // Fallback: derive from the metadata's own directory.
    const dir = metaKey.replace(/job_metadata\.json$/, "").replace(/\/$/, "");
    resultKeys.push(requireExpectedPrefix(`${dir}/0/standard_output/0/result.json`));
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

  return {
    markdown: markdown.trim(),
    summary: summary.trim(),
    pages,
    tablesCsv,
    ...(opts?.includeRaw ? { raw } : {}),
  };
}

// --- tolerant extractors (BDA result shape varies by version; keep defensive) ---
function extractMarkdown(doc: Record<string, unknown>): string {
  // Whole-doc markdown representation, else concatenate page markdown/text.
  const docRep = (
    doc["document"] as { representation?: { markdown?: string; text?: string } } | undefined
  )?.representation;
  if (docRep?.markdown) return docRep.markdown + "\n\n";
  const pages =
    (doc["pages"] as { representation?: { markdown?: string; text?: string } }[] | undefined) ?? [];
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
  const els =
    (doc["elements"] as
      | { type?: string; representation?: { csv?: string; text?: string } }[]
      | undefined) ?? [];
  for (const e of els) {
    if ((e.type ?? "").toLowerCase() === "table") {
      const csv = e.representation?.csv ?? e.representation?.text;
      if (csv) out.push(csv);
    }
  }
  return out;
}

export function bdaEnabled(): boolean {
  loadBdaConfig();
  return true;
}

export { keyOf as _keyOf, getText as _getText };
