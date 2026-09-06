// Ask-AI over a highlighted passage (SSE, Nemotron on Bedrock).
import { createFileRoute } from "@tanstack/react-router";
import { BEDROCK_AGENT_MODEL, bedrockChat, userText } from "@/lib/agents/bedrock.server";
import { quickAskPrompt } from "@/lib/agents/prompts";
import { agentLog, agentError, since, trunc } from "@/lib/agents/log.server";
import { startSseHeartbeat } from "@/lib/sse.server";

export const Route = createFileRoute("/api/quick-ask")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { question?: string; context?: string } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty body */
        }
        const question = (body.question ?? "").trim();
        const context = (body.context ?? "").trim();
        if (!question) return new Response("question is required", { status: 400 });

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (event: string, data: unknown) => {
              try {
                controller.enqueue(
                  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
                );
              } catch {
                /* closed */
              }
            };
            const stopHeartbeat = startSseHeartbeat(
              (comment) => controller.enqueue(encoder.encode(comment)),
              request.signal,
            );
            const started = Date.now();
            try {
              const { text } = await bedrockChat({
                model: BEDROCK_AGENT_MODEL,
                system: quickAskPrompt(),
                messages: [
                  userText(`EXCERPT\n"""\n${context}\n"""\n\nQUESTION\n${question}`),
                ],
                maxTokens: 1200,
                ...(request.signal ? { signal: request.signal } : {}),
              });
              if (text) send("delta", { text });
              send("done", {});
              agentLog("quick_ask", {
                model: BEDROCK_AGENT_MODEL,
                ms: since(started),
                answer_chars: text.length,
                q: trunc(question, 120),
              });
            } catch (err) {
              agentError("quick_ask_failed", {
                model: BEDROCK_AGENT_MODEL,
                ms: since(started),
                error: trunc(err instanceof Error ? err.message : String(err), 200),
              });
              send("error", {
                message: err instanceof Error ? err.message : "Ask AI failed.",
              });
            } finally {
              stopHeartbeat();
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store, no-transform",
            Connection: "keep-alive",
          },
        });
      },
    },
  },
});
