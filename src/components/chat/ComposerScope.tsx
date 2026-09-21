// Composer scope control: replaces the native matter dropdown in the chat
// composer. The composer shows only a display-only matter chip plus an
// "N sources" button; picking the matter and focus documents happens inside
// this button's popover (never a bare selector in the composer toolbar).
//
// Sources come from three real places: the user's matters corpus (matter
// documents), their Library files, and any files uploaded to this message.
// Matter scoping is real (matter_id reaches the orchestrator) and the uploaded
// files are read in full (real attachments); matter/library document
// *selections* fold into the request text as focus hints via
// `appendSourceScope` (there is no per-document retrieval field yet).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Briefcase,
  Check,
  ChevronDown,
  FileText,
  Layers,
  Loader2,
  Paperclip,
  Search,
  X,
} from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { MatterScope } from "@/lib/chat-types";
import type { SelectedDoc } from "@/lib/research-skills";
import { listItemsFn } from "@/lib/library/library.functions";
import { docTypeLabel, documentsQueryOptions, formatCorpusDate, mattersQueryOptions } from "@/lib/workspace";
import type { WorkspaceDocument } from "@/lib/workspace-types";

export type ComposerScopeValue = {
  matter: MatterScope | null;
  onMatterChange: (m: MatterScope | null) => void;
  selectedDocs: SelectedDoc[];
  onDocsChange: (docs: SelectedDoc[]) => void;
  focusOnly: boolean;
  onFocusOnlyChange: (v: boolean) => void;
  /** Files uploaded to the current message (read in full; surfaced for context). */
  uploads?: { name: string }[];
  disabled?: boolean;
};

