// One model turn for an Office editor's browser-side assistant loop (server-only).
// Shared by /api/writer/stream (app = writer) and /api/office/stream (app from
// the body). Body: { requestId, mode, profile, system, messages, tools }.
// Streams `data: {requestId, type, ...}` lines (delta | reasoning | tool-call |
// done | error | ping), the chunk protocol the editors' transports read. Tool
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

const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;
const TURN_TIMEOUT_MS = 180_000;

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
  if (mode === "research") {
    return Response.json(
      { error: "Public research mode is not enabled; use web search inside Edit or Ask." },
      { status: 501 },
    );
  }
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
      const deadline = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
      let stopReason = "end_turn";
      try {
        await streamWriterTurn(
          {
            profile,
            system: conversation.system,
            messages: conversation.messages,
            tools,
            signal: controller.signal,
          },
          {
            onDelta: (text) => send({ type: "delta", text }),
            onReasoning: (text) => send({ type: "reasoning", text }),
            onToolCall: (toolCall) => send({ type: "tool-call", toolCall }),
            onStopReason: (reason) => {
              stopReason = reason;
            },
            onUsage: (usage) => {
              // Server-side only: confirms prompt-cache hits per round without
              // exposing accounting to the renderer.
              if (process.env["OFFICE_LOG_USAGE"] === "1") {
                console.info(
                  `[office:${String(app)}] tokens in=${usage.inputTokens} out=${usage.outputTokens} cache_read=${usage.cacheReadTokens} cache_write=${usage.cacheWriteTokens}`,
                );
              }
            },
          },
        );
        send({ type: "done", stopReason });
      } catch (err) {
        const aborted = controller.signal.aborted || (err as Error)?.name === "AbortError";
        const status = Number((err as { status?: number })?.status);
        send(
          aborted
            ? { type: "done", stopReason: "cancelled" }
            : {
                type: "error",
                error:
                  status === 429
                    ? "The writing service is busy. Wait briefly and try again."
                    : "The writing service could not complete this request. Earlier applied edits remain in the document.",
                ...(status === 429 ? { errorCode: "overloaded" } : {}),
              },
        );
        if (!aborted) console.error(`[office:${app}] stream failed:`, err);
      } finally {
        clearInterval(heartbeat);
        clearTimeout(deadline);
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
