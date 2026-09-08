import { ArrowLeft, ExternalLink, Loader2, Pin, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Source } from "@/lib/chat-types";
import { readSourceFn, type ReadSourceResult } from "@/lib/agents/read-source.functions";

/**
 * Reading pane. Opens over the source list so a citation can be inspected
 * without leaving the conversation: the retrieved passage first, then the full
 * page text for a web source (loaded through the same hardened fetcher the
 * agent uses) or the PDF itself when the source resolves to one.
 */
export function SourceReader({
  source,
  quote,
  onBack,
  onPin,
}: {
  source: Source;
  quote?: string;
  onBack: () => void;
  onPin?: (source: Source, quote: string) => void;
}) {
  const url = source.source_url ?? "";
  const isPdf = /\.pdf(\?|$)/i.test(url) || /s3|amazonaws|storage/i.test(url);
  const external = Boolean(url) && !url.startsWith("/");
  const readable = external && !isPdf && /^https?:\/\//i.test(url);

  const host = useMemo(() => {
    if (!external) return null;
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }, [external, url]);

  const passage = source.content?.trim() ?? "";
  const highlighted = useMemo(() => splitOnNeedle(passage, quote), [passage, quote]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex shrink-0 items-start gap-2 border-b border-border/60 px-3 py-2.5">
        <button
          type="button"
          onClick={onBack}
          className="mt-[2px] rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Back to sources"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold leading-snug text-brand-navy">
            {source.citation}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px] text-muted-foreground/70">
            <span className="truncate">{host || source.authority || source.source_type}</span>
            {source.effective_date && (
              <span className="tabular-nums">· {source.effective_date}</span>
            )}
            <span>· {source.ref}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onPin && passage && (
            <button
              type="button"
              onClick={() => onPin(source, quote || passage.slice(0, 600))}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Pin className="h-3 w-3" />
              Pin
            </button>
          )}
          {external && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Open <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>

      <div className="wr-app-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {passage ? (
          <div className="rounded-md border border-border/70 bg-card px-3.5 py-3">
            <div className="pb-1.5 text-[10px] font-medium uppercase tracking-[0.09em] text-muted-foreground/60">
              Retrieved passage
            </div>
            <p className="whitespace-pre-wrap text-[12.5px] leading-[1.6] text-foreground/90">
              {highlighted.map((part, i) =>
                part.hit ? (
                  <mark key={i} className="rounded-[3px] bg-brand-orange/20 px-0.5 text-foreground">
                    {part.text}
                  </mark>
                ) : (
                  <span key={i}>{part.text}</span>
                ),
              )}
            </p>
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">
            No retrieved text stored for this source.
          </p>
        )}

        {readable && <FullPage url={url} quote={quote} />}

        {external && isPdf && (
          <div className="mt-3 overflow-hidden rounded-md border border-border/70 bg-card">
            <iframe src={url} title={source.citation} className="h-[70vh] w-full" />
          </div>
        )}
      </div>
    </div>
  );
}

/** The whole page, fetched on open, with the cited quote highlighted and a
 *  find-in-page box. One fetch per URL; the result is cached for the session. */
function FullPage({ url, quote }: { url: string; quote?: string }) {
  const [page, setPage] = useState<ReadSourceResult | null>(() => pageCache.get(url) ?? null);
  const [loading, setLoading] = useState(!pageCache.has(url));
  const [find, setFind] = useState("");
  const firstHitRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cached = pageCache.get(url);
    if (cached) {
      setPage(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    readSourceFn({ data: { url } })
      .then((result) => {
        pageCache.set(url, result);
        if (!cancelled) setPage(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPage({
          ok: false,
          title: "",
          text: "",
          finalUrl: url,
          truncated: false,
          note: err instanceof Error ? err.message : "Could not load the page.",
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const needle = find.trim().length >= 2 ? find.trim() : quote;
  const parts = useMemo(
    () => (page?.ok ? splitOnNeedle(page.text, needle, needle === quote ? 1 : 200) : []),
    [page, needle, quote],
  );
  const hitCount = parts.filter((p) => p.hit).length;

  // Bring the first highlight into view once the page (or the search) changes.
  useEffect(() => {
    firstHitRef.current?.scrollIntoView({ block: "center" });
  }, [parts]);

  return (
    <div className="mt-3 rounded-md border border-border/70 bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.09em] text-muted-foreground/60">
          Full page
        </span>
        {page?.ok && (
          <span className="text-[10.5px] tabular-nums text-muted-foreground/70">
            {Math.round(page.text.length / 1_000)}k chars{page.truncated ? " · truncated" : ""}
          </span>
        )}
        <label className="ml-auto flex items-center gap-1 rounded-md border border-border/70 bg-background px-1.5 py-0.5">
          <Search className="h-3 w-3 text-muted-foreground" />
          <input
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder="Find in page"
            className="w-28 bg-transparent text-[11px] focus:outline-none"
          />
          {find.trim().length >= 2 && (
            <span className="text-[10px] tabular-nums text-muted-foreground">{hitCount}</span>
          )}
        </label>
      </div>
      <div className="px-3.5 py-3">
        {loading ? (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the page…
          </div>
        ) : !page || !page.ok ? (
          <p className="text-[12px] text-muted-foreground">
            {page?.note || "Could not load the page."}{" "}
            <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
              Open it in a new tab
            </a>
            .
          </p>
        ) : (
          <>
            {page.title && (
              <div className="mb-2 text-[13px] font-semibold leading-snug text-foreground">
                {page.title}
              </div>
            )}
            <p className="whitespace-pre-wrap text-[12.5px] leading-[1.6] text-foreground/85">
              {parts.map((part, i) => {
                if (!part.hit) return <span key={i}>{part.text}</span>;
                const first = !parts.slice(0, i).some((p) => p.hit);
                return (
                  <mark
                    key={i}
                    ref={first ? firstHitRef : undefined}
                    className="rounded-[3px] bg-brand-orange/25 px-0.5 text-foreground"
                  >
                    {part.text}
                  </mark>
                );
              })}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

const pageCache = new Map<string, ReadSourceResult>();

type Part = { text: string; hit: boolean };

/** Split text around case-insensitive occurrences of needle (up to maxHits). */
function splitOnNeedle(text: string, needle?: string, maxHits = 1): Part[] {
  const n = (needle ?? "").trim();
  if (!n || (maxHits === 1 && n.length < 12) || !text) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const target = n.toLowerCase();
  const parts: Part[] = [];
  let from = 0;
  let hits = 0;
  while (hits < maxHits) {
    const idx = lower.indexOf(target, from);
    if (idx < 0) break;
    if (idx > from) parts.push({ text: text.slice(from, idx), hit: false });
    parts.push({ text: text.slice(idx, idx + n.length), hit: true });
    from = idx + n.length;
    hits++;
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false });
  return parts.length ? parts : [{ text, hit: false }];
}
