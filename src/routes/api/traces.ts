// Run Inspector data endpoint (SSE-free JSON). Serves the in-memory run-trace
// ring collected from agentLog. Auth-gated (under /api/, not /api/public/), and
// empty in production unless AGENT_TRACE=1. GET /api/traces -> recent run
// summaries; GET /api/traces?run=<id> -> that run's full event timeline.
import { createFileRoute } from "@tanstack/react-router";
import { getRunSummaries, getRunTrace, traceEnabled } from "@/lib/agents/trace.server";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/traces")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const run = new URL(request.url).searchParams.get("run");
        if (run) {
          const trace = getRunTrace(run);
          if (!trace) return json({ error: "run not found (aged out of the ring)" }, 404);
          return json({ trace });
        }
        return json({ enabled: traceEnabled(), runs: getRunSummaries() });
      },
    },
  },
});
