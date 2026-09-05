// Discovers the DocketBird MCP server's tools via a standard MCP handshake,
// using DOCKETBIRD_API_KEY from .env (bun auto-loads it; the value is never
// printed). Tries a few likely endpoints + auth styles. Read-only (initialize +
// tools/list). Run: bun run scripts/probe-docketbird-mcp.ts
const KEY = process.env["DOCKETBIRD_API_KEY"] || process.env["DOCKETBIRD_MCP_KEY"] || "";
if (!KEY) {
  console.log("DOCKETBIRD_API_KEY not found in env/.env — add it, or tell me the MCP endpoint + auth.");
  process.exit(0);
}

const ENDPOINTS = [
  "https://api.docketbird.com/mcp",
  "https://www.docketbird.com/mcp",
  "https://mcp.docketbird.com/mcp",
  "https://mcp.docketbird.com",
  "https://docketbird.com/mcp",
];
const PROTO = "2025-06-18";

type AuthStyle = { name: string; headers: (k: string) => Record<string, string> };
const AUTHS: AuthStyle[] = [
  { name: "Bearer", headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { name: "X-Api-Key", headers: (k) => ({ "X-Api-Key": k }) },
];

const baseHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "MCP-Protocol-Version": PROTO,
};

function parseBody(ct: string, text: string): Record<string, unknown>[] {
  if (ct.includes("event-stream")) {
    const out: Record<string, unknown>[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const c = line.slice(5).trim();
      if (!c || c === "[DONE]") continue;
      try { out.push(JSON.parse(c)); } catch { /* skip */ }
    }
    return out;
  }
  try { return [JSON.parse(text)]; } catch { return []; }
}

async function rpc(url: string, headers: Record<string, string>, method: string, params: unknown, id?: number) {
  const body = JSON.stringify(id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params });
  const res = await fetch(url, { method: "POST", headers, body });
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  return { res, ct, text, sessionId: res.headers.get("mcp-session-id") || res.headers.get("Mcp-Session-Id") };
}

async function tryEndpoint(url: string, auth: AuthStyle): Promise<boolean> {
  const headers = { ...baseHeaders, ...auth.headers(KEY) };
  // 1) Try tools/list directly (stateless servers accept it).
  try {
    let r = await rpc(url, headers, "tools/list", {}, 1);
    if (r.res.status === 401 || r.res.status === 403) {
      console.log(`  [${auth.name}] ${url} -> ${r.res.status} (auth rejected)`);
      return false;
    }
    let msgs = parseBody(r.ct, r.text);
    let result = msgs.find((m) => m["id"] === 1)?.["result"] as Record<string, unknown> | undefined;

    // 2) If the server wants an init/session, do the full handshake.
    if (!result) {
      const init = await rpc(url, headers, "initialize", {
        protocolVersion: PROTO,
        capabilities: {},
        clientInfo: { name: "seegerweiss-probe", version: "0.1" },
      }, 1);
      if (init.res.status >= 400) {
        console.log(`  [${auth.name}] ${url} -> init HTTP ${init.res.status}: ${init.text.slice(0, 120)}`);
        return false;
      }
      const sessHeaders = init.sessionId ? { ...headers, "Mcp-Session-Id": init.sessionId } : headers;
      await rpc(url, sessHeaders, "notifications/initialized", {});
      r = await rpc(url, sessHeaders, "tools/list", {}, 2);
      msgs = parseBody(r.ct, r.text);
      result = msgs.find((m) => m["id"] === 2)?.["result"] as Record<string, unknown> | undefined;
    }

    const tools = Array.isArray(result?.["tools"]) ? (result!["tools"] as Record<string, unknown>[]) : [];
    if (tools.length) {
      console.log(`\n✅ FOUND: ${url}  [auth: ${auth.name}]  proto ${PROTO}  -> ${tools.length} tools:\n`);
      for (const t of tools) {
        const schema = (t["inputSchema"] ?? t["input_schema"] ?? {}) as Record<string, unknown>;
        const props = (schema["properties"] ?? {}) as Record<string, unknown>;
        console.log(`  • ${t["name"]}`);
        console.log(`      ${String(t["description"] ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
        console.log(`      args: ${Object.keys(props).join(", ") || "(none)"}`);
      }
      return true;
    }
    console.log(`  [${auth.name}] ${url} -> HTTP ${r.res.status}, no tools (${r.text.slice(0, 120)})`);
    return false;
  } catch (err) {
    console.log(`  [${auth.name}] ${url} -> ${err instanceof Error ? err.message : "error"}`);
    return false;
  }
}

async function main() {
  console.log("Probing DocketBird MCP (key present, value hidden)...\n");
  for (const url of ENDPOINTS) {
    for (const auth of AUTHS) {
      if (await tryEndpoint(url, auth)) return;
    }
  }
  console.log("\nNo endpoint responded with a tool list. Need the exact MCP URL + auth from the docs.");
}

main().catch((e) => { console.error("probe failed:", e); process.exit(1); });
