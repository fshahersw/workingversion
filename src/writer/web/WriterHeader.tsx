// Trailing header actions for the browser Writer (Save / Download DOCX /
// Export PDF / Connection). Same markup and classes as the Office web preview
// header, backed by the platform adapter instead of the Office API server.
import { useEffect, useState } from "react";

import {
  currentDocument,
  downloadCurrent,
  emitMenu,
  setDirty,
  subscribeState,
} from "../platform/adapter";
import type { WriterStatus } from "../shared/sw-policy";
import "./workspace.css";

export function WebWriterHeader({ fileName, modified }: { fileName?: string; modified: boolean }) {
  const [meta, setMeta] = useState(currentDocument);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<WriterStatus | null>(null);
  useEffect(() => subscribeState(() => setMeta(currentDocument())), []);
  useEffect(() => {
    setDirty(modified);
  }, [modified]);
  const refresh = async () => {
    try {
      setStatus(await window.desktop.writerStatus());
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "The connection status is unavailable.");
    }
  };
  useEffect(() => {
    const show = () => {
      setOpen(true);
      void refresh();
    };
    window.addEventListener("sw-open-connection", show);
    return () => window.removeEventListener("sw-open-connection", show);
  }, []);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
  const download = async () => {
    setBusy(true);
    setMessage("");
    try {
      await downloadCurrent();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "The download failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="office-writer-header" role="group" aria-label="Document actions">
        <div className="office-file-heading">
          <small title={fileName || undefined}>
            {modified
              ? "Unsaved changes"
              : meta
                ? `Saved · revision ${meta.version}`
                : fileName
                  ? "Opening document…"
                  : "Opening document…"}
          </small>
        </div>
        <div className="office-actions">
          <button disabled={busy || !meta} onClick={() => emitMenu("save")}>
            Save
          </button>
          <button disabled={busy || !meta} onClick={() => void download()}>
            Download DOCX
          </button>
          <button disabled={busy || !meta} onClick={() => emitMenu("export-pdf")}>
            Export PDF
          </button>
          <button
            onClick={() => {
              setOpen(true);
              void refresh();
            }}
          >
            Connection
          </button>
        </div>
      </div>
      {message && !open && (
        <div className="office-inline-error office-writer-error" role="alert">
          {message}
          <button aria-label="Dismiss message" onClick={() => setMessage("")}>
            ×
          </button>
        </div>
      )}
      {open && (
        <div
          className="office-dialog-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <section
            className="office-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Writing connection"
          >
            <header>
              <h2>Writing connection</h2>
              <button autoFocus aria-label="Close connection" onClick={() => setOpen(false)}>
                ×
              </button>
            </header>
            <p>{message || status?.message || "Reading the connection status…"}</p>
            <p>
              Documents are saved to your Seeger Weiss Library as numbered revisions. The assistant
              runs through the platform's approved model connection; no API key is used in this
              browser.
            </p>
            <dl>
              <dt>Web search</dt>
              <dd>
                Available to the assistant in Edit, Ask and Review through the platform's curated
                search.
              </dd>
              <dt>Assistant history</dt>
              <dd>Kept with this document, separate from the Research workspace.</dd>
              <dt>Configuration</dt>
              <dd>Managed by the platform</dd>
            </dl>
            <footer>
              <button disabled={busy} onClick={() => void refresh()}>
                Refresh
              </button>
              <button
                disabled={busy || !status?.configured}
                onClick={async () => {
                  setBusy(true);
                  setMessage("");
                  try {
                    setStatus(await window.desktop.writerTestConnection());
                  } catch (e) {
                    setMessage(e instanceof Error ? e.message : "The test failed.");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Checking…" : "Check connection"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
