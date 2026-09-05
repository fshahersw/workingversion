// SSE client for the Seeger Weiss litigation orchestrate endpoint.
export const SUPABASE_URL = "https://tbasvydiknulgtnsqvfp.supabase.co";
export const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRiYXN2eWRpa251bGd0bnNxdmZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzMzIxNjksImV4cCI6MjA5NzkwODE2OX0.ZxC8v10ya0T8YyoqxwA4FAVxSROOUUXlzonUc0rwgxw";

import { litigationContext, SW_PROMPT_SUGGESTIONS } from "./system-prompt";
import { classifyIntent, type RetrievalHints } from "./research-intent";

/** Compact per-query frame. The full persona + citation contract now travel as
 *  top-level body fields (system_prompt / citation_contract) instead of being
 *  stuffed into the query text, which was bloating conversation history. */
function frameQuery(text: string, hints: RetrievalHints) {
  return `[Seeger Weiss LLP — plaintiffs' mass tort & complex litigation. Research focus: ${hints.focus_note}]\n\n${text}`;
}
export { type PromptSuggestion, SW_PROMPT_SUGGESTIONS } from "./system-prompt";



export type SSEEvent = { event: string; data: unknown };

export async function streamSSE(
  url: string,
  body: unknown,
  onEvent: (e: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON}`,
    },
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
    history?: HistoryTurn[];
    stream?: boolean;
    matter_id?: string;
    matter_label?: string;
    /** Attorney-selected effort. "auto" (default) lets the classifier decide. */
    mode?: "auto" | "fast" | "think";
    /** Filenames already uploaded into the sandbox this session. */
    attachments?: string[];
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

/** Upload a file into the code-interpreter sandbox; resolves to the sanitized
 *  name the sandbox stored it under (reference it in run_python by that name). */
export async function uploadFile(
  file: File,
  signal?: AbortSignal,
): Promise<{ ok: boolean; name: string; error?: string }> {
  try {
    const b64 = await fileToB64(file);
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON}`,
      },
      body: JSON.stringify({ name: file.name, b64, mime: file.type }),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      name?: string;
      error?: string;
    };
    if (!res.ok || !data.ok)
      return { ok: false, name: file.name, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, name: data.name ?? file.name };
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON}`,
      },
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

export async function fetchPromptSuggestions(): Promise<
  { text: string; category: string }[]
> {
  // Starter prompts are curated in-app for Seeger Weiss's practice areas.
  return SW_PROMPT_SUGGESTIONS;
}

export async function transcribeAudio(
  blob: Blob,
  signal?: AbortSignal,
): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const audio_base64 = btoa(binary);
  const mime_type = blob.type || "audio/webm";
  const res = await fetch(`${SUPABASE_URL}/functions/v1/transcribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON,
      Authorization: `Bearer ${SUPABASE_ANON}`,
    },
    body: JSON.stringify({ audio_base64, mime_type }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Transcription failed (${res.status})`);
  }
  const data = (await res.json()) as { text?: string; error?: string };
  if (data.error) throw new Error(data.error);
  return (data.text ?? "").trim();
}
