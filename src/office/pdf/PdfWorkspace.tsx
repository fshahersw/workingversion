import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useBlocker } from "@tanstack/react-router";
import { ArrowLeft, ArrowUp, ChevronLeft, ChevronRight, Download, Highlighter, Loader2, MessageSquarePlus, RotateCw, Save, Undo2, PanelRightClose, PanelRightOpen, MousePointer2, Type, Trash2, GripVertical, X, Search, Files, ListChecks, MessageSquare } from "lucide-react";
import { AgentLoop } from "@genoffice/agent-core";
import { AssistantMessage, AssistantHeader, AssistantContext, AssistantActivity, AssistantWorking, AssistantReplyActions, AssistantStarters, JumpToLatest, mergeActivities, finishActivities, type Activity } from "@genoffice/ui";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { OfficeDocSummary } from "@/lib/office/types";
import { appendOfficeChatFn, getOfficeDocFn, loadOfficeChatFn } from "@/lib/office/office.functions";
import { OrderedChatAppender } from "@/lib/office/chat-persistence";
import { OfficeTaskControls, type OfficeTaskLoop } from "../shared/OfficeTaskControls";
import { createPdfTaskDirections } from "./task-directions";
import { applyPdfOperations, listPdfFields, listPdfAnnotations, validatePdf, type PdfOperation, type PdfAnnotation } from "./document";
import { openPdfView, pageText, highlightRects, capturePdfPage } from "./reader";
import { createPdfSkill } from "./skill";
import { pdfTransport } from "./transport";
import { downloadPdf, downloadSavedPdf } from "./api";
import { createPdfExportDelivery } from "./export-delivery";
import { createLargeOfficeDocument } from "../shared/create-transfer";
import { loadOfficeRevision, transferOfficeRevision } from "../shared/revision-transfer";
import { PdfThumbnail, PdfFieldEditor, PdfAnnotationCard } from "./PdfPanels";
import { PdfSourcesPanel } from "./PdfSourcesPanel";
import type { PdfLocalSource } from "./local-sources";
import "./text-layer.css";
import "./pdf.css";

type Model = { bytes: Uint8Array; revision: number; view: PDFDocumentProxy; meta: OfficeDocSummary; dirty: boolean };
type Message = { role: "user" | "assistant"; text: string };
type Fields = Awaited<ReturnType<typeof listPdfFields>>;
const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