/** Display-only chip for the current matter (composer card corner). */
export function MatterChip({
  matter,
  onClear,
}: {
  matter: MatterScope | null;
  onClear?: () => void;
}) {
  if (!matter) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-brand-navy/20 bg-brand-blue-soft px-2 py-0.5 text-[11px] font-medium text-brand-navy">
      <Briefcase className="h-3 w-3 shrink-0" strokeWidth={2} />
      <span className="max-w-[168px] truncate">{matter.label}</span>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear matter scope"
          title="Clear matter scope"
          className="-mr-0.5 grid h-4 w-4 place-items-center rounded text-brand-navy/60 hover:bg-brand-navy/10 hover:text-brand-navy"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

type LibFile = { itemId: string; name: string };

/** The "N sources ▾" button + scope popover (matter, matter docs, library, uploads). */
export function ComposerScope({
  matter,
  onMatterChange,
  selectedDocs,
  onDocsChange,
  focusOnly,
  onFocusOnlyChange,
  uploads = [],
  disabled,
}: ComposerScopeValue) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const { data: matters, isLoading: mattersLoading } = useQuery({
    ...mattersQueryOptions,
    enabled: open,
  });

  const list = useMemo(() => {
    const all = matters ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((m) =>
      `${m.shortName} ${m.caseName} ${m.docketNumber} ${m.mdlNumber ?? ""}`.toLowerCase().includes(q),
    );
  }, [matters, query]);

  const slug = useMemo(
    () => matters?.find((m) => m.matterId === matter?.matterId)?.slug ?? null,
    [matters, matter],
  );

  const { data: docPage, isLoading: docsLoading } = useQuery({
    ...documentsQueryOptions({ slug: slug ?? "", sort: "date-desc", limit: 40 }),
    enabled: open && !!slug,
  });
  const docs: WorkspaceDocument[] = docPage?.rows ?? [];

  const { data: libRows, isLoading: libLoading } = useQuery({
    queryKey: ["library", "files", "scope"],
    queryFn: () => listItemsFn({ data: { kind: "file" } }),
    enabled: open,
    staleTime: 30_000,
  });
  const libFiles = (libRows ?? []) as LibFile[];

  const pickMatter = (m: MatterScope | null) => {
    onMatterChange(m);
    // Matter documents belong to a specific matter; drop those when it changes,
    // but keep any library selections (they aren't matter-scoped).
    onDocsChange(selectedDocs.filter((d) => d.id.startsWith("lib:")));
    setQuery("");
  };

  const isOn = (id: string) => selectedDocs.some((x) => x.id === id);
  const toggle = (id: string, title: string) =>
    onDocsChange(isOn(id) ? selectedDocs.filter((x) => x.id !== id) : [...selectedDocs, { id, title }]);

  const focusCount = selectedDocs.length;
  const sourceCount = focusCount + uploads.length;
  const active = Boolean(matter) || sourceCount > 0;
  const label = sourceCount > 0 ? `${sourceCount} source${sourceCount === 1 ? "" : "s"}` : "Sources";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Choose matter and source documents"
          title="Choose matter and source documents"
          className={[
            "inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium transition-colors",
            active
              ? "border-brand-navy/25 bg-brand-blue-soft text-brand-navy"
              : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-brand-navy",
            disabled ? "opacity-60" : "",
          ].join(" ")}
        >
          <Layers className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span className="max-w-[150px] truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="w-[360px] rounded-lg border-border bg-card p-0 shadow-[0_20px_50px_-18px_rgba(31,42,94,0.35)]"
      >
        {/* Matter (scope) */}
        <div className="border-b border-border px-3 py-2">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Matter (scope)
          </div>
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search matters…"
              className="w-full bg-transparent text-[12.5px] placeholder:text-muted-foreground/70 focus:outline-none"
            />
          </div>
        </div>
        <div className="max-h-40 overflow-y-auto p-1.5">
          <button
            type="button"
            onClick={() => pickMatter(null)}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-semibold text-brand-navy">All matters</div>
              <div className="text-[10.5px] text-muted-foreground">
                Search the full corpus and the open web
              </div>
            </div>
            {!matter && <Check className="h-3.5 w-3.5 text-brand-navy" />}
          </button>
          {mattersLoading ? (
            <p className="px-2 py-3 text-[11.5px] text-muted-foreground">Loading matters…</p>
          ) : list.length === 0 ? (
            <p className="px-2 py-3 text-[11.5px] text-muted-foreground">No matters match “{query}”.</p>
          ) : (
            list.map((m) => (
              <button
                key={m.matterId}
                type="button"
                onClick={() => pickMatter({ matterId: m.matterId, label: `${m.shortName} (${m.docketNumber})` })}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12.5px] font-semibold text-brand-navy">{m.shortName}</span>
                    {m.mdlNumber && (
                      <span className="shrink-0 rounded bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground">
                        MDL {m.mdlNumber}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[10.5px] text-muted-foreground">
                    {m.docketNumber} · {m.courtName ?? m.courtId} · {m.documents.toLocaleString()} docs
                  </div>
                </div>
                {matter?.matterId === m.matterId && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-brand-navy" />
                )}
              </button>
            ))
          )}
        </div>

        {/* Focus documents: matter corpus + library */}
        <div className="border-t border-border px-3 py-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Focus documents
            </span>
            {focusCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  onDocsChange([]);
                  onFocusOnlyChange(false);
                }}
                className="text-[10.5px] text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>

          <div className="max-h-52 space-y-2 overflow-y-auto pr-0.5">
            {/* From the selected matter */}
            {matter && (
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
                  From {matter.label}
                </p>
                {docsLoading ? (
                  <p className="flex items-center gap-2 px-1 py-2 text-[12px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading documents…
                  </p>
                ) : docs.length === 0 ? (
                  <p className="px-1 py-2 text-[12px] text-muted-foreground">
                    No documents to list for this matter yet.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {docs.map((d) => (
                      <DocRow
                        key={d.id}
                        on={isOn(d.id)}
                        title={d.title}
                        meta={[
                          docTypeLabel(d.docType),
                          d.dateFiled ? formatCorpusDate(d.dateFiled) : "",
                          d.pageCount ? `${d.pageCount} pp` : "",
                        ]}
                        onToggle={() => toggle(d.id, d.title)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* From the user's library */}
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
                Your library
              </p>
              {libLoading ? (
                <p className="flex items-center gap-2 px-1 py-2 text-[12px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading files…
                </p>
              ) : libFiles.length === 0 ? (
                <p className="px-1 py-2 text-[12px] text-muted-foreground">
                  No files in your library yet.
                </p>
              ) : (
                <div className="space-y-1">
                  {libFiles.map((f) => (
                    <DocRow
                      key={f.itemId}
                      on={isOn(`lib:${f.itemId}`)}
                      title={f.name}
                      meta={["Library file"]}
                      onToggle={() => toggle(`lib:${f.itemId}`, f.name)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {focusCount > 0 && (
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11.5px] text-foreground">
              <input
                type="checkbox"
                checked={focusOnly}
                onChange={(e) => onFocusOnlyChange(e.target.checked)}
                className="h-3.5 w-3.5 accent-brand-navy"
              />
              Base the analysis strictly on the {focusCount} selected document{focusCount === 1 ? "" : "s"}
            </label>
          )}

          {uploads.length > 0 && (
            <div className="mt-2 flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground">
              <Paperclip className="h-3 w-3 shrink-0" strokeWidth={2} />
              {uploads.length} file{uploads.length === 1 ? "" : "s"} attached to this message — read in full.
            </div>
          )}

          <p className="mt-2 text-[10px] leading-snug text-muted-foreground/70">
            Selected documents guide the search; uploaded files are read in full.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DocRow({
  on,
  title,
  meta,
  onToggle,
}: {
  on: boolean;
  title: string;
  meta: string[];
  onToggle: () => void;
}) {
  const metaLine = meta.filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex w-full items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
        on ? "border-brand-navy bg-brand-blue-soft/40" : "border-border hover:bg-muted/40"
      }`}
    >
      <span
        className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
          on ? "border-brand-navy bg-brand-navy text-white" : "border-border"
        }`}
      >
        {on && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      <FileText className="h-3.5 w-3.5 shrink-0 text-brand-navy/50" strokeWidth={1.8} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-foreground">{title}</span>
        {metaLine && <span className="block text-[10.5px] text-muted-foreground">{metaLine}</span>}
      </span>
    </button>
  );
}
