import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, FilePlus2, FileUp, Loader2 } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { OfficeTabs } from "@/components/office/OfficeTabs";
import { DocRow, EmptyState } from "@/components/office/DocList";
import { listOfficeDocsFn, deleteOfficeDocFn } from "@/lib/office/office.functions";
import type { OfficeDocSummary } from "@/lib/office/types";
import { createBlankPdf, validatePdf, PDF_MAX_BYTES } from "@/office/pdf/document";
import { createPdfDocument } from "@/office/pdf/api";

export const Route = createFileRoute("/_authenticated/office/pdf/")({
  ssr: false, head: () => ({ meta: [{ title: "PDF — Office — Seeger Weiss" }] }), component: PdfList,
});
function PdfList() {
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [docs, setDocs] = useState<OfficeDocSummary[] | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setDocs(await listOfficeDocsFn({ data: { kind: "pdf" } })); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not list PDF documents."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const create = async (file?: File) => {
    setBusy(true); setError("");
    try {
      if (file && file.size > PDF_MAX_BYTES) throw new Error("Choose a PDF up to 30 MB.");
      const bytes = file ? new Uint8Array(await file.arrayBuffer()) : await createBlankPdf();
      await validatePdf(bytes);
      const doc = await createPdfDocument(file?.name ?? "Untitled.pdf", bytes);
      await navigate({ to: "/office/pdf/$docId", params: { docId: doc.draftId } });
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create the PDF."); }
    finally { setBusy(false); }
  };
  return <AppShell><div className="mx-auto w-full max-w-[1000px] p-6">
    <OfficeTabs active="pdf" description="Review, annotate and organize PDFs with page-cited assistance. Keep each saved revision and download real PDF files." />
    {error && <p role="alert" className="my-4 rounded border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    <div className="my-5 flex flex-wrap items-center justify-end gap-2">
      <input ref={fileInput} type="file" accept=".pdf,application/pdf" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void create(file); }} />
      <button className="rounded border px-3 py-2 text-sm" disabled={busy} onClick={() => fileInput.current?.click()}><FileUp className="mr-2 inline h-4 w-4" />Upload PDF copy</button>
      <button className="rounded bg-brand-navy px-3 py-2 text-sm text-white" disabled={busy} onClick={() => void create()}>{busy ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : <FilePlus2 className="mr-2 inline h-4 w-4" />}New PDF</button>
    </div>
    <p className="mb-5 text-xs text-muted-foreground">Up to 30 MB and 500 pages. Signed, encrypted, active-content and embedded-file PDFs require an unsigned review copy. Permanent redaction and rewriting existing text are not available.</p>
    {docs === null ? <p role="status">Loading PDFs…</p> : docs.length === 0 ? <EmptyState icon={FileText} title="Your PDF review workspace" body="Upload a PDF copy to search, highlight passages, add notes, fill supported forms and organize pages." /> :
      <ul className="grid gap-3 sm:grid-cols-2">{docs.map(doc => <DocRow key={doc.draftId} doc={doc} icon={FileText} onOpen={() => void navigate({ to: "/office/pdf/$docId", params: { docId: doc.draftId } })} deleting={busy} onDelete={() => {
        if (!window.confirm("Delete this PDF workspace and its saved revisions?")) return;
        setBusy(true); void deleteOfficeDocFn({ data: { docId: doc.draftId } }).then(load).catch(e => setError(String(e))).finally(() => setBusy(false));
      }} />)}</ul>}
  </div></AppShell>;
}
