// SSE client for the Seeger Weiss litigation orchestrate endpoint.
// Auth is the Cognito httpOnly session cookie (sw_id): it is auto-sent with these
// same-origin fetches and verified by the /api/* request middleware. The legacy
// Supabase anon bearer was removed — the app is Cognito-only now.
import { litigationContext } from "./system-prompt";
import { classifyIntent, type RetrievalHints } from "./research-intent";
import type { Attachment, ChoiceAnswer } from "./chat-types";

/** Compact per-query frame. The full persona + citation contract now travel as
 *  top-level body fields (system_prompt / citation_contract) instead of being
 *  stuffed into the query text, which was bloating conversation history. */
function frameQuery(text: string, hints: RetrievalHints) {
  return `[Seeger Weiss LLP — plaintiffs' mass tort & complex litigation. Research focus: ${hints.focus_note}]\n\n${text}`;
}

export type SSEEvent = { event: string; data: unknown };

export async function streamSSE(
  url: string,
  body: unknown,
  onEvent: (e: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    onEvent({ event: "error", data: { message: `HTTP ${res.status}` } });
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!raw.trim()) continue;
      let evt = "message";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) evt = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (evt === "message" && !dataLines.length) continue;
      const dataStr = dataLines.join("\n");
      let data: unknown = dataStr;
      if (dataStr) {
        try {
          data = JSON.parse(dataStr);
        } catch {
          /* keep as string */
        }
      }
      onEvent({ event: evt, data });
    }
  }
}

export type HistoryTurn = { role: "user" | "assistant"; content: string };

export function streamOrchestrate(
  body: {
    query: string;
    known_source_refs?: string[];
    memory?: unknown;
    session_id: string;
    /** Saved conversation id once the first turn has been persisted. */
    conversation_id?: string;
    history?: HistoryTurn[];
    stream?: boolean;
    matter_id?: string;
    matter_label?: string;
    /** Attorney-selected effort. "auto" (default) lets the classifier decide. */
    mode?: "auto" | "fast" | "think";
    /** Files uploaded into the sandbox this session (with extracted content). */
    attachments?: Attachment[];
    /** Resume the same question after a clarification-panel selection. */
    choice?: ChoiceAnswer;
  },
  onEvent: (e: SSEEvent) => void,
  signal?: AbortSignal,
) {
  const hints = classifyIntent(body.query);
  return streamSSE(
    "/api/orchestrate",
    {
      ...litigationContext(),
      ...hints,
      ...body,
      query: frameQuery(body.query, hints),
    },
    onEvent,
    signal,
  );
}

export function streamQuickAsk(
  body: { question: string; context: string },
  onEvent: (e: SSEEvent) => void,
  signal?: AbortSignal,
) {
  const hints = classifyIntent(body.question);
  return streamSSE(
    "/api/quick-ask",
    {
      ...litigationContext(),
      ...hints,
      ...body,
      question: frameQuery(body.question, hints),
    },
    onEvent,
    signal,
  );
}


/** Read a File as raw base64 (no data: prefix). */
function fileToB64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const res = String(reader.result ?? "");
      resolve(res.replace(/^data:[^;]*;base64,/, ""));
    };
    reader.readAsDataURL(file);
  });
}

async function ingestPost(body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok && !data.status) data.status = "error";
  return data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ingest a file. Sandbox files (csv/xlsx/docx/txt/…) resolve immediately;
 *  PDF/image files go through Amazon Bedrock Data Automation (OCR + markdown +
 *  AI summary) asynchronously — onProcessing fires with a placeholder chip and
 *  this polls until the extracted Attachment is ready. */
export async function uploadFile(
  file: File,
  opts?: { onProcessing?: (a: Attachment) => void; signal?: AbortSignal },
): Promise<{ ok: true; attachment: Attachment } | { ok: false; name: string; error: string }> {
  try {
    const b64 = await fileToB64(file);
    const start = await ingestPost(
      { action: "start", name: file.name, b64, mime: file.type, size: file.size },
      opts?.signal,
    );

    if (start.status === "ready") return { ok: true, attachment: start.attachment as Attachment };
    if (start.status !== "processing") {
      return { ok: false, name: file.name, error: String(start.error ?? "upload failed") };
    }

    const handle = {
      invocationArn: String(start.invocationArn),
      key: String(start.key),
      name: String(start.name),
      kind: String(start.kind),
      size: Number(start.size) || file.size,
    };
    opts?.onProcessing?.({
      name: handle.name,
      kind: handle.kind,
      size: handle.size,
      contextText: "",
      hasFullText: false,
      status: "processing",
    });

    // Poll ~3s up to ~3.5 min (BDA async).
    for (let i = 0; i < 70; i++) {
      await sleep(3000);
      const s = await ingestPost({ action: "status", ...handle }, opts?.signal);
      if (s.status === "ready") return { ok: true, attachment: s.attachment as Attachment };
      if (s.status === "error") return { ok: false, name: handle.name, error: String(s.error ?? "extraction failed") };
    }
    return { ok: false, name: handle.name, error: "extraction timed out" };
  } catch (err) {
    return { ok: false, name: file.name, error: err instanceof Error ? err.message : "upload failed" };
  }
}

export async function fetchFollowups(
  query: string,
  answer: string,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const res = await fetch("/api/followups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ...litigationContext(), query, answer }),
      signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { followups?: string[] };
    return (data.followups ?? []).slice(0, 3);
  } catch {
    return [];
  }
}

// Dictation is handled OS-level by the firm dictation helper (hold Right Alt →
// Amazon Transcribe Streaming → typed into the focused field). The web app no
// longer records audio or calls a transcription backend, so the old Supabase
// transcribe function was removed.
