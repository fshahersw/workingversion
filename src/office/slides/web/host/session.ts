import { OrderedChatAppender } from "@/lib/office/chat-persistence";
// ============================================================================
// Platform host for the Slides renderer. The retained preload bridge talks to
// `ipcRenderer` (shimmed in ./electron); every channel lands here and is
// either served locally (settings, attachments, chat history, browser-side
// export/print, assistant stream through the platform) or forwarded to the
// Office engine service, which runs the deck worker (pptx-engine + pptx-render
// with real font shaping).
//
// Ported from the Office web preview host (apps/slides/web/host/session.ts):
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
import { OfficeSessionQueue, type SessionGeneration } from "@/lib/office/session-queue";
import { writerWebSearchFn } from "@/lib/writer/writer.functions";

import { getPlatformImage, handleOf, isPlatformImage, putPlatformImage } from "@/office/shared/image-store";
import {
  classifyOfficeAttachment,
  extractOfficeAttachment,
  OFFICE_ATTACHMENT_ACCEPT,
  OFFICE_EXTRACT_EXTS,
  OFFICE_LOCAL_TEXT_EXTS,
} from "@/office/shared/extract-attachment";

import { createBlankDeck, downloadBlob, pickFiles, platformFetch, uploadDeck } from "../api";
import { emitHost, installHost, takeDropped } from "./electron";

type EngineSession = {
  engineUrl: string;
  token: string;
  tokenExpiresAt: number;
  document: { docId: string; kind: string; name: string; version: number; hash: string };
  source: string;
};

