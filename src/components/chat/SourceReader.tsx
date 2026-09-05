import { ArrowLeft, ExternalLink, Pin } from "lucide-react";
import { useMemo } from "react";

import type { Source } from "@/lib/chat-types";

/**
 * Reading pane. Opens over the source list so a citation can be inspected
 * without leaving the conversation: retrieved passage first, then the
 * underlying PDF when the source resolves to one.
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

  const host = useMemo(() => {
    if (!external) return null;
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }, [external, url]);

  const passage = source.content?.trim() ?? "";
  const highlighted = useMemo(
    () => splitOnQuote(passage, quote),
    [passage, quote],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[oklch(0.995_0.002_260)]">
      <div className="flex shrink-0 items-start gap-2 border-b border-border/50 px-3 py-2.5">
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
            <span className="truncate">
              {host || source.authority || source.source_type}
            </span>
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
          <div className="rounded-lg border border-border/60 bg-card px-3.5 py-3">
            <div className="pb-1.5 text-[10px] font-medium uppercase tracking-[0.09em] text-muted-foreground/50">
              Retrieved passage
            </div>
            <p className="whitespace-pre-wrap text-[12.5px] leading-[1.6] text-foreground/90">
              {highlighted.map((part, i) =>
                part.hit ? (
                  <mark
                    key={i}
                    className="rounded-[3px] bg-brand-orange/20 px-0.5 text-foreground"
                  >
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

        {external && isPdf && (
          <div className="mt-3 overflow-hidden rounded-lg border border-border/60 bg-card">
            <iframe
              src={url}
              title={source.citation}
              className="h-[70vh] w-full"
            />
          </div>
        )}
      </div>
    </div>
  );
}

type Part = { text: string; hit: boolean };

function splitOnQuote(text: string, quote?: string): Part[] {
  const needle = (quote ?? "").trim();
  if (!needle || needle.length < 12) return [{ text, hit: false }];
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return [{ text, hit: false }];
  return [
    { text: text.slice(0, idx), hit: false },
    { text: text.slice(idx, idx + needle.length), hit: true },
    { text: text.slice(idx + needle.length), hit: false },
  ].filter((p) => p.text.length > 0);
}
