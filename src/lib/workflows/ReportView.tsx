import { useEffect, useState } from "react";
import { downloadBlob, downloadReportDocument, reportDocumentBlob, saveToOffice } from "./files";
import { Badge, Button, Icon, Notice } from "./ui";
import { reportCsv } from "./recipes";
import type { AnalysisReport, Artifact, EvidenceRow } from "./types";
export function ReportView({ report }: { report: AnalysisReport; artifacts: Artifact[] }) {
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState<EvidenceRow>(),
    [reviewed, setReviewed] = useState<string[]>([]),
    [view, setView] = useState("table"),
    [error, setError] = useState("");
  const [officeUrl, setOfficeUrl] = useState(""),
    [savingOffice, setSavingOffice] = useState(false);
  const [statusFilter, setStatusFilter] = useState("All findings");
  const [page, setPage] = useState(0);
  const rows = report.rows.filter(
    (r) =>
      (statusFilter === "All findings" || r.status === statusFilter) &&
      JSON.stringify([r.cells, r.source, r.excerpt]).toLowerCase().includes(query.toLowerCase()),
  );
  useEffect(() => setPage(0), [query, statusFilter, report]);
  const shownRows = rows.slice(page * 50, (page + 1) * 50);
  useEffect(
    () => () => {
      window.speechSynthesis?.cancel();
    },
    [],
  );
  return (
    <div className="swf-report">
      <div className="swf-report-heading">
        <div>
          <Badge tone="green">Ready for review</Badge>
          <h2>{report.title}</h2>
          <p>{report.summary}</p>
        </div>
        <div className="swf-inline">
          <Button
            icon="Download"
            onClick={() =>
              downloadBlob(
                report.title + ".csv",
                new Blob([reportCsv(report)], { type: "text/csv" }),
              )
            }
          >
            CSV
          </Button>
          <Button
            icon="FileText"
            onClick={() =>
              void downloadReportDocument(report).catch((e) =>
                setError(e instanceof Error ? e.message : "Word export failed."),
              )
            }
          >
            Word
          </Button>
        </div>
      </div>
      <div className="swf-inline">
        <Button
          icon="FileText"
          disabled={savingOffice || !!officeUrl}
          onClick={async () => {
            setSavingOffice(true);
            try {
              setOfficeUrl(await saveToOffice(report.title, await reportDocumentBlob(report)));
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setSavingOffice(false);
            }
          }}
        >
          {savingOffice ? "Saving to Office…" : officeUrl ? "Saved to Office" : "Save to Office"}
        </Button>
        {officeUrl && (
          <a href={officeUrl} target="_blank" rel="noreferrer">
            Open in Word editor
          </a>
        )}
      </div>
      <div className="swf-report-toolbar">
        <div className="swf-inline">
          <button className={view === "table" ? "active" : ""} onClick={() => setView("table")}>
            Table
          </button>
          <button className={view === "draft" ? "active" : ""} onClick={() => setView("draft")}>
            Full report
          </button>
          <span>
            {reviewed.length} / {report.rows.length} reviewed
          </span>
        </div>
        <Button
          variant="ghost"
          icon="Volume2"
          onClick={() => {
            if (!window.speechSynthesis) {
              setError("Read aloud is unavailable.");
              return;
            }
            window.speechSynthesis.cancel();
            const voice = window.speechSynthesis
              .getVoices()
              .find((v) => v.localService && v.lang.startsWith("en"));
            if (!voice) {
              setError(
                "Install an English voice on this device to use read aloud. No report text was sent to an external voice service.",
              );
              return;
            }
            const utterance = new SpeechSynthesisUtterance(report.text);
            utterance.voice = voice;
            window.speechSynthesis.speak(utterance);
          }}
        >
          Read aloud
        </Button>
        <Button variant="ghost" icon="Square" onClick={() => window.speechSynthesis?.cancel()}>
          Stop
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {report.coverage && (
        <div className="swf-report-coverage">
          <span>
            <strong>{report.coverage.documents}</strong> sources
          </span>
          <span>{report.coverage.characters.toLocaleString()} characters inspected</span>
          <span>{report.coverage.totalRows} findings</span>
          {report.coverage.warnings.length > 0 && (
            <Badge tone="amber">{report.coverage.warnings.length} coverage notes</Badge>
          )}
        </div>
      )}
      {view === "table" ? (
        <>
          <div className="swf-report-filters">
            <div className="swf-search">
              <Icon name="Search" />
              <input
                aria-label="Filter results"
                placeholder="Filter findings…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <label>
              Show
              <select
                aria-label="Finding status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                {["All findings", "Review", "Missing", "Found", "Changed"].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="swf-evidence-table">
            <table>
              <thead>
                <tr>
                  <th>Reviewed</th>
                  {report.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {shownRows.map((r) => (
                  <tr key={r.id} className={reviewed.includes(r.id) ? "is-reviewed" : ""}>
                    <td>
                      <input
                        aria-label={"Mark item " + (report.rows.indexOf(r) + 1) + " reviewed"}
                        type="checkbox"
                        checked={reviewed.includes(r.id)}
                        onChange={(e) =>
                          setReviewed(
                            e.target.checked
                              ? [...reviewed, r.id]
                              : reviewed.filter((id) => id !== r.id),
                          )
                        }
                      />
                    </td>
                    {report.columns.map((c) => (
                      <td key={c}>{r.cells[c] || "Not found"}</td>
                    ))}
                    <td>
                      <button className="swf-source-link" onClick={() => setSelected(r)}>
                        <Icon name="FileText" size={13} />
                        {r.source}
                        <small>
                          {r.page ? `Page ${r.page} · ` : ""}
                          {r.line > 0
                            ? `Line ${r.line}${r.endLine && r.endLine !== r.line ? `–${r.endLine}` : ""}`
                            : "Document check"}{" "}
                          · {r.status}
                        </small>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && (
              <div className="swf-empty">
                <Icon name="Search" />
                <h3>No matching evidence</h3>
                <p>Try a different filter or supply more source material.</p>
              </div>
            )}
          </div>
          <div className="swf-report-pagination">
            <span>
              {rows.length
                ? `${page * 50 + 1}–${Math.min((page + 1) * 50, rows.length)} of ${rows.length}`
                : "0 findings"}
            </span>
            <Button variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button
              variant="ghost"
              disabled={(page + 1) * 50 >= rows.length}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </>
      ) : (
        <pre className="swf-report-draft">{report.text}</pre>
      )}
      {selected && (
        <aside className="swf-source-peek">
          <div className="swf-inline">
            <Icon name="FileText" />
            <strong>
              {selected.source}
              {selected.page ? ` · page ${selected.page}` : ""} ·{" "}
              {selected.line > 0
                ? `extracted line ${selected.line}${selected.endLine ? `–${selected.endLine}` : ""}`
                : "document-level check"}
            </strong>
            <Button variant="ghost" icon="X" onClick={() => setSelected(undefined)}>
              Close excerpt
            </Button>
          </div>
          <blockquote>
            {selected.excerpt ||
              "No matching source excerpt. This is a missing-information flag, not a quotation."}
          </blockquote>
          {selected.references?.map((ref, i) => (
            <div className="swf-supporting-source" key={i}>
              <strong>
                {ref.source}
                {ref.page ? ` · page ${ref.page}` : ""} · extracted line {ref.line}
              </strong>
              <blockquote>{ref.excerpt}</blockquote>
            </div>
          ))}
          <small>
            Exact extracted text. Page and line layout may differ from the original document.
          </small>
          {/^https:\/\/[^\s]+$/.test(selected.source) && (
            <p>
              <a href={selected.source} target="_blank" rel="noreferrer">
                Open original web source <Icon name="ExternalLink" size={13} />
              </a>
            </p>
          )}
        </aside>
      )}
      <details className="swf-report-notes">
        <summary>Scope & review notes</summary>
        {report.notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
      </details>
      <div className="swf-report-end">
        <span>Review marks stay in this view until you leave.</span>
        <Button
          variant="ghost"
          icon="Download"
          onClick={() =>
            downloadBlob(
              "Reviewed findings.json",
              new Blob(
                [
                  JSON.stringify(
                    { report, reviewed, exportedAt: new Date().toISOString() },
                    null,
                    2,
                  ),
                ],
                { type: "application/json" },
              ),
            )
          }
        >
          Export review record
        </Button>
      </div>
    </div>
  );
}
