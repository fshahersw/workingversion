import type { ReactNode } from "react";

import {
  asObject,
  booleanValue,
  firstNumber,
  firstText,
  numberValue,
  objectArray,
  rowsAt,
  textValue,
  type JsonObject,
} from "@/lib/archive/corpus-shapes";
import { provenanceOf, type JsonValue } from "@/lib/archive/policy";

import { Badge, Structured } from "./corpus-ui";

function formatNumber(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(textValue).filter((item): item is string => item !== null);
}

function displayDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  // Date-only strings ("2026-09-01") are UTC midnight; format them in UTC so the
  // calendar day is not shifted back in western time zones. Full timestamps stay local.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(dateOnly ? { timeZone: "UTC" } : {}),
  });
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">{label}</p>
      <div className="mt-0.5 text-[14px] font-semibold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.09em] text-slate-500">
        {label}
      </dt>
      <dd className="mt-0.5 text-[12.5px] leading-relaxed text-slate-800">{value}</dd>
    </div>
  );
}

function SourceLink({ url }: { url: string | null }) {
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return <span className="break-all">{url}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all text-blue-700 underline decoration-blue-300 underline-offset-2 hover:text-blue-800"
    >
      official source
    </a>
  );
}

function Qualification({ value }: { value: unknown }) {
  const qualification = textValue(value);
  if (!qualification) return null;
  return (
    <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900">
      {qualification}
    </p>
  );
}

function Provenance({
  record,
  date,
  dateLabel = "Captured",
}: {
  record: JsonObject;
  date?: string | null;
  dateLabel?: string;
}) {
  const provenance = provenanceOf(record);
  const shownDate = provenance.capturedAt ?? date ?? null;
  if (
    !provenance.recordId &&
    !provenance.layer &&
    !provenance.sourceUrl &&
    !shownDate &&
    !provenance.qualification
  ) {
    return null;
  }
  return (
    <div className="mt-3 border-t border-slate-100 pt-2 text-[11.5px] leading-relaxed text-slate-500">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {provenance.recordId ? <span>Record: {provenance.recordId}</span> : null}
        {provenance.layer ? <span>Layer: {provenance.layer}</span> : null}
        {shownDate ? (
          <span>
            {provenance.capturedAt ? "Captured" : dateLabel}: {displayDate(shownDate)}
          </span>
        ) : null}
        {provenance.sourceUrl ? <SourceLink url={provenance.sourceUrl} /> : null}
      </div>
      {provenance.qualification ? (
        <p className="mt-1 text-slate-600">{provenance.qualification}</p>
      ) : null}
    </div>
  );
}

function EmptyRows({ value }: { value: JsonValue }) {
  return (
    <div>
      <p className="mb-3 text-[12.5px] text-slate-500">
        The response did not match the expected live list shape. Showing the archive response.
      </p>
      <Structured value={value} />
    </div>
  );
}

