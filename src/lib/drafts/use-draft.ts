import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { getDraftFn, saveDraftContentFn, updateDraftMetaFn } from "./drafts.functions";
import { exportDraftFn } from "./export.functions";
import { countWords, type DraftDetail, type DraftStyle, type JsonValue } from "./types";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "conflict" | "error";

const AUTOSAVE_MS = 1_500;

/**
 * Loads a draft, autosaves edits (debounced, versioned) and exposes title,
 * style and export actions. A version conflict (another tab saved) stops
 * autosave and asks the user to reload rather than overwriting their work.
 */
export function useDraft(draftId: string) {
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [wordCount, setWordCount] = useState(0);
  const [exporting, setExporting] = useState<"docx" | "pdf" | null>(null);

  const versionRef = useRef(0);
  const pendingRef = useRef<{ doc: JsonValue; text: string } | null>(null);
  // The content a refused save carried, kept so "Keep mine" can force it through.
  const conflictRef = useRef<{ doc: JsonValue; text: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const titleRef = useRef("");
  // flush and schedule refer to each other; the ref breaks the cycle.
  const scheduleRef = useRef<() => void>(() => {});
  // Bumped by every load so the editor remounts with the fresh document.
  const [loadCount, setLoadCount] = useState(0);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const loaded = await getDraftFn({ data: { draftId } });
      versionRef.current = loaded.version;
      titleRef.current = loaded.title;
      pendingRef.current = null;
      conflictRef.current = null;
      setDraft(loaded);
      setWordCount(loaded.content ? countWords(loaded.content.text) : loaded.wordCount);
      setSaveState("idle");
      setLoadCount((n) => n + 1);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not open this draft");
    }
  }, [draftId]);

  useEffect(() => {
    void load();
  }, [load]);

  const flush = useCallback(async () => {
    if (savingRef.current) return;
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    savingRef.current = true;
    setSaveState("saving");
    try {
      const result = await saveDraftContentFn({
        data: {
          draftId,
          expectedVersion: versionRef.current,
          content: { format: "tiptap", doc: pending.doc, text: pending.text },
          title: titleRef.current,
        },
      });
      versionRef.current = result.version;
      setDraft((d) =>
        d
          ? {
              ...d,
              version: result.version,
              wordCount: result.wordCount,
              updatedAt: result.updatedAt,
            }
          : d,
      );
      setSaveState(pendingRef.current ? "dirty" : "saved");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Save failed";
      if (/saved elsewhere|DraftVersionConflict/i.test(message)) {
        setSaveState("conflict");
        pendingRef.current = null;
        conflictRef.current = pending;
        toast.error(
          "This document was saved in another tab. Reload to take that version, or keep yours.",
        );
      } else {
        // Keep the edit queued so the next change retries.
        pendingRef.current = pendingRef.current ?? pending;
        setSaveState("error");
        toast.error(message);
      }
    } finally {
      savingRef.current = false;
      if (pendingRef.current && !timerRef.current) scheduleRef.current();
    }
  }, [draftId]);

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, AUTOSAVE_MS);
  }, [flush]);
  scheduleRef.current = schedule;

  /** Called by the editor on every change. */
  const onChange = useCallback(
    (doc: JsonValue, text: string) => {
      setWordCount(countWords(text));
      if (saveState === "conflict") return;
      pendingRef.current = { doc, text };
      setSaveState("dirty");
      schedule();
    },
    [saveState, schedule],
  );

  // Save on unmount / tab hide so a quick navigation never drops the last edit.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && pendingRef.current) void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (pendingRef.current) void flush();
    };
  }, [flush]);

  /** Conflict recovery: overwrite the other tab's save with this tab's content. */
  const keepMine = useCallback(async () => {
    const mine = conflictRef.current;
    if (!mine) return;
    setSaveState("saving");
    try {
      const result = await saveDraftContentFn({
        data: {
          draftId,
          expectedVersion: versionRef.current,
          content: { format: "tiptap", doc: mine.doc, text: mine.text },
          title: titleRef.current,
          force: true,
        },
      });
      versionRef.current = result.version;
      conflictRef.current = null;
      setDraft((d) =>
        d
          ? {
              ...d,
              version: result.version,
              wordCount: result.wordCount,
              updatedAt: result.updatedAt,
            }
          : d,
      );
      setSaveState("saved");
      toast.success("Kept this version");
    } catch (err) {
      setSaveState("conflict");
      toast.error(err instanceof Error ? err.message : "Could not save");
    }
  }, [draftId]);

  const setTitle = useCallback(
    async (title: string) => {
      titleRef.current = title;
      setDraft((d) => (d ? { ...d, title } : d));
      try {
        await updateDraftMetaFn({ data: { draftId, title } });
      } catch {
        /* the next content save carries the title too */
      }
    },
    [draftId],
  );

  const setStyle = useCallback(
    async (style: DraftStyle) => {
      setDraft((d) => (d ? { ...d, style } : d));
      try {
        await updateDraftMetaFn({ data: { draftId, style } });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not change the style");
      }
    },
    [draftId],
  );

  const exportAs = useCallback(
    async (format: "docx" | "pdf", markdown: string) => {
      if (!draft) return;
      if (!markdown.trim()) {
        toast.error("Nothing to export yet.");
        return;
      }
      setExporting(format);
      try {
        const result = await exportDraftFn({
          data: { format, title: draft.title, markdown, style: draft.style },
        });
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        downloadBase64(result.name, result.mime, result.dataB64);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Export failed");
      } finally {
        setExporting(null);
      }
    },
    [draft],
  );

  return {
    draft,
    loadError,
    saveState,
    wordCount,
    exporting,
    /** Changes on every (re)load; key the editor on it so it remounts with fresh content. */
    loadCount,
    reload: load,
    keepMine,
    onChange,
    setTitle,
    setStyle,
    exportAs,
    /** Force a save now (used before export so the file matches the page). */
    saveNow: flush,
  };
}

function downloadBase64(name: string, mime: string, dataB64: string): void {
  const bytes = Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
