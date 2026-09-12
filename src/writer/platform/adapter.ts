// ============================================================================
// Platform adapter: implements the Writer renderer's `DesktopApi` (the typed
// preload surface the Electron build exposes) on top of the Seeger Weiss
// platform. Documents live in the Library (DOCX revisions in S3), the
// assistant streams through /api/writer/stream, web search calls the
// platform's curated search, and chat history is stored per document.
//
// Derived from the Office web preview adapter (apps/writer/web/adapter.ts);
// the renderer itself is untouched.
// ============================================================================
import type {
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
  AttachmentMeta,
  DesktopApi,
  MenuCommand,
  OpenFileResult,
} from "../shared/ipc";
import { AI_PROVIDERS } from "../shared/ipc";
import type { WriterStatus } from "../shared/sw-policy";
import type { ProjectApi } from "@genoffice/project-store";
import { parseDocx } from "@genoffice/docx-engine";
import {
  classifyOfficeAttachment,
  extractOfficeAttachment,
  OFFICE_ATTACHMENT_ACCEPT,
  OFFICE_EXTRACT_EXTS,
  OFFICE_LOCAL_TEXT_EXTS,
} from "@/office/shared/extract-attachment";

import {
  appendWriterChatFn,
  listWriterDocsFn,
  loadWriterChatFn,
  writerWebSearchFn,
} from "@/lib/writer/writer.functions";
import type { WriterDocSummary } from "@/lib/writer/types";

// --- Event bus --------------------------------------------------------------------

// Listener signatures come from DesktopApi's typed subscribe methods; the bus
// itself is untyped by design (one map for every channel).
type Listener = (...args: never[]) => void;
const events = new Map<string, Set<Listener>>();
function on(name: string, fn: (...args: never[]) => void): () => void {
  let set = events.get(name);
  if (!set) {
    set = new Set();
    events.set(name, set);
  }
  set.add(fn as Listener);
  return () => {
    set!.delete(fn as Listener);
  };
}
function emit(name: string, ...args: unknown[]): void {
  for (const fn of events.get(name) ?? []) (fn as (...a: unknown[]) => void)(...args);
}

// --- Adapter state --------------------------------------------------------------------

export type PlatformAdapterOptions = {
  /** The document this editor instance owns. */
  draftId: string;
  /** Navigate to another document (or the Drafts list when null). */
  navigateTo(draftId: string | null): void;
  /** Called whenever the unsaved-changes flag changes. */
  onDirtyChange?(dirty: boolean): void;
};

const state: {
  document: WriterDocSummary | null;
  dirty: boolean;
  options: PlatformAdapterOptions | null;
} = {
  document: null,
  dirty: false,
  options: null,
};
const pendingFiles = new Map<string, File>();
const attachments = new Map<string, File>();
const attachmentTextCache = new Map<string, Promise<string>>();
const streams = new Map<string, AbortController>();
const pendingSaves = new Map<string, string>();

let settings = {
  provider: "custom",
  providers: Object.fromEntries(
    AI_PROVIDERS.map((p) => [p.id, { apiKey: "", model: "", baseUrl: "" }]),
  ),
  gskToolsEnabled: false,
  swMode: "write",
  swProfile: "standard",
} as AiSettings & { swMode: string; swProfile: string };

export function currentDocument(): WriterDocSummary | null {
  return state.document;
}
export function subscribeState(fn: () => void): () => void {
  return on("state", fn);
}
export function setDirty(dirty: boolean): void {
  if (state.dirty === dirty) return;
  state.dirty = dirty;
  publish();
}
export function isDirty(): boolean {
  return state.dirty;
}
function publish(): void {
  emit("state");
  state.options?.onDirtyChange?.(state.dirty);
}
export function emitMenu(command: MenuCommand, payload?: string): void {
  emit("menu", command, payload);
}

// --- Platform HTTP (cookie-authenticated, same origin) ----------------------------------

class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`/api/writer${path}`, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) {
    const value = (await res.json().catch(() => ({}))) as { error?: string };
    throw new RequestError(res.status, value.error || "The document request failed.");
  }
  return res;
}
async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await api(path, init)).json() as Promise<T>;
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_UPLOAD = 30 * 1024 * 1024;