function SummaryStats({ children }: { children: ReactNode }) {
  return <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

export function ExploreResults({ value }: { value: JsonValue }) {
  const root = asObject(value);
  if (!root) return <EmptyRows value={value} />;
  const totals = asObject(root["totals"]);
  const datasets = objectArray(root["datasets"]);
  if (!totals && datasets.length === 0) return <EmptyRows value={value} />;
  return (
    <div className="space-y-4">
      {totals ? (
        <SummaryStats>
          <Stat label="Saved records" value={formatNumber(firstNumber(totals, "total"))} />
          <Stat
            label="Publisher records"
            value={formatNumber(firstNumber(totals, "bulk_records"))}
          />
          <Stat
            label="Local documents"
            value={formatNumber(firstNumber(totals, "local_documents"))}
          />
          <Stat
            label="Source observations"
            value={formatNumber(firstNumber(totals, "local_source_observations"))}
          />
        </SummaryStats>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {datasets.map((dataset) => (
          <article
            key={firstText(dataset, "id") ?? JSON.stringify(dataset)}
            className="rounded-md border border-slate-200 p-3"
          >
            <h3 className="text-[13.5px] font-semibold text-slate-900">
              {firstText(dataset, "label", "id") ?? "Collection"}
            </h3>
            <p className="mt-1 text-[12px] text-slate-600">
              {firstText(dataset, "snapshot_label", "source_as_of_label") ??
                "Saved archive collection"}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone="blue">{formatNumber(firstNumber(dataset, "total"))} records</Badge>
              {firstText(dataset, "snapshot_date") ? (
                <Badge>{displayDate(firstText(dataset, "snapshot_date"))}</Badge>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      <Qualification value={root["count_basis"]} />
      {Array.isArray(root["limitations"]) ? (
        <ul className="list-disc space-y-1 pl-5 text-[12px] text-slate-600">
          {stringList(root["limitations"]).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function SearchResults({ value }: { value: JsonValue }) {
  const root = asObject(value);
  const rows = rowsAt(value, "results", "items");
  if (!root || rows.length === 0) return rows.length === 0 ? <EmptyRows value={value} /> : null;
  return (
    <div className="space-y-4">
      <SummaryStats>
        <Stat label="Matches" value={formatNumber(firstNumber(root, "total"))} />
        <Stat label="Returned" value={formatNumber(firstNumber(root, "returned") ?? rows.length)} />
        <Stat label="Page" value={formatNumber(firstNumber(root, "page") ?? 1)} />
        <Stat
          label="Elapsed"
          value={
            firstNumber(root, "elapsed_ms") === null
              ? "—"
              : `${formatNumber(firstNumber(root, "elapsed_ms"))} ms`
          }
        />
      </SummaryStats>
      <div className="space-y-3">
        {rows.map((row, index) => {
          const title = firstText(row, "title", "heading", "name") ?? `Result ${index + 1}`;
          const passage = firstText(row, "passage", "snippet", "description");
          return (
            <article
              key={firstText(row, "id") ?? `${title}-${index}`}
              className="rounded-md border border-slate-200 p-3"
            >
              <h3 className="text-[13.5px] font-semibold leading-snug text-slate-900">{title}</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {firstText(row, "collection_title", "category_label", "collection", "dataset") ? (
                  <Badge tone="blue">
                    {firstText(row, "collection_title", "category_label", "collection", "dataset")}
                  </Badge>
                ) : null}
                {firstText(row, "jurisdiction", "state", "county") ? (
                  <Badge>{firstText(row, "jurisdiction", "state", "county")}</Badge>
                ) : null}
                {firstText(row, "citation") ? <Badge>{firstText(row, "citation")}</Badge> : null}
                {firstText(row, "availability", "kind", "record_type") ? (
                  <Badge
                    tone={firstText(row, "availability") === "metadata_only" ? "amber" : "slate"}
                  >
                    {firstText(row, "availability", "kind", "record_type")}
                  </Badge>
                ) : null}
              </div>
              {passage ? (
                <p className="mt-2 text-[12.5px] leading-relaxed text-slate-700">{passage}</p>
              ) : null}
              <Provenance record={row} />
            </article>
          );
        })}
      </div>
      <Qualification value={root["qualification"]} />
    </div>
  );
}

export function MdlResults({ value }: { value: JsonValue }) {
  const root = asObject(value);
  const rows = rowsAt(value, "results");
  if (!root || rows.length === 0) return <EmptyRows value={value} />;
  const asOf = firstText(root, "as_of");
  return (
    <div className="space-y-4">
      <SummaryStats>
        <Stat label="MDLs" value={formatNumber(firstNumber(root, "total"))} />
        <Stat label="Report date" value={displayDate(asOf) ?? "—"} />
        <Stat label="Page" value={formatNumber(firstNumber(root, "page") ?? 1)} />
        <Stat label="Pages" value={formatNumber(firstNumber(root, "pages"))} />
      </SummaryStats>
      {firstText(root, "counts_label") ? (
        <p className="text-[12px] text-slate-600">{firstText(root, "counts_label")}</p>
      ) : null}
      <div className="space-y-3">
        {rows.map((row, index) => {
          const number = firstNumber(row, "mdl_number");
          const title = firstText(row, "title") ?? `MDL ${number ?? index + 1}`;
          return (
            <article
              key={firstText(row, "id") ?? `${number}-${index}`}
              className="rounded-md border border-slate-200 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="max-w-4xl text-[13.5px] font-semibold leading-snug text-slate-900">
                  {title}
                </h3>
                <div className="flex gap-1.5">
                  {number !== null ? <Badge tone="blue">MDL {number}</Badge> : null}
                  {firstText(row, "status") ? (
                    <Badge tone="green">{firstText(row, "status")}</Badge>
                  ) : null}
                </div>
              </div>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Court" value={firstText(row, "court_name", "district_code")} />
                <Field label="Circuit" value={firstText(row, "circuit")} />
                <Field label="Transferee judge" value={firstText(row, "judge_name_as_printed")} />
                <Field label="Type" value={firstText(row, "litigation_type")} />
                <Field
                  label="Pending actions"
                  value={formatNumber(firstNumber(row, "actions_pending"))}
                />
                <Field
                  label="Total actions"
                  value={formatNumber(firstNumber(row, "total_actions"))}
                />
                <Field label="Master docket" value={firstText(row, "master_docket")} />
                <Field
                  label="Transferred"
                  value={displayDate(firstText(row, "date_transferred"))}
                />
              </dl>
              <Provenance record={row} date={asOf} dateLabel="JPML report" />
            </article>
          );
        })}
      </div>
      <Qualification value={root["qualification"]} />
    </div>
  );
}

export function JudgeResults({ value }: { value: JsonValue }) {
  const root = asObject(value);
  const rows = rowsAt(value, "items");
  if (!root || rows.length === 0) return <EmptyRows value={value} />;
  return (
    <div className="space-y-4">
      <SummaryStats>
        <Stat label="Judges" value={formatNumber(firstNumber(root, "total"))} />
        <Stat label="Page" value={formatNumber(firstNumber(root, "page") ?? 1)} />
        <Stat label="Returned" value={formatNumber(rows.length)} />
        <Stat label="Page size" value={formatNumber(firstNumber(root, "limit"))} />
      </SummaryStats>
      <div className="grid gap-3 xl:grid-cols-2">
        {rows.map((row, index) => {
          const name =
            firstText(row, "name", "profile_heading_as_published") ?? `Judge ${index + 1}`;
          const courts = stringList(row["courts"]);
          return (
            <article
              key={firstText(row, "id") ?? `${name}-${index}`}
              className="rounded-md border border-slate-200 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="text-[13.5px] font-semibold text-slate-900">{name}</h3>
                <div className="flex gap-1.5">
                  {firstText(row, "system") ? (
                    <Badge tone="blue">{firstText(row, "system")}</Badge>
                  ) : null}
                  {booleanValue(row["current_service_verified"]) === true ? (
                    <Badge tone="green">current service verified</Badge>
                  ) : null}
                </div>
              </div>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Native id" value={firstText(row, "id")} />
                <Field label="Role" value={firstText(row, "role")} />
                <Field label="Court" value={courts.join(", ")} />
                <Field label="Location" value={firstText(row, "location", "state")} />
                <Field label="Published term" value={firstText(row, "term_as_published")} />
                <Field
                  label="Profile detail"
                  value={booleanValue(row["has_details"]) ? "available" : "not saved"}
                />
              </dl>
              <Provenance record={row} />
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function CourtResults({ value }: { value: JsonValue }) {
  const root = asObject(value);
  const rows = rowsAt(value, "results");
  if (!root || rows.length === 0) return <EmptyRows value={value} />;
  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-slate-600">
        {firstText(root, "basis", "note") ?? "Saved court matches"}
      </p>
      <div className="space-y-3">
        {rows.map((row, index) => {
          const title =
            firstText(row, "name", "court_name", "label", "title", "full_name") ??
            `Court match ${index + 1}`;
          return (
            <article
              key={firstText(row, "id", "court_id") ?? `${title}-${index}`}
              className="rounded-md border border-slate-200 p-3"
            >
              <h3 className="text-[13.5px] font-semibold text-slate-900">{title}</h3>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Court id" value={firstText(row, "id", "court_id")} />
                <Field label="Abbreviation" value={firstText(row, "abbreviation", "abbr")} />
                <Field label="Jurisdiction" value={firstText(row, "state", "jurisdiction")} />
                <Field label="Level" value={firstText(row, "level", "type")} />
              </dl>
              <Provenance record={row} />
            </article>
          );
        })}
      </div>
      <Qualification value={root["note"]} />
    </div>
  );
}

export function CfrResults({ value }: { value: JsonValue }) {
  const root = asObject(value);
  const rows = rowsAt(value, "titles", "results");
  if (!root || rows.length === 0) return <EmptyRows value={value} />;
  const isTitles = Array.isArray(root["titles"]);
  return (
    <div className="space-y-4">
      <SummaryStats>
        <Stat
          label={isTitles ? "CFR titles" : "Matches"}
          value={formatNumber(firstNumber(root, "total") ?? rows.length)}
        />
        <Stat label="Page" value={formatNumber(firstNumber(root, "page") ?? 1)} />
        <Stat label="Pages" value={formatNumber(firstNumber(root, "pages") ?? 1)} />
        <Stat label="Returned" value={formatNumber(rows.length)} />
      </SummaryStats>
      <div className="grid gap-3 xl:grid-cols-2">
        {rows.map((row, index) => {
          const titleNumber = firstText(row, "title");
          const citation = firstText(row, "citation");
          const heading =
            firstText(row, "name", "heading") ?? citation ?? `CFR result ${index + 1}`;
          const sourceUrl = firstText(row, "gpo_xml_source_url", "ecfr_url");
          return (
            <article
              key={firstText(row, "id") ?? `${heading}-${index}`}
              className="rounded-md border border-slate-200 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="text-[13.5px] font-semibold text-slate-900">
                  {isTitles && titleNumber ? `Title ${titleNumber} — ` : ""}
                  {heading}
                </h3>
                <div className="flex gap-1.5">
                  {firstText(row, "record_type") ? (
                    <Badge tone="blue">{firstText(row, "record_type")}</Badge>
                  ) : null}
                  {booleanValue(row["official_text_local"]) === true ? (
                    <Badge tone="green">official text saved</Badge>
                  ) : null}
                </div>
              </div>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Citation" value={citation} />
                <Field label="Part" value={firstText(row, "part")} />
                <Field label="Section" value={firstText(row, "section")} />
                <Field
                  label="Parts in slice"
                  value={formatNumber(firstNumber(row, "parts_in_slice"))}
                />
                <Field label="Parts total" value={formatNumber(firstNumber(row, "parts_total"))} />
                <Field
                  label="Sections in slice"
                  value={formatNumber(firstNumber(row, "sections_in_slice"))}
                />
                <Field
                  label="Latest amendment"
                  value={displayDate(firstText(row, "latest_amendment_date"))}
                />
                <Field
                  label="eCFR received"
                  value={displayDate(firstText(row, "ecfr_received_on"))}
                />
                <Field label="Source" value={<SourceLink url={sourceUrl} />} />
              </dl>
              <Provenance
                record={row}
                date={firstText(row, "ecfr_received_on")}
                dateLabel="eCFR received"
              />
            </article>
          );
        })}
      </div>
      <Qualification value={asObject(root["publisher_index"])?.["basis"]} />
    </div>
  );
}

export function LawOutlineResults({ value }: { value: JsonValue }) {
  const root = asObject(value);
  const rows = root ? objectArray(root["collections"]) : [];
  if (!root || rows.length === 0) return <EmptyRows value={value} />;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[15px] font-semibold text-slate-900">
          {firstText(root, "state") ?? "Federal law outline"}
        </h3>
        {firstText(root, "usps") ? (
          <p className="mt-1 text-[12px] text-slate-500">Jurisdiction: {firstText(root, "usps")}</p>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row, index) => (
          <article
            key={firstText(row, "kind") ?? String(index)}
            className="rounded-md border border-slate-200 p-3"
          >
            <h4 className="text-[13px] font-semibold text-slate-900">
              {firstText(row, "label", "kind") ?? "Collection"}
            </h4>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Stat label="Provisions" value={formatNumber(firstNumber(row, "provisions"))} />
              <Stat label="Headings" value={formatNumber(firstNumber(row, "headings"))} />
            </div>
          </article>
        ))}
      </div>
      <Qualification value={root["qualification"]} />
      {asObject(root["statute_audit"]) ? (
        <details className="rounded-md border border-slate-200 px-3 py-2">
          <summary className="cursor-pointer text-[12.5px] font-medium text-slate-700">
            Publisher statute audit
          </summary>
          <div className="mt-3">
            <Structured value={root["statute_audit"]} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

export function AgencyResults({ value }: { value: JsonValue }) {
  const root = asObject(value);
  const rows = Array.isArray(value) ? objectArray(value) : rowsAt(value, "results");
  if (rows.length === 0) return <EmptyRows value={value} />;
  return (
    <div className="space-y-4">
      {root ? (
        <SummaryStats>
          <Stat label="Matches" value={formatNumber(firstNumber(root, "total") ?? rows.length)} />
          <Stat label="Page" value={formatNumber(firstNumber(root, "page") ?? 1)} />
          <Stat label="Pages" value={formatNumber(firstNumber(root, "pages") ?? 1)} />
          <Stat label="Returned" value={formatNumber(rows.length)} />
        </SummaryStats>
      ) : null}
      <div className="grid gap-3 xl:grid-cols-2">
        {rows.map((row, index) => {
          const counts = asObject(row["counts"]);
          const latestRule = asObject(row["latest_rule"]);
          const asOf = asObject(row["as_of"]);
          const title =
            firstText(row, "name", "title", "short_name", "firm") ?? `Agency result ${index + 1}`;
          return (
            <article
              key={firstText(row, "id", "key") ?? `${title}-${index}`}
              className="rounded-md border border-slate-200 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-[13.5px] font-semibold text-slate-900">{title}</h3>
                  {firstText(row, "parent") ? (
                    <p className="mt-0.5 text-[11.5px] text-slate-500">
                      {firstText(row, "parent")}
                    </p>
                  ) : null}
                </div>
                <div className="flex gap-1.5">
                  {firstText(row, "short_name", "dataset", "group") ? (
                    <Badge tone="blue">{firstText(row, "short_name", "dataset", "group")}</Badge>
                  ) : null}
                  {firstText(row, "status", "classification") ? (
                    <Badge>{firstText(row, "status", "classification")}</Badge>
                  ) : null}
                </div>
              </div>
              {firstText(row, "note", "snippet") ? (
                <p className="mt-2 text-[12.5px] leading-relaxed text-slate-700">
                  {firstText(row, "note", "snippet")}
                </p>
              ) : null}
              <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Firm" value={firstText(row, "firm")} />
                <Field label="State" value={firstText(row, "state", "country")} />
                <Field
                  label="Published"
                  value={displayDate(firstText(row, "published_at", "sort_date"))}
                />
                <Field
                  label="Federal Register records"
                  value={formatNumber(
                    counts ? firstNumber(counts, "federal_register_documents") : null,
                  )}
                />
                <Field
                  label="CFR parts cited"
                  value={formatNumber(counts ? firstNumber(counts, "cfr_parts_cited") : null)}
                />
                <Field
                  label="Safety records"
                  value={formatNumber(counts ? firstNumber(counts, "safety_records") : null)}
                />
                <Field
                  label="Latest rule"
                  value={latestRule ? firstText(latestRule, "title", "citation") : null}
                />
                <Field
                  label="Latest rule date"
                  value={latestRule ? displayDate(firstText(latestRule, "date")) : null}
                />
                <Field
                  label="Sources as of"
                  value={
                    asOf
                      ? displayDate(firstText(asOf, "documents", "regulations", "federal_register"))
                      : null
                  }
                />
              </dl>
              <Provenance
                record={row}
                date={firstText(row, "published_at", "sort_date")}
                dateLabel="Published"
              />
            </article>
          );
        })}
      </div>
      <Qualification value={root?.["qualification"]} />
    </div>
  );
}

export function StateCoverageResults({ value }: { value: JsonValue }) {
  const root = asObject(value);
  if (!root) return <EmptyRows value={value} />;
  const jurisdictions = objectArray(root["jurisdictions"]);
  if (jurisdictions.length > 0) {
    const totals = asObject(root["totals"]);
    return (
      <div className="space-y-4">
        <SummaryStats>
          <Stat label="Jurisdictions mapped" value={formatNumber(jurisdictions.length)} />
          <Stat
            label="Saved records"
            value={formatNumber(totals ? firstNumber(totals, "total") : null)}
          />
          <Stat
            label="Local documents"
            value={formatNumber(totals ? firstNumber(totals, "local_documents") : null)}
          />
          <Stat
            label="Publisher records"
            value={formatNumber(totals ? firstNumber(totals, "bulk_records") : null)}
          />
        </SummaryStats>
        <Qualification value={root["count_basis"]} />
      </div>
    );
  }

  const families = asObject(root["families"]);
  if (!families) return <EmptyRows value={value} />;
  const county = asObject(root["county_layer"]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-slate-900">
          {firstText(root, "name") ?? "State coverage"}
        </h3>
        {firstText(root, "abbr") ? <Badge tone="blue">{firstText(root, "abbr")}</Badge> : null}
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Object.entries(families).map(([key, value]) => {
          const family = asObject(value);
          const official = family ? asObject(family["official_capture"]) : null;
          return (
            <article key={key} className="rounded-md border border-slate-200 p-3">
              <h4 className="text-[12.5px] font-semibold capitalize text-slate-900">
                {key.replaceAll("_", " ")}
              </h4>
              <dl className="mt-2 grid gap-2">
                <Field
                  label="Official captures"
                  value={formatNumber(official ? firstNumber(official, "total") : null)}
                />
                <Field
                  label="Imported collection"
                  value={formatNumber(family ? firstNumber(family, "imported_collection") : null)}
                />
                <Field
                  label="Third-party snapshot"
                  value={formatNumber(family ? firstNumber(family, "third_party_snapshot") : null)}
                />
                <Field
                  label="Pending publication"
                  value={formatNumber(family ? firstNumber(family, "pending_publication") : null)}
                />
              </dl>
            </article>
          );
        })}
      </div>
      {county ? (
        <SummaryStats>
          <Stat label="Counties" value={formatNumber(firstNumber(county, "counties_total"))} />
          <Stat
            label="Saved profiles"
            value={formatNumber(firstNumber(county, "with_saved_trellis_profile"))}
          />
          <Stat
            label="Saved county pages"
            value={formatNumber(firstNumber(county, "with_saved_site_page"))}
          />
          <Stat
            label="Local resources"
            value={formatNumber(firstNumber(county, "with_local_resource"))}
          />
        </SummaryStats>
      ) : null}
      {stringList(root["gaps"]).length > 0 ? (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500">
            Saved-data gaps
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {stringList(root["gaps"]).map((gap) => (
              <Badge key={gap} tone="amber">
                {gap.replaceAll("_", " ")}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
      <Qualification value={root["qualification"]} />
    </div>
  );
}

export function CountyResults({ value }: { value: JsonValue }) {
  const root = asObject(value);
  const rows = rowsAt(value, "items");
  if (!root || rows.length === 0) return <EmptyRows value={value} />;
  return (
    <div className="space-y-4">
      <SummaryStats>
        <Stat label="Counties" value={formatNumber(firstNumber(root, "total"))} />
        <Stat label="Returned" value={formatNumber(rows.length)} />
        <Stat label="Page" value={formatNumber(firstNumber(root, "page") ?? 1)} />
        <Stat label="Page size" value={formatNumber(firstNumber(root, "limit"))} />
      </SummaryStats>
      <div className="grid gap-3 xl:grid-cols-2">
        {rows.map((row, index) => {
          const name = firstText(row, "name") ?? `County ${index + 1}`;
          return (
            <article
              key={firstText(row, "geoid") ?? `${name}-${index}`}
              className="rounded-md border border-slate-200 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="text-[13.5px] font-semibold text-slate-900">{name}</h3>
                <div className="flex gap-1.5">
                  {firstText(row, "geoid") ? (
                    <Badge tone="blue">FIPS {firstText(row, "geoid")}</Badge>
                  ) : null}
                  {booleanValue(row["complete"]) === true ? (
                    <Badge tone="green">complete</Badge>
                  ) : (
                    <Badge tone="amber">partial</Badge>
                  )}
                </div>
              </div>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="State" value={firstText(row, "state")} />
                <Field label="Profile status" value={firstText(row, "profile_status")} />
                <Field label="Website evidence" value={firstText(row, "website_evidence_status")} />
                <Field
                  label="Saved profiles"
                  value={formatNumber(firstNumber(row, "saved_profiles"))}
                />
                <Field label="Saved sites" value={formatNumber(firstNumber(row, "saved_sites"))} />
                <Field
                  label="Local resources"
                  value={formatNumber(firstNumber(row, "local_resources"))}
                />
                <Field
                  label="Litigation resources"
                  value={formatNumber(firstNumber(row, "litigation_resources"))}
                />
                <Field
                  label="Published resources"
                  value={formatNumber(firstNumber(row, "published_local_resources"))}
                />
                <Field
                  label="Court registry"
                  value={booleanValue(row["has_court_registry"]) ? "saved" : "not saved"}
                />
              </dl>
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function CountyLitigationResults({ value }: { value: JsonValue }) {
  const root = asObject(value);
  const rows = rowsAt(value, "items");
  if (!root || rows.length === 0) return <EmptyRows value={value} />;
  return (
    <div className="space-y-4">
      <SummaryStats>
        <Stat label="Resources" value={formatNumber(firstNumber(root, "total"))} />
        <Stat label="Returned" value={formatNumber(rows.length)} />
        <Stat label="Page" value={formatNumber(firstNumber(root, "page") ?? 1)} />
        <Stat label="Validated" value={displayDate(firstText(root, "validated_at")) ?? "—"} />
      </SummaryStats>
      <div className="space-y-3">
        {rows.map((row, index) => {
          const title = firstText(row, "title") ?? `County resource ${index + 1}`;
          return (
            <article
              key={firstText(row, "id") ?? `${title}-${index}`}
              className="rounded-md border border-slate-200 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="max-w-4xl text-[13.5px] font-semibold text-slate-900">{title}</h3>
                <div className="flex gap-1.5">
                  {firstText(row, "resource_type_label", "kind") ? (
                    <Badge tone="blue">{firstText(row, "resource_type_label", "kind")}</Badge>
                  ) : null}
                  {firstText(row, "availability") ? (
                    <Badge tone="green">{firstText(row, "availability")}</Badge>
                  ) : null}
                </div>
              </div>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="County" value={firstText(row, "county")} />
                <Field label="State" value={firstText(row, "state")} />
                <Field label="Legal status" value={firstText(row, "legal_status")} />
                <Field label="Source" value={<SourceLink url={firstText(row, "source_url")} />} />
              </dl>
              <Provenance record={row} date={firstText(row, "saved_at")} dateLabel="Saved" />
            </article>
          );
        })}
      </div>
      <Qualification value={root["qualification"]} />
    </div>
  );
}
