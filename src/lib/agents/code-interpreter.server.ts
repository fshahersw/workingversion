// ============================================================================
// AgentCore Code Interpreter client (server-only).
//
// A secure Python sandbox (pandas/numpy/matplotlib/dateutil preinstalled, NO
// network egress) for exact CALCULATIONS the answer must not get wrong:
// settlement allocation, limitations/repose date math, data aggregation.
//
// One module-level session is reused across calls (cold start ~2s, then
// sub-second); each execution runs with clearContext=true so calls are isolated
// (no leaked variables between unrelated queries). The session is recreated
// before its absolute TTL and on any error. Single-instance only — a second
// server process has its own session (fine for dev; the seam to a shared pool
// is ensureSession()).
// ============================================================================
import {
  BedrockAgentCoreClient,
  StartCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";

const REGION = process.env["BEDROCK_REGION"] ?? process.env["AWS_REGION"] ?? "us-east-1";
const INTERPRETER_ID = process.env["CODE_INTERPRETER_ID"] || "aws.codeinterpreter.v1";
const SESSION_TTL_S = 1800; // 30 min absolute TTL
const TTL_MARGIN_MS = 120_000; // recreate 2 min before the absolute TTL

let _client: BedrockAgentCoreClient | null = null;
function client(): BedrockAgentCoreClient {
  return (_client ??= new BedrockAgentCoreClient({ region: REGION }));
}

let session: { id: string; startedAt: number } | null = null;
let starting: Promise<{ id: string; startedAt: number }> | null = null;

async function ensureSession(): Promise<{ id: string; startedAt: number }> {
  if (session && Date.now() - session.startedAt < SESSION_TTL_S * 1000 - TTL_MARGIN_MS) return session;
  if (starting) return starting;
  starting = (async () => {
    if (session) {
      const old = session.id;
      try {
        await client().send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: INTERPRETER_ID, sessionId: old }));
      } catch {
        /* best effort */
      }
    }
    const res = await client().send(
      new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: INTERPRETER_ID,
        name: "lit-ai",
        sessionTimeoutSeconds: SESSION_TTL_S,
      }),
    );
    session = { id: res.sessionId ?? "", startedAt: Date.now() };
    return session;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

export type CodeResult = { text: string; images: string[]; isError: boolean };

async function invokeOnce(code: string): Promise<CodeResult> {
  const sess = await ensureSession();
  const resp = await client().send(
    new InvokeCodeInterpreterCommand({
      codeInterpreterIdentifier: INTERPRETER_ID,
      sessionId: sess.id,
      name: "executeCode",
      arguments: { code, language: "python", clearContext: true },
    }),
  );
  let text = "";
  const images: string[] = [];
  let isError = false;
  const stream = (resp as unknown as { stream?: AsyncIterable<unknown> }).stream;
  if (stream) {
    for await (const ev of stream) {
      const r = (
        ev as {
          result?: {
            content?: { type?: string; text?: string; data?: string; source?: { data?: string } }[];
            isError?: boolean;
          };
        }
      ).result;
      if (!r) continue;
      if (r.isError) isError = true;
      for (const c of r.content ?? []) {
        if (c.type === "text" && typeof c.text === "string") text += c.text;
        else if (c.type === "image") {
          const d = c.data ?? c.source?.data;
          if (d) images.push(d);
        }
      }
    }
  }
  return { text, images, isError };
}

/** Run a snippet of Python in the sandbox. Retries once on a dead session. */
export async function runPython(code: string): Promise<CodeResult> {
  try {
    return await invokeOnce(code);
  } catch {
    session = null; // session may have expired/died — recreate and retry once
    return await invokeOnce(code);
  }
}

export function codeInterpreterEnabled(): boolean {
  return true; // reachable under the default AWS credential chain (SigV4)
}
