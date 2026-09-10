// Inline header actions for the platform Sheets (Save / Download XLSX /
// Connection). Same markup and classes as the Office web preview header,
// backed by the platform session instead of the Office API server.
import { useEffect, useRef, useState } from "react";

import { currentState, downloadSaved, saveNow, subscribe } from "./session";
import "./host.css";

type Status = {
  configured: boolean;
  researchConfigured?: boolean;
  message: string;
  testedAt?: string;
};

export function OfficeHeader({ inline = false }: { onLibrary?: () => void; inline?: boolean }) {
  const [, refresh] = useState(0);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const state = currentState();
  useEffect(() => subscribe(() => refresh((n) => n + 1)), []);
  useEffect(() => {
    const show = () => {
      setOpen(true);
      void window.desktopApi
        .swStatus()
        .then((s: Status) => setStatus(s))
        .catch((e: Error) => setError(e.message));
    };
    window.addEventListener("sw-open-connection", show);
    return () => window.removeEventListener("sw-open-connection", show);
  }, []);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await job();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <header className={inline ? "web-editor-header web-editor-inline" : "web-editor-header"}>
        {!inline && <strong>Sheets</strong>}
        {!inline && (
          <span title={state.document?.name}>{state.document?.name || "Opening workbook…"}</span>
        )}
        <small role="status" title={state.document?.name}>
          {state.readOnly
            ? "Read only"
            : state.dirty
              ? "Unsaved changes"
              : "Saved · revision " + (state.document?.version ?? "")}
        </small>
        <nav>
          <button
            disabled={busy || state.readOnly || !state.dirty}
            onClick={() => void run(saveNow)}
          >
            Save
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (state.dirty) await saveNow();
                await downloadSaved();
              })
            }
          >
            Download XLSX
          </button>
          <button onClick={() => window.dispatchEvent(new Event("sw-open-connection"))}>
            Connection
          </button>
        </nav>
      </header>
      {error && (
        <div
          className={inline ? "web-editor-error web-editor-error-float" : "web-editor-error"}
          role="alert"
        >
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      <dialog
        ref={dialog}
        className="web-connection-dialog"
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
      >
        <header>
          <h2>Writing connection</h2>
          <button aria-label="Close connection" onClick={() => setOpen(false)}>
            ×
          </button>
        </header>
        <p>{status?.message || "Reading connection status…"}</p>
        <p>
          Editing runs in your browser and the Seeger Weiss spreadsheet engine. Every save is a
          numbered revision in your Library. The assistant runs through the platform's approved
          model connection; no API key is used in this page.
        </p>
        <p>
          Web search is available to the assistant in Edit, Ask and Review. Assistant history is
          kept with this workbook, separate from Research.
        </p>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const s = (await window.desktopApi.swTestConnection()) as Status | undefined;
              if (s) setStatus(s);
            })
          }
        >
          {busy ? "Checking…" : "Check connection"}
        </button>
      </dialog>
    </>
  );
}
