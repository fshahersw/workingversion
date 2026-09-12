import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Notice } from "./ui";
import { MicButton } from "@/components/chat/MicButton";
type DirHandle = {
  name: string;
  values: () => AsyncIterable<{
    kind: string;
    name: string;
    getFile?: () => Promise<File>;
  }>;
};

export function VoiceInput({ onText }: { onText: (text: string) => void }) {
  return (
    <div className="swf-voice">
      <MicButton onTranscript={onText} />
      <small>Dictate with your platform’s transcription service, then review the text.</small>
    </div>
  );
}
export function FolderInput({
  onFiles,
  busy,
}: {
  onFiles: (files: File[]) => Promise<void>;
  busy: boolean;
}) {
  const [handle, setHandle] = useState<DirHandle>(),
    [watch, setWatch] = useState(false),
    [error, setError] = useState(""),
    [scanning, setScanning] = useState(false);
  const seen = useRef(new Map<string, string>()),
    ref = useRef<HTMLInputElement>(null),
    scanningRef = useRef(false),
    callback = useRef(onFiles);
  callback.current = onFiles;
  const scan = useCallback(
    async (dir: DirHandle, initial = false) => {
      if (scanningRef.current || busy) return;
      scanningRef.current = true;
      setScanning(true);
      try {
        const found: File[] = [];
        const signatures = new Map<string, string>();
        for await (const item of dir.values()) {
          if (
            item.kind !== "file" ||
            !item.getFile ||
            !/\.(pdf|docx|eml|txt|md|csv|tsv|json)$/i.test(item.name)
          )
            continue;
          const file = await item.getFile(),
            sig = String(file.lastModified) + ":" + file.size;
          signatures.set(item.name, sig);
          if (initial || seen.current.get(item.name) !== sig) found.push(file);
          if (found.length >= 20) break;
        }
        if (found.length) await callback.current(found);
        for (const [name, sig] of signatures) seen.current.set(name, sig);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Folder scan failed.");
        setWatch(false);
      } finally {
        scanningRef.current = false;
        setScanning(false);
      }
    },
    [busy],
  );
  useEffect(() => {
    if (!watch || !handle) return;
    const timer = setInterval(() => void scan(handle), 10000);
    return () => clearInterval(timer);
  }, [watch, handle, scan]);
  const choose = async () => {
    const picker = (
      window as unknown as {
        showDirectoryPicker?: (options: { mode: string }) => Promise<DirHandle>;
      }
    ).showDirectoryPicker;
    if (!picker) {
      ref.current?.click();
      return;
    }
    try {
      const dir = await picker({ mode: "read" });
      seen.current = new Map();
      setHandle(dir);
      setWatch(false);
      setError("");
      await scan(dir, true);
    } catch (e) {
      if ((e as Error).name !== "AbortError")
        setError("Directory access was unavailable. Use Add files instead.");
    }
  };
  return (
    <div className="swf-folder-intake">
      <div className="swf-inline">
        <Button icon="FolderOpen" onClick={() => void choose()} disabled={busy || scanning}>
          {scanning ? "Reading folder…" : "Choose folder"}
        </Button>
        {handle && (
          <label className="swf-inline">
            <input type="checkbox" checked={watch} onChange={(e) => setWatch(e.target.checked)} />
            Watch for new or changed files
          </label>
        )}
      </div>
      <input
        hidden
        ref={ref}
        type="file"
        multiple
        {...{ webkitdirectory: "" }}
        onChange={(e) => {
          if (e.target.files)
            void onFiles(Array.from(e.target.files).slice(0, 20)).catch((e) =>
              setError(e instanceof Error ? e.message : "Folder import failed."),
            );
          e.target.value = "";
        }}
      />
      <small>
        {handle ? handle.name + " · " : ""}Reads up to 20 supported files in the selected folder.
        Watching checks every 10 seconds while this app stays open.
      </small>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