export async function createDocument(
  name: string,
  bytes: ArrayBuffer | Uint8Array,
): Promise<WriterDocSummary> {
  const body = bytes instanceof Uint8Array ? new Blob([bytes as BlobPart]) : new Blob([bytes]);
  return apiJson<WriterDocSummary>("/docs", {
    method: "POST",
    headers: { "Content-Type": DOCX_MIME, "X-Writer-Filename": encodeURIComponent(name) },
    body,
  });
}

export async function uploadDocument(file: File): Promise<WriterDocSummary> {
  if (file.size > MAX_UPLOAD || !file.name.toLowerCase().endsWith(".docx")) {
    throw new Error("Choose a Word document (.docx) up to 30 MB.");
  }
  return createDocument(file.name, await file.arrayBuffer());
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener("change", () => resolve(Array.from(input.files || [])), { once: true });
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.click();
  });
}

// --- Virtual paths ----------------------------------------------------------------------

const virtualPath = (m: WriterDocSummary) => `/writer-documents/${m.draftId}/${m.name}`;
function fromPath(path: string): string {
  const m = path.match(/^\/writer-documents\/([0-9A-HJKMNP-TV-Z]{26})\//);
  if (!m) throw new Error("Only platform document identifiers are supported.");
  return m[1]!;
}

async function fetchMeta(draftId: string): Promise<WriterDocSummary> {
  const { getWriterDocFn } = await import("@/lib/writer/writer.functions");
  return getWriterDocFn({ data: { draftId } });
}

async function openId(id: string): Promise<OpenFileResult> {
  const meta = await fetchMeta(id);
  const response = await api(`/docs/${meta.draftId}/content?version=${meta.version}`);
  let data = await response.arrayBuffer();
  let recovered = false;
  if (
    meta.recovery &&
    confirm("A recovery copy of unsaved work exists for this document. Open it as unsaved changes?")
  ) {
    try {
      const rec = await api(`/docs/${meta.draftId}/recovery`);
      data = await rec.arrayBuffer();
      recovered = true;
    } catch {
      /* fall back to the saved revision */
    }
  }
  for (const c of streams.values()) c.abort();
  state.document = meta;
  state.dirty = false;
  publish();
  return {
    path: virtualPath(meta),
    name: meta.name,
    data,
    hash: response.headers.get("X-Writer-Hash") || meta.hash,
    recovered,
  };
}

async function saveExisting(path: string, data: ArrayBuffer): Promise<{ ok: true }> {
  const id = fromPath(path);
  const meta = state.document;
  if (!meta || id !== meta.draftId) throw new Error("The document session changed before saving.");
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hash = Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
  const key = `${id}:${meta.version}:${hash}`;
  const operation = pendingSaves.get(key) || crypto.randomUUID();
  pendingSaves.set(key, operation);
  const saved = await apiJson<WriterDocSummary>(`/docs/${id}/content`, {
    method: "PUT",
    headers: {
      "Content-Type": DOCX_MIME,
      "If-Match": String(meta.version),
      "Idempotency-Key": operation,
    },
    body: data,
  });
  if (state.document?.draftId === id) {
    state.document = saved;
    state.dirty = false;
    publish();
  }
  pendingSaves.delete(key);
  return { ok: true };
}

async function saveAsNew(
  name: string,
  data: ArrayBuffer,
  ask: boolean,
): Promise<{ ok: boolean; path?: string }> {
  const chosen = ask ? prompt("Name for the new copy", name) : name;
  if (chosen === null) return { ok: false };
  const saved = await createDocument(chosen, data);
  // The copy opens as its own document; this instance is left as it was.
  state.options?.navigateTo(saved.draftId);
  return { ok: true, path: virtualPath(saved) };
}

/** Save through the renderer's own close-save flow (used by the header and by downloads). */
export async function saveNow(): Promise<WriterDocSummary> {
  if (!state.document) throw new Error("No document is open.");
  if (!state.dirty) return state.document;
  await new Promise<void>((resolve, reject) => {
    const off = on("save-result", (ok: boolean) => {
      clearTimeout(timer);
      off();
      if (ok) resolve();
      else reject(new Error("Save did not complete."));
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error("Save timed out. Check the document before retrying."));
    }, 20_000);
    emit("close-save");
  });
  return state.document!;
}

