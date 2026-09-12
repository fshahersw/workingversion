import { useState } from "react";
import { Download } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { DepAnalysis } from "@/lib/pile/deposition-analysis";
import {
  DEPOSITION_EXPORT_SECTIONS,
  depositionExportCsv,
  depositionExportMarkdown,
  type DepExportSection,
} from "@/lib/pile/deposition-export";

export function DepositionExportDialog({
  analysis,
  label,
  activeTab,
  complete,
}: {
  analysis: DepAnalysis | null;
  label: string;
  activeTab: string;
  complete: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sections, setSections] = useState<DepExportSection[]>([]);
  const [format, setFormat] = useState("docx");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const download = async () => {
    if (!analysis || !sections.length) return;
    setBusy(true);
    setError("");
    try {
      let blob: Blob;
      if (format === "csv")
        blob = new Blob([depositionExportCsv(analysis, sections, complete)], {
          type: "text/csv;charset=utf-8",
        });
      else {
        const markdown = depositionExportMarkdown(analysis, sections, label, complete);
        if (format === "md") blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
        else {
          const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
          const document = new Document({
            sections: [
              {
                children: markdown.split("\n").map(
                  (line) =>
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: line.replace(/^#{1,6}\s|^>\s/g, ""),
                          italics: line.startsWith(">"),
                        }),
                      ],
                      heading: line.startsWith("# ")
                        ? HeadingLevel.HEADING_1
                        : line.startsWith("## ")
                          ? HeadingLevel.HEADING_2
                          : line.startsWith("### ")
                            ? HeadingLevel.HEADING_3
                            : undefined,
                      spacing: { after: 100 },
                    }),
                ),
              },
            ],
          });
          blob = await Packer.toBlob(document);
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `deposition-${sections.length === 1 ? sections[0] : "selected-analysis"}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not export analysis");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (next) {
          setSections(
            DEPOSITION_EXPORT_SECTIONS.some(([id]) => id === activeTab)
              ? [activeTab as DepExportSection]
              : DEPOSITION_EXPORT_SECTIONS.map(([id]) => id),
          );
          setError("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-8 rounded-sm" disabled={!analysis}>
          <Download className="h-3.5 w-3.5" />
          Export
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg bg-white">
        <DialogHeader>
          <DialogTitle>Export deposition analysis</DialogTitle>
          <DialogDescription>
            Choose the sections to share. Source quotations, page and line references, and review
            status travel with the findings.
          </DialogDescription>
        </DialogHeader>
        {!complete && (
          <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
            Some analysis passes are incomplete. The export will be marked as partial.
          </p>
        )}
        <div className="flex gap-3 text-xs">
          <button
            type="button"
            onClick={() => setSections(DEPOSITION_EXPORT_SECTIONS.map(([id]) => id))}
            className="font-medium underline"
          >
            Select all
          </button>
          <button type="button" className="underline" onClick={() => setSections([])}>
            Clear
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {DEPOSITION_EXPORT_SECTIONS.map(([id, title]) => (
            <label
              key={id}
              className={`flex items-center gap-2 rounded-md border p-2.5 text-xs ${sections.includes(id) ? "border-slate-300 bg-slate-50 text-slate-900" : "border-slate-200 text-slate-600"}`}
            >
              <input
                type="checkbox"
                checked={sections.includes(id)}
                onChange={() =>
                  setSections((s) =>
                    s.includes(id) ? s.filter((item) => item !== id) : [...s, id],
                  )
                }
              />
              {title}
            </label>
          ))}
        </div>
        <label className="flex items-center justify-between text-xs font-medium text-slate-700">
          Format
          <select
            aria-label="Export format"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="rounded-md border px-3 py-2"
          >
            <option value="docx">Word document (.docx)</option>
            <option value="csv">Spreadsheet with evidence (.csv)</option>
            <option value="md">Markdown (.md)</option>
          </select>
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button onClick={() => void download()} disabled={!sections.length || busy}>
          {busy
            ? "Preparing…"
            : `Export ${sections.length} section${sections.length === 1 ? "" : "s"}`}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
