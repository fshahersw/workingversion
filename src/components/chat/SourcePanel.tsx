import { AnimatePresence, motion } from "framer-motion";
import { BookOpen, ExternalLink, FileText, Loader2, Pin, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Source } from "@/lib/chat-types";
import { streamQuickAsk } from "@/lib/orchestrate";
import { gradeSource, sortByAuthority } from "@/lib/source-tiering";
import { hostOf } from "@/lib/host";
import { Favicon } from "./Favicon";

type Bucket =
  | "corpus"
  | "federal_courts"
  | "state_courts"
  | "statutes"
  | "agencies"
  | "web"
  | "press";

const BUCKET_ORDER: Bucket[] = [
  "corpus",
  "federal_courts",
  "state_courts",
  "statutes",
  "agencies",
  "web",
  "press",
];

const BUCKET_LABEL: Record<Bucket, string> = {
  corpus: "Firm corpus",
  federal_courts: "Federal courts",
  state_courts: "State courts",
  statutes: "Statutes & regulations",
  agencies: "Agencies",
  web: "Web research",
  press: "Press",
};

const CORPUS_TYPES = new Set(["matter", "document", "docket_entry"]);

const FED_COURT_RE =
  /\b(supreme court|s\.?\s?ct\.?|[nsew]\.d\.\s?[a-z]{2,}|\d{1,2}(st|nd|rd|th)\s?cir\.?|f\.\s?(supp|app'?x|\dd)|jpml|mdl\b|fed\.\s?r\.\s?civ)/i;
const STATE_COURT_RE =
  /\b(superior court|court of appeal|supreme court of [a-z ]+|cal\.\s?(app|rptr)|n\.?y\.?s\.?2d|a\.\s?\dd|p\.\s?\dd|so\.\s?\dd|s\.w\.\s?\dd|n\.e\.\s?\dd)\b/i;
const STATUTE_RE =
  /\b(\d+\s?u\.?s\.?c\.?|\d+\s?c\.?f\.?r\.?|fed\.?\s?reg\.?|pub\.?\s?l\.?\s?no|public law|§)/i;

function bucketOf(s: Source): Bucket {
  const type = (s.source_type || "").toLowerCase();
  if (CORPUS_TYPES.has(type) || /docket|motion|order|complaint/.test(type)) {
    return "corpus";
  }

  const host = (hostOf(s.source_url) || "").toLowerCase();
  const text = `${s.citation || ""} ${s.authority || ""}`;

  if (
    /uscourts\.gov$|courtlistener\.com$|supremecourt\.gov$|pacer\.gov$/.test(
      host,
    ) ||
    FED_COURT_RE.test(text)
  ) {
    return "federal_courts";
  }
  if (/\.state\.[a-z]{2}\.us$|courts\.[a-z]{2}\.gov$/.test(host) || STATE_COURT_RE.test(text)) {
    return "state_courts";
  }
  if (
    /(ecfr|federalregister|govinfo|congress|law\.cornell)\.gov?$/.test(host) ||
    /law\.cornell\.edu$/.test(host) ||
    STATUTE_RE.test(text)
  ) {
    return "statutes";
  }
  if (host.endsWith(".gov") || host.endsWith(".mil")) return "agencies";
  if (type === "news") return "press";
  return gradeSource(s).tier === 3 ? "press" : "web";
}

type Scope = "turn" | "all";

export function SourcePanel({
  sources,
  turnSources,
  selectedRef,
  citedRefs,
  onClearSelect,
  onRead,
  onPin,
}: {
  /** Every source retrieved in the conversation (refs are stable across turns). */
  sources: Source[];
  /** Sources specific to the latest answer: the ones it cites plus the ones
   *  first retrieved for it (the server re-seeds every turn with the carried
   *  sources, so the raw per-message list is nearly the whole thread). Enables
   *  the "This answer" scope whenever it is smaller than `sources`. */
  turnSources?: Source[];
  selectedRef: string | null;
  selectedQuote?: string;
  citedRefs?: Set<string>;
  sessionId?: string;
  onClearSelect: () => void;
  onRead?: (source: Source) => void;
  onPin?: (source: Source) => void;
}) {
  // Scope defaults to the latest answer whenever its own sources are a strict
  // subset of the thread's; otherwise (single turn, or nothing new) the toggle
  // would be a no-op, so it is hidden and everything shows.
  const hasTurnScope = Boolean(
    turnSources && turnSources.length > 0 && turnSources.length < sources.length,
  );
  const [scope, setScope] = useState<Scope>("turn");
  const [citedOnly, setCitedOnly] = useState(false);
  const effectiveScope: Scope = hasTurnScope ? scope : "all";
  const scoped = effectiveScope === "turn" && turnSources ? turnSources : sources;
  const canFilterCited = Boolean(citedRefs && citedRefs.size > 0);
  const visibleSources = useMemo(
    () =>
      citedOnly && canFilterCited
        ? scoped.filter((s) => citedRefs!.has(s.ref.toUpperCase()))
        : scoped,
    [scoped, citedOnly, canFilterCited, citedRefs],
  );

  // A citation click may target a source outside the current scope/filter:
  // widen so the highlighted row is actually visible.
  useEffect(() => {
    if (!selectedRef) return;
    if (!visibleSources.some((s) => s.ref === selectedRef)) {
      if (effectiveScope === "turn" && sources.some((s) => s.ref === selectedRef)) setScope("all");
      if (citedOnly) setCitedOnly(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRef]);

  const grouped = useMemo(() => {
    const g = {} as Record<Bucket, Source[]>;
    for (const b of BUCKET_ORDER) g[b] = [];
    for (const s of sortByAuthority(visibleSources)) g[bucketOf(s)].push(s);
    return g;
  }, [visibleSources]);


  if (sources.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <div className="grid h-11 w-11 place-items-center rounded-full bg-brand-blue-soft">
          <FileText className="h-[18px] w-[18px] text-primary" />
        </div>
        <h3 className="mt-3 text-[13px] font-semibold text-brand-navy">
          Sources will appear here
        </h3>
        <p className="mt-1 max-w-xs text-[11.5px] text-muted-foreground">
          Every authority cited in the answer will be listed here.
        </p>
      </div>
    );
  }

  const visible = BUCKET_ORDER.filter((b) => grouped[b].length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[oklch(0.995_0.002_260)]">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border/50 px-3.5 py-2">
        <h3 className="text-[13px] font-semibold tracking-tight text-brand-navy">
          Sources{" "}
          <span className="font-normal tabular-nums text-muted-foreground/60">
            {visibleSources.length}
            {visibleSources.length !== sources.length ? ` / ${sources.length}` : ""}
          </span>
        </h3>
        <div className="ml-auto flex items-center gap-1">
          {hasTurnScope && (
            <div
              role="tablist"
              aria-label="Source scope"
              className="inline-flex rounded-md border border-border/70 bg-card p-[2px] text-[10.5px] font-medium"
            >
              {(
                [
                  ["turn", "This answer"],
                  ["all", "All"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={effectiveScope === id}
                  onClick={() => setScope(id)}
                  className={`rounded-[4px] px-2 py-[3px] transition-colors ${
                    effectiveScope === id
                      ? "bg-brand-blue-soft text-brand-navy"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {canFilterCited && (
            <button
              type="button"
              aria-pressed={citedOnly}
              onClick={() => setCitedOnly((v) => !v)}
              title="Show only sources the answer cites"
              className={`rounded-md border px-2 py-[3px] text-[10.5px] font-medium transition-colors ${
                citedOnly
                  ? "border-brand-navy/30 bg-brand-blue-soft text-brand-navy"
                  : "border-border/70 bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              Cited
            </button>
          )}
          {selectedRef && (
            <button
              onClick={onClearSelect}
              className="px-1 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="wr-app-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {visibleSources.length === 0 && (
          <p className="px-1 py-6 text-center text-[11.5px] text-muted-foreground">
            No sources match this filter.
          </p>
        )}
        {visible.map((b) => (
          <section key={b} className="mb-3 last:mb-2">
            <div className="flex items-center gap-1.5 pb-1 text-[10px] font-medium uppercase tracking-[0.09em] text-muted-foreground/50">
              {BUCKET_LABEL[b]}
              <span className="tabular-nums text-muted-foreground/40">
                {grouped[b].length}
              </span>
            </div>
            <div className="divide-y divide-border/40">
              {grouped[b].map((s) => (
                <SourceRow
                  key={s.ref}
                  source={s}
                  selected={selectedRef === s.ref}
                  dim={b === "press"}
                  cited={citedRefs?.has(s.ref.toUpperCase())}
                  onRead={onRead}
                  onPin={onPin}
                />
              ))}
            </div>
          </section>
        ))}

      </div>
    </div>
  );
}

function isInternalSource(source: Source): boolean {
  return source.authority === "registry" || !hostOf(source.source_url);
}

function SourceRow({
  source,
  selected,
  dim,
  cited,
  onRead,
  onPin,
}: {
  source: Source;
  selected: boolean;
  dim?: boolean;
  /** Whether the answer cites this source (undefined before any answer). */
  cited?: boolean;
  onRead?: (source: Source) => void;
  onPin?: (source: Source) => void;
}) {

  const ref = useRef<HTMLDivElement>(null);
  const grade = useMemo(() => gradeSource(source), [source]);
  const host = hostOf(source.source_url);

  useEffect(() => {
    if (!selected) return;
    const t = setTimeout(() => {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 140);
    return () => clearTimeout(t);
  }, [selected]);

  return (
    <motion.div
      ref={ref}
      id={`source-${source.ref}`}
      data-ref={source.ref}
      layout
      transition={{ duration: 0.26, ease: [0.22, 0.61, 0.36, 1] }}
      className={`group relative px-2 py-2.5 transition-colors ${
        selected ? "bg-brand-blue-soft/30" : "hover:bg-muted/30"
      } ${cited === false ? "opacity-70 hover:opacity-100" : ""}`}
    >
      {selected && (
        <span className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-brand-navy/60" />
      )}
      <div className="flex items-start gap-2">
        <div className="mt-[2px] flex shrink-0 flex-col items-center gap-1">
          <Favicon host={host} src={source.favicon} />
          <span
            className={`text-[9.5px] font-medium tabular-nums ${
              cited ? "text-brand-navy/80" : "text-muted-foreground/45"
            }`}
            title={cited ? "Cited in the answer" : undefined}
          >
            {source.ref.slice(1)}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <h4
            onClick={() => onRead?.(source)}
            className={`line-clamp-2 text-[13px] font-medium leading-snug ${
              onRead ? "cursor-pointer hover:underline decoration-brand-navy/30 underline-offset-2" : ""
            } ${dim ? "text-foreground/80" : "text-brand-navy"}`}
          >
            {source.citation}
          </h4>


          <div
            className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground/70"
            title={grade.tierHint}
          >
            <span className="truncate">
              {host || source.authority || source.source_type}
            </span>
            {source.effective_date && (
              <span className="tabular-nums">· {source.effective_date}</span>
            )}
            {grade.stale && <span>· verify</span>}
          </div>

          <div
            className={`mt-1 flex items-center gap-3 transition-opacity duration-200 ${
              selected
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
            }`}
          >
            {onRead && (
              <button
                type="button"
                onClick={() => onRead(source)}
                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 transition-colors hover:text-brand-orange"
              >
                <BookOpen className="h-2.5 w-2.5" />
                Read
              </button>
            )}
            {onPin && (
              <button
                type="button"
                onClick={() => onPin(source)}
                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 transition-colors hover:text-brand-orange"
              >
                <Pin className="h-2.5 w-2.5" />
                Pin
              </button>
            )}
            {source.source_url && !isInternalSource(source) && (
              <a
                href={source.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 transition-colors hover:text-brand-orange"
              >
                Open <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
            <AskAIPopover source={source} />
          </div>
        </div>

      </div>
    </motion.div>
  );
}


function AskAIPopover({ source }: { source: Source }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      setQ("");
      setAnswer("");
      setError(null);
      setBusy(false);
    } else {
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [open]);

  async function go() {
    if (!q.trim() || busy) return;
    setBusy(true);
    setAnswer("");
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await streamQuickAsk(
        { question: q.trim(), context: source.content || source.citation },
        (e) => {
          if (e.event === "delta") {
            const d = (e.data ?? {}) as { text?: string };
            if (d.text) setAnswer((a) => a + d.text);
          } else if (e.event === "error") {
            const d = (e.data ?? {}) as { message?: string };
            setError(d.message || "Something went wrong.");
          }
        },
        ac.signal,
      );
    } catch (err) {
      if (!ac.signal.aborted)
        setError((err as Error).message || "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 transition-colors hover:text-brand-orange"
        >
          <Sparkles className="h-2.5 w-2.5" />
          Ask AI
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="w-[340px] rounded-xl border-border bg-card p-0 shadow-[0_20px_50px_-18px_rgba(31,42,94,0.35)]"
      >
        <div className="border-b border-border px-3.5 py-2.5">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-orange">
            <Sparkles className="h-2.5 w-2.5" />
            Ask about this source
          </div>
          <div className="mt-0.5 truncate text-[12px] font-semibold text-brand-navy">
            {source.citation}
          </div>
        </div>
        <div className="px-3.5 py-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              go();
            }}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 transition-colors focus-within:border-primary/40"
          >
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ask a quick question…"
              className="flex-1 bg-transparent text-[12.5px] focus:outline-none"
              disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || !q.trim()}
              className="rounded-md bg-brand-navy px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:bg-brand-navy/90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Ask"}
            </button>
          </form>

          <AnimatePresence initial={false}>
            {(busy || answer || error) && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="wr-app-scroll mt-2.5 max-h-56 overflow-y-auto rounded-md bg-muted/40 px-3 py-2.5 text-[12.5px] leading-[1.55] text-foreground/90">
                  {error ? (
                    <span className="text-destructive">{error}</span>
                  ) : answer ? (
                    <span className="whitespace-pre-wrap">{answer}</span>
                  ) : (
                    <span className="wr-shimmer">Thinking…</span>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <p className="mt-2 text-[10px] text-muted-foreground/80">
            Grounded in this single source.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
