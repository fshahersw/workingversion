// ============================================================================
// Platform host for the Sheets renderer. The retained preload bridge talks to
// `ipcRenderer` (shimmed in ./electron); every channel lands here and is
// either served locally (settings, attachments, chat history, assistant
// stream through the platform) or forwarded to the Office engine service,
// which runs the workbook worker and the Rust xlsx-sidecar.
//
// Ported from the Office web preview host (apps/sheets/web/host/session.ts):
//   - engine session is opened with a platform-minted token + S3 grant
//   - saves land as platform revisions (the engine calls the platform back)
//   - chat history is per document in the platform, separate from Research
// ============================================================================
import {
  appendOfficeChatFn,
  loadOfficeChatFn,
  openEngineSessionFn,
} from "@/lib/office/office.functions";
import type { OfficeDocSummary } from "@/lib/office/types";
import { writerWebSearchFn } from "@/lib/writer/writer.functions";

import { createWorkbook, downloadBlob, pickFiles, platformFetch, uploadWorkbook } from "../api";
import { emitHost, installHost, takeDropped } from "./electron";

type EngineSession = {
  engineUrl: string;
  token: string;
  tokenExpiresAt: number;
  document: { docId: string; kind: string; name: string; version: number; hash: string };
  source: string;
};

export type SheetsHostOptions = {
  docId: string;
  navigateTo(docId: string | null): void;
  onDirtyChange?(dirty: boolean): void;
};

type State = {
  document: OfficeDocSummary | null;
  sessionId: string;
  sequence: number;
  dirty: boolean;
  busy: boolean;
  readOnly: boolean;
};

const state: State = {
  document: null,
  sessionId: "",
  sequence: 0,
  dirty: false,
  busy: false,
  readOnly: false,
};
const observers = new Set<() => void>();
const streams = new Map<string, AbortController>();
const attachments = new Map<string, File>();
let options: SheetsHostOptions | null = null;
let engine: EngineSession | null = null;
let queue: Promise<unknown> = Promise.resolve();
let initial: { sessionId: string; sequence: number; result: unknown; events?: unknown[] } | null =
  null;
let consumed = false;
let settings: Record<string, unknown> = {
  provider: "custom",
  providers: { custom: { apiKey: "", model: "", baseUrl: "" } },
  gskToolsEnabled: false,
  swMode: "write",
  swProfile: "standard",
};

export const researchAvailable = () => false;
export const currentState = () => state;
export function subscribe(fn: () => void): () => void {
  observers.add(fn);
  return () => {
    observers.delete(fn);
  };
}
function publish(): void {
  for (const f of observers) f();
  options?.onDirtyChange?.(state.dirty);
}
export function markDirty(dirty: boolean): void {
  if (state.dirty === dirty) return;
  state.dirty = dirty;
  publish();
}
export function command(name: string): void {
  emitHost("menu:action", name);
}
export function engineCredentials(): { engineUrl: string; token: string } | null {
  return engine ? { engineUrl: engine.engineUrl, token: engine.token } : null;
}

// --- Wire encoding (bytes as base64) --------------------------------------------------------

function encode(v: unknown): unknown {
  if (v instanceof ArrayBuffer || v instanceof Uint8Array) {
    const a = v instanceof ArrayBuffer ? new Uint8Array(v) : v;
    let s = "";
    for (let i = 0; i < a.length; i += 32768) s += String.fromCharCode(...a.subarray(i, i + 32768));
    return { $officeBytes: btoa(s), kind: v instanceof ArrayBuffer ? "arraybuffer" : "uint8" };
  }
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
}
function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["$officeBytes"] === "string") {
      const s = atob(o["$officeBytes"]);
      const a = Uint8Array.from(s, (c) => c.charCodeAt(0));
      return o["kind"] === "arraybuffer" ? a.buffer : a;
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decode(x)]));
  }
  return v;
}
function applyEvents(events: unknown[] = []): void {
  for (const event of events as Array<{ channel: string; args: unknown[] }>)
    emitHost(event.channel, ...event.args);
}

// --- Engine calls --------------------------------------------------------------------------------

class EngineError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Re-mint the engine token when it is close to expiry (tokens live 15 minutes). */
async function freshEngine(): Promise<EngineSession> {
  if (!engine || !options) throw new Error("The workbook session is not open.");
  if (engine.tokenExpiresAt - Date.now() < 3 * 60_000) {
    const next = await openEngineSessionFn({ data: { docId: options.docId } });
    engine = { ...engine, token: next.token, tokenExpiresAt: next.tokenExpiresAt };
  }
  return engine;
}

