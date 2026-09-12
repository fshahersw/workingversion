import { useState } from "react";
import { request } from "./client";
import { Button, Notice } from "./ui";
import type { SourceFile } from "./types";
type WorkspaceChoice = { itemId: string; name: string; docCount: number; status: string };
export function WorkspaceChoice({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const [items, setItems] = useState<WorkspaceChoice[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      setItems(await request<WorkspaceChoice[]>("view=sources"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="swf-field">
      <span>Saved document workspace</span>
      <div className="swf-inline">
        <select
          value={value}
          aria-label="Saved document workspace"
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => {
            if (!items.length && !loading) void load();
          }}
        >
          <option value="">Choose your workspace…</option>
          {value && !items.some((i) => i.itemId === value) && (
            <option value={value}>Selected workspace</option>
          )}
          {items.map((i) => (
            <option key={i.itemId} value={i.itemId}>
              {i.name} · {i.docCount} documents
            </option>
          ))}
        </select>
        <Button disabled={loading} onClick={() => void load()} icon="RefreshCw">
          Refresh
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
export function SourcePicker({
  onFiles,
  busy,
}: {
  onFiles: (files: SourceFile[]) => void;
  busy?: boolean;
}) {
  const [id, setId] = useState(""),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  return (
    <details className="swf-report-notes">
      <summary>Use saved platform documents</summary>
      <WorkspaceChoice value={id} onChange={setId} />
      <Button
        icon="FolderOpen"
        disabled={!id || loading || busy}
        onClick={async () => {
          setLoading(true);
          try {
            onFiles(await request<SourceFile[]>("view=source&id=" + encodeURIComponent(id)));
            setError("");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setLoading(false);
          }
        }}
      >
        {loading ? "Loading source pages…" : "Use these documents"}
      </Button>
      {error && <Notice tone="error">{error}</Notice>}
      <p>
        Imports the readable pages from your own saved workspace. New runs retain their own source
        snapshot.
      </p>
    </details>
  );
}