export async function downloadCurrent(): Promise<void> {
  const meta = await saveNow();
  const response = await api(`/docs/${meta.draftId}/content?version=${meta.version}`);
  downloadBlob(await response.blob(), meta.name);
}

// --- Attachments (client-side, per session) -----------------------------------------------

async function addFiles(files: File[]) {
  const accepted: AttachmentMeta[] = [];
  const rejected: string[] = [];
  for (const file of files.slice(0, 10)) {
    try {
      const ext = file.name.split(".").at(-1)?.toLowerCase() || "";
      const check =
        ext === "docx" && file.size <= 5 * 1024 * 1024
          ? { ok: true as const }
          : classifyOfficeAttachment(ext, file.size);
      if (!check.ok) throw new Error(check.error);
      const path = "web-attachment/" + crypto.randomUUID();
      attachments.set(path, file);
      accepted.push({ path, name: file.name, ext, sizeBytes: file.size });
    } catch (error) {
      rejected.push(file.name + ": " + String(error instanceof Error ? error.message : error));
    }
  }
  if (files.length > 10) rejected.push("At most 10 files may be attached at once.");
  return { accepted, rejected };
}

function base64(data: ArrayBuffer): string {
  let text = "";
  const a = new Uint8Array(data);
  for (let i = 0; i < a.length; i += 32768)
    text += String.fromCharCode(...a.subarray(i, i + 32768));
  return btoa(text);
}

async function attachmentText(path: string, offset: number, maxChars: number) {
  const file = attachments.get(path);
  if (!file)
    return { ok: false, error: "This attachment is not available in this document session." };
  const ext = file.name.split(".").at(-1)?.toLowerCase() || "";
  let text = "";
  try {
    if (OFFICE_LOCAL_TEXT_EXTS.has(ext)) {
      text = await file.text();
    } else if (OFFICE_EXTRACT_EXTS.has(ext)) {
      let pending = attachmentTextCache.get(path);
      if (!pending) {
        pending = extractOfficeAttachment(file);
        attachmentTextCache.set(path, pending);
      }
      text = await pending;
    } else {
      text = await file.text();
    }
  } catch (error) {
    attachmentTextCache.delete(path);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The attachment could not be read.",
    };
  }
  const start = Math.max(0, Math.trunc(offset || 0));
  const length = Math.min(24000, Math.max(1, Math.trunc(maxChars || 24000)));
  return {
    ok: true,
    name: file.name,
    totalChars: text.length,
    offset: start,
    text: text.slice(start, start + length),
  };
}

// --- Assistant stream -------------------------------------------------------------------------

async function streamRequest(r: AiStreamRequest): Promise<void> {
  const meta = state.document;
  if (!meta) throw new Error("Open a document before asking the assistant.");
  const captured = meta.draftId;
  const controller = new AbortController();
  streams.set(r.requestId, controller);
  try {
    const prefs = r.settings as AiSettings & { swMode?: string; swProfile?: string };
    const response = await api("/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: r.requestId,
        mode: prefs.swMode || "write",
        profile: prefs.swProfile || "standard",
        system: r.system,
        messages: r.messages,
        tools: r.tools ?? [],
      }),
      signal: controller.signal,
    });
    if (!response.body) throw new Error("The server returned no stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let complete = false;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        if (buffer.length > 12_000_000) throw new Error("Stream event is too large.");
        let at: number;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, at).trimEnd();
          buffer = buffer.slice(at + 1);
          if (!line.startsWith("data:")) continue;
          const chunk = JSON.parse(line.slice(5)) as AiStreamChunk;
          if (state.document?.draftId !== captured)
            throw new Error("The document session changed. The request was stopped.");
          if (chunk.requestId !== r.requestId) throw new Error("Response request mismatch.");
          if (chunk.type === "done" || chunk.type === "error") complete = true;
          emit("ai-stream", chunk);
        }
      }
      if (!complete && !controller.signal.aborted)
        throw new Error("The connection ended before completion.");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (error) {
    emit(
      "ai-stream",
      controller.signal.aborted
        ? ({
            requestId: r.requestId,
            type: "done",
            stopReason: "cancelled",
          } satisfies AiStreamChunk)
        : ({
            requestId: r.requestId,
            type: "error",
            error: error instanceof Error ? error.message : String(error),
          } satisfies AiStreamChunk),
    );
  } finally {
    streams.delete(r.requestId);
  }
}

