import { Link } from "@tanstack/react-router";
import { ExternalLink, Lock, MessageSquare, Scale, ShieldCheck, X } from "lucide-react";

import { shortDate, type TerminalRow } from "./useTerminalData";

export function ReaderPane({
  row,
  onClose,
  onTopic,
}: {
  row: TerminalRow;
  onClose: () => void;
  onTopic: (topic: string) => void;
}) {
  const intel = row.intel;
  const facts = [
    row.score !== null ? { k: "Signal", v: String(row.score) } : null,
    row.badge ? { k: "Category", v: row.badge } : null,
    row.source ? { k: "Source", v: row.source } : null,
    row.timestamp ? { k: "Published", v: shortDate(row.timestamp) } : null,
    intel?.rights ? { k: "Rights", v: intel.rights } : null,
    intel?.paywall && intel.paywall !== "none" ? { k: "Access", v: intel.paywall } : null,
  ].filter(Boolean) as { k: string; v: string }[];

  return (
    <article className="h-full min-h-0 overflow-y-auto bg-card">
      <div className="sticky top-0 z-10 flex h-[34px] items-center gap-2 border-b border-border/70 bg-card px-3">
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          Briefing
        </span>
        {row.url && (
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-brand-navy hover:underline"
          >
            Open source <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close briefing"
          className={`grid h-6 w-6 place-items-center rounded-[3px] text-muted-foreground hover:bg-muted hover:text-foreground ${row.url ? "" : "ml-auto"}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {row.kind === "media" && row.imageUrl && (
        <img src={row.imageUrl} alt={intel?.imageAlt ?? ""} loading="lazy" className="h-56 w-full object-cover" />
      )}

      <div className="mx-auto max-w-[760px] px-5 py-4">
        <div className="flex flex-wrap items-center gap-2 text-[9.5px] uppercase tracking-[0.07em] text-muted-foreground">
          {row.faviconUrl && <img src={row.faviconUrl} alt="" className="h-3 w-3 rounded-sm" />}
          {row.source && <b className="text-foreground/80">{row.source}</b>}
          {row.badge && <span className="text-brand-blue">{row.badge}</span>}
          {row.timestamp && <span className="normal-case tracking-normal">{shortDate(row.timestamp)}</span>}
        </div>

        <h2 className="mt-2 font-display text-[25px] leading-[1.13] tracking-[-0.02em] text-foreground">
          {row.title}
        </h2>

        {row.detail && (
          <p className="mt-2.5 text-[14px] leading-[1.5] text-foreground/80">{row.detail}</p>
        )}
        {row.bullets.length > 0 && (
          <ul className="mt-3 space-y-1.5 rounded-md border border-border/70 bg-muted/30 px-4 py-3">
            {row.bullets.map((b) => (
              <li
                key={b}
                className="relative pl-3.5 text-[12.5px] leading-[1.5] text-foreground/85 before:absolute before:left-0 before:top-[8px] before:h-[4px] before:w-[4px] before:rounded-full before:bg-brand-orange"
              >
                {b}
              </li>
            ))}
          </ul>
        )}

        {row.analysis && (
          <div className="mt-3 border-l-2 border-brand-orange/70 pl-3">
            <p className="text-[9.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
              Why it matters
            </p>
            <p className="mt-1 text-[12.5px] leading-[1.55] text-foreground/80">{row.analysis}</p>
          </div>
        )}

        {facts.length > 0 && (
          <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border/70 bg-border/70 sm:grid-cols-3">
            {facts.map((f) => (
              <div key={f.k} className="bg-card px-3 py-2">
                <span className="block text-[8px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  {f.k}
                </span>
                <b className="mt-0.5 flex items-center gap-1 text-[11.5px] font-semibold text-brand-navy">
                  {f.k === "Rights" && <ShieldCheck className="h-3 w-3" />}
                  {f.k === "Access" && <Lock className="h-3 w-3" />}
                  {f.v}
                </b>
              </div>
            ))}
          </div>
        )}

        {intel && intel.primarySources.length > 0 && (
          <Section title="Primary sources">
            <div className="grid gap-2 sm:grid-cols-2">
              {intel.primarySources.slice(0, 6).map((p) => (
                <a
                  key={p.url}
                  href={p.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 transition-colors hover:bg-brand-blue-soft"
                >
                  <b className="block text-[11.5px] font-semibold leading-snug text-brand-navy">
                    {p.title}
                  </b>
                  {p.domain && (
                    <span className="mt-0.5 block text-[9.5px] text-muted-foreground">{p.domain}</span>
                  )}
                </a>
              ))}
            </div>
          </Section>
        )}

        {row.meta.length > 0 && (
          <Section title="Related topics">
            <div className="flex flex-wrap gap-1.5">
              {row.meta.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => onTopic(t)}
                  className="rounded border border-border/70 bg-muted/40 px-2 py-0.5 text-[10.5px] text-muted-foreground hover:bg-brand-blue-soft hover:text-brand-navy"
                >
                  {t}
                </button>
              ))}
            </div>
          </Section>
        )}

        <Section title="Take it further">
          <div className="flex flex-wrap gap-2">
            {row.matterSlug && (
              <Link
                to="/matters/$slug"
                params={{ slug: row.matterSlug }}
                className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-card px-3 py-1.5 text-[11.5px] font-medium text-brand-navy hover:bg-brand-blue-soft"
              >
                <Scale className="h-3.5 w-3.5" /> {row.matterLabel ?? row.matterSlug}
              </Link>
            )}
            <Link
              to="/research"
              className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-card px-3 py-1.5 text-[11.5px] font-medium text-brand-navy hover:bg-brand-blue-soft"
            >
              <MessageSquare className="h-3.5 w-3.5" /> Ask the research agent
            </Link>
          </div>
        </Section>
      </div>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      <p className="mb-2 text-[9.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}