export type SlidesHostOptions = {
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
const chatAppender = new OrderedChatAppender();
const streams = new Map<string, AbortController>();
const attachments = new Map<string, File>();
const attachmentTextCache = new Map<string, Promise<string>>();
let options: SlidesHostOptions | null = null;
type EngineBinding = { engine: EngineSession; generation: SessionGeneration; sessionId: string; sequence: number };
const sessionQueue = new OfficeSessionQueue();
let activeSession: EngineBinding | null = null;
let lifecycleSignal: AbortSignal | undefined;
let initial: { sessionId: string; sequence: number; result: unknown; events?: unknown[] } | null =
  null;
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
/** Route a ribbon/menu command (save, export-pdf, …) into the renderer. */
export function command(name: string): void {
  emitHost("slides:menu", name);
}
export function engineCredentials(): { engineUrl: string; token: string } | null {
  const engine = activeSession?.engine;
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
const base64Of = async (blob: Blob) =>
  (encode(await blob.arrayBuffer()) as { $officeBytes: string }).$officeBytes;

// --- Engine calls --------------------------------------------------------------------------------

class EngineError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Re-mint the engine token when it is close to expiry (tokens live 15 minutes). */
async function freshEngine(binding: EngineBinding): Promise<EngineSession> {
  sessionQueue.assertCurrent(binding.generation);
  if (binding.engine.tokenExpiresAt - Date.now() < 3 * 60_000) {
    const next = await openEngineSessionFn({ data: { docId: binding.engine.document.docId } });
    sessionQueue.assertCurrent(binding.generation);
    binding.engine = { ...binding.engine, token: next.token, tokenExpiresAt: next.tokenExpiresAt };
  }
  return binding.engine;
}

async function engineJson<T>(binding: EngineBinding, path: string, body: unknown): Promise<T> {
  const e = await freshEngine(binding);
  sessionQueue.assertCurrent(binding.generation);
  const res = await fetch(`${e.engineUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${e.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: binding.generation.signal,
  });
  sessionQueue.assertCurrent(binding.generation);
  if (!res.ok) {
    const value = (await res.json().catch(() => ({}))) as { error?: string };
    throw new EngineError(res.status, value.error || "The presentation engine request failed.");
  }
  const result = (await res.json()) as T;
  sessionQueue.assertCurrent(binding.generation);
  return result;
}

export function rpc(channel: string, args: unknown[] = []): Promise<unknown> {
  const binding = activeSession;
  if (!binding) return Promise.reject(new Error("The presentation session is not open."));
  const operationId = crypto.randomUUID();
  const encodedArgs = encode(args);
  return sessionQueue.enqueue(binding.generation, async () => {
    const response = decode(
      await engineJson(
        binding,
        `/engine/${binding.sessionId}/rpc`,
        { channel, args: encodedArgs, sequence: binding.sequence, operationId },
      ),
    ) as {
      sequence: number;
      document?: OfficeDocSummary | null;
      operationKind?: string;
      events?: unknown[];
      result?: unknown;
    };
    sessionQueue.assertCurrent(binding.generation);
    binding.sequence = response.sequence;
    state.sequence = response.sequence;
    if (response.document) {
      state.document = response.document;
      state.dirty = false;
    } else if (response.operationKind === "write") state.dirty = true;
    publish();
    applyEvents(response.events);
    return response.result;
  });
}

// --- Documents -----------------------------------------------------------------------------------------

async function openNew(upload: boolean): Promise<null> {
  if (upload) {
    const [file] = await pickFiles(".pptx");
    if (!file) return null;
    const created = await uploadDeck(file);
    options?.navigateTo(created.draftId);
    return null;
  }
  const created = await createBlankDeck();
  options?.navigateTo(created.draftId);
  return null;
}

export async function downloadSaved(): Promise<void> {
  const d = state.document!;
  if (state.dirty) throw new Error("Save the deck before downloading its committed revision.");
  const r = await platformFetch(`/api/office/docs/${d.draftId}/content?version=${d.version}`);
  downloadBlob(await r.blob(), d.name);
}

// --- Assistant stream (platform model, Slides tool policy) --------------------------------------------------

async function stream(r: {
  requestId: string;
  system: string;
  messages: unknown[];
  tools?: unknown[];
  settings?: { swMode?: string; swProfile?: string };
}): Promise<void> {
  const binding = activeSession;
  if (!binding) throw new Error("The document session is not open.");
  sessionQueue.assertCurrent(binding.generation);
  const doc = state.document!;
  const controller = new AbortController();
  const abort = () => controller.abort();
  binding.generation.signal.addEventListener("abort", abort, { once: true });
  streams.set(r.requestId, controller);
  state.busy = true;
  publish();
  try {
    const response = await platformFetch("/api/office/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        app: "slides",
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
        if (text.length > 12_000_000) throw new Error("Stream event is too large.");
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
          sessionQueue.assertCurrent(binding.generation);
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
    if (activeSession !== binding || binding.generation.signal.aborted) return;
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
    binding.generation.signal.removeEventListener("abort", abort);
    if (activeSession === binding && !binding.generation.signal.aborted) {
      streams.delete(r.requestId);
      state.busy = streams.size > 0;
      publish();
    }
  }
}

// --- Attachments (client-side, per session) -------------------------------------------------------------------

async function addAttachments(files: File[]) {
  const accepted: Array<{ path: string; name: string; ext: string; sizeBytes: number }> = [];
  const rejected: string[] = [];
  for (const f of files.slice(0, 10)) {
    const ext = f.name.split(".").at(-1)!.toLowerCase();
    const check = classifyOfficeAttachment(ext, f.size);
    if (!check.ok) {
      rejected.push(f.name + ": " + check.error);
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
    return addAttachments(await pickFiles(OFFICE_ATTACHMENT_ACCEPT, true));
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
    return { ok: true, mime: f.type, base64: await base64Of(f) };
  }
  const ext = f.name.split(".").at(-1)?.toLowerCase() || "";
  const path = String(args[0]);
  let text = "";
  try {
    if (OFFICE_LOCAL_TEXT_EXTS.has(ext)) {
      text = await f.text();
    } else if (OFFICE_EXTRACT_EXTS.has(ext)) {
      let pending = attachmentTextCache.get(path);
      if (!pending) {
        pending = extractOfficeAttachment(f);
        attachmentTextCache.set(path, pending);
      }
      text = await pending;
    } else {
      text = await f.text();
    }
  } catch (error) {
    attachmentTextCache.delete(path);
    return { ok: false, error: error instanceof Error ? error.message : "The attachment could not be read." };
  }
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
    const message = structuredClone({
      role: r.role, text: r.text,
      ...(Array.isArray(r.tools) ? { tools: r.tools as never } : {}),
      ...(Array.isArray(r.attachments) ? { attachments: r.attachments as never } : {}),
    });
    await chatAppender.append(docId, operationId =>
      appendOfficeChatFn({ data: { docId, message: { ...message, operationId } } }));
    return;
  }
  if (channel === "project:rebindChat") return { projectId: docId, chatId: docId };
  if (channel === "project:list") return [];
  if (channel === "project:timeline") return [];
  throw new Error("This project operation is not available in the platform Slides.");
}

// --- Style templates (assistant "Style Skill" presets, kept in this browser) ------------------------------------

type StyleTemplate = { name: string; topic: string; styleSkill: string; createdAt: string };
const STYLE_KEY = "sw-slides-style-templates";
function readStyles(): StyleTemplate[] {
  try {
    const v = JSON.parse(localStorage.getItem(STYLE_KEY) || "[]") as unknown;
    return Array.isArray(v) ? (v as StyleTemplate[]) : [];
  } catch {
    return [];
  }
}
function writeStyles(list: StyleTemplate[]): void {
  localStorage.setItem(STYLE_KEY, JSON.stringify(list.slice(0, 20)));
}
function saveStyle(name: unknown, data: unknown): { ok: boolean; error?: string } {
  const n = String(name ?? "")
    .trim()
    .slice(0, 80);
  const d = (data ?? {}) as Partial<StyleTemplate>;
  if (!n || typeof d.styleSkill !== "string")
    return { ok: false, error: "Name and style are required." };
  if (d.styleSkill.length > 64_000) return { ok: false, error: "The style is too large to store." };
  const list = readStyles().filter((t) => t.name !== n);
  list.unshift({
    name: n,
    topic: String(d.topic ?? ""),
    styleSkill: d.styleSkill,
    createdAt: String(d.createdAt ?? new Date().toISOString()),
  });
  writeStyles(list);
  return { ok: true };
}

// --- Browser-side insert / export / print --------------------------------------------------------------------------

const EMU_PER_PX_96 = 9525;

/** File > Insert picture: browser picker, then the engine's addPicture through add-image-bytes. */
async function insertImage(slideIndex: number, fitWidthPx: number) {
  const [file] = await pickFiles(".png,.jpg,.jpeg,.gif,.bmp,.webp,.tif,.tiff");
  if (!file) return null;
  const ext = file.name.split(".").pop()!.toLowerCase();
  const size = (await rpc("slides:get-slide-size")) as { cx: number; cy: number } | null;
  if (!size) return null;
  const scale = fitWidthPx / (size.cx / EMU_PER_PX_96);
  const pageW = fitWidthPx;
  const pageH = (size.cy / EMU_PER_PX_96) * scale;
  let natural = { width: 4, height: 3 };
  try {
    const bmp = await createImageBitmap(file);
    natural = { width: bmp.width, height: bmp.height };
    bmp.close();
  } catch {
    /* TIFF/BMP the browser cannot decode: keep the 4:3 placeholder box */
  }
  const s = Math.min(pageW / 2 / natural.width, pageH / 2 / natural.height);
  const wPx = natural.width * s;
  const hPx = natural.height * s;
  return rpc("slides:add-image-bytes", [
    {
      slideIndex,
      base64: await base64Of(file),
      ext,
      xPx: (pageW - wPx) / 2,
      yPx: (pageH - hPx) / 2,
      wPx,
      hPx,
      fitWidthPx,
      name: file.name,
    },
  ]);
}

/**
 * Images the assistant produced (Nova Canvas, rendered diagrams, Python
 * figures) live in the browser as platform-image handles; the renderer's
 * insert_web_image / replace_image hand the handle here and the bytes go into
 * the deck through the engine's add-image-bytes / replace-picture-bytes ops.
 */
function platformImageBytes(url: unknown): { base64: string; ext: string; label: string } | null {
  if (!isPlatformImage(url)) return null;
  const image = getPlatformImage(url);
  if (!image) return null;
  return { base64: image.base64, ext: image.mime === "image/png" ? "png" : "jpg", label: image.label };
}

/**
 * Bytes for an image reference: a platform-image handle from the browser
 * store, or a public http(s) URL downloaded through the platform (the
 * browser cannot fetch cross-origin images itself).
 */
async function imageSearch(query: string, maxResults: number) {
  try {
    const { officeImageSearchFn } = await import("@/lib/office/tools.functions");
    const r = await officeImageSearchFn({ data: { query, maxResults } });
    if (r.method === "error") return { images: [], method: "error", error: r.error };
    return {
      images: r.images.map((i) => ({ imageUrl: i.imageUrl, title: i.title, sourceUrl: i.imageUrl, source: "web" })),
      method: "tavily",
    };
  } catch (error) {
    return { images: [], method: "error", error: error instanceof Error ? error.message : "Image search failed." };
  }
}

async function imageBytesFor(url: unknown): Promise<{ base64: string; ext: string; label: string }> {
  const local = platformImageBytes(url);
  if (local) return local;
  if (isPlatformImage(url)) throw new Error("That image handle is no longer available; produce the image again.");
  const href = String(url ?? "");
  if (!/^https?:\/\//i.test(href)) {
    throw new Error("Pass an http(s) image URL or a platform-image handle from generate_image / render_diagram / run_python / edit_image.");
  }
  const { officeFetchImageFn } = await import("@/lib/office/tools.functions");
  const r = await officeFetchImageFn({ data: { url: href } });
  const ext = r.mime === "image/png" ? "png" : r.mime === "image/gif" ? "gif" : r.mime === "image/webp" ? "webp" : "jpg";
  let label = "Web image";
  try {
    label = decodeURIComponent(new URL(href).pathname.split("/").pop() || label).slice(0, 80) || label;
  } catch {
    /* keep the default label */
  }
  return { base64: r.base64, ext, label };
}

async function insertPlatformImage(op: {
  slideIndex: number;
  url: string;
  xPx: number;
  yPx: number;
  wPx: number;
  hPx: number;
  fitWidthPx: number;
}) {
  const bytes = await imageBytesFor(op?.url);
  return rpc("slides:add-image-bytes", [
    {
      slideIndex: op.slideIndex,
      base64: bytes.base64,
      ext: bytes.ext,
      xPx: op.xPx,
      yPx: op.yPx,
      wPx: op.wPx,
      hPx: op.hPx,
      fitWidthPx: op.fitWidthPx,
      name: bytes.label,
    },
  ]);
}

async function replacePlatformImage(op: { slideIndex: number; sourceId: string; url: string; keepSrcRect?: boolean }) {
  const bytes = await imageBytesFor(op?.url);
  return rpc("slides:replace-picture-bytes", [
    {
      slideIndex: op.slideIndex,
      sourceId: op.sourceId,
      base64: bytes.base64,
      ext: bytes.ext,
      ...(op.keepSrcRect ? { keepSrcRect: true } : {}),
    },
  ]);
}

/** Slides' generate_image channel: Nova Canvas through the platform; returns a handle usable as a URL. */
async function generateImage(op: { prompt?: string; aspectRatio?: string; referenceImageUrls?: string[] }) {
  if (Array.isArray(op?.referenceImageUrls) && op.referenceImageUrls.length) {
    return { error: "Editing an existing image (reference images) is not available; generate a new image instead." };
  }
  try {
    const { officeGenerateImageFn } = await import("@/lib/office/tools.functions");
    const r = await officeGenerateImageFn({
      data: { prompt: String(op?.prompt ?? ""), ...(op?.aspectRatio ? { aspectRatio: op.aspectRatio } : {}) },
    });
    const image = await putPlatformImage({ mime: r.mime, base64: r.base64, width: r.width, height: r.height, label: String(op?.prompt ?? "").slice(0, 80) });
    return { url: handleOf(image) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Image generation failed." };
  }
}

async function clipboardExternal() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const image = item.types.find((t) => t.startsWith("image/"));
      if (image) {
        const blob = await item.getType(image);
        const ext = image.split("/")[1] === "jpeg" ? "jpg" : image.split("/")[1]!;
        return { kind: "image" as const, base64: await base64Of(blob), ext };
      }
    }
    for (const item of items) {
      if (item.types.includes("text/plain")) {
        const text = await (await item.getType("text/plain")).text();
        if (text) return { kind: "text" as const, text };
      }
    }
  } catch {
    /* clipboard permission denied or unavailable */
  }
  return { kind: "none" as const };
}

type PageImages = { pngsBase64: string[]; widthPx: number; heightPx: number };

async function exportImagesZip(op: { baseName?: string; pngsBase64?: string[] }) {
  const pngs = op.pngsBase64 ?? [];
  if (!pngs.length || pngs.length > 200) return { ok: false, error: "Choose 1 to 200 slides." };
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const base = String(op.baseName || "slides").replace(/[^\w.\- ()]/g, "_");
  const paths: string[] = [];
  pngs.forEach((png, i) => {
    const name = `${base}-${String(i + 1).padStart(2, "0")}.png`;
    zip.file(name, png, { base64: true });
    paths.push(name);
  });
  downloadBlob(await zip.generateAsync({ type: "blob" }), `${base}.zip`);
  return { ok: true, paths };
}

/** Same page assembly as the desktop print path, rendered into a hidden frame for the browser's print dialog. */
function printSlides(
  op: PageImages & {
    layout?: "full" | "handout2" | "handout3" | "handout6" | "notes";
    notes?: string[];
    orientation?: "portrait" | "landscape";
    frame?: boolean;
  },
): Promise<{ ok: boolean; error?: string }> {
  const { pngsBase64, widthPx, heightPx } = op;
  if (!Array.isArray(pngsBase64) || !pngsBase64.length)
    return Promise.resolve({ ok: false, error: "Nothing to print." });
  const layout = op.layout ?? "full";
  const ratio = widthPx / heightPx;
  const perPage =
    layout === "handout2" ? 2 : layout === "handout3" ? 3 : layout === "handout6" ? 6 : 1;
  const heightIn = 7.5;
  const pageSize =
    layout === "full"
      ? `${Math.round(ratio * heightIn * 1000) / 1000}in ${heightIn}in`
      : op.orientation === "landscape"
        ? "11in 8.5in"
        : "8.5in 11in";
  const border = op.frame ? "border:1px solid #000;" : "";
  const img = (png: string, style: string) =>
    `<img src="data:image/png;base64,${png}" style="${style}${border}" />`;
  let body = "";
  if (layout === "full") {
    body = pngsBase64
      .map(
        (p) =>
          `<section class="page">${img(p, "width:100%;height:100%;object-fit:contain;")}</section>`,
      )
      .join("");
  } else if (layout === "notes") {
    body = pngsBase64
      .map(
        (p, i) =>
          `<section class="page notes">${img(p, "width:70%;margin:0 auto;display:block;aspect-ratio:" + ratio + ";")}<pre>${(
            op.notes?.[i] ?? ""
          )
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")}</pre></section>`,
      )
      .join("");
  } else {
    for (let i = 0; i < pngsBase64.length; i += perPage) {
      const cols = perPage === 6 ? 2 : 1;
      body += `<section class="page grid" style="grid-template-columns:repeat(${cols},1fr);">${pngsBase64
        .slice(i, i + perPage)
        .map((p) => img(p, "width:100%;aspect-ratio:" + ratio + ";object-fit:contain;"))
        .join("")}</section>`;
    }
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Print</title><style>
@page{size:${pageSize};margin:${layout === "full" ? "0" : "0.5in"}}
html,body{margin:0;padding:0}
.page{page-break-after:always;break-after:page;height:100vh;box-sizing:border-box;overflow:hidden}
.page:last-child{page-break-after:auto;break-after:auto}
.grid{display:grid;gap:0.4in;align-content:start}
.notes pre{white-space:pre-wrap;font:12pt/1.4 sans-serif;margin-top:0.4in}
</style></head><body>${body}</body></html>`;
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(frame);
    const finish = (result: { ok: boolean; error?: string }) => {
      setTimeout(() => frame.remove(), 60_000);
      resolve(result);
    };
    frame.addEventListener("load", () => {
      const w = frame.contentWindow;
      if (!w) return finish({ ok: false, error: "The print frame could not be created." });
      // Let the data-URL images decode before the dialog snapshots the page.
      setTimeout(() => {
        try {
          w.focus();
          w.print();
          finish({ ok: true });
        } catch (error) {
          finish({ ok: false, error: error instanceof Error ? error.message : "Print failed." });
        }
      }, 250);
    });
    frame.srcdoc = html;
  });
}

// --- Save through the renderer's own flow -------------------------------------------------------------------------------

let saveResolve: ((ok: boolean) => void) | null = null;
export async function saveNow(): Promise<void> {
  if (state.readOnly) throw new Error("This deck is read-only.");
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
    emitHost("slides:menu", "save");
  });
}

const STATUS = {
  configured: true,
  researchConfigured: false,
  configPath: "Seeger Weiss platform",
  message:
    "The assistant is connected through the platform. Web search is available inside Edit, Ask and Review.",
};

const DESKTOP_ONLY = "This desktop-only operation is not available in the browser.";
let pdfExportToken = "";
let exportDirToken = "";

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
  if (channel === "ai:gsk-status") return { loggedIn: false, available: false };
  if (channel === "ai:gsk-login") return;
  if (channel === "ai:log-run-failure") return;
  if (channel === "ai:image-search") return imageSearch(String(args[0] ?? ""), Number(args[1]) || 8);
  if (channel === "ai:insert-image-url") return insertPlatformImage(args[0] as never);
  if (channel === "ai:replace-picture-url") return replacePlatformImage(args[0] as never);
  if (channel === "ai:generate-image") return generateImage(args[0] as never);
  if (channel === "ai:analyze-media") return { error: "External media analysis is not enabled." };
  if (channel === "ai:save-sidecar") return { ok: true };
  if (channel === "ai:save-style-template") return saveStyle(args[0], args[1]);
  if (channel === "ai:list-style-templates")
    return readStyles().map((t) => ({ name: t.name, topic: t.topic, createdAt: t.createdAt }));
  if (channel === "ai:load-style-template") {
    const t = readStyles().find((x) => x.name === String(args[0] ?? ""));
    return t
      ? { ok: true, styleSkill: t.styleSkill, topic: t.topic }
      : { ok: false, error: "Style template not found." };
  }
  if (channel.startsWith("project:")) return project(channel, args);
  if (/files-(pick|add|add-pasted-image|read|read-image)$/.test(channel))
    return fileAction(channel, args);
  if (channel === "slides:consume-pending-open") {
    setTimeout(() => applyEvents(initial!.events), 0);
    return initial!.result;
  }
  if (channel === "slides:open" || channel === "slides:open-path") return openNew(true);
  if (channel === "slides:new-blank") return openNew(false);
  if (channel === "slides:recent") return [];
  if (channel === "slides:cloud-gen-status")
    return { enabled: false, available: false, configured: false };
  if (channel === "slides:cloud-page-generate")
    throw new Error("Cloud page generation is not enabled. Use the assistant's slide tools.");
  if (channel === "slides:show-fullscreen") {
    if (args[0]) await document.documentElement.requestFullscreen?.().catch(() => undefined);
    else if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    return;
  }
  if (channel === "slides:insert-image") return insertImage(Number(args[0]), Number(args[1]));
  if (channel === "slides:insert-media" || channel === "slides:insert-model3d")
    throw new Error(
      "Video, audio and 3D model insertion are not available in the browser edition.",
    );
  if (channel === "slides:clipboard-external") return clipboardExternal();
  if (channel === "slides:native-clipboard") {
    try {
      document.execCommand(String(args[0]));
    } catch {
      /* not permitted */
    }
    return;
  }
  if (channel === "slides:font-download")
    return { ok: false, error: "Online font downloads are disabled. Use an installed font." };
  if (channel === "slides:font-install-local") return { families: [] };
  if (channel === "slides:presenter-start") return { audience: false };
  if (channel === "slides:presenter-swap") return false;
  if (channel === "slides:presenter-end") return;
  if (channel === "slides:audience-ready") return null;
  if (channel === "slides:pick-export-dir") {
    exportDirToken = "web-export-dir:" + crypto.randomUUID();
    return exportDirToken;
  }
  if (channel === "slides:export-images") {
    const input = args[0] as { dir?: string; baseName?: string; pngsBase64?: string[] };
    if (!exportDirToken || input?.dir !== exportDirToken)
      throw new Error("Choose Export images again.");
    exportDirToken = "";
    return exportImagesZip(input);
  }
  if (channel === "slides:pick-export-pdf-path") {
    pdfExportToken = "web-export:" + crypto.randomUUID();
    return pdfExportToken;
  }
  if (channel === "slides:export-pdf") {
    const input = args[0] as { filePath?: string } & PageImages;
    if (!pdfExportToken || input?.filePath !== pdfExportToken)
      throw new Error("Choose Export PDF again.");
    pdfExportToken = "";
    const { renderedImagesPdf } = await import("./rendered-pdf.mjs");
    const bytes = await renderedImagesPdf(input);
    downloadBlob(
      new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
      state.document!.name.replace(/\.pptx$/i, ".pdf"),
    );
    return { ok: true, path: "Browser download" };
  }
  if (channel === "slides:print") return printSlides(args[0] as never);
  if (channel === "slides:save-as")
    return {
      ok: false,
      error: "Save As is not available here. Save a revision, then use Download PPTX.",
    };
  if (channel === "shell:open-external") {
    const url = String(args[0] ?? "");
    if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener");
    return;
  }
  if (channel === "shell:read-local-image") throw new Error(DESKTOP_ONLY);
  if (channel === "slides:save") {
    try {
      const result = (await rpc(channel, args)) as { ok?: boolean } | undefined;
      saveResolve?.(result?.ok === true);
      return result;
    } catch (error) {
      saveResolve?.(false);
      throw error;
    }
  }
  return rpc(channel, args);
}

function notify(channel: string, args: unknown[]): void {
  if (channel === "slides:close-save-result") saveResolve?.(args[0] === true);
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

/**
 * Open the engine session and install the host. `signal` belongs to the route
 * effect that started this boot: when it aborts (navigation, or React's
 * development double-mount) the boot stops at its next checkpoint without
 * touching shared state, and any engine session it already opened is closed.
 */
export async function initialize(opts: SlidesHostOptions, signal?: AbortSignal): Promise<void> {
  // Invalidate before awaiting authentication: queued work can only use its own generation.
  void teardown();
  const generation = sessionQueue.begin(signal);
  lifecycleSignal = signal;
  const session = (await openEngineSessionFn({ data: { docId: opts.docId } })) as EngineSession;
  sessionQueue.assertCurrent(generation);
  if (session.document.kind !== "pptx") throw new Error("This document is not a deck.");
  const opened = await sessionQueue.open(generation, async () => {
    const response = await fetch(`${session.engineUrl}/engine/open`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        docId: session.document.docId, kind: "pptx", name: session.document.name,
        version: session.document.version, hash: session.document.hash, source: session.source,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const value = await response.json();
    if (!response.ok) {
      throw new EngineError(response.status, value.error || "The document could not open.");
    }
    return decode(value) as NonNullable<typeof initial>;
  }, opened => closeEngineSession(session, opened.sessionId));
  try { sessionQueue.assertCurrent(generation); } catch (error) {
    await closeEngineSession(session, opened.sessionId);
    throw error;
  }
  activeSession = { engine: session, generation, sessionId: opened.sessionId, sequence: opened.sequence };
  options = opts;
  state.dirty = false;
  state.busy = false;
  state.readOnly = false;
  state.document = {
    draftId: session.document.docId, kind: "pptx", name: session.document.name,
    title: session.document.name.replace(/\.pptx$/i, ""), folderId: "ROOT",
    version: session.document.version, hash: session.document.hash,
    size: 0, createdAt: "", updatedAt: "", recovery: null,
  };
  initial = opened;
  state.sessionId = opened.sessionId;
  state.sequence = opened.sequence;
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

/** Stop only the generation owned by this route effect. */
export async function teardown(signal?: AbortSignal): Promise<void> {
  if (signal && signal !== lifecycleSignal) return;
  sessionQueue.invalidate();
  for (const c of streams.values()) c.abort();
  streams.clear();
  saveResolve?.(false);
  const binding = activeSession;
  activeSession = null;
  lifecycleSignal = undefined;
  state.sessionId = "";
  state.document = null;
  state.sequence = 0;
  state.dirty = false;
  state.busy = false;
  options = null;
  initial = null;
  attachments.clear();
  attachmentTextCache.clear();
  if (binding) void closeEngineSession(binding.engine, binding.sessionId);
}
