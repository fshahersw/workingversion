// One-off probe (safe, read-only): does the new agenticWebsearch gateway return
// results, and does it honor a REQUEST-LEVEL domainFilter.include? Reuses the
// app's SigV4 signer (default cred chain = SSO). Run: bun scripts/probe-websearch.ts
import { signedAwsFetch } from "../src/lib/agents/bedrock-sign.server.ts";

const GATEWAY_URL =
  "https://agenticwebsearch-kqnvc6gbhf.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp";
const TOOL = "general___WebSearch";

async function call(label: string, args: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: TOOL, arguments: args },
  });
  const res = await signedAwsFetch("bedrock-agentcore", GATEWAY_URL, {
    body,
    headers: {
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
  });
  const text = await res.text();
  // Extract every https URL's hostname from the raw payload (SSE or JSON).
  const hosts = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/([^\s"'\\/]+)/g)) {
    const h = m[1].toLowerCase();
    if (!h.includes("bedrock-agentcore") && !h.includes("amazonaws.com")) hosts.add(h);
  }
  console.log(`\n=== ${label} === HTTP ${res.status}`);
  console.log(`result hosts (${hosts.size}):`, [...hosts].slice(0, 25).join(", ") || "(none)");
  if (res.status !== 200 || hosts.size === 0) {
    console.log("raw (first 600):", text.slice(0, 600));
  }
}

const query = "Meta Platforms securities class action litigation 2026";
await call("NO FILTER", { query, maxResults: 8 });
await call("INCLUDE sec.gov ONLY", {
  query,
  maxResults: 8,
  filters: { domainFilter: { include: ["sec.gov"] } },
});
await call("PUBLISHED AFTER 2026-06-01", {
  query,
  maxResults: 6,
  filters: { publishedDateFilter: { from: "2026-06-01T00:00:00Z" } },
});
