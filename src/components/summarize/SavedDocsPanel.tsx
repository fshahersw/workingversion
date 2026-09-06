import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Loader2, Search } from "lucide-react";

import {
  listKbDocuments,
  searchKbApi,
  type KbDocument,
  type KbSearchHit,
} from "@/lib/kb/kb-client";

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Left-rail panel: the user's durable KB documents + a search-my-documents box.
 *  Reloads when `reloadKey` changes (e.g. after a Save). Self-contained; degrades
 *  quietly if the KB isn't configured or the call fails. */
export function SavedDocsPanel({ reloadKey }: { reloadKey: string }) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KbSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDocs(await listKbDocuments());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, reloadKey, load]);

  const runSearch = async () => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    setSearching(true);
    try {
      setHits(await searchKbApi(q, { topK: 12 }));
    } catch {
      setHits([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="mt-3 border-t border-border pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-2 flex w-full items-center gap-2"
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Saved documents{docs.length ? ` · ${docs.length}` : ""}
        </span>
        <span className="h-px flex-1 bg-border" />
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div className="space-y-2.5">
          {/* search my documents */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runSearch();
              }}
              placeholder="Search my documents"
              className="h-[27px] w-full rounded border border-border bg-muted/40 pl-7 pr-2 text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground focus:border-brand-blue/50 focus:bg-card"
            />
          </div>

          {searching ? (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Searching…
            </p>
          ) : hits ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {hits.length} passage{hits.length === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  onClick={() => setHits(null)}
                  className="text-[10.5px] text-muted-foreground hover:text-foreground"
                >
                  clear
                </button>
              </div>
              {hits.map((h) => (
                <div key={h.chunk_id} className="rounded border border-border/70 bg-card px-2 py-1.5">
                  <p className="mb-0.5 text-[10px] tabular-nums text-muted-foreground">
                    p. {h.page_start ?? "?"}
                    {h.page_end && h.page_end !== h.page_start ? `–${h.page_end}` : ""}
                  </p>
                  <p className="line-clamp-3 text-[11.5px] leading-snug text-foreground">
                    {h.content}
                  </p>
                </div>
              ))}
              {!hits.length ? (
                <p className="text-[11px] text-muted-foreground">No matches in your saved documents.</p>
              ) : null}
            </div>
          ) : null}

          {/* saved document list */}
          {loading ? (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </p>
          ) : error ? (
            <p className="text-[11px] text-destructive">{error}</p>
          ) : !docs.length ? (
            <p className="text-[11px] text-muted-foreground">
              Nothing saved yet. Use “Save to my documents” to persist this working set.
            </p>
          ) : (
            <ul className="space-y-1">
              {docs.map((d) => (
                <li key={d.doc_id} className="flex items-baseline gap-2 text-[11.5px]">
                  <span className="min-w-0 flex-1 truncate text-foreground" title={d.file_name}>
                    {d.file_name}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {d.chunk_count}p · {relTime(d.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