// --- Chat history (per document, separate from Research) -------------------------------------------

function projectApiFor(draftId: string): ProjectApi {
  const ids = { projectId: draftId, chatId: draftId };
  const unsupported = async (): Promise<never> => {
    throw new Error("Project operations are not available in the platform Writer.");
  };
  return {
    resolveChat: async () => ids,
    loadChat: async (args) => {
      const rows = await loadWriterChatFn({ data: { draftId, limit: args.limit ?? 200 } });
      return rows.map((m) => ({
        seq: m.seq,
        ts: m.ts,
        role: m.role,
        text: m.text,
        ...(m.tools ? { tools: m.tools } : {}),
        ...(m.attachments ? { attachments: m.attachments } : {}),
      }));
    },
    appendChat: async (args) => {
      await appendWriterChatFn({
        data: {
          draftId,
          message: {
            role: args.role,
            text: args.text,
            ...(args.tools ? { tools: args.tools } : {}),
            ...(args.attachments ? { attachments: args.attachments } : {}),
          },
        },
      });
    },
    rebindChat: async () => ids,
    listProjects: async () => [],
    createProject: unsupported,
    renameProject: unsupported,
    deleteProject: unsupported,
    moveFile: unsupported,
    getTimeline: async () => [],
  };
}

// --- Install -------------------------------------------------------------------------------------------

const STATUS: WriterStatus = {
  configured: true,
  researchConfigured: false,
  configPath: "Seeger Weiss platform",
  message:
    "The assistant is connected through the platform. Web search is available inside Edit, Ask and Review.",
};

const unsupported = async (): Promise<never> => {
  throw new Error("This desktop-only operation is not available in the platform Writer.");
};
const failed = async () => ({
  ok: false,
  error: "This operation is not enabled in the platform Writer.",
});

let teardownListeners: Array<() => void> = [];

