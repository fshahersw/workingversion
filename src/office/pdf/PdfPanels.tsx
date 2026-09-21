import { useEffect, useRef, useState } from "react";
import { Check, MessageSquare, Trash2 } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PdfAnnotation, PdfOperation, listPdfFields } from "./document";

/** Only visible thumbnails render. Each render is cancelled when its revision retires. */
export function PdfThumbnail({ doc, page, active, onChoose }: { doc: PDFDocumentProxy; page: number; active: boolean; onChoose(): void }) {
  const button = useRef<HTMLButtonElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = button.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "120px" });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    setFailed(false);
    void doc.getPage(page).then(async pdfPage => {
      if (cancelled || !canvas.current) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: Math.min(116 / base.width, 146 / base.height) });
      const element = canvas.current;
      element.width = Math.ceil(viewport.width); element.height = Math.ceil(viewport.height);
      render = pdfPage.render({ canvas: element, canvasContext: element.getContext("2d")!, viewport });
      await render.promise;
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; render?.cancel(); };
  }, [doc, page, visible]);
  return <button ref={button} className="sw-pdf-thumbnail" aria-label={`Go to page ${page}`} aria-current={active ? "page" : undefined} onClick={onChoose}>
    <span className="sw-pdf-thumb-paper">{failed ? <span>Preview unavailable</span> : <canvas ref={canvas} aria-hidden="true" />}</span>
    <span>Page {page}{active && <Check size={12} />}</span>
  </button>;
}

type Field = Awaited<ReturnType<typeof listPdfFields>>[number];
export function PdfFieldEditor({ field, locked, onApply }: { field: Field; locked: boolean; onApply(operation: PdfOperation): void }) {
  const initial = field.type === "checkbox" ? Boolean(field.value) : Array.isArray(field.value) ? field.value[0] ?? "" : String(field.value ?? "");
  const [value, setValue] = useState<string | boolean>(initial);
  const disabled = locked || field.readOnly || field.type === "unsupported";
  return <form className="sw-pdf-field" onSubmit={event => { event.preventDefault(); if (!disabled) onApply({ type: "fill_form", name: field.name, value }); }}>
    <label><span>{field.name}</span>{field.type === "checkbox"
      ? <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={event => setValue(event.target.checked)} />
      : field.options ? <select value={String(value)} disabled={disabled} onChange={event => setValue(event.target.value)}><option value="">Choose a value</option>{field.options.map(option => <option key={option}>{option}</option>)}</select>
      : <input value={String(value)} disabled={disabled} maxLength={10000} onChange={event => setValue(event.target.value)} />}</label>
    {field.readOnly || field.type === "unsupported" ? <small>{field.readOnly ? "Read-only field" : "Unsupported field type"}</small> : <button disabled={disabled || value === initial}>Apply value</button>}
  </form>;
}

export function PdfAnnotationCard({ annotation, locked, onApply }: { annotation: PdfAnnotation; locked: boolean; onApply(operation: PdfOperation): void }) {
  const [editing, setEditing] = useState(false), [text, setText] = useState(annotation.text);
  return <article className="sw-pdf-annotation"><header><MessageSquare size={14} /><strong>{annotation.kind}</strong><small>p. {annotation.page}</small></header>
    {editing ? <textarea aria-label="Annotation text" value={text} maxLength={10000} onChange={event => setText(event.target.value)} /> : <p>{annotation.text || "No comment text"}</p>}
    {annotation.author && <small>{annotation.author}</small>}
    <div>{annotation.editable && (editing ? <><button disabled={locked || !text.trim()} onClick={() => { onApply({ type: "update_annotation", annotationId: annotation.id, text }); setEditing(false); }}>Apply comment</button><button onClick={() => setEditing(false)}>Cancel</button></> : <button disabled={locked} onClick={() => setEditing(true)}>Edit comment</button>)}
    {annotation.removable && <button aria-label={`Delete ${annotation.kind} annotation`} disabled={locked} onClick={() => onApply({ type: "delete_annotation", annotationId: annotation.id })}><Trash2 size={13} />Remove</button>}</div>
    {annotation.reason && <small>{annotation.reason}</small>}
  </article>;
}
