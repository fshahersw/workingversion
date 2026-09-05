// ============================================================================
// AgentCore Code Interpreter client (server-only).
//
// A secure Python sandbox (pandas/numpy/matplotlib/dateutil preinstalled, NO
// network egress) for exact CALCULATIONS the answer must not get wrong:
// settlement allocation, limitations/repose date math, data aggregation.
//
// One module-level session is reused across calls (cold start ~2s, then
// sub-second). Executions run with clearContext=false so the sandbox FILESYSTEM
// (and state) persist across calls within a session — that is what lets an
// uploaded file be written, then read/processed by a later run_python, then its
// output file (xlsx/docx/pdf/png) read back for download. Single-instance only —
// a second server process gets its own session (fine for dev; the seam to a
// per-actor pool is ensureSession()). The session is recreated before its
// absolute TTL and on any error.
// ============================================================================
import {
  BedrockAgentCoreClient,
  StartCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  type InvokeCodeInterpreterCommandInput,
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

type ContentItem = { type?: string; text?: string; data?: string; source?: { data?: string }; name?: string; path?: string };

/** Drain the InvokeCodeInterpreter event stream into its content items + error flag. */
async function drain(resp: unknown): Promise<{ content: ContentItem[]; isError: boolean }> {
  const content: ContentItem[] = [];
  let isError = false;
  const stream = (resp as { stream?: AsyncIterable<unknown> }).stream;
  if (stream) {
    for await (const ev of stream) {
      const r = (ev as { result?: { content?: ContentItem[]; isError?: boolean } }).result;
      if (!r) continue;
      if (r.isError) isError = true;
      for (const c of r.content ?? []) content.push(c);
    }
  }
  return { content, isError };
}

async function invoke(name: string, args: Record<string, unknown>): Promise<{ content: ContentItem[]; isError: boolean }> {
  const sess = await ensureSession();
  const resp = await client().send(
    new InvokeCodeInterpreterCommand({
      codeInterpreterIdentifier: INTERPRETER_ID,
      sessionId: sess.id,
      name: name as InvokeCodeInterpreterCommandInput["name"],
      arguments: args,
    }),
  );
  return drain(resp);
}

async function invokeOnce(code: string): Promise<CodeResult> {
  const { content, isError } = await invoke("executeCode", { code, language: "python", clearContext: false });
  let text = "";
  const images: string[] = [];
  for (const c of content) {
    if (c.type === "text" && typeof c.text === "string") text += c.text;
    else if (c.type === "image") {
      const d = c.data ?? c.source?.data;
      if (d) images.push(d);
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

/** Write a text file into the sandbox (an upload the model / run_python can read).
 *  Use a RELATIVE path (the sandbox rejects absolute paths like /tmp as traversal). */
export async function writeFile(path: string, text: string): Promise<void> {
  const { isError, content } = await invoke("writeFiles", { content: [{ path, text }] });
  if (isError) throw new Error(`writeFile failed: ${content.map((c) => c.text ?? "").join("").slice(0, 200)}`);
}

/** Download a file from the sandbox as base64 (binary-safe), via run_python — the
 *  dedicated readFiles tool's arg shape is unreliable and this handles binary
 *  (xlsx/docx/pdf/png) cleanly. Returns null if the file is missing. */
export async function getFile(path: string): Promise<string | null> {
  const code = `import base64,os\np=${JSON.stringify(path)}\nprint('<<B64>>'+(base64.b64encode(open(p,'rb').read()).decode() if os.path.exists(p) else '')+'<<END>>')`;
  const { text, isError } = await invokeOnce(code);
  if (isError) return null;
  const m = text.match(/<<B64>>([\s\S]*?)<<END>>/);
  return m && m[1] ? m[1] : null;
}

export type Artifact = { name: string; size: number };

/** List files in the sandbox working dir (name + byte size), via run_python. */
export async function listArtifacts(): Promise<Artifact[]> {
  const code = `import os,json\nout=[{'name':f,'size':os.path.getsize(f)} for f in sorted(os.listdir('.')) if os.path.isfile(f)]\nprint('<<JSON>>'+json.dumps(out)+'<<END>>')`;
  const { text } = await invokeOnce(code);
  const m = text.match(/<<JSON>>([\s\S]*?)<<END>>/);
  if (!m) return [];
  try {
    return JSON.parse(m[1]) as Artifact[];
  } catch {
    return [];
  }
}

export function codeInterpreterEnabled(): boolean {
  return true; // reachable under the default AWS credential chain (SigV4)
}
