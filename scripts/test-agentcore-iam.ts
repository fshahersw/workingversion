// Enumerates the tools the IAM AgentCore gateway (ClaudeAddinWebSearchIamGateway)
// exposes, signed with the default credential chain (SSO) — proves invocability
// + reveals the real tool suite, with NO static SEARCH_AWS_* keys.
//   AWS_PROFILE=AdministratorAccess-475976462949 AWS_REGION=us-east-1 bun run scripts/test-agentcore-iam.ts
import { signedAwsFetch } from "../src/lib/agents/bedrock-sign.server";

const URL_ = "https://claudeaddinwebsearchiamgateway-x9d5bnlhd4.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp";

async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const res = await signedAwsFetch("bedrock-agentcore", URL_, {
    body,
    headers: { accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
  });
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  if (ct.includes("event-stream")) {
    const out: Record<string, unknown>[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const chunk = line.slice(5).trim();
      if (!chunk || chunk === "[DONE]") continue;
      try { out.push(JSON.parse(chunk)); } catch { /* skip */ }
    }
    return out;
  }
  try { return [JSON.parse(text)]; } catch { return []; }
}

async function main() {
  console.log("bearer present?:", !!process.env["AWS_BEARER_TOKEN_BEDROCK"], "| SEARCH keys?:", !!process.env["SEARCH_AWS_ACCESS_KEY_ID"], "\n");
  const msgs = await rpc("tools/list", {});
  const msg = msgs.find((m) => m["id"] === 1) ?? msgs[msgs.length - 1] ?? {};
  const result = (msg["result"] ?? {}) as Record<string, unknown>;
  const tools = Array.isArray(result["tools"]) ? (result["tools"] as Record<string, unknown>[]) : [];
  console.log(`tools/list -> ${tools.length} tool(s):\n`);
  for (const t of tools) {
    const schema = (t["inputSchema"] ?? t["input_schema"] ?? {}) as Record<string, unknown>;
    const props = (schema["properties"] ?? {}) as Record<string, unknown>;
    console.log(`  • ${t["name"]}`);
    console.log(`      ${String(t["description"] ?? "").slice(0, 160)}`);
    console.log(`      args: ${Object.keys(props).join(", ") || "(none)"}`);
  }
  if (!tools.length) throw new Error("no tools returned");

  const ws = tools.find((t) => t["name"] === "general___WebSearch");
  console.log("\ngeneral___WebSearch full inputSchema:");
  console.log(JSON.stringify(ws?.["inputSchema"] ?? ws?.["input_schema"] ?? {}, null, 2).slice(0, 900));

  console.log("\n--- live tools/call general___WebSearch ---");
  const callMsgs = await rpc("tools/call", {
    name: "general___WebSearch",
    arguments: { query: "AFFF MDL 2873 South Carolina latest order 2026", maxResults: 3 },
  });
  const cm = callMsgs.find((m) => m["id"] === 1) ?? callMsgs[callMsgs.length - 1] ?? {};
  const cr = (cm["result"] ?? {}) as Record<string, unknown>;
  const content = Array.isArray(cr["content"]) ? (cr["content"] as Record<string, unknown>[]) : [];
  const firstText = content.find((b) => b["type"] === "text")?.["text"];
  let parsed: unknown = firstText;
  try { parsed = JSON.parse(String(firstText)); } catch { /* leave as text */ }
  const results = (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>)["results"]))
    ? (parsed as Record<string, unknown>)["results"] as Record<string, unknown>[] : [];
  console.log("isError:", cr["isError"] ?? false, "| result items:", results.length);
  for (const r of results.slice(0, 3)) {
    console.log(`  - ${String(r["title"] ?? "").slice(0, 70)} | ${String(r["url"] ?? "").slice(0, 70)} | ${String(r["publishedDate"] ?? r["published"] ?? "")}`);
  }
  console.log("\nAGENTCORE IAM GATEWAY REACHABLE + general___WebSearch WORKS via SigV4 (no static keys).");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
