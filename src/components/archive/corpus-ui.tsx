// ============================================================================
// Shared presentational pieces for the Legal Archive corpus pages. The archive
// returns its own JSON shapes; <Structured> renders any of them (arrays of flat
// objects -> tables, objects -> key/value lists, else JSON) without
// reinterpreting anything, mirroring archive.sources.tsx. Data fetching is left
// to the pages (react-query); this file is presentation only.
// ============================================================================
import type { ReactNode } from "react";

import { ARCHIVE_CAVEATS, type JsonValue } from "@/lib/archive/policy";
import type { CorpusResult } from "@/lib/archive/corpus-types";

type Scalar = string | number | boolean | null;

function isScalar(v: unknown): v is Scalar {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** One scalar, formatted for reading: external links, thousands separators, human dates, yes/no. Values are the archive's; only the presentation changes. */
function ScalarValue({ value }: { value: Scalar }) {
  if (value === null || value === "") return <span className="text-slate-400">—</span>;
  if (typeof value === "boolean")
    return <Badge tone={value ? "green" : "slate"}>{value ? "yes" : "no"}</Badge>;
  if (typeof value === "number")
    return (
      <span className="tabular-nums">
        {Number.isInteger(value) ? value.toLocaleString("en-US") : String(value)}
      </span>
    );
  const s = String(value);
  if (/^https?:\/\//i.test(s)) {
    const shown = s.replace(/^https?:\/\//, "");
    return (
      <a
        href={s}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-blue-700 underline decoration-blue-300 underline-offset-2 hover:text-blue-800"
      >
        {shown.slice(0, 64)}
        {shown.length > 64 ? "…" : ""}
      </a>
    );
  }
  if (ISO_DATE.test(s)) {
    // A date-only value ("2026-09-01") parses as UTC midnight; formatting it in
    // the browser's local zone shifts it a day earlier west of UTC. Format those
    // in UTC so the calendar date is preserved; keep local time for full timestamps.
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
    const d = new Date(s);
    if (!Number.isNaN(d.getTime()))
      return (
        <span className="tabular-nums" title={s}>
          {d.toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
            ...(dateOnly ? { timeZone: "UTC" } : {}),
          })}
        </span>
      );
  }
  return <span>{s}</span>;
}

