import { AlertTriangle, FileText, Loader2, Plus, SlidersHorizontal } from "lucide-react";
import { useRef } from "react";

import type { PileFile, PileStructure } from "@/lib/pile/types";

export type FacetCount = { key: string; label: string; count: number };

export function fileFormat(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "PDF";
  if (ext === "docx" || ext === "doc") return "Word";
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return "Spreadsheet";
  if (ext === "pptx" || ext === "ppt") return "Slides";
  if (ext === "txt" || ext === "md") return "Text";
  return ext ? ext.toUpperCase() : "Other";
}

export function docTypeOf(fileName: string, structure: PileStructure | null): string {
  const row = structure?.inventory.find((r) => r.file === fileName);
  const t = (row?.docType ?? "").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Unclassified";
}

function counts(values: string[]): FacetCount[] {
  const map = new Map<string, number>();
  for (const v of values) map.set(v, (map.get(v) ?? 0) + 1);
  return Array.from(map, ([key, count]) => ({ key, label: key, count })).sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
}

function FacetGroup({
  title,
  facets,
  selected,
  onToggle,
}: {
  title: string;
  facets: FacetCount[];
  selected: Set<string>;
  onToggle: (key: string) => void;
}) {
  if (!facets.length) return null;
  return (
    <section className="border-b border-border/70 px-4 py-3.5">
      <h3 className="mb-2 text-[11.5px] font-semibold text-foreground">{title}</h3>
      <ul className="space-y-0.5">
        {facets.map((f) => (
          <li key={f.key}>
            <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-[3px] text-[12px] transition-colors hover:bg-muted/50">
              <input
                type="checkbox"
                checked={selected.has(f.key)}
                onChange={() => onToggle(f.key)}
                className="h-3.5 w-3.5 shrink-0 rounded border-border accent-[hsl(var(--brand-navy,0_0%_20%))]"
              />
              <span className="min-w-0 flex-1 truncate text-foreground">{f.label}</span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                {f.count}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RefineRail({
  files,
  structure,
  selectedTypes,
  selectedFormats,
  selectedFileId,
  restrictFileIds,
  adding,
  onToggleType,
  onToggleFormat,
  onToggleRestrict,
  onClear,
  onOpen,
  onAddFiles,
  children,
}: {
  files: PileFile[];
  structure: PileStructure | null;
  selectedTypes: Set<string>;
  selectedFormats: Set<string>;
  selectedFileId?: string | null;
  restrictFileIds?: Set<string>;
  adding?: boolean;
  onToggleType: (key: string) => void;
  onToggleFormat: (key: string) => void;
  onToggleRestrict?: (fileId: string) => void;
  onClear: () => void;
  onOpen: (fileId: string, page: number) => void;
  onAddFiles?: (files: File[]) => void;
  children?: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const typeFacets = counts(files.map((f) => docTypeOf(f.name, structure)));
  const formatFacets = counts(files.map((f) => fileFormat(f.name)));
  const usefulTypes = typeFacets.filter((f) => f.key !== "Unclassified");
  const pages = files.reduce((n, f) => n + f.pageCount, 0);
  const empty = files.reduce((n, f) => n + f.emptyPages, 0);
  const ocr = files.reduce((n, f) => n + f.ocrPages, 0);
  const filtered = selectedTypes.size + selectedFormats.size > 0;
  const showTypes = usefulTypes.length >= 2;
  const showFormats = formatFacets.length >= 2;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Working set
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{files.length}</span>
        {onAddFiles ? (
          <>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".pdf,.docx,.xlsx,.xlsm,.xls,.pptx,.pptm,.txt,.md"
              className="hidden"
              onChange={(e) => {
                onAddFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={adding}
              className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-foreground hover:underline disabled:opacity-50"
            >
              {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" strokeWidth={2} />}
              Add
            </button>
          </>
        ) : null}
      </div>

      <div className="wr-app-scroll min-h-0 flex-1 overflow-y-auto">
        <section className="border-b border-border/70 px-3 py-2">
          <ul className="space-y-0.5">
            {files.map((f) => {
              const unreadable = f.emptyPages > 0 && f.emptyPages === f.pageCount;
              const active = selectedFileId === f.id;
              const restricted = restrictFileIds?.has(f.id) ?? false;
              return (
                <li key={f.id} className="flex items-start gap-1">
                  {onToggleRestrict ? (
                    <label className="mt-1.5 shrink-0" title="Restrict Ask and search to this file">
                      <input
                        type="checkbox"
                        checked={restricted}
                        onChange={() => onToggleRestrict(f.id)}
                        className="h-3.5 w-3.5 rounded border-border accent-[hsl(var(--brand-navy,0_0%_20%))]"
                      />
                    </label>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onOpen(f.id, 1)}
                    className={`flex min-w-0 flex-1 items-start gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors ${
                      active ? "bg-brand-orange-soft/40" : "hover:bg-muted/50"
                    }`}
                  >
                    <FileText
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      strokeWidth={1.75}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-foreground">{f.name}</span>
                      <span className="block font-mono text-[10.5px] tabular-nums text-muted-foreground">
                        {fileFormat(f.name)} · {f.pageCount} pp
                        {f.ocrPages ? ` · ${f.ocrPages} recovered` : ""}
                        {f.emptyPages ? ` · ${f.emptyPages} unreadable` : ""}
                      </span>
                    </span>
                    {unreadable ? (
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" strokeWidth={1.75} />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {empty > 0 ? (
            <p className="mt-2 px-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {empty} page{empty === 1 ? "" : "s"} still have no usable text
              {ocr ? ` · ${ocr} recovered by OCR` : ""}.
            </p>
          ) : null}
          <p className="mt-2 px-1.5 font-mono text-[10.5px] tabular-nums text-muted-foreground">
            {pages.toLocaleString()} pages indexed
            {restrictFileIds && restrictFileIds.size
              ? ` · Ask limited to ${restrictFileIds.size}`
              : ""}
          </p>
        </section>

        {showTypes || showFormats ? (
          <div className="border-b border-border/70">
            <div className="flex items-center gap-2 px-4 pt-3">
              <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.75} />
              <span className="text-[11.5px] font-semibold text-foreground">Filter</span>
              {filtered ? (
                <button
                  type="button"
                  onClick={onClear}
                  className="ml-auto text-[11px] font-medium text-brand-orange hover:underline"
                >
                  Clear
                </button>
              ) : null}
            </div>
            {showTypes ? (
              <FacetGroup
                title="Document type"
                facets={typeFacets}
                selected={selectedTypes}
                onToggle={onToggleType}
              />
            ) : null}
            {showFormats ? (
              <FacetGroup
                title="File format"
                facets={formatFacets}
                selected={selectedFormats}
                onToggle={onToggleFormat}
              />
            ) : null}
          </div>
        ) : null}

        {children ? <div className="px-4 py-3.5">{children}</div> : null}
      </div>
    </div>
  );
}
