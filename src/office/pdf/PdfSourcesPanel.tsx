import { useRef, useState } from "react";
import { admitPdfLocalSource, type PdfLocalSource } from "./local-sources";
export function PdfSourcesPanel({ sources, locked, onChange, onError }: { sources: PdfLocalSource[]; locked: boolean; onChange: (sources: PdfLocalSource[]) => void; onError: (message: string) => void }) {
  const [loading, setLoading] = useState(false), gate = useRef(false);
  return <section className="sw-pdf-sources"><h2>Attached sources <span>{sources.length}</span></h2><p className="sw-pdf-hint">Attach PDFs to merge pages or PNG/JPEG images to insert or replace. Files stay in this open workspace and are cleared when you leave.</p>
    <label className="sw-pdf-source-picker">{loading ? "Checking files…" : "Attach PDF or image"}<input aria-label="Attach PDF or image sources" type="file" accept="application/pdf,image/png,image/jpeg" multiple disabled={locked || loading} onChange={event => {
      const files = Array.from(event.target.files ?? []); event.target.value = "";
      if (!files.length || locked || gate.current) return;
      gate.current = true; setLoading(true);
      void (async () => {
        if (sources.length + files.length > 8 || sources.reduce((sum, source) => sum + source.bytes.length, 0) + files.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) throw new Error("Attach at most eight files totaling 64 MB.");
        const additions: PdfLocalSource[] = [];
        for (const file of files) additions.push(await admitPdfLocalSource(file.name, new Uint8Array(await file.arrayBuffer())));
        onChange([...sources, ...additions]);
      })().catch(error => onError(error instanceof Error ? error.message : String(error))).finally(() => { gate.current = false; setLoading(false); });
    }} /></label>
    <ul>{sources.map(source => <li key={source.id}><div><strong>{source.name}</strong><small>{source.kind === "pdf" ? source.pageCount + " pages" : "Image"} · {(source.bytes.length / 1024).toFixed(0)} KB</small></div><button aria-label={"Remove source " + source.name} disabled={locked || loading} onClick={() => onChange(sources.filter(item => item.id !== source.id))}>Remove</button></li>)}</ul>
  </section>;
}