/** Arrays of flat objects render as tables, objects as key/value lists, anything else as JSON. Shapes are the archive's; nothing is reinterpreted. */
export function Structured({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return <span className="text-slate-400">—</span>;
  if (isScalar(value)) return <ScalarValue value={value} />;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-slate-400">none</span>;
    if (
      value.every(
        (row) =>
          row &&
          typeof row === "object" &&
          !Array.isArray(row) &&
          Object.values(row as object).every(isScalar),
      )
    ) {
      const columns = [...new Set(value.flatMap((row) => Object.keys(row as object)))].slice(0, 14);
      return (
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <table className="min-w-full text-[12.5px]">
            <thead className="bg-slate-50 text-left text-[10.5px] font-semibold uppercase tracking-[0.1em] text-slate-500">
              <tr>
                {columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-3 py-2">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {value.slice(0, 300).map((row, i) => (
                <tr key={i} className="odd:bg-white even:bg-slate-50/40">
                  {columns.map((c) => (
                    <td key={c} className="px-3 py-1.5 align-top text-slate-700">
                      {isScalar((row as Record<string, unknown>)[c]) ? (
                        <ScalarValue value={(row as Record<string, unknown>)[c] as Scalar} />
                      ) : (
                        ""
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {value.length > 300 && (
            <p className="px-3 py-2 text-[11px] text-slate-500">
              {value.length - 300} more rows not shown
            </p>
          )}
        </div>
      );
    }
    if (value.every(isScalar))
      return <span className="text-slate-700">{value.map(String).join(", ")}</span>;
    return (
      <pre className="max-h-96 overflow-auto rounded-md bg-slate-50 p-3 text-[11.5px] text-slate-700">
        {JSON.stringify(value, null, 1).slice(0, 12000)}
      </pre>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth > 1)
      return (
        <pre className="max-h-96 overflow-auto rounded-md bg-slate-50 p-3 text-[11.5px] text-slate-700">
          {JSON.stringify(value, null, 1).slice(0, 12000)}
        </pre>
      );
    return (
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {entries.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-slate-500">
              {k}
            </dt>
            <dd className="mt-0.5 text-[13px] text-slate-800">
              <Structured value={v} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
}

export function Badge({
  tone = "slate",
  children,
}: {
  tone?: "slate" | "green" | "red" | "amber" | "blue";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    slate: "border-slate-200 bg-slate-50 text-slate-600",
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    red: "border-red-200 bg-red-50 text-red-700",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    blue: "border-blue-200 bg-blue-50 text-blue-700",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** Eyebrow "Corpus" + title + description, with an optional actions slot on the right. */
export function CorpusHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="border-b border-slate-200 px-6 py-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Corpus
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-slate-600">{description}</p>
        </div>
        {children}
      </div>
    </header>
  );
}

export function TabBar<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-slate-200 px-6">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition ${active === t.id ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800"}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Banner({
  tone,
  children,
}: {
  tone: "amber" | "red" | "slate";
  children: ReactNode;
}) {
  const tones = {
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    red: "border-red-200 bg-red-50 text-red-700",
    slate: "border-slate-200 bg-slate-50 text-slate-600",
  };
  return <div className={`rounded-md border px-4 py-3 text-[13px] ${tones[tone]}`}>{children}</div>;
}

/** The archive is unconfigured / unreachable message, shared by every page. */
export function UnavailableNotice({
  configured,
  error,
}: {
  configured: boolean;
  error?: string | null;
}) {
  if (!configured) {
    return (
      <Banner tone="amber">
        The Legal Archive is not configured for this environment (LEGAL_ARCHIVE_URL and
        ARCHIVE_APP_KEY). Deploy the legal-archive stacks, then redeploy the platform with{" "}
        <code className="rounded bg-white/70 px-1">bun run deploy:testing --refresh-env</code>.
      </Banner>
    );
  }
  return (
    <Banner tone="red">
      Configured but unreachable{error ? `: ${error}` : ""}. The service may still be waiting for
      the first release pull.
    </Banner>
  );
}

/** Render a CorpusResult: loading skeleton, error, closed-layer notice, empty, or the structured data. */
export function ResultPanel({
  result,
  loading,
  error,
  emptyLabel = "No results.",
  render,
}: {
  result?: CorpusResult;
  loading?: boolean;
  error?: string | null;
  emptyLabel?: string;
  render?: (data: JsonValue) => ReactNode;
}) {
  if (loading)
    return <div className="h-24 animate-pulse rounded-md border border-slate-200 bg-slate-50" />;
  if (error) return <Banner tone="red">{error}</Banner>;
  if (!result) return <p className="text-[13px] text-slate-500">{emptyLabel}</p>;
  if (result.closed) {
    const reason =
      (result.data && typeof result.data === "object" && "reason" in result.data
        ? String((result.data as { reason?: unknown }).reason ?? "")
        : "") || "failed its hash or validation check";
    return (
      <Banner tone="amber">
        This data layer is closed ({reason}); it is reported as unavailable rather than worked
        around. {ARCHIVE_CAVEATS.closedLayer}
      </Banner>
    );
  }
  const empty = result.data === null || (Array.isArray(result.data) && result.data.length === 0);
  if (empty) return <p className="text-[13px] text-slate-500">{emptyLabel}</p>;
  return (
    <div className="rounded-md border border-slate-200 p-4">
      {render ? render(result.data) : <Structured value={result.data} />}
    </div>
  );
}

/** The archive's ground rules, shown once per page footer. */
export function Caveats() {
  return (
    <section>
      <h2 className="text-[13px] font-semibold text-slate-900">
        Ground rules carried into every answer
      </h2>
      <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-slate-600">
        {Object.values(ARCHIVE_CAVEATS).map((c) => (
          <li key={c} className="flex gap-2">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-400" />
            {c}
          </li>
        ))}
      </ul>
    </section>
  );
}