async function engineJson<T>(path: string, body: unknown): Promise<T> {
  const e = await freshEngine();
  const res = await fetch(`${e.engineUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${e.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const value = (await res.json().catch(() => ({}))) as { error?: string };
    throw new EngineError(res.status, value.error || "The spreadsheet engine request failed.");
  }
  return (await res.json()) as T;
}

export function rpc(channel: string, args: unknown[] = []): Promise<unknown> {
  const operationId = crypto.randomUUID();
  const next = queue.then(async () => {
    const response = decode(
      await engineJson(
        `/engine/${state.sessionId}/rpc`,
        encode({ channel, args, sequence: state.sequence, operationId }),
      ),
    ) as {
      sequence: number;
      document?: OfficeDocSummary | null;
      operationKind?: string;
      events?: unknown[];
      result?: unknown;
    };
    state.sequence = response.sequence;
    if (response.document) {
      state.document = response.document;
      state.dirty = false;
    } else if (response.operationKind === "write") state.dirty = true;
    publish();
    applyEvents(response.events);
    return response.result;
  });
  queue = next.catch(() => {});
  return next;
}

// --- Documents -----------------------------------------------------------------------------------------

async function openNew(upload: boolean): Promise<null> {
  if (upload) {
    const [file] = await pickFiles(".xlsx,.csv");
    if (!file) return null;
    const created = await uploadWorkbook(file);
    options?.navigateTo(created.draftId);
    return null;
  }
  const { blankXlsxBuffer } = await import("../../src/gateway/csv-import");
  const created = await createWorkbook("Untitled.xlsx", await blankXlsxBuffer("Sheet1"));
  options?.navigateTo(created.draftId);
  return null;
}

export async function downloadSaved(): Promise<void> {
  const d = state.document!;
  if (state.dirty) throw new Error("Save the workbook before downloading its committed revision.");
  const r = await platformFetch(`/api/office/docs/${d.draftId}/content?version=${d.version}`);
  downloadBlob(await r.blob(), d.name);
}

// --- Assistant stream (platform model, Sheets tool policy) --------------------------------------------------

async function stream(r: {
  requestId: string;
  system: string;
  messages: unknown[];
  tools?: unknown[];
  settings?: { swMode?: string; swProfile?: string };
}): Promise<void> {
  const doc = state.document!;
  const controller = new AbortController();
  streams.set(r.requestId, controller);
  state.busy = true;
  publish();
  try {
    const response = await platformFetch("/api/office/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        app: "sheets",
        requestId: r.requestId,
        system: r.system,
        messages: r.messages,
        tools: r.tools ?? [],
        mode: r.settings?.swMode || settings["swMode"],
        profile: r.settings?.swProfile || settings["swProfile"],
      }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let complete = false;
    try {
      for (;;) {
        const p = await reader.read();
        if (p.done) break;
        text += decoder.decode(p.value, { stream: true });
        if (text.length > 1_600_000) throw new Error("Stream event is too large.");
        let at: number;
        while ((at = text.indexOf("\n")) >= 0) {
          const line = text.slice(0, at).trimEnd();
          text = text.slice(at + 1);
          if (!line.startsWith("data:")) continue;
          const e = JSON.parse(line.slice(5)) as { requestId: string; type: string };
          if (e.requestId !== r.requestId || state.document?.draftId !== doc.draftId) {
            throw new Error("Document response mismatch.");
          }
          if (["done", "error"].includes(e.type)) complete = true;
          emitHost("ai:stream-chunk", e);
        }
      }
      if (!complete && !controller.signal.aborted)
        throw new Error("The response ended before completion.");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (error) {
    emitHost(
      "ai:stream-chunk",
      controller.signal.aborted
        ? { requestId: r.requestId, type: "done", stopReason: "cancelled" }
        : {
            requestId: r.requestId,
            type: "error",
            error: error instanceof Error ? error.message : "Request failed.",
          },
    );
  } finally {
    streams.delete(r.requestId);
    state.busy = streams.size > 0;
    publish();
  }
}

// --- Attachments (client-side, per session) -------------------------------------------------------------------

async function addAttachments(files: File[]) {
  const accepted: Array<{ path: string; name: string; ext: string; sizeBytes: number }> = [];
  const rejected: string[] = [];
  for (const f of files.slice(0, 10)) {
    const ext = f.name.split(".").at(-1)!.toLowerCase();
    if (
      !["txt", "md", "csv", "json", "png", "jpg", "jpeg", "gif", "webp"].includes(ext) ||
      f.size > 5 * 1024 * 1024
    ) {
      rejected.push(f.name + ": use text or an image up to 5 MB.");
      continue;
    }
    const path = "attachment:" + crypto.randomUUID();
    attachments.set(path, f);
    accepted.push({ path, name: f.name, ext, sizeBytes: f.size });
  }
  return { accepted, rejected };
}

async function fileAction(channel: string, args: unknown[]) {
  if (channel.endsWith("files-pick"))
    return addAttachments(await pickFiles(".txt,.md,.csv,.json,.png,.jpg,.jpeg,.gif,.webp", true));
  if (channel.endsWith("files-add"))
    return addAttachments(((args[0] as string[]) ?? []).map(takeDropped).filter(Boolean) as File[]);
  if (channel.endsWith("files-add-pasted-image")) {
    return addAttachments([
      new File([args[0] as BlobPart], "Pasted." + String(args[1]), {
        type: "image/" + String(args[1]),
      }),
    ]);
  }
  const f = attachments.get(String(args[0]));
  if (!f) return { ok: false, error: "Attachment is not available in this document session." };
  if (channel.endsWith("files-read-image")) {
    return {
      ok: true,
      mime: f.type,
      base64: (encode(await f.arrayBuffer()) as { $officeBytes: string }).$officeBytes,
    };
  }
  const text = await f.text();
  const offset = Math.max(0, Math.trunc(Number(args[1]) || 0));
  const max = Math.min(24000, Math.max(1, Math.trunc(Number(args[2]) || 24000)));
  return {
    ok: true,
    name: f.name,
    text: text.slice(offset, offset + max),
    offset,
    totalChars: text.length,
  };
}

// --- Chat history (per document, in the platform) ------------------------------------------------------------------

async function project(channel: string, args: unknown[]) {
  const docId = options!.docId;
  if (channel === "project:resolveChat") return { projectId: docId, chatId: docId };
  if (channel === "project:loadChat") {
    const rows = await loadOfficeChatFn({ data: { docId, limit: 200 } });
    return rows.map((m) => ({
      seq: m.seq,
      ts: m.ts,
      role: m.role,
      text: m.text,
      tools: m.tools,
      attachments: m.attachments,
    }));
  }
  if (channel === "project:appendChat") {
    const r = args[0] as {
      role: "user" | "assistant";
      text: string;
      tools?: unknown;
      attachments?: unknown;
    };
    await appendOfficeChatFn({
      data: {
        docId,
        message: {
          role: r.role,
          text: r.text,
          ...(Array.isArray(r.tools) ? { tools: r.tools as never } : {}),
          ...(Array.isArray(r.attachments) ? { attachments: r.attachments as never } : {}),
        },
      },
    });
    return;
  }
  if (channel === "project:rebindChat") return { projectId: docId, chatId: docId };
  if (channel === "project:list") return [];
  if (channel === "project:timeline") return [];
  throw new Error("This project operation is not available in the platform Sheets.");
}

// --- Separate documents (assistant create_document) ------------------------------------------------------------------

/**
 * The renderer's create_document hands over either a worksheet serialized as
 * CSV (type xlsx/csv) or authored content (docx/pdf as restricted HTML, md as
 * Markdown). Worksheets become a new Library workbook (CSV downloads); authored
 * content becomes a Library document through the platform's document builder.
 */
async function createDocumentFromWorkbook(request: {
  type?: string;
  title?: string;
  content?: string;
  sheetName?: string;
}): Promise<{ ok: true; name: string; path?: string } | { ok: false; error: string }> {
  const type = String(request?.type ?? "xlsx");
  const title = String(request?.title ?? "").trim() || "Untitled";
  const content = String(request?.content ?? "");
  try {
    if (type === "csv") {
      downloadBlob(new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }), `${title}.csv`);
      return { ok: true, name: `${title}.csv`, path: "Browser download" };
    }
    if (type === "xlsx") {
      const { csvToXlsxBuffer } = await import("../../src/gateway/csv-import");
      const created = await createWorkbook(`${title}.xlsx`, new Uint8Array(await csvToXlsxBuffer(content)));
      return { ok: true, name: created.name, path: `${location.origin}/office/sheets/${created.draftId}` };
    }
    if (type === "docx" || type === "pdf" || type === "md") {
      const { officeCreateDocumentFn } = await import("@/lib/office/tools.functions");
      const r = await officeCreateDocumentFn({
        data: {
          kind: type === "md" ? "docx" : type,
          title,
          markdown: content,
          format: type === "md" ? "markdown" : "html",
        },
      });
      if (r.kind === "pdf") {
        const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
        downloadBlob(new Blob([bytes], { type: "application/pdf" }), r.name);
        return { ok: true, name: r.name, path: "Browser download" };
      }
      return { ok: true, name: r.doc.name, path: `${location.origin}${r.url}` };
    }
    return { ok: false, error: `Unsupported file type ${type}.` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Creating the document failed." };
  }
}

// --- Save through the renderer's own flow -------------------------------------------------------------------------------

let saveResolve: ((ok: boolean) => void) | null = null;
export async function saveNow(): Promise<void> {
  if (state.readOnly) throw new Error("This workbook is read-only.");
  if (!state.dirty) return;
  if (saveResolve) throw new Error("A save is already in progress.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      saveResolve = null;
      reject(new Error("Save did not finish. Your unsaved changes remain in this tab."));
    }, 40_000);
    saveResolve = (ok) => {
      clearTimeout(timer);
      saveResolve = null;
      if (ok) resolve();
      else reject(new Error("Save did not complete."));
    };
    emitHost("menu:action", "save");
  });
}

const STATUS = {
  configured: true,
  researchConfigured: false,
  configPath: "Seeger Weiss platform",
  message:
    "The assistant is connected through the platform. Web search is available inside Edit, Ask and Review.",
};

// --- IPC dispatch ---------------------------------------------------------------------------------------------------------

async function invoke(channel: string, args: unknown[]): Promise<unknown> {
  if (channel === "app:get-language") return "en";
  if (channel === "app:get-theme") return "light";
  if (channel === "sw:status") return STATUS;
  if (channel === "sw:test") return { ...STATUS, testedAt: new Date().toISOString() };
  if (channel === "sw:approve-research")
    throw new Error("Public research mode is not enabled. Use web search inside Edit or Ask.");
  if (channel === "sw:open-config")
    throw new Error("The platform manages the writing connection. No keys belong in the browser.");
  if (channel === "ai:get-settings") return settings;
  if (channel === "ai:set-settings") {
    const x = args[0] as { swMode?: string; swProfile?: string } | undefined;
    const mode = state.readOnly
      ? "ask"
      : ["write", "ask", "review"].includes(x?.swMode ?? "")
        ? x!.swMode!
        : "write";
    settings = {
      ...settings,
      swMode: mode,
      swProfile: x?.swProfile === "thorough" ? "thorough" : "standard",
    };
    return;
  }
  if (channel === "ai:stream") return stream(args[0] as never);
  if (channel === "ai:stream-cancel") {
    streams.get(String(args[0]))?.abort();
    return;
  }
  if (channel === "ai:web-search") {
    try {
      return await writerWebSearchFn({
        data: { query: String(args[0] ?? ""), maxResults: Number(args[1]) || 6 },
      });
    } catch (error) {
      return {
        results: [],
        method: "error",
        error: error instanceof Error ? error.message : "Web search failed.",
      };
    }
  }
  if (channel === "ai:gsk-status") return { loggedIn: false };
  if (channel === "ai:image-search")
    return { images: [], method: "error", error: "External image search is not enabled." };
  if (channel === "ai:fetch-image") return null;
  if (channel === "sheets:ai-generate-image")
    return { error: "External image generation is not enabled." };
  if (channel === "ai:list-style-templates") return [];
  if (channel.startsWith("project:")) return project(channel, args);
  if (/files-(pick|add|add-pasted-image|read|read-image)$/.test(channel))
    return fileAction(channel, args);
  if (channel === "sheets:has-queued-workbook") return !consumed;
  if (channel === "sheets:consume-new-blank") return false;
  if (channel === "workbook:select" && !consumed) {
    consumed = true;
    setTimeout(() => applyEvents(initial!.events), 0);
    return { ...(initial!.result as object), readOnly: state.readOnly };
  }
  if (channel === "workbook:select") return openNew(true);
  if (channel === "sw:new-workbook") return openNew(false);
  if (channel === "workbook:select-for-merge" || channel === "workbook:open-for-merge") {
    throw new Error("Merging workbooks is not available in the platform Sheets yet.");
  }
  if (channel === "workbook:auto-rename") return { renamed: false };
  if (channel === "workbook:close") return;
  if (channel === "workbook:create-document") return createDocumentFromWorkbook(args[0] as never);
  if (channel === "workbook:export-pdf")
    return {
      ok: false,
      error: "PDF export is not enabled yet; download the XLSX or print from the browser.",
    };
  if (channel === "shell:open-external") {
    const url = String(args[0] ?? "");
    if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener");
    return;
  }
  if (channel === "shell:read-local-image" || channel.startsWith("sheets:capture-screen")) {
    throw new Error("This desktop-only operation is not available in the browser.");
  }
  if (channel === "workbook:csv-save-confirm") {
    return confirm(
      "CSV retains values only and loses spreadsheet formatting and formulas. Continue?",
    )
      ? "csv"
      : "cancel";
  }
  if (channel === "workbook:export-csv") {
    const r = args[0] as { content?: string; fileName?: string };
    if (typeof r?.content !== "string" || r.content.length > 16_000_000)
      throw new Error("CSV is too large.");
    const fileName = r.fileName || "export.csv";
    downloadBlob(
      new Blob(["\uFEFF", r.content], { type: "text/csv;charset=utf-8" }),
      fileName.endsWith(".csv") ? fileName : fileName + ".csv",
    );
    return { canceled: false, path: "Browser download" };
  }
  if (channel === "workbook:save") {
    try {
      const result = (await rpc(channel, args)) as { canceled?: boolean } | undefined;
      saveResolve?.(result?.canceled === false);
      return result;
    } catch (error) {
      saveResolve?.(false);
      throw error;
    }
  }
  return rpc(channel, args);
}

function notify(channel: string, args: unknown[]): void {
  if (channel === "workbook:pending-edits") markDirty(Number(args[0]) > 0);
  else if (channel === "workbook:close-save-result") saveResolve?.(args[0] === true);
}

// --- Lifecycle -------------------------------------------------------------------------------------------------------------------

async function closeEngineSession(e: EngineSession, id: string): Promise<void> {
  await fetch(`${e.engineUrl}/engine/${id}/close`, {
    method: "POST",
    headers: { authorization: `Bearer ${e.token}`, "content-type": "application/json" },
    body: "{}",
    keepalive: true,
  }).catch(() => undefined);
}

const ABORTED = "The workbook was closed before it finished opening.";

/**
 * Open the engine session and install the host. `signal` belongs to the route
 * effect that started this boot: when it aborts (navigation, or React's
 * development double-mount) the boot stops at its next checkpoint without
 * touching shared state, and any engine session it already opened is closed.
 */
export async function initialize(opts: SheetsHostOptions, signal?: AbortSignal): Promise<void> {
  const session = (await openEngineSessionFn({ data: { docId: opts.docId } })) as EngineSession;
  if (signal?.aborted) throw new Error(ABORTED);
  options = opts;
  consumed = false;
  state.sessionId = "";
  state.sequence = 0;
  state.dirty = false;
  state.busy = false;
  engine = session;
  state.readOnly = false;
  state.document = {
    draftId: session.document.docId,
    kind: "xlsx",
    name: session.document.name,
    title: session.document.name.replace(/\.xlsx$/i, ""),
    folderId: "ROOT",
    version: session.document.version,
    hash: session.document.hash,
    size: 0,
    createdAt: "",
    updatedAt: "",
    recovery: null,
  };
  const opened = decode(
    await engineJson("/engine/open", {
      docId: session.document.docId,
      kind: "xlsx",
      name: session.document.name,
      version: session.document.version,
      hash: session.document.hash,
      source: session.source,
    }),
  ) as NonNullable<typeof initial>;
  if (signal?.aborted) {
    // The route unmounted while the engine was opening: release the session now
    // rather than leaving it to the idle reaper.
    void closeEngineSession(session, opened.sessionId);
    throw new Error(ABORTED);
  }
  initial = opened;
  state.sessionId = initial.sessionId;
  state.sequence = initial.sequence;
  installHost(invoke, notify);
  if (settings["swMode"] === "research") settings = { ...settings, swMode: "write" };
  publish();
  // Writable + configurable: the Writer's platform adapter assigns its own
  // window.__officeWeb when the user switches to Drafts in the same session.
  Object.defineProperty(window, "__officeWeb", {
    value: { currentState, saveNow, downloadSaved, readOnly: state.readOnly },
    configurable: true,
    writable: true,
  });
}

/** Stop streams and release the engine session when the editor unmounts. */
export async function teardown(): Promise<void> {
  for (const c of streams.values()) c.abort();
  streams.clear();
  const id = state.sessionId;
  const e = engine;
  state.sessionId = "";
  options = null;
  if (id && e) void closeEngineSession(e, id);
  engine = null;
  initial = null;
}
