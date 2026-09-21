import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useBlocker } from "@tanstack/react-router";
import { ArrowLeft, ArrowUp, Download, Highlighter, Loader2, RotateCw, Save, Square, Undo2, PanelRightClose, PanelRightOpen } from "lucide-react";
import { AgentLoop } from "@genoffice/agent-core";
import { Markdown } from "@genoffice/ui";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { OfficeDocSummary } from "@/lib/office/types";
import { appendOfficeChatFn, getOfficeDocFn, loadOfficeChatFn } from "@/lib/office/office.functions";
import { OrderedChatAppender } from "@/lib/office/chat-persistence";
import { applyPdfOperations, listPdfFields, validatePdf, type PdfOperation } from "./document";
import { openPdfView, pageText, highlightRects, capturePdfPage } from "./reader";
import { createPdfSkill } from "./skill";
import { pdfTransport } from "./transport";
import { downloadPdf, pdfRequest } from "./api";
import "./text-layer.css";
import "./pdf.css";

type Model = { bytes: Uint8Array; revision: number; view: PDFDocumentProxy; meta: OfficeDocSummary; dirty: boolean };
type Message = { role: "user" | "assistant"; text: string };
type Fields = Awaited<ReturnType<typeof listPdfFields>>;
const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

export function PdfWorkspace({ docId }: { docId: string }) {
  const model = useRef<Model | null>(null), alive = useRef(true), busyRef = useRef(false);
  const undo = useRef<Uint8Array[]>([]), loop = useRef<AgentLoop | null>(null);
  const chatAppender = useRef(new OrderedChatAppender());
  const conversation = useRef<HTMLDivElement>(null), followConversation = useRef(true);
  const runStart = useRef<Uint8Array | null>(null);
  const saveAttempt = useRef<{ bytes: Uint8Array; version: number; operationId: string } | null>(null);
  const [view, setView] = useState<PDFDocumentProxy | null>(null), [meta, setMeta] = useState<OfficeDocSummary | null>(null);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(""), [error, setError] = useState(""), [page, setPage] = useState(1);
  const [prompt, setPrompt] = useState(""), [messages, setMessages] = useState<Message[]>([]), [reply, setReply] = useState("");
  const [activity, setActivity] = useState<string[]>([]), [panel, setPanel] = useState(true), [selection, setSelection] = useState("");
  const [zoom, setZoom] = useState(1), [fields, setFields] = useState<Fields>([]), [notes, setNotes] = useState<string[]>([]);
  const [search, setSearch] = useState(""), [hits, setHits] = useState<number[]>([]), [searching, setSearching] = useState(false);
  useLayoutEffect(() => {
    const element = conversation.current;
    if (element && followConversation.current) element.scrollTop = element.scrollHeight;
  }, [messages, reply, activity, busy, fields, panel, view]);
  const locked = busy || saving || saveAttempt.current !== null;
  const current = () => { if (!model.current) throw new Error("The PDF is not ready."); return model.current; };
  const keepUndo = (bytes: Uint8Array) => {
    undo.current.push(bytes);
    while (undo.current.length > 10 || undo.current.reduce((n, item) => n + item.byteLength, 0) > 64 * 1024 * 1024) undo.current.shift();
  };
  const install = async (bytes: Uint8Array, expected: number, description: string, signal?: AbortSignal, history = true) => {
    signal?.throwIfAborted();
    const before = current();
    if (before.revision !== expected || saveAttempt.current) throw new Error("The document changed or a save needs recovery. Read it again.");
    const next = await openPdfView(bytes);
    if (!alive.current || signal?.aborted || model.current !== before) {
      await next.destroy(); signal?.throwIfAborted(); throw new Error("The document changed while preparing the operation.");
    }
    if (history && !busyRef.current) keepUndo(before.bytes);
    model.current = { ...before, bytes, view: next, revision: expected + 1, dirty: true };
    setView(next); setDirty(true); setSelection(""); setPage(n => Math.min(n, next.numPages)); setNotice(description);
    // The old canvas render cleanup runs before its document proxy is retired.
    setTimeout(() => { void before.view.destroy(); }, 0);
    void listPdfFields(bytes).then(value => { if (alive.current && model.current?.view === next) setFields(value); }).catch(e => setError(messageOf(e)));
  };
  const append = async (message: Message) => {
    if (alive.current) setMessages(previous => [...previous, message]);
    try { await chatAppender.current.append(docId, operationId => appendOfficeChatFn({ data: { docId, message: { ...message, operationId } } })); }
    catch (e) { if (alive.current) setError("Conversation could not be saved: " + messageOf(e)); }
  };
  const finishRun = async (text: string, outcome: "complete" | "cancelled" | "failed" = "complete") => {
    const before = runStart.current; runStart.current = null;
    try {
      if (!alive.current) return;
      const changed = before && current().bytes !== before;
      if (outcome !== "complete" && changed) {
        await install(before, current().revision, "The interrupted run was rolled back. Earlier user changes remain.", undefined, false);
      } else if (changed) keepUndo(before);
      setNotice(outcome === "complete"
        ? changed ? "Task complete. PDF changes are unsaved." : "Task complete. No PDF changes were made."
        : (outcome === "cancelled" ? "Task stopped." : "Task failed.") + (changed ? " Its PDF changes were rolled back." : " No PDF changes were made."));
      if (text) await append({ role: "assistant", text });
    } catch (e) { setNotice("Task ended. Recovery needs attention."); setError("Recovery needs attention: " + messageOf(e)); }
    finally { if (alive.current) { busyRef.current = false; setBusy(false); setReply(""); } }
  };

  useBlocker({ shouldBlockFn: () => (model.current?.dirty || busyRef.current) ? !window.confirm("Leave this PDF with unsaved changes or an active task?") : false, enableBeforeUnload: false });
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const beforeUnload = (event: BeforeUnloadEvent) => { if (model.current?.dirty || busyRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    void (async () => {
      const [metadata, response, chat] = await Promise.all([
        getOfficeDocFn({ data: { docId } }),
        pdfRequest("/api/office/docs/" + docId + "/content", { signal: controller.signal }),
        loadOfficeChatFn({ data: { docId } }),
      ]);
      if (metadata.kind !== "pdf" || response.headers.get("X-Office-Kind") !== "pdf") throw new Error("This document is not a PDF.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      await validatePdf(bytes);
      const pdf = await openPdfView(bytes);
      if (controller.signal.aborted) { await pdf.destroy(); return; }
      // The bytes endpoint is authoritative if a concurrent save occurred during load.
      const version = Number(response.headers.get("X-Office-Version"));
      if (!Number.isInteger(version) || version < 1) throw new Error("Missing PDF revision metadata.");
      const actualMeta = { ...metadata, version, hash: response.headers.get("X-Office-Hash") || metadata.hash };
      model.current = { bytes, revision: 0, view: pdf, meta: actualMeta, dirty: false };
      setView(pdf); setMeta(actualMeta); setMessages(chat.map(m => ({ role: m.role, text: m.text })));
      setFields(await listPdfFields(bytes));
      const skill = createPdfSkill({
        state: () => { const s = current(); return { bytes: s.bytes, revision: s.revision, storageRevision: s.meta.version, pageCount: s.view.numPages, name: s.meta.name }; },
        readPage: n => pageText(current().view, n),
        capturePage: (n, signal) => capturePdfPage(current().view, n, signal),
        commit: install,
      });
      loop.current = new AgentLoop({
        skill, transport: pdfTransport(), maxTurns: 20,
        events: {
          onText: text => { if (alive.current) setReply(text); },
          onToolStart: call => { if (alive.current) setNotice(call.name.startsWith("pdf_read") || call.name === "pdf_search" ? "Reading source pages…" : "Checking the requested operation…"); },
          onToolExecuted: event => { if (alive.current) setActivity(previous => [...previous.slice(-19), event.execution.summary + (event.execution.isError ? " — needs attention" : "")]); },
          onDone: result => { void finishRun(result.cancelled ? "Task stopped. Its PDF changes were rolled back." : result.text || "The PDF task finished.", result.cancelled ? "cancelled" : "complete"); },
          onError: failure => { if (alive.current) setError(failure); void finishRun("The task failed. Its PDF changes were rolled back.", "failed"); },
        },
      });
      loop.current.restore(chat.map(m => ({ role: m.role, text: m.text })));
    })().catch(e => { if (!controller.signal.aborted) setError(messageOf(e)); });
    return () => {
      alive.current = false; controller.abort(); loop.current?.cancel(); loop.current = null;
      window.removeEventListener("beforeunload", beforeUnload);
      void model.current?.view.destroy();
    };
  }, [docId]);

  const apply = async (ops: PdfOperation[], description: string) => {
    if (locked) return;
    setError("");
    const state = current(); setSaving(true);
    try { await install(await applyPdfOperations(state.bytes, ops), state.revision, description); }
    catch (e) { setError(messageOf(e)); }
    finally { if (alive.current) setSaving(false); }
  };
  const send = async () => {
    if (locked || !prompt.trim() || !loop.current) return;
    followConversation.current = true;
    const text = prompt.trim(); setPrompt(""); setError(""); setActivity([]);
    busyRef.current = true; setBusy(true); runStart.current = current().bytes;
    // Persist in order without delaying the cancellable run on a network write.
    void append({ role: "user", text });
    if (alive.current) loop.current.run(text);
  };
  const save = async () => {
    if (busy || saving || !dirty) return;
    setSaving(true); setError("");
    const state = current();
    saveAttempt.current ??= { bytes: state.bytes, version: state.meta.version, operationId: crypto.randomUUID() };
    const attempt = saveAttempt.current;
    try {
      const response = await pdfRequest("/api/office/docs/" + docId + "/content", { method: "PUT",
        headers: { "Content-Type": "application/pdf", "If-Match": String(attempt.version), "Idempotency-Key": attempt.operationId },
        body: new Blob([attempt.bytes as BlobPart]),
      });
      const saved = await response.json() as OfficeDocSummary;
      if (!alive.current) return;
      model.current = { ...current(), meta: saved, dirty: false };
      saveAttempt.current = null; setMeta(saved); setDirty(false); setNotice("Saved revision " + saved.version + ".");
    } catch (e) { if (alive.current) setError(messageOf(e) + " Retry this same save, or download your copy before reopening."); }
    finally { if (alive.current) setSaving(false); }
  };
  const find = async () => {
    if (!search.trim() || !view || busy || searching) return;
    setSearching(true); setError("");
    const snapshot = current();
    try {
      const found: number[] = [];
      for (let n = 1; n <= snapshot.view.numPages; n++) {
        if (current() !== snapshot || !alive.current) return;
        if ((await pageText(snapshot.view, n)).text.toLocaleLowerCase().includes(search.toLocaleLowerCase())) found.push(n);
      }
      setHits(found); if (found[0]) setPage(found[0]); setNotice(found.length + " matching pages in the text layer.");
    } catch (e) { setError(messageOf(e)); }
    finally { if (alive.current) setSearching(false); }
  };

  if (!view || !meta) return <div className="p-8">{error ? <p role="alert">{error}</p> : <p role="status"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Opening PDF…</p>}<Link className="mt-4 block text-sm underline" to="/office/pdf">Back to PDFs</Link></div>;
  return <div className="sw-pdf-workspace">
    <header className="sw-pdf-header">
      <Link to="/office/pdf" aria-label="Back to PDFs"><ArrowLeft size={18} /></Link>
      <div className="min-w-0 flex-1"><h1>{meta.title}</h1><p>PDF · {view.numPages} pages · Revision {meta.version}{dirty ? " · Unsaved changes" : " · Saved"}</p></div>
      <button disabled={locked || !undo.current.length} title="Undo last change" onClick={() => {
        const bytes = undo.current[undo.current.length - 1]; if (!bytes) return; setSaving(true);
        void install(bytes, current().revision, "Change undone.", undefined, false).then(() => undo.current.pop()).catch(e => setError(messageOf(e))).finally(() => setSaving(false));
      }}><Undo2 size={16} /><span>Undo</span></button>
      <button disabled={busy || saving || !dirty} onClick={() => void save()}><Save size={16} /><span>{saving ? "Saving…" : saveAttempt.current ? "Retry save" : "Save revision"}</span></button>
      <button disabled={busy || saving} onClick={() => downloadPdf(current().bytes, dirty ? meta.name.replace(/\.pdf$/i, "-review.pdf") : meta.name)}><Download size={16} /><span>Download{dirty ? " copy" : ""}</span></button>
      <button aria-label={panel ? "Hide assistant" : "Show assistant"} onClick={() => setPanel(p => !p)}>{panel ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
    </header>
    {error && <div role="alert" className="sw-pdf-error">{error}</div>}
    <div className="sw-pdf-body">
      <aside className="sw-pdf-pages">
        <h2>Pages</h2>
        <form onSubmit={e => { e.preventDefault(); void find(); }}><input aria-label="Search PDF text" placeholder="Find in document" value={search} onChange={e => setSearch(e.target.value)} /><button disabled={searching || busy}>{searching ? "Searching…" : "Find"}</button></form>
        {hits.length > 0 && <p className="text-xs">Matches: {hits.slice(0, 50).map(n => <button key={n} onClick={() => setPage(n)}>{n}</button>)}</p>}
        <div className="sw-pdf-page-list">{Array.from({ length: view.numPages }, (_, i) => <button key={i} aria-current={page === i + 1 ? "page" : undefined} onClick={() => { setPage(i + 1); setSelection(""); }}><span className="sw-pdf-page-icon">{i + 1}</span>Page {i + 1}</button>)}</div>
      </aside>
      <main className="sw-pdf-document">
        <div className="sw-pdf-toolbar">
          <label>Page <input aria-label="Current PDF page" type="number" min={1} max={view.numPages} value={page} onChange={e => { const n = Number(e.target.value); if (n >= 1 && n <= view.numPages) setPage(n); }} /> / {view.numPages}</label>
          <select aria-label="PDF zoom" value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value={0.75}>75%</option><option value={1}>100%</option><option value={1.25}>125%</option><option value={1.5}>150%</option></select>
          <button disabled={locked} onClick={() => void apply([{ type: "rotate_pages", pages: [page], degrees: 90 }], "Page rotated.")}><RotateCw size={15} />Rotate</button>
          <button disabled={locked || !selection} onClick={() => {
            const state = current(); setSaving(true);
            void pageText(state.view, page).then(p => applyPdfOperations(state.bytes, [{ type: "highlight", page, rects: highlightRects(p, selection) }])).then(bytes => install(bytes, state.revision, "Highlighted selected text runs.")).catch(e => setError(messageOf(e))).finally(() => setSaving(false));
          }}><Highlighter size={15} />Highlight selection</button>
        </div>
        <div className="sw-pdf-canvas-scroll" onMouseUp={() => setSelection(window.getSelection()?.toString().trim() || "")}>
          <PdfCanvas doc={view} page={page} zoom={zoom} onNotes={setNotes} onError={setError} />
        </div>
        {notes.length > 0 && <div className="sw-pdf-notes"><strong>Page notes</strong>{notes.map((note, i) => <p key={i}>{note}</p>)}</div>}
        <footer role="status">{notice || "Select text to highlight it, or ask the assistant to review a passage."}</footer>
      </main>
      {panel && <aside className="sw-pdf-agent">
        <div className="sw-pdf-agent-title"><span className="sw-pdf-spark">✦</span><div><h2>PDF assistant</h2><p>Review · annotate · organize</p></div></div>
        <div ref={conversation} className="sw-pdf-conversation" onScroll={event => {
          const element = event.currentTarget;
          followConversation.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
        }}>
          {messages.length === 0 && <div className="sw-pdf-welcome"><h3>Start with the evidence.</h3><p>Ask about a page, highlight an exact passage, add a review note, or fill a supported form.</p>{["Summarize this PDF with page citations.", "List the form fields and their current values.", "Add a note on page 1: Review before filing."].map(text => <button key={text} onClick={() => setPrompt(text)}>{text}</button>)}</div>}
          {messages.map((m, i) => <div key={i} className={"sw-pdf-message " + m.role}><span>{m.role === "user" ? "You" : "PDF assistant"}</span><Markdown text={m.text} nav={{ scheme: "#pdf-page-", onNavigate: href => { const n = Number(href.slice(10)); if (n >= 1 && n <= view.numPages) setPage(n); } }} /></div>)}
          {activity.length > 0 && <details className="sw-pdf-activity" open={busy}><summary>{busy ? "Working with your PDF" : "Task activity"} · {activity.length} actions</summary>{activity.map((text, i) => <p key={i}>{text}</p>)}</details>}
          {reply && <div className="sw-pdf-message assistant"><Markdown text={reply} /></div>}
          {fields.length > 0 && <details className="sw-pdf-fields"><summary>{fields.length} form fields</summary>{fields.map(field => <div key={current().revision + ":" + field.name}><label>{field.name}<span>{field.readOnly ? " · Read-only" : ""}</span></label><input aria-label={field.name} disabled={locked || field.readOnly || field.type === "unsupported"} defaultValue={String(field.value ?? "")} placeholder={field.type === "checkbox" ? "true or false" : field.options?.join(" / ")} onKeyDown={e => { if (e.key !== "Enter") return; const value = e.currentTarget.value; if (field.type === "checkbox" && value !== "true" && value !== "false") { setError("Enter true or false for a checkbox."); return; } void apply([{ type: "fill_form", name: field.name, value: field.type === "checkbox" ? value === "true" : value }], "Form value updated."); }} /></div>)}<p>Press Enter to apply a field value.</p></details>}
        </div>
        <div className="sw-pdf-composer"><textarea aria-label="Ask the PDF assistant" placeholder="Ask about this PDF or describe a change…" value={prompt} disabled={locked && !busy} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} /><div><span>{busy ? "Working · changes remain unsaved" : "Changes are reversible until you save."}</span>{busy ? <button aria-label="Stop PDF task" onClick={() => loop.current?.cancel()}><Square size={16} /></button> : <button aria-label="Send to PDF assistant" disabled={locked || !prompt.trim()} onClick={() => void send()}><ArrowUp size={18} /></button>}</div></div>
        <p className="sw-pdf-limit">Text-layer review only. No OCR, permanent redaction or rewriting existing text.</p>
      </aside>}
    </div>
  </div>;
}

function PdfCanvas({ doc, page: number, zoom, onNotes, onError }: { doc: PDFDocumentProxy; page: number; zoom: number; onNotes(notes: string[]): void; onError(error: string): void }) {
  const canvas = useRef<HTMLCanvasElement>(null), layer = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 612, height: 792 });
  useEffect(() => {
    let cancelled = false;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    let textLayer: { cancel(): void } | undefined;
    void (async () => {
      const page = await doc.getPage(number);
      if (cancelled || !canvas.current || !layer.current) return;
      const viewport = page.getViewport({ scale: zoom });
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      const element = canvas.current, container = layer.current;
      setSize({ width: viewport.width, height: viewport.height });
      element.width = Math.ceil(viewport.width * scale); element.height = Math.ceil(viewport.height * scale);
      container.replaceChildren();
      render = page.render({ canvasContext: element.getContext("2d")!, viewport, transform: [scale, 0, 0, scale, 0, 0], canvas: element });
      await render.promise;
      if (cancelled) return;
      const [{ TextLayer }, content, annotations] = await Promise.all([import("pdfjs-dist"), page.getTextContent(), page.getAnnotations()]);
      if (cancelled) return;
      const text = new TextLayer({ textContentSource: content, container, viewport }); textLayer = text;
      await text.render();
      if (!cancelled) onNotes(annotations.filter(a => a.subtype === "Text").map(a => a.contentsObj?.str || a.contents || "").filter(Boolean));
    })().catch(e => { if (!cancelled) onError(messageOf(e)); });
    return () => { cancelled = true; render?.cancel(); textLayer?.cancel(); };
  }, [doc, number, zoom, onNotes, onError]);
  return <div className="sw-pdf-paper" style={{ width: size.width, height: size.height, "--scale-factor": zoom, "--total-scale-factor": zoom } as CSSProperties}>
    <canvas ref={canvas} style={{ width: size.width, height: size.height }} aria-label={"PDF page " + number} />
    <div ref={layer} className="textLayer" />
  </div>;
}
