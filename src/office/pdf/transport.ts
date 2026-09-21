import type { AgentToolCall, AgentTransport } from "@genoffice/agent-core";

/** Uses the same authenticated, provider-independent Office SSE endpoint as the editors. */
export function pdfTransport(): AgentTransport {
  return {
    stream(request, callbacks) {
      const controller = new AbortController();
      const requestId = crypto.randomUUID();
      let ended = false;
      const finish = () => { if (!ended) { ended = true; callbacks.onDone(); } };
      void (async () => {
        const response = await fetch("/api/office/stream", { method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ ...request, requestId, app: "pdf", mode: "write", profile: "standard" }),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "The assistant request failed.");
        if (!response.body) throw new Error("The assistant response has no stream.");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            if (buffer.length > 2_000_000) throw new Error("The assistant event exceeds the size limit.");
            let end: number;
            while ((end = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
              if (!line.startsWith("data:")) continue;
              const event = JSON.parse(line.slice(5));
              if (event.requestId !== requestId) throw new Error("Assistant response mismatch.");
              if (event.type === "delta") callbacks.onDelta(event.text);
              else if (event.type === "reasoning") callbacks.onReasoning?.(event.text);
              else if (event.type === "tool-call") callbacks.onToolCall(event.toolCall as AgentToolCall);
              else if (event.type === "status") callbacks.onStatus?.(event);
              else if (event.type === "error") throw new Error(event.error || "The assistant failed.");
              else if (event.type === "done") { callbacks.onStopReason?.(event.stopReason); finish(); return; }
            }
          }
          if (!ended) throw new Error("The assistant response ended before completion.");
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      })().catch(error => {
        if (controller.signal.aborted) finish();
        else if (!ended) { ended = true; callbacks.onError(error instanceof Error ? error.message : String(error)); }
      });
      return { cancel: () => { controller.abort(); finish(); } };
    },
  };
}