export function PdfWorkspace({ docId }: { docId: string }) {
  const model = useRef<Model | null>(null), alive = useRef(true), busyRef = useRef(false);
  const undo = useRef<Uint8Array[]>([]), loop = useRef<AgentLoop | null>(null), manualBusy = useRef(false);
  const directions = useRef<ReturnType<typeof createPdfTaskDirections> | null>(null);
  const [taskLoop, setTaskLoop] = useState<OfficeTaskLoop | null>(null);
  const chatAppender = useRef(new OrderedChatAppender());
  const conversation = useRef<HTMLDivElement>(null), followConversation = useRef(true);
  const runStart = useRef<Uint8Array | null>(null);
  const saveAttempt = useRef<{ bytes: Uint8Array; version: number; operationId: string } | null>(null);
  const [view, setView] = useState<PDFDocumentProxy | null>(null), [meta, setMeta] = useState<OfficeDocSummary | null>(null);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(""), [error, setError] = useState(""), [page, setPage] = useState(1);
  const [prompt, setPrompt] = useState(""), [messages, setMessages] = useState<Message[]>([]), [reply, setReply] = useState("");
  const [activity, setActivity] = useState<Activity[]>([]), [panel, setPanel] = useState(true), [selection, setSelection] = useState("");
  const [zoom, setZoom] = useState<number | "fit">("fit"), [fields, setFields] = useState<Fields>([]);
  const [mode, setMode] = useState<"write" | "ask" | "review">("write"), modeRef = useRef(mode);
  const [depth, setDepth] = useState<"standard" | "thorough">("standard"), depthRef = useRef(depth);
  const pageRef = useRef(page), selectionRef = useRef(selection);
  modeRef.current = mode; depthRef.current = depth; pageRef.current = page; selectionRef.current = selection;
  const [ribbon, setRibbon] = useState<"review" | "organize" | "forms">("review");
  const [sidebar, setSidebar] = useState<"pages" | "search" | "notes" | "fields" | "sources">("pages");
  const [sources, setSources] = useState<PdfLocalSource[]>([]), sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const [placement, setPlacement] = useState<"select" | "note" | "text">("select");
  const [placementText, setPlacementText] = useState(""), [textSize, setTextSize] = useState(12);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]), [annotationTotal, setAnnotationTotal] = useState(0);
  const [connection, setConnection] = useState(false), [panelWidth, setPanelWidth] = useState(370);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const canvasScroll = useRef<HTMLDivElement>(null), [canvasWidth, setCanvasWidth] = useState(700);
  const [search, setSearch] = useState(""), [hits, setHits] = useState<number[]>([]), [searching, setSearching] = useState(false);
  useLayoutEffect(() => {
    const element = conversation.current;
    if (element && followConversation.current) element.scrollTop = element.scrollHeight;
  }, [messages, reply, activity, busy, fields, panel, view]);
  const locked = busy || saving || saveAttempt.current !== null;
  useEffect(() => {
    const element = canvasScroll.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => setCanvasWidth(entries[0]?.contentRect.width ?? 700));
    observer.observe(element); return () => observer.disconnect();
  }, [view]);
  useEffect(() => {
    const snapshot = model.current;
    if (!snapshot || sidebar !== "notes") return;
    let cancelled = false;
    setAnnotations([]); setAnnotationTotal(0);
    void listPdfAnnotations(snapshot.bytes, { page, limit: 100 }).then(result => {
      if (!cancelled && model.current === snapshot) { setAnnotations(result.annotations); setAnnotationTotal(result.total); }
    }).catch(e => { if (!cancelled) setError(messageOf(e)); });
    return () => { cancelled = true; };
  }, [view, page, sidebar]);
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
  const finishRun = async (text: string, outcome: "complete" | "partial" | "cancelled" | "failed" = "complete") => {
    const owner = loop.current;
    const ownsRun = () => alive.current && loop.current === owner;
    const before = runStart.current; runStart.current = null;
    try {
      if (!ownsRun()) return;
      let transcript = text;
      try {
        const changed = before && current().bytes !== before;
        if ((outcome === "cancelled" || outcome === "failed") && changed) {
          await install(before, current().revision, "The interrupted run was rolled back. Earlier user changes remain.", undefined, false);
        } else if (changed) keepUndo(before);
        if (!ownsRun()) return;
        setNotice(outcome === "complete"
          ? changed ? "Task complete. PDF changes are unsaved." : "Task complete. No PDF changes were made."
          : outcome === "partial" ? "Task paused before completion. Review the PDF and continue the remaining work."
          : (outcome === "cancelled" ? "Task stopped." : "Task failed.") + (changed ? " Its PDF changes were rolled back." : " No PDF changes were made."));
      } catch (e) {
        if (!ownsRun()) return;
        const recovery = "Recovery was incomplete. Inspect the PDF before continuing; changes may remain. " + messageOf(e);
        transcript = [text, recovery].filter(Boolean).join("\n\n");
        setNotice("Task ended. Recovery needs attention."); setError(recovery);
      }
      // A failed rollback must not discard the checkpoint needed to resume.
      if (ownsRun() && transcript) await append({ role: "assistant", text: transcript });
    } catch (e) { if (ownsRun()) setError("Conversation could not be saved: " + messageOf(e)); }
    finally { if (ownsRun()) { busyRef.current = false; setBusy(false); setReply(""); } }
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
        loadOfficeRevision(docId, controller.signal),
        loadOfficeChatFn({ data: { docId } }),
      ]);
      if (metadata.kind !== "pdf") throw new Error("This document is not a PDF.");
      const bytes = response.bytes;
      await validatePdf(bytes);
      const pdf = await openPdfView(bytes);
      if (controller.signal.aborted) { await pdf.destroy(); return; }
      // The bytes endpoint is authoritative if a concurrent save occurred during load.
      const version = response.version;
      if (!Number.isInteger(version) || version < 1) throw new Error("Missing PDF revision metadata.");
      const actualMeta = { ...metadata, version, hash: response.hash };
      model.current = { bytes, revision: 0, view: pdf, meta: actualMeta, dirty: false };
      setView(pdf); setMeta(actualMeta); setMessages(chat.map(m => ({ role: m.role, text: m.text })));
      const formFields = await listPdfFields(bytes);
      if (controller.signal.aborted) return;
      setFields(formFields);
      const skill = createPdfSkill({
        state: () => { const s = current(); return { bytes: s.bytes, revision: s.revision, storageRevision: s.meta.version, pageCount: s.view.numPages, name: s.meta.name, currentPage: pageRef.current, selection: selectionRef.current }; },
        readPage: n => pageText(current().view, n),
        capturePage: (n, signal) => capturePdfPage(current().view, n, signal),
        navigate: n => { if (Number.isInteger(n) && n >= 1 && n <= current().view.numPages) { setPage(n); setSelection(""); } },
        sources: () => sourcesRef.current.map(({ bytes: _, ...source }) => source),
        sourceBytes: async id => { const source = sourcesRef.current.find(item => item.id === id); if (!source) throw new Error("This attached source is no longer available."); return source.bytes.slice(); },
        exportFile: createPdfExportDelivery((name, bytes) => createLargeOfficeDocument("pdf", name, bytes), downloadSavedPdf, () => alive.current && !controller.signal.aborted),
        commit: install,
      }, { mode: () => modeRef.current });
      const isCurrent = (): boolean => alive.current && !controller.signal.aborted && loop.current === agent;
      const agent = new AgentLoop({
        skill, transport: pdfTransport({ mode: () => modeRef.current, profile: () => depthRef.current }), maxTurns: 100,
        events: {
          onText: text => { if (isCurrent()) setReply(text); },
          onToolStart: call => { if (isCurrent()) {
            setNotice(call.name.startsWith("pdf_read") || call.name === "pdf_search" ? "Reading source pages…" : "Checking the requested operation…");
            setActivity(previous => mergeActivities(previous, { id: call.id, name: call.name, summary: "", running: true, startedAt: Date.now() }).slice(-100));
          } },
          onToolExecuted: event => { if (isCurrent()) setActivity(previous => mergeActivities(previous, { id: event.call.id, name: event.call.name, ...event.execution, running: false, finishedAt: Date.now(), output: event.execution.output?.slice(0, 6000) }).slice(-100)); },
          onTurnEnd: updates => { if (isCurrent()) controls.applied(updates); },
          onDone: result => {
            if (!isCurrent()) return;
            controls.finish();
            setActivity(previous => finishActivities(previous));
            const partial = result.turnLimit || result.truncated || result.unverified;
            void finishRun(result.cancelled ? "Task stopped. Inspect the PDF before continuing."
              : [result.text, partial ? "This task is incomplete. Review the current PDF before continuing." : ""].filter(Boolean).join("\n\n") || "The PDF task finished.",
            result.cancelled ? "cancelled" : partial ? "partial" : "complete");
          },
          onError: failure => {
            if (!isCurrent()) return;
            controls.finish(); setError(failure);
            setActivity(previous => finishActivities(previous));
            void finishRun(agent.failureCheckpoint ?? "The task failed. Inspect the PDF before continuing.", "failed");
          },
        },
      });
      loop.current = agent;
      const controls = createPdfTaskDirections(agent, { isCurrent, append: message => { void append(message); } });
      directions.current = controls; setTaskLoop(controls.loop);
      agent.restore(chat.map(m => ({ role: m.role, text: m.text })));
    })().catch(e => { if (!controller.signal.aborted) setError(messageOf(e)); });
    return () => {
      alive.current = false; controller.abort(); loop.current?.cancel(); loop.current = null; directions.current = null;
      window.removeEventListener("beforeunload", beforeUnload);
      void model.current?.view.destroy();
    };
  }, [docId]);

  const apply = async (ops: PdfOperation[], description: string) => {
    if (locked || manualBusy.current || busyRef.current) return false;
    manualBusy.current = true;
    setError("");
    const state = current(); setSaving(true);
    try { await install(await applyPdfOperations(state.bytes, ops), state.revision, description); return true; }
    catch (e) { setError(messageOf(e)); return false; }
    finally { manualBusy.current = false; if (alive.current) setSaving(false); }
  };
  const send = async (instruction = prompt) => {
    const text = instruction.trim();
    if (!alive.current || !text || !loop.current) return;
    if (busyRef.current) {
      const result = directions.current?.loop.steer(text);
      if (result?.accepted) { setPrompt(""); setError(""); setNotice("Direction queued. It will apply after the current operation."); }
      else setError(result?.reason ?? "The task is finishing. Send a new request when it stops.");
      return;
    }
    if (locked || manualBusy.current) return;
    followConversation.current = true;
    setPrompt(""); setError(""); setActivity([]);
    busyRef.current = true; setBusy(true); runStart.current = current().bytes;
    // Persist in order without delaying the cancellable run on a network write.
    void append({ role: "user", text });
    if (alive.current) loop.current.run(text);
  };
  const save = async () => {
    if (busy || busyRef.current || saving || manualBusy.current || !dirty) return;
    manualBusy.current = true;
    setSaving(true); setError("");
    const state = current();
    saveAttempt.current ??= { bytes: state.bytes, version: state.meta.version, operationId: crypto.randomUUID() };
    const attempt = saveAttempt.current;
    try {
      const saved = await transferOfficeRevision(docId, attempt.version, attempt.operationId, attempt.bytes);
      if (!alive.current) return;
      model.current = { ...current(), meta: saved, dirty: false };
      saveAttempt.current = null; setMeta(saved); setDirty(false); setNotice("Saved revision " + saved.version + ".");
    } catch (e) { if (alive.current) setError(messageOf(e) + " Retry this same save, or download your copy before reopening."); }
    finally { manualBusy.current = false; if (alive.current) setSaving(false); }
  };
  const download = async () => {
    if (!alive.current || busy || busyRef.current || saving || manualBusy.current) return;
    const snapshot = current();
    if (snapshot.dirty) await save();
    if (!alive.current || current().bytes !== snapshot.bytes) return;
    const state = current();
    if (state.dirty) {
      // A failed save must never download an older server revision as the edit.
      downloadPdf(state.bytes, state.meta.name.replace(/\.pdf$/i, "-recovery.pdf"));
      setNotice("Save did not complete. An unsaved recovery copy is prepared; keep this document open and retry Save.");
      return;
    }
    downloadSavedPdf(docId, state.meta.version, state.meta.name);
  };
  const find = async () => {
    if (!search.trim() || !view || busy || searching) return;
    setSearching(true); setError("");
    const snapshot = current();
    try {
      const found: number[] = [];
      const query = search.trim().toLocaleLowerCase();
      for (let n = 1; n <= snapshot.view.numPages; n++) {
        if (current() !== snapshot || !alive.current) return;
        const text = await pageText(snapshot.view, n);
        if (current() !== snapshot || !alive.current) return;
        if (text.text.toLocaleLowerCase().includes(query)) found.push(n);
      }
      setHits(found); if (found[0]) setPage(found[0]); setNotice(found.length + " matching pages in the text layer.");
    } catch (e) { setError(messageOf(e)); }
    finally { if (alive.current) setSearching(false); }
  };

  const goToPage = (n: number) => { if (view && Number.isInteger(n) && n >= 1 && n <= view.numPages) { setPage(n); setSelection(""); } };
  const highlightSelection = async () => {
    if (locked || manualBusy.current || busyRef.current || !selection) return;
    manualBusy.current = true;
    const snapshot = current(); setSaving(true); setError("");
    try {
      const source = await pageText(snapshot.view, page);
      const bytes = await applyPdfOperations(snapshot.bytes, [{ type: "highlight", page, rects: highlightRects(source, selection) }]);
      await install(bytes, snapshot.revision, "Highlighted the selected text runs. Use Undo to revert.");
    } catch (e) { setError(messageOf(e)); }
    finally { manualBusy.current = false; if (alive.current) setSaving(false); }
  };
  const movePage = (direction: -1 | 1) => {
    if (!view || page + direction < 1 || page + direction > view.numPages) return;
    const order = Array.from({ length: view.numPages }, (_, i) => i + 1);
    [order[page - 1], order[page - 1 + direction]] = [order[page - 1 + direction]!, order[page - 1]!];
    void apply([{ type: "reorder_pages", order }], "Page moved. Review its new position before saving.").then(ok => { if (ok) goToPage(page + direction); });
  };
  const placeAt = (x: number, y: number) => {
    if (locked || placement === "select" || !placementText.trim()) return;
    void apply([{ type: placement === "note" ? "add_note" : "insert_text", page, text: placementText.trim(), x, y, ...(placement === "text" ? { size: textSize } : {}) }], placement === "note" ? "Review note added. Changes are unsaved." : "New text added. Existing content was preserved.").then(ok => { if (ok) { setPlacement("select"); setSidebar("notes"); } });
  };

  if (!view || !meta) return <div className="sw-pdf-loading">{error ? <p role="alert">{error}</p> : <p role="status"><Loader2 size={18} className="animate-spin" />Opening PDF workspace…</p>}<Link to="/office/pdf">Back to PDFs</Link></div>;
  return <div className="sw-pdf-workspace" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
    if (event.key === "Escape") { setPlacement("select"); setConnection(false); }
  }}>
    <header className="sw-pdf-header">
      <Link to="/office/pdf" aria-label="Back to PDFs"><ArrowLeft size={17} /></Link>
      <span className="sw-pdf-file-mark">PDF</span>
      <div className="sw-pdf-document-name"><h1>{meta.title}</h1><p>{view.numPages} {view.numPages === 1 ? "page" : "pages"}<span>·</span>{saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</p></div>
      <button disabled={locked || !undo.current.length} title="Undo last change" onClick={() => {
        const bytes = undo.current[undo.current.length - 1]; if (!bytes || locked || manualBusy.current || busyRef.current) return; manualBusy.current = true; setSaving(true);
        void install(bytes, current().revision, "Change undone.", undefined, false).then(() => undo.current.pop()).catch(e => setError(messageOf(e))).finally(() => { manualBusy.current = false; if (alive.current) setSaving(false); });
      }}><Undo2 size={16} /><span>Undo</span></button>
      <button className="sw-pdf-save" disabled={busy || saving || !dirty} onClick={() => void save()}><Save size={16} /><span>{saving ? "Saving…" : saveAttempt.current ? "Retry save" : "Save"}</span></button>
      <button disabled={busy || saving} onClick={() => void download()} title="Save changes and download the current PDF revision"><Download size={16} /><span>Download PDF</span></button>
      <button aria-label={panel ? "Hide assistant" : "Show assistant"} onClick={() => setPanel(p => !p)}>{panel ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
    </header>
    <nav className="sw-pdf-ribbon-tabs" aria-label="PDF tools">{([['review', 'Review'], ['organize', 'Organize pages'], ['forms', 'Forms']] as const).map(([id, label]) => <button key={id} aria-pressed={ribbon === id} onClick={() => { setRibbon(id); setPlacement("select"); if (id === "forms") setSidebar("fields"); }}>{label}</button>)}<button aria-pressed={sidebar === "sources"} onClick={() => setSidebar("sources")}>Attached sources{sources.length ? " (" + sources.length + ")" : ""}</button><span>PDF workspace</span></nav>
    <div className="sw-pdf-ribbon">
      {ribbon === "review" && <><div className="sw-pdf-tool-group">
        <button aria-pressed={placement === "select"} onClick={() => setPlacement("select")}><MousePointer2 size={18} />Select text</button>
        <button disabled={locked || !selection} onClick={() => void highlightSelection()}><Highlighter size={18} />Highlight</button>
        <button disabled={locked} aria-pressed={placement === "note"} onClick={() => { setPlacement("note"); setPlacementText(""); }}><MessageSquarePlus size={18} />Add note</button>
        <button disabled={locked} aria-pressed={placement === "text"} onClick={() => { setPlacement("text"); setPlacementText(""); }}><Type size={18} />Add text</button>
      </div><div className="sw-pdf-tool-group"><button onClick={() => setSidebar("search")}><Search size={18} />Find text</button><button onClick={() => setSidebar("notes")}><MessageSquare size={18} />Annotations</button></div><p>Select a passage to highlight it, or place a review note directly on the page.</p></>}
      {ribbon === "organize" && <><div className="sw-pdf-tool-group"><button disabled={locked} onClick={() => void apply([{ type: "rotate_pages", pages: [page], degrees: 90 }], "Page rotated.")}><RotateCw size={18} />Rotate right</button><button disabled={locked || page === 1} onClick={() => movePage(-1)}><ChevronLeft size={18} />Move earlier</button><button disabled={locked || page === view.numPages} onClick={() => movePage(1)}><ChevronRight size={18} />Move later</button><button disabled={locked || view.numPages <= 1} onClick={() => void apply([{ type: "delete_pages", pages: [page] }], "Page removed. Undo is available before you leave.")}><Trash2 size={18} />Remove page</button></div><p>Organize page {page}. Linked or structured PDFs may require a specialist editor.</p></>}
      {ribbon === "forms" && <><div className="sw-pdf-tool-group"><button onClick={() => setSidebar("fields")}><ListChecks size={18} />Form fields</button></div><p>{fields.length ? fields.length + " fields available. Apply a value, review the page, then save." : "This PDF has no supported fillable form fields. Add text creates a separate line."}</p></>}
    </div>
    {placement !== "select" && <div className="sw-pdf-placement"><label>{placement === "note" ? "Review note" : "New text"}<input autoFocus value={placementText} maxLength={10000} placeholder={placement === "note" ? "Type a note, then click the page to place it" : "Type one line, then click the page to place it"} onChange={event => setPlacementText(event.target.value)} /></label>{placement === "text" && <label>Size<input aria-label="New text font size" type="number" min={6} max={72} value={textSize} onChange={event => setTextSize(Math.max(6, Math.min(72, Number(event.target.value) || 12)))} /></label>}<span>{placementText.trim() ? "Click a position on the page" : "Enter text to begin"}</span><button aria-label="Cancel placement" onClick={() => setPlacement("select")}><X size={16} /></button></div>}
    {error && <div role="alert" className="sw-pdf-error"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError("")}><X size={15} /></button></div>}
    <div className="sw-pdf-body">
      <aside className="sw-pdf-pages" aria-label="PDF navigation">
        <div className="sw-pdf-sidebar-tabs">{([['pages', Files, 'Pages'], ['search', Search, 'Find'], ['notes', MessageSquare, 'Annotations'], ['fields', ListChecks, 'Form fields']] as const).map(([id, Icon, label]) => <button key={id} aria-label={label} title={label} aria-pressed={sidebar === id} onClick={() => setSidebar(id)}><Icon size={17} /></button>)}</div>
        <div className="sw-pdf-side-content">
          {sidebar === "sources" && <PdfSourcesPanel sources={sources} locked={locked} onChange={value => { if (alive.current && !busyRef.current) setSources(value); }} onError={value => { if (alive.current) setError(value); }} />}
          {sidebar === "pages" && <><h2>Pages <span>{view.numPages}</span></h2><div className="sw-pdf-page-list">{Array.from({ length: view.numPages }, (_, i) => <PdfThumbnail key={i} doc={view} page={i + 1} active={page === i + 1} onChoose={() => goToPage(i + 1)} />)}</div></>}
          {sidebar === "search" && <><h2>Find in document</h2><form className="sw-pdf-search" onSubmit={event => { event.preventDefault(); void find(); }}><input aria-label="Search PDF text" placeholder="Search the text layer" value={search} onChange={event => setSearch(event.target.value)} maxLength={500} /><button disabled={searching || busy || !search.trim()}>{searching ? "Searching…" : "Find"}</button></form><div className="sw-pdf-search-results">{hits.map(n => <button key={n} onClick={() => goToPage(n)}>Page {n}<ChevronRight size={14} /></button>)}</div><p className="sw-pdf-hint">Search covers selectable text. Scanned pages need OCR.</p></>}
          {sidebar === "notes" && <><h2>Annotations <span>{annotationTotal}</span></h2><p className="sw-pdf-hint">On page {page}</p>{annotations.length ? annotations.map(annotation => <PdfAnnotationCard key={current().revision + ":" + annotation.id} annotation={annotation} locked={locked} onApply={operation => { void apply([operation], "Annotation updated. Changes are unsaved."); }} />) : <p className="sw-pdf-empty-side">No annotations on this page. Use Add note or highlight a selected passage.</p>}{annotationTotal > annotations.length && <p className="sw-pdf-hint">Showing the first {annotations.length}. Ask the assistant to inspect further annotations.</p>}</>}
          {sidebar === "fields" && <><h2>Form fields <span>{fields.length}</span></h2>{fields.length ? fields.map(field => <PdfFieldEditor key={current().revision + ":" + field.name} field={field} locked={locked} onApply={operation => { void apply([operation], "Form value updated. Review before saving."); }} />) : <p className="sw-pdf-empty-side">There are no fillable fields in this PDF.</p>}</>}
        </div>
      </aside>
      <main className="sw-pdf-document">
        <div className="sw-pdf-toolbar"><div><button aria-label="Previous PDF page" disabled={page === 1} onClick={() => goToPage(page - 1)}><ChevronLeft size={16} /></button><label>Page <input aria-label="Current PDF page" type="number" min={1} max={view.numPages} value={page} onChange={event => goToPage(Number(event.target.value))} /> <span>of {view.numPages}</span></label><button aria-label="Next PDF page" disabled={page === view.numPages} onClick={() => goToPage(page + 1)}><ChevronRight size={16} /></button></div><select aria-label="PDF zoom" value={zoom} onChange={event => setZoom(event.target.value === "fit" ? "fit" : Number(event.target.value))}><option value="fit">Fit width</option><option value={0.5}>50%</option><option value={0.75}>75%</option><option value={1}>100%</option><option value={1.25}>125%</option><option value={1.5}>150%</option><option value={2}>200%</option></select></div>
        <div ref={canvasScroll} className={"sw-pdf-canvas-scroll" + (placement !== "select" && placementText.trim() ? " placing" : "")} onMouseUp={() => {
          const selected = window.getSelection();
          setSelection(selected?.anchorNode && selected.focusNode && canvasScroll.current?.contains(selected.anchorNode) && canvasScroll.current.contains(selected.focusNode) ? selected.toString().trim() : "");
        }}><PdfCanvas doc={view} page={page} zoom={zoom} availableWidth={canvasWidth} placing={!locked && placement !== "select" && !!placementText.trim()} onPlace={placeAt} onError={setError} /></div>
        <footer role="status"><span>{notice || (selection ? "Selected passage · " + selection.split(/\s+/).length + " words" : "Select text or ask the assistant to review this PDF.")}</span><span>Revision {meta.version}</span></footer>
      </main>
      {panel && <><div className="sw-pdf-resizer" role="separator" aria-label="Resize PDF assistant" aria-orientation="vertical" aria-valuemin={285} aria-valuemax={600} aria-valuenow={panelWidth} tabIndex={0} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setPanelWidth(width => Math.max(285, Math.min(600, width + (event.key === "ArrowLeft" ? 20 : -20)))); } }} onPointerDown={event => { resizeStart.current = { x: event.clientX, width: panelWidth }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (resizeStart.current) setPanelWidth(Math.max(285, Math.min(600, resizeStart.current.width + resizeStart.current.x - event.clientX))); }} onPointerUp={() => { resizeStart.current = null; }} onPointerCancel={() => { resizeStart.current = null; }}><GripVertical size={12} /></div>
      <aside className="sw-pdf-agent" style={{ width: panelWidth }}>
        <AssistantHeader kind="PDF" busy={locked || !taskLoop} onNew={() => { if (locked) return; loop.current?.reset(); setMessages([]); setReply(""); setActivity([]); setNotice("New conversation. Document changes are preserved."); }} onCollapse={() => setPanel(false)} onConnection={() => setConnection(value => !value)} />
        {connection && <div className="sw-pdf-connection"><strong>Office connection</strong><p>Uses the platform's authenticated model routing and configured model tiers. Credentials are managed by the server.</p><button onClick={() => setConnection(false)}>Close</button></div>}
        <div role="tablist" aria-label="Assistant mode" className="sw-pdf-mode-tabs">{([['write', 'Edit'], ['ask', 'Ask'], ['review', 'Review']] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={mode === id} disabled={locked} title={id === "write" ? "Edit the PDF on request" : "Read-only; no document changes"} onClick={() => setMode(id)}>{label}</button>)}</div>
        <div ref={conversation} className="sw-pdf-conversation" onScroll={event => { const element = event.currentTarget; followConversation.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 80; }}>
          {messages.length === 0 && !busy && <AssistantStarters app="pdf" mode={mode} selected={!!selection} onChoose={setPrompt} />}
          {messages.map((message, i) => <div key={i} className={"sw-pdf-message " + message.role}><AssistantMessage role={message.role} text={message.text} nav={{ scheme: "#pdf-page-", onNavigate: href => goToPage(Number(href.slice(10))) }} />{message.role === "assistant" && <AssistantReplyActions text={message.text} />}</div>)}
          <AssistantActivity tools={activity} active={busy} />
          {busy && !reply && <AssistantWorking />}
          {reply && <div className="sw-pdf-message assistant"><AssistantMessage text={reply} nav={{ scheme: "#pdf-page-", onNavigate: href => goToPage(Number(href.slice(10))) }} /></div>}
        </div>
        <JumpToLatest targetRef={conversation} followRef={followConversation} />
        <OfficeTaskControls app="pdf" document={docId} mode={mode} loop={taskLoop} busy={busy} allowVoice={false} stopTitle="Stop the task and restore its PDF changes when possible." onSend={instruction => { void send(instruction); }} onStop={() => loop.current?.cancel()} />
        <AssistantContext label={selection ? "Selected passage · " + selection.split(/\s+/).length + " words" : "PDF · viewing page " + page} busy={busy} />
        <div className="sw-pdf-composer"><textarea aria-label="Ask the PDF assistant" placeholder={busy ? "Add a direction to the running task…" : mode === "write" ? "Ask about this PDF or describe a change…" : "Ask for a source-based answer without editing…"} value={prompt} disabled={locked && !busy} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div><select aria-label="Response depth" value={depth} disabled={locked} onChange={event => setDepth(event.target.value as "standard" | "thorough")}><option value="standard">Standard</option><option value="thorough">Thorough</option></select><button aria-label={busy ? "Queue PDF direction" : "Send to PDF assistant"} disabled={(locked && !busy) || !taskLoop || !prompt.trim()} onClick={() => void send()}><ArrowUp size={18} /></button></div></div>
        <details className="sw-pdf-capabilities"><summary>PDF capabilities</summary><p>Review and edit annotations; edit inspected native text/image objects within source-font limits; create editable text blocks; fill forms; organize, merge and extract pages. Attach local PDFs or images for the assistant. OCR, permanent redaction, signing and Office conversion are unavailable.</p></details>
      </aside></>}
    </div>
  </div>;
}

