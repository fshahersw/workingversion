import { Link } from "@tanstack/react-router";

import type { CorpusSignal } from "@/lib/intel-types";
import { daysSince, shortDate } from "./useTerminalData";

function heat(iso: string | null): { label: string; className: string } {
  const d = daysSince(iso);
  if (d === null) return { label: "—", className: "text-muted-foreground" };
  if (d <= 14) return { label: "High", className: "text-destructive" };
  if (d <= 90) return { label: "Med", className: "text-brand-orange" };
  return { label: "Low", className: "text-muted-foreground" };
}

export function ContextRail({
  matters,
  filings,
  alerts,
}: {
  matters: CorpusSignal[];
  filings: CorpusSignal[];
  alerts: CorpusSignal[];
}) {
  return (
    <div className="h-full min-h-0 overflow-y-auto bg-muted/30">
      <Module title="Matter watch" count={`${matters.length}`}>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Matter</Th>
              <Th>Court</Th>
              <Th>Heat</Th>
            </tr>
          </thead>
          <tbody>
            {matters.slice(0, 10).map((m) => {
              const h = heat(m.timestamp);
              return (
                <tr key={m.id} className="border-t border-border/60 align-top">
                  <td className="px-2.5 py-2">
                    {m.matterSlug ? (
                      <Link
                        to="/matters/$slug"
                        params={{ slug: m.matterSlug }}
                        className="block text-[10.2px] font-semibold leading-snug text-brand-navy hover:underline"
                      >
                        {m.title}
                      </Link>
                    ) : (
                      <b className="block text-[10.2px] font-semibold text-brand-navy">{m.title}</b>
                    )}
                    {m.badge && <small className="text-[8px] text-muted-foreground">{m.badge}</small>}
                  </td>
                  <td className="px-2.5 py-2 text-[9.5px] text-muted-foreground">{m.detail}</td>
                  <td className={`px-2.5 py-2 text-[8px] font-bold ${h.className}`}>{h.label}</td>
                </tr>
              );
            })}
            {matters.length === 0 && (
              <tr>
                <td colSpan={3} className="px-2.5 py-3 text-[9.5px] text-muted-foreground">
                  No matters in the corpus yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Module>

      <Module title="Recent filings" count={`${filings.length}`}>
        {filings.slice(0, 10).map((f) => (
          <div key={f.id} className="border-b border-border/50 px-2.5 py-2 last:border-b-0">
            <b className="block text-[10.2px] font-semibold leading-[1.3] text-brand-navy line-clamp-2">
              {f.title}
            </b>
            <span className="mt-0.5 block text-[8.8px] text-muted-foreground">
              {[f.badge, f.detail, shortDate(f.timestamp)].filter(Boolean).join(" · ")}
            </span>
          </div>
        ))}
        {filings.length === 0 && (
          <p className="px-2.5 py-3 text-[9.5px] text-muted-foreground">No docket entries yet.</p>
        )}
      </Module>

      <Module title="Alerts" count={`${alerts.length}`}>
        {alerts.slice(0, 8).map((a) => (
          <div key={a.id} className="border-b border-border/50 px-2.5 py-2 last:border-b-0">
            <span className="block text-[8px] font-bold uppercase tracking-[0.06em] text-destructive">
              {a.badge ?? "alert"}
            </span>
            <b className="mt-0.5 block text-[10.2px] font-semibold text-brand-navy">{a.title}</b>
            {a.detail && (
              <small className="mt-0.5 block text-[9px] leading-snug text-muted-foreground">
                {a.detail}
              </small>
            )}
          </div>
        ))}
        {alerts.length === 0 && (
          <p className="px-2.5 py-3 text-[9.5px] text-muted-foreground">
            Every ingestion run is healthy.
          </p>
        )}
      </Module>
    </div>
  );
}

function Module({
  title,
  count,
  children,
}: {
  title: string;
  count: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border/70 bg-card">
      <header className="flex h-[34px] items-center justify-between border-b border-border/70 bg-muted/40 px-2.5">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.07em] text-brand-navy">
          {title}
        </h3>
        <span className="text-[9px] text-muted-foreground">{count}</span>
      </header>
      {children}
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="bg-card px-2.5 py-1.5 text-left text-[8px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
      {children}
    </th>
  );
}