export function installPlatformAdapter(options: PlatformAdapterOptions): void {
  state.options = options;
  state.document = null;
  state.dirty = false;
  const desktopApi: DesktopApi = {
    getLanguage: async () => "en",
    onLanguageChanged: (h) => on("language", h),
    getTheme: async () => "light",
    onThemeChanged: (h) => on("theme", h),
    onChromePressed: (h) => on("chrome", h),
    writerStatus: async () => STATUS,
    writerOpenConfig: unsupported,
    writerTestConnection: async () => ({ ...STATUS, testedAt: new Date().toISOString() }),
    writerApproveResearch: async () => {
      throw new Error("Public research mode is not enabled. Use web search inside Edit or Ask.");
    },
    // Dictation: hand the recorded clip to the same-origin transcription route
    // (Bedrock Voxtral). Same auth posture and cookies as the rest of the app.
    transcribe: async (audioBase64, format) => {
      try {
        const res = await fetch("/api/transcribe", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio: audioBase64, format }),
        });
        const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!res.ok) return { error: data.error || "Transcription failed." };
        return { text: data.text };
      } catch {
        return { error: "Transcription failed." };
      }
    },
    openDocx: async () => {
      const [file] = await pickFiles(".docx");
      if (!file) return null;
      const created = await uploadDocument(file);
      options.navigateTo(created.draftId);
      return null;
    },
    openDocxPath: async (path) => {
      const id = fromPath(path);
      if (id === state.document?.draftId) return null;
      options.navigateTo(id);
      return null;
    },
    openDocxDecrypt: async () => ({
      ok: false,
      reason: "unsupported",
      error: "Encrypted DOCX files are not supported.",
    }),
    setDocPassword: unsupported,
    docPasswordIntentRevision: async () => 0,
    discardDocPasswordIntents: async () => ({ ok: true }),
    consumePendingOpenDocx: async () => openId(options.draftId),
    consumeNewBlankDoc: async () => false,
    consumeAiDocContent: async () => null,
    createDocument: failed,
    onOpenDocx: (h) => on("opened", h),
    onRenamedDocx: (h) => on("renamed", h),
    saveDocx: async (path, data) => {
      try {
        return await saveExisting(path, data);
      } catch (error) {
        return {
          ok: false,
          error: String(error instanceof Error ? error.message : error),
          ...((error as { status?: number }).status === 409
            ? { reason: "external-modified" as const }
            : {}),
        };
      }
    },
    saveDocxAs: async (name, data) => {
      try {
        return await saveAsNew(name, data, true);
      } catch (error) {
        return { ok: false, error: String(error instanceof Error ? error.message : error) };
      }
    },
    saveDocxNew: async (name, data) => {
      try {
        return await saveAsNew(name, data, false);
      } catch (error) {
        return { ok: false, error: String(error instanceof Error ? error.message : error) };
      }
    },
    writeRecoveryCopy: async (path, data) => {
      try {
        const id = fromPath(path);
        if (state.document?.draftId !== id) return { ok: false };
        await api(`/docs/${id}/recovery`, {
          method: "POST",
          headers: { "Content-Type": DOCX_MIME, "If-Match": String(state.document.version) },
          body: data,
        });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    onTeardown: (h) => on("teardown", h),
    getRecentFiles: async () => (await listWriterDocsFn()).map(virtualPath),
    pickImage: async () => {
      const [file] = await pickFiles("image/png,image/jpeg,image/gif");
      if (!file) return null;
      if (file.size > 5 * 1024 * 1024) throw new Error("Images must be under 5 MB.");
      const mime = file.type;
      if (!["image/png", "image/jpeg", "image/gif"].includes(mime))
        throw new Error("Unsupported image type.");
      return {
        base64: base64(await file.arrayBuffer()),
        mime: mime as "image/png" | "image/jpeg" | "image/gif",
        name: file.name,
      };
    },
    fontMetrics: async () => null,
    getAiSettings: async () => settings,
    setAiSettings: async (next) => {
      const n = next as AiSettings & { swMode?: string; swProfile?: string };
      const mode = n.swMode || "write";
      if (!["write", "ask", "review"].includes(mode)) throw new Error("Unknown assistant mode.");
      settings = {
        ...settings,
        swMode: mode,
        swProfile: n.swProfile === "thorough" ? "thorough" : "standard",
      };
    },
    print: async () => {
      window.print();
      return { ok: true };
    },
    exportPdf: async () => ({
      ok: false,
      error:
        "Use Print and choose 'Save as PDF' for now; server-side PDF export is not enabled yet.",
    }),
    printPdfBuffer: async () => ({
      ok: false,
      error: "Mixed-paper PDF export is not enabled. Use Print or download the DOCX.",
    }),
    saveMergedPdf: failed,
    aiChat: async () => ({ ok: false, error: "Use the assistant panel." }),
    aiStream: streamRequest,
    aiStreamCancel: async (id) => {
      streams.get(id)?.abort();
    },
    aiGskStatus: async () => ({ loggedIn: false }),
    aiGskLogin: unsupported,
    webSearch: async (query, maxResults) => {
      try {
        return await writerWebSearchFn({ data: { query, maxResults: maxResults ?? 6 } });
      } catch (error) {
        return {
          results: [],
          method: "error",
          error: error instanceof Error ? error.message : "Web search failed.",
        };
      }
    },
    imageSearch: async (query, maxResults) => {
      try {
        const { officeImageSearchFn } = await import("@/lib/office/tools.functions");
        const r = await officeImageSearchFn({ data: { query, maxResults: maxResults ?? 8 } });
        if (r.method === "error") return { images: [], method: "error", error: r.error };
        return {
          images: r.images.map((i) => ({
            imageUrl: i.imageUrl,
            title: i.title,
            sourceUrl: i.imageUrl,
            source: "web",
          })),
          method: "tavily",
        };
      } catch (error) {
        return {
          images: [],
          method: "error",
          error: error instanceof Error ? error.message : "Image search failed.",
        };
      }
    },
    // Public image URLs download through the platform (SSRF-guarded, bounded);
    // the browser cannot fetch them directly because of CORS.
    fetchImage: async (url) => {
      if (!/^https?:\/\//i.test(url)) return null;
      try {
        const { officeFetchImageFn } = await import("@/lib/office/tools.functions");
        const r = await officeFetchImageFn({ data: { url } });
        return { base64: r.base64, mime: r.mime };
      } catch {
        return null;
      }
    },
    aiGenerateImage: async () => ({ error: "Use the assistant's generate_image tool." }),
    pickAttachments: async () => addFiles(await pickFiles(OFFICE_ATTACHMENT_ACCEPT, true)),
    addAttachmentPaths: async (paths) => {
      const files: File[] = [];
      for (const path of paths) {
        const file = pendingFiles.get(path);
        if (file) {
          files.push(file);
          pendingFiles.delete(path);
        }
      }
      return addFiles(files);
    },
    addPastedImage: async (data, ext) =>
      addFiles([new File([data], "Pasted image." + ext, { type: "image/" + ext })]),
    readAttachment: attachmentText,
    readAttachmentImage: async (path) => {
      const file = attachments.get(path);
      if (!file || !file.type.startsWith("image/"))
        return { ok: false, error: "Image attachment not found in this session." };
      return { ok: true, base64: base64(await file.arrayBuffer()), mime: file.type };
    },
    getPathForFile: (file) => {
      const id = "web-pending:" + crypto.randomUUID();
      pendingFiles.set(id, file);
      return id;
    },
    copyImageToClipboard: async (dataUrl) => {
      if (!/^data:image\/(png|jpeg);base64,/.test(dataUrl)) return false;
      try {
        const blob = await (await fetch(dataUrl)).blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        return true;
      } catch {
        return false;
      }
    },
    openNewTab: async (path) => {
      const target = path ? `/drafts/${fromPath(path)}` : "/drafts";
      window.open(target, "_blank", "noopener");
    },
    listDocsTabs: async () =>
      state.document
        ? [{ id: state.document.draftId, title: state.document.name, focused: true }]
        : [],
    focusDocsTab: async () => undefined,
    onAiStream: (h) => on("ai-stream", h),
    onMenuCommand: (h) => on("menu", h),
    onCloseCheck: (h) => on("close-check", h),
    reportCloseCheck: (value) => setDirty(value.dirty),
    onCloseSaveRequest: (h) => on("close-save", h),
    reportCloseSaveResult: (ok) => emit("save-result", ok),
    reportViewMenuState: () => undefined,
  };
  window.desktop = desktopApi;
  window.projectApi = projectApiFor(options.draftId);
  window.__officeWeb = {
    canWrite: true,
    emitMenu,
    downloadCurrent,
    saveNow,
    printReady: null,
    printError: null,
  };

  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (state.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  const pageHide = () => {
    for (const c of streams.values()) c.abort();
    emit("teardown");
  };
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("pagehide", pageHide);
  teardownListeners = [
    () => window.removeEventListener("beforeunload", beforeUnload),
    () => window.removeEventListener("pagehide", pageHide),
  ];
}

/** Stop streams and background timers when the editor route unmounts. */
export function teardownPlatformAdapter(): void {
  for (const c of streams.values()) c.abort();
  streams.clear();
  emit("teardown");
  for (const off of teardownListeners) off();
  teardownListeners = [];
  events.clear();
  state.options = null;
  state.document = null;
  state.dirty = false;
}

declare global {
  interface Window {
    __officeWeb: {
      canWrite: boolean;
      emitMenu: typeof emitMenu;
      downloadCurrent: typeof downloadCurrent;
      saveNow: typeof saveNow;
      printReady: null | { name: string; width: number; height: number; scale: number };
      printError: string | null;
    };
  }
}
