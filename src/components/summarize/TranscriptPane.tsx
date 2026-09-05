import { useEffect, useMemo } from "react";
import { Search } from "lucide-react";

import {
  lineMatchesQuery,
  lineMatchesSpeaker,
  parseCiteStart,
} from "@/lib/pile/deposition-analysis";
import type { TranscriptLine, TranscriptParse } from "@/lib/pile/transcript";
import type { DepSpeakerFilter } from "@/lib/use-deposition";

const FILTERS: { id: DepSpeakerFilter; label: string }[] = [
  { id: "any", label: "Any speaker" },
  { id: "question", label: "Question" },
  { id: "answer", label: "Answer" },
  { id: "objection", label: "Objection" },
];

function Highlight({ text, query, regex }: { text: string; query: string; regex: boolean }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  let re: RegExp;
  try {
    re = new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  } catch {
    return <>{text}</>;
  }
  const out: { t: string; hit: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index == null || !m[0]) break;
    if (m.index > last) out.push({ t: text.slice(last, m.index), hit: false });
    out.push({ t: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (!out.length) return <>{text}</>;
  if (last < text.length) out.push({ t: text.slice(last), hit: false });
  return (
    <>
      {out.map((part, i) =>
        part.hit ? (
          <mark key={i} className="rounded-sm bg-brand-orange/25 px-0.5 text-foreground">
            {part.t}
          </mark>
        ) : (
          <span key={i}>{part.t}</span>
        ),
      )}
    </>
  );
}

function prefix(line: TranscriptLine): string {
  if (line.speaker === "Q") return "Q.";
  if (line.speaker === "A") return "A.";
  return line.speakerLabel ? line.speakerLabel.replace(/:$/, "") : "";
}

function lineKey(line: TranscriptLine): string {
  return `${line.page}:${line.line}`;
}

function citeHits(line: TranscriptLine, selected: string | null): boolean {
  if (!selected) return false;
  const start = parseCiteStart(selected);
  if (!start) return selected === lineKey(line);
  return line.page === start.page && line.line === start.line;
}

export function TranscriptPane({
  transcript,
  files,
  activeFileId,
  search,
  regex,
  speaker,
  selectedCite,
  onSearch,
  onRegex,
  onSpeaker,
  onSelectFile,
}: {
  transcript: TranscriptParse;
  files?: { fileId: string; fileName: string; witness: string | null }[];
  activeFileId?: string | null;
  search: string;
  regex: boolean;
  speaker: DepSpeakerFilter;
  selectedCite: string | null;
  onSearch: (q: string) => void;
  onRegex: (on: boolean) => void;
  onSpeaker: (s: DepSpeakerFilter) => void;
  onSelectFile?: (fileId: string) => void;
}) {
  const visible = useMemo(
    () =>
      transcript.lines.filter(
        (l) => lineMatchesSpeaker(l, speaker) && lineMatchesQuery(l, search, regex),
      ),
    [transcript.lines, speaker, search, regex],
  );

  const pages = useMemo(() => {
    const groups: { page: number; lines: TranscriptLine[] }[] = [];
    for (const line of visible) {
      const last = groups[groups.length - 1];
      if (last && last.page === line.page) last.lines.push(line);
      else groups.push({ page: line.page, lines: [line] });
    }
    return groups;
  }, [visible]);

  useEffect(() => {
    if (!selectedCite) return;
    const start = parseCiteStart(selectedCite);
    const id = start ? `dep-line-${start.page}-${start.line}` : null;
    if (!id) return;
    document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selectedCite]);

  const matchHint = search.trim()
    ? `${visible.length} match${visible.length === 1 ? "" : "es"}`
    : `${transcript.lines.length} lines`;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-r border-border/80 bg-white">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border/80 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <p className="text-[13px] font-semibold text-slate-900">Transcript</p>
          {files && files.length > 1 && onSelectFile ? (
            <select
              value={activeFileId ?? ""}
              onChange={(e) => onSelectFile(e.target.value)}
              className="h-7 max-w-[12rem] truncate rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-800 outline-none"
            >
              {files.map((f) => (
                <option key={f.fileId} value={f.fileId}>
                  {f.witness || f.fileName}
                </option>
              ))}
            </select>
          ) : (
            <span className="truncate text-[12px] text-slate-500">
              {transcript.witness || transcript.fileName}
            </span>
          )}
        </div>
        <span className="shrink-0 tabular-nums text-[11px] text-slate-400">{matchHint}</span>
      </div>
      <div className="shrink-0 space-y-2 border-b border-border/80 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              id="dep-transcript-search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Find in transcript…"
              className="h-8 w-full rounded-md border border-slate-200 bg-white pl-8 pr-3 text-[13px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
            />
          </div>
          <button
            type="button"
            onClick={() => onRegex(!regex)}
            className={`h-8 rounded-md border px-2.5 text-[12px] font-medium ${
              regex
                ? "border-brand-navy bg-brand-navy text-white"
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
            }`}
          >
            Regex
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onSpeaker(f.id)}
              className={`rounded-md px-2 py-1 text-[11.5px] font-medium ${
                speaker === f.id
                  ? "bg-brand-navy text-white"
                  : "border border-slate-200 bg-white text-slate-600 hover:border-slate-300"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="wr-app-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {pages.length === 0 ? (
          <p className="px-2 text-[13px] text-muted-foreground">No lines match this search.</p>
        ) : (
          pages.map((group) => (
            <div key={group.page} className="mb-4">
              <div className="mb-2 flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Page {group.page}
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
              <div className="font-mono text-[12.5px] leading-[1.65] text-foreground/85">
                {group.lines.map((line) => {
                  const active = citeHits(line, selectedCite);
                  const tag = prefix(line);
                  return (
                    <div
                      key={lineKey(line)}
                      id={`dep-line-${line.page}-${line.line}`}
                      className={`grid grid-cols-[3.25rem_1.75rem_minmax(0,1fr)] gap-x-2 rounded-sm px-1.5 py-[3px] ${
                        active ? "bg-brand-orange-soft" : "hover:bg-slate-50"
                      }`}
                    >
                      <span className="text-right tabular-nums text-muted-foreground/80">
                        {line.page}:{line.line}
                      </span>
                      <span className="text-muted-foreground">{tag}</span>
                      <p className="select-text">
                        <Highlight text={line.text} query={search} regex={regex} />
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
