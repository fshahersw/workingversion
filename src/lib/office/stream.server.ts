// One model turn for an Office editor's browser-side assistant loop (server-only).
// Shared by /api/writer/stream (app = writer) and /api/office/stream (app from
// the body). Body: { requestId, mode, profile, system, messages, tools }.
// Streams `data: {requestId, type, ...}` lines (delta | reasoning | status |
// tool-call | done | error | ping), the chunk protocol the editors' transports read. Tool
// execution happens in the browser; this only filters the tool set to the
// caller's app and mode and relays the model.
import {
  allowedToolNames,
  isOfficeApp,
  isWriterMode,
  isWriterProfile,
  streamWriterTurn,
  validateConversation,
  type OfficeApp,
} from "@/lib/writer/inference.server";
import { officeStreamFailure } from "./stream-errors";

const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;
/**
 * Per-turn ceiling. A 64k-token redraft on the main tier can legitimately run
 * several minutes; the Lambda/API Gateway window is 300 s, so stop a little
 * under it and let the browser loop continue on the next round.
 */
const TURN_TIMEOUT_MS = 280_000;

/**
 * One structured line per model turn, in CloudWatch embedded-metric format so
 * the dashboards get TTFB, tokens and cache hit rate per app and tier without
 * a metrics client. Disable with OFFICE_METRICS=off.
 */
function emitTurnMetric(fields: {
  app: string;
  mode: string;
  profile: string;
  tier: string;
  model: string;
  taskClass: string;
  ttfbMs: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
  stopReason: string;
  outcome: "ok" | "error" | "cancelled";
}): void {
  if ((process.env["OFFICE_METRICS"] ?? "on").toLowerCase() === "off") return;
  const namespace = process.env["OFFICE_METRICS_NAMESPACE"] || "LitAI/Office";
  const line = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          Dimensions: [["App", "Tier"], ["App"]],
          Metrics: [
            { Name: "TurnTtfbMs", Unit: "Milliseconds" },
            { Name: "TurnDurationMs", Unit: "Milliseconds" },
            { Name: "InputTokens", Unit: "Count" },
            { Name: "OutputTokens", Unit: "Count" },
            { Name: "CacheReadTokens", Unit: "Count" },
            { Name: "ToolCalls", Unit: "Count" },
            { Name: "TurnErrors", Unit: "Count" },
          ],
        },
      ],
    },
    App: fields.app,
    Tier: fields.tier,
    TurnTtfbMs: fields.ttfbMs,
    TurnDurationMs: fields.durationMs,
    InputTokens: fields.inputTokens,
    OutputTokens: fields.outputTokens,
    CacheReadTokens: fields.cacheReadTokens,
    ToolCalls: fields.toolCalls,
    TurnErrors: fields.outcome === "error" ? 1 : 0,
    mode: fields.mode,
    profile: fields.profile,
    model: fields.model,
    taskClass: fields.taskClass,
    cacheWriteTokens: fields.cacheWriteTokens,
    stopReason: fields.stopReason,
    outcome: fields.outcome,
    kind: "office-turn",
  };
  console.log(JSON.stringify(line));
}

export async function handleOfficeStream(
  request: Request,
  fixedApp?: OfficeApp,
): Promise<Response> {
  const { getUserFromRequest } = await import("@/lib/auth/cognito.server");
  const user = await getUserFromRequest(request);
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON request." }, { status: 400 });
  }
  let conversation: ReturnType<typeof validateConversation>;
  try {
    conversation = validateConversation(body);
  } catch (err) {
    const status = Number((err as { status?: number }).status) || 400;
    return Response.json({ error: (err as Error).message }, { status });
  }
  const requestId = String(body["requestId"] ?? "");
  if (!REQUEST_ID.test(requestId))
    return Response.json({ error: "Invalid request identifier." }, { status: 422 });
  const app = fixedApp ?? body["app"];
  if (!isOfficeApp(app)) return Response.json({ error: "Invalid editor." }, { status: 422 });
  const mode = body["mode"];
  const profile = body["profile"];
  if (!isWriterMode(mode) || !isWriterProfile(profile)) {
    return Response.json({ error: "Invalid assistant mode or depth." }, { status: 422 });
  }
  // Research mode runs the same loop with research-only tools (web search,
  // page reading, firm knowledge, library, citations); no document tools.
  const allowed = allowedToolNames(mode, app);
  const tools = conversation.tools ?? [];
  if (tools.some((t) => !t || typeof t.name !== "string" || !allowed.has(t.name))) {
    return Response.json({ error: "This request contains an unavailable tool." }, { status: 403 });
  }

  const encoder = new TextEncoder();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  request.signal.addEventListener("abort", onAbort);

  const stream = new ReadableStream({
    async start(sink) {
      let closed = false;
      const send = (event: Record<string, unknown>) => {
        if (closed) return;
        try {
          sink.enqueue(encoder.encode(`data: ${JSON.stringify({ requestId, ...event })}\n\n`));
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => send({ type: "ping" }), 10_000);
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, TURN_TIMEOUT_MS);
      let stopReason = "end_turn";
      const startedAt = Date.now();
      const metric = {
        tier: "main",
        model: "",
        taskClass: "",
        ttfbMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolCalls: 0,
      };
      let outcome: "ok" | "error" | "cancelled" = "ok";
      try {
        await streamWriterTurn(
          {
            app,
            profile,
            system: conversation.system,
            messages: conversation.messages,
            tools,
            signal: controller.signal,
          },
          {
            onDelta: (text) => send({ type: "delta", text }),
            onReasoning: (text) => send({ type: "reasoning", text }),
            onToolCall: (toolCall) => {
              metric.toolCalls++;
              send({ type: "tool-call", toolCall });
            },
            onStopReason: (reason) => {
              stopReason = reason;
            },
            onStatus: (status) => {
              metric.tier = status.tier;
              metric.model = status.model;
              metric.taskClass = status.taskClass ?? "";
              send({ type: "status", text: status.text, model: status.model, tier: status.tier });
            },
            onUsage: (usage) => {
              metric.ttfbMs = usage.ttfbMs;
              metric.inputTokens = usage.inputTokens;
              metric.outputTokens = usage.outputTokens;
              metric.cacheReadTokens = usage.cacheReadTokens;
              metric.cacheWriteTokens = usage.cacheWriteTokens;
              // Server-side only: confirms prompt-cache hits per round without
              // exposing accounting to the renderer.
              if (process.env["OFFICE_LOG_USAGE"] === "1") {
                console.info(
                  `[office:${String(app)}] ${usage.tier}/${usage.model} ttfb=${usage.ttfbMs}ms tokens in=${usage.inputTokens} out=${usage.outputTokens} cache_read=${usage.cacheReadTokens} cache_write=${usage.cacheWriteTokens}`,
                );
              }
            },
          },
        );
        send({ type: "done", stopReason });
      } catch (err) {
        const aborted = !timedOut && (controller.signal.aborted || (err as Error)?.name === "AbortError");
        outcome = aborted ? "cancelled" : "error";
        send(
          aborted
            ? { type: "done", stopReason: "cancelled" }
            : {
                type: "error",
                ...officeStreamFailure(err, timedOut),
              },
        );
        if (!aborted) console.error(`[office:${app}] stream failed:`, err);
      } finally {
        clearInterval(heartbeat);
        clearTimeout(deadline);
        emitTurnMetric({
          app,
          mode,
          profile,
          ...metric,
          durationMs: Date.now() - startedAt,
          stopReason,
          outcome,
        });
        request.signal.removeEventListener("abort", onAbort);
        closed = true;
        try {
          sink.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      controller.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