function PdfCanvas({ doc, page: number, zoom, availableWidth, placing, onPlace, onError }: { doc: PDFDocumentProxy; page: number; zoom: number | "fit"; availableWidth: number; placing: boolean; onPlace(x: number, y: number): void; onError(error: string): void }) {
  const canvas = useRef<HTMLCanvasElement>(null), layer = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 612, height: 792 });
  const [scaleFactor, setScaleFactor] = useState(1), [rendering, setRendering] = useState(true);
  const placementView = useRef<{ doc: PDFDocumentProxy; page: number; viewport: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["getViewport"]> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    placementView.current = null; setRendering(true);
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    let textLayer: { cancel(): void } | undefined;
    void (async () => {
      const page = await doc.getPage(number);
      if (cancelled || !canvas.current || !layer.current) return;
      const base = page.getViewport({ scale: 1 });
      const chosenScale = zoom === "fit" ? Math.max(0.1, Math.min(2, (availableWidth - 48) / base.width)) : zoom;
      const viewport = page.getViewport({ scale: chosenScale });
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      const element = canvas.current, container = layer.current;
      setSize({ width: viewport.width, height: viewport.height });
      setScaleFactor(chosenScale);
      element.width = Math.ceil(viewport.width * scale); element.height = Math.ceil(viewport.height * scale);
      container.replaceChildren();
      render = page.render({ canvasContext: element.getContext("2d")!, viewport, transform: [scale, 0, 0, scale, 0, 0], canvas: element });
      await render.promise;
      if (cancelled) return;
      const [{ TextLayer }, content] = await Promise.all([import("pdfjs-dist"), page.getTextContent()]);
      if (cancelled) return;
      const text = new TextLayer({ textContentSource: content, container, viewport }); textLayer = text;
      await text.render();
      if (!cancelled) { placementView.current = { doc, page: number, viewport }; setRendering(false); }
    })().catch(e => { if (!cancelled) { setRendering(false); onError(messageOf(e)); } });
    return () => { cancelled = true; placementView.current = null; render?.cancel(); textLayer?.cancel(); };
  }, [doc, number, zoom, availableWidth, onError]);
  return <div className="sw-pdf-paper" style={{ width: size.width, height: size.height, "--scale-factor": scaleFactor, "--total-scale-factor": scaleFactor } as CSSProperties} onPointerDown={event => {
    const ready = placementView.current;
    if (!placing || event.button !== 0 || !ready || ready.doc !== doc || ready.page !== number) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const [x, y] = ready.viewport.convertToPdfPoint((event.clientX - bounds.left) * ready.viewport.width / bounds.width, (event.clientY - bounds.top) * ready.viewport.height / bounds.height);
    event.preventDefault(); onPlace(x!, y!);
  }}>
    {rendering && <div className="sw-pdf-render-status" role="status"><Loader2 size={14} className="animate-spin" />Rendering page…</div>}
    <canvas ref={canvas} style={{ width: size.width, height: size.height }} aria-label={"PDF page " + number} />
    <div ref={layer} className="textLayer" />
  </div>;
}
