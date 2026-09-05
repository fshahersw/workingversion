// ============================================================================
// AWS Bedrock AgentCore web search (server-only).
//
// The research sub-agents search the web through the account's IAM AgentCore
// gateway (ClaudeAddinWebSearchIamGateway) — the same secure, admin-domain-
// filtered connector the Office add-in backend uses. One MCP tool,
// `general___WebSearch`, reached by a single SigV4-signed POST (JSON-RPC 2.0
// tools/call) under the "bedrock-agentcore" service.
//
// Auth is SigV4 via the DEFAULT CREDENTIAL CHAIN (SSO in dev, the app IAM role
// in prod) — see bedrock-sign.server.ts. No static SEARCH_AWS_* keys, no bearer
// token, no MCP initialize handshake.
//
// The seven category tools in tools.server.ts all route here; per-category
// scoping (domainFilter) can be layered on later via DOMAIN_FILTERS — today the
// connector's admin-level domain allow-list already keeps results authoritative.
// ============================================================================
import { signedAwsFetch } from "./bedrock-sign.server";

const GATEWAY_URL =
  process.env["AGENTCORE_SEARCH_URL"] ||
  "https://claudeaddinwebsearchiamgateway-x9d5bnlhd4.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp";
const TOOL_NAME = process.env["AGENTCORE_SEARCH_TOOL"] || "general___WebSearch";
// This gateway negotiates MCP 2025-03-26 (not the newer 2025-11-25).
const PROTOCOL_VERSION = "2025-03-26";
const JSONRPC_ID = 1;

/** Category keys the research tools use. All route to the one gateway tool;
 *  each MAY carry a domain allow-list (see DOMAIN_FILTERS) for scoping. */
export type GatewayKey =
  | "case_law"
  | "regulatory_statutory"
  | "regulatory_enforcement"
  | "scientific_research"
  | "technical_environmental"
  | "judicial_parties"
  | "legal_news";

/** Optional per-category domain allow-lists, merged with the connector's
 *  admin-level filter. Empty by default (unrestricted authoritative search);
 *  populate a category to scope it, e.g. scientific_research -> pubmed/nih. */
const DOMAIN_FILTERS: Partial<Record<GatewayKey, string[]>> = {};

export type GatewayResult = {
  title?: string;
  url?: string;
  text: string;
  published?: string;
};

export class AgentCoreSearchError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "AgentCoreSearchError";
  }
}

/** Search runs under the default AWS credential chain, resolved at call time
 *  (SSO in dev, the app role in prod). Always attempt it server-side. */
export function agentCoreConfigured(): boolean {
  return true;
}

// --- Response parsing ------------------------------------------------------

/** Handles both plain application/json and text/event-stream (SSE) framing. */
async function readPayloads(res: Response): Promise<Record<string, unknown>[]> {
  const contentType = res.headers.get("content-type") || "";
  const bodyText = await res.text();
  if (contentType.includes("event-stream")) {
    const out: Record<string, unknown>[] = [];
    for (const line of bodyText.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const chunk = line.slice(5).trim();
      if (!chunk || chunk === "[DONE]") continue;
      try {
        out.push(JSON.parse(chunk) as Record<string, unknown>);
      } catch {
        /* skip non-JSON keepalive frames */
      }
    }
    return out;
  }
  try {
    return [JSON.parse(bodyText) as Record<string, unknown>];
  } catch {
    return [];
  }
}

function extractResults(messages: Record<string, unknown>[]): GatewayResult[] {
  const message =
    messages.find((m) => m["id"] === JSONRPC_ID) ?? messages[messages.length - 1] ?? {};
  const result = message["result"];
  if (!result || typeof result !== "object") {
    const error = message["error"];
    throw new AgentCoreSearchError(
      502,
      error ? `Gateway error: ${JSON.stringify(error).slice(0, 300)}` : "No result block from gateway.",
    );
  }
  const r = result as Record<string, unknown>;
  if (r["isError"]) {
    throw new AgentCoreSearchError(502, `Search tool reported an error: ${JSON.stringify(r).slice(0, 300)}`);
  }

  const out: GatewayResult[] = [];
  const content = Array.isArray(r["content"]) ? (r["content"] as Record<string, unknown>[]) : [];
  for (const block of content) {
    if (!block || typeof block !== "object" || block["type"] !== "text") continue;
    let inner: Record<string, unknown>;
    try {
      inner = JSON.parse(String(block["text"] ?? "{}")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const items = Array.isArray(inner["results"]) ? (inner["results"] as Record<string, unknown>[]) : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      out.push({
        title: typeof item["title"] === "string" ? item["title"] : undefined,
        url: typeof item["url"] === "string" ? item["url"] : undefined,
        text: typeof item["text"] === "string" ? item["text"] : "",
        published:
          typeof item["publishedDate"] === "string"
            ? item["publishedDate"]
            : typeof item["published"] === "string"
              ? item["published"]
              : undefined,
      });
    }
  }
  return out;
}

// --- Public API ------------------------------------------------------------

export async function agentCoreSearch(
  gatewayKey: GatewayKey,
  query: string,
  maxResults = 5,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<GatewayResult[]> {
  const q = (query || "").trim().slice(0, 200);
  if (!q) return [];

  const domains = DOMAIN_FILTERS[gatewayKey];
  const args: Record<string, unknown> = {
    query: q,
    maxResults: Math.max(1, Math.min(Math.floor(maxResults || 5), 25)),
  };
  if (domains && domains.length) {
    args["filters"] = { domainFilter: { include: domains } };
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: JSONRPC_ID,
    method: "tools/call",
    params: { name: TOOL_NAME, arguments: args },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 30_000);
  if (opts?.signal) opts.signal.addEventListener("abort", () => controller.abort());

  let res: Response;
  try {
    res = await signedAwsFetch("bedrock-agentcore", GATEWAY_URL, {
      body,
      headers: {
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
      },
      signal: controller.signal,
    });
  } catch (err) {
    throw new AgentCoreSearchError(
      0,
      `AgentCore search request failed: ${err instanceof Error ? err.message : "network error"}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AgentCoreSearchError(
      res.status,
      `AgentCore gateway returned HTTP ${res.status}: ${detail.slice(0, 300)}`,
    );
  }

  return extractResults(await readPayloads(res));
}
