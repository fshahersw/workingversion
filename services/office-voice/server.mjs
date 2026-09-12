import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { jwtVerify } from "jose";
import { WebSocketServer, WebSocket } from "ws";
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttp2Handler } from "@smithy/node-http-handler";
import {
  EventQueue,
  initialize,
  parseClientMessage,
  toolResult,
  VOICE_TOOLS,
} from "./protocol.mjs";

export function createVoiceServer({ secret, origins, provider, maxSessions = 16 }) {
  if (!secret || Buffer.byteLength(secret) < 32 || !origins?.length)
    throw new Error("Configure a 32-byte OFFICE_VOICE_JWT_SECRET and explicit allowed origins.");
  const consumed = new Map(),
    users = new Map();
  const http = createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(
      JSON.stringify(
        req.url === "/health" ? { status: "ok", service: "office-voice" } : { error: "Not found" },
      ),
    );
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32000, perMessageDeflate: false });
  http.on("upgrade", (req, socket, head) => {
    if (
      req.url !== "/voice" ||
      !origins.includes(req.headers.origin) ||
      wss.clients.size >= maxSessions * 2
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => {
    let binding,
      started = false,
      authenticating = false,
      closed = false,
      init;
    const queue = new EventQueue(),
      abort = new AbortController(),
      pending = new Map(),
      assembling = new Map();
    let bytes = 0,
      windowAt = Date.now();
    const send = (value) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 512000) {
        stop("Voice playback connection is too slow.");
        return;
      }
      ws.send(JSON.stringify(value));
    };
    const timers = new Set();
    const later = (fn, ms) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
      return timer;
    };
    function stop(error) {
      if (closed) return;
      if (error && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 512000)
        ws.send(JSON.stringify({ type: "error", message: error }));
      closed = true;
      abort.abort();
      queue.close();
      timers.forEach(clearTimeout);
      timers.clear();
      if (binding) {
        const count = (users.get(binding.sub) || 1) - 1;
        if (count) users.set(binding.sub, count);
        else users.delete(binding.sub);
      }
      ws.close(error ? 1011 : 1000);
    }
    const authTimer = later(() => stop("Voice sign-in timed out."), 5000);
    ws.on("close", () => stop());
    ws.on("error", () => stop());
    async function consume() {
      try {
        const stream = await provider(queue, abort.signal);
        send({ type: "ready" });
        later(() => send({ type: "renew" }), 7 * 60 * 1000);
        later(() => stop("Voice session expired. Reconnect to continue."), 7.5 * 60 * 1000);
        for await (const chunk of stream) {
          if (closed) break;
          if (!chunk.chunk?.bytes) throw new Error("Voice provider stream failed");
          const event = JSON.parse(new TextDecoder().decode(chunk.chunk.bytes)).event;
          if (!event) continue;
          if (event.toolUse) {
            const t = event.toolUse;
            if (
              typeof t.toolUseId !== "string" ||
              t.toolUseId.length > 200 ||
              assembling.size + pending.size >= 16
            )
              throw new Error("Invalid voice tool sequence");
            assembling.set(t.contentName || t.contentId || t.toolUseId, t);
          } else if (event.contentEnd?.type === "TOOL") {
            const key = event.contentEnd.contentName || event.contentEnd.contentId;
            const entry = assembling.has(key)
              ? key
              : assembling.size === 1
                ? assembling.keys().next().value
                : undefined;
            const t = assembling.get(entry);
            if (!t) throw new Error("Unmatched voice tool event");
            assembling.delete(entry);
            if (!VOICE_TOOLS.some((v) => v.toolSpec.name === t.toolName)) {
              toolResult(
                queue,
                init.promptName,
                t.toolUseId,
                JSON.stringify({ error: "Unsupported voice action" }),
              );
              continue;
            }
            let input;
            try {
              input = JSON.parse(t.content);
              if (!input || Array.isArray(input) || typeof input !== "object") throw new Error();
            } catch {
              toolResult(
                queue,
                init.promptName,
                t.toolUseId,
                JSON.stringify({ error: "Invalid tool arguments" }),
              );
              continue;
            }
            if (pending.has(t.toolUseId)) throw new Error("Duplicate in-flight voice action");
            pending.set(
              t.toolUseId,
              later(() => {
                if (!pending.delete(t.toolUseId) || closed) return;
                try {
                  toolResult(
                    queue,
                    init.promptName,
                    t.toolUseId,
                    JSON.stringify({
                      error:
                        "Office did not acknowledge the request. Check task status; do not retry a write automatically.",
                    }),
                  );
                } catch {
                  stop("Voice connection stalled.");
                }
              }, 15000),
            );
            send({ type: "tool", id: t.toolUseId, name: t.toolName, input });
          } else if (
            event.contentStart ||
            event.textOutput ||
            event.audioOutput ||
            event.contentEnd
          ) {
            send({ type: "event", event });
          }
        }
        stop();
      } catch {
        if (!closed)
          stop(
            "AWS voice connection failed. Check gateway access and the selected AWS region. Your Office task is unaffected.",
          );
      }
    }
    ws.on("message", async (raw) => {
      try {
        if (closed) return;
        if (!started) {
          if (authenticating) throw new Error("Voice sign-in is still pending");
          authenticating = true;
          const m = JSON.parse(raw.toString());
          if (
            m.type !== "auth" ||
            typeof m.token !== "string" ||
            m.token.length > 4000 ||
            (m.resume !== undefined && (typeof m.resume !== "string" || m.resume.length > 12000))
          )
            throw new Error("Invalid voice grant");
          const { payload } = await jwtVerify(m.token, new TextEncoder().encode(secret), {
            algorithms: ["HS256"],
            issuer: "seegerweiss-platform",
            audience: "seegerweiss-office-voice",
            maxTokenAge: "65s",
          });
          if (closed) return;
          if (
            !payload.sub ||
            !payload.jti ||
            !payload.exp ||
            !["writer", "sheets", "slides"].includes(payload.app) ||
            !["write", "ask", "review"].includes(payload.mode) ||
            typeof payload.document !== "string"
          )
            throw new Error("Invalid voice binding");
          for (const [id, exp] of consumed) if (exp < Date.now() / 1000) consumed.delete(id);
          if (
            consumed.has(payload.jti) ||
            (users.get(payload.sub) || 0) >= 2 ||
            [...users.values()].reduce((a, b) => a + b, 0) >= maxSessions
          )
            throw new Error("Voice grant already used or session capacity reached");
          consumed.set(payload.jti, payload.exp);
          users.set(payload.sub, (users.get(payload.sub) || 0) + 1);
          binding = payload;
          started = true;
          clearTimeout(authTimer);
          timers.delete(authTimer);
          init = initialize(queue, binding, m.resume || "");
          void consume();
          return;
        }
        if (Date.now() - windowAt > 1000) {
          bytes = 0;
          windowAt = Date.now();
        }
        bytes += raw.length;
        if (bytes > 160000) throw new Error("Voice input rate exceeded");
        const m = parseClientMessage(raw.toString());
        if (m.type === "stop") {
          stop();
          return;
        }
        if (m.type === "audio")
          queue.push({
            audioInput: {
              promptName: init.promptName,
              contentName: init.audioName,
              content: m.data,
            },
          });
        else if (m.type === "tool_result") {
          const timer = pending.get(m.id);
          if (!timer) return; // Late or duplicate acknowledgment must never invoke another action.
          clearTimeout(timer);
          timers.delete(timer);
          pending.delete(m.id);
          toolResult(queue, init.promptName, m.id, m.result);
        }
      } catch {
        stop("Voice request was rejected. Reconnect from the signed-in Office editor.");
      }
    });
  });
  return {
    http,
    close: () => {
      wss.clients.forEach((ws) => ws.terminate());
      wss.close();
      http.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION || "us-east-1",
    maxAttempts: 1,
    requestHandler: new NodeHttp2Handler({ requestTimeout: 490000, sessionTimeout: 490000 }),
  });
  const service = createVoiceServer({
    secret: process.env.OFFICE_VOICE_JWT_SECRET,
    origins: (process.env.OFFICE_VOICE_ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    provider: async (body, abortSignal) => {
      const response = await client.send(
        new InvokeModelWithBidirectionalStreamCommand({
          modelId: "amazon.nova-2-sonic-v1:0",
          body,
        }),
        { abortSignal },
      );
      if (!response.body) throw new Error("No voice response");
      return response.body;
    },
  });
  service.http.listen(Number(process.env.PORT || 8091), process.env.HOST || "127.0.0.1", () =>
    console.log("Office voice gateway listening"),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      service.close();
      client.destroy();
    });
}
