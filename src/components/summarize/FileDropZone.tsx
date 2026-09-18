import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { UploadCloud } from "lucide-react";

import { collectDroppedFiles, hasFileDrag } from "@/lib/pile/drop-files";

/**
 * Whole-surface drop target for a Discovery tab. Wraps the tab's content and
 * accepts file drops anywhere over it, showing a labelled overlay while a file
 * drag is in progress. Behaviour the small intake strip alone could not give:
 *
 *  - drags that carry no files (text, links) never light it up;
 *  - moving over child elements does not flicker (enter/leave depth counter);
 *  - dropped folders are expanded;
 *  - while mounted, a file dropped anywhere else in the window is swallowed
 *    instead of navigating the tab away from the session (browser default).
 *
 * Inner drop targets that want to handle a drop themselves must call
 * `stopPropagation()` in their own onDrop.
 */
export function FileDropZone({
  onFiles,
  disabled = false,
  label,
  hint,
  className,
  children,
}: {
  onFiles: (files: File[]) => void;
  /** No overlay, no handling (drops fall through to the window guard). */
  disabled?: boolean;
  /** Overlay headline, e.g. "Drop to add to this working set". */
  label: string;
  /** Overlay second line, e.g. accepted formats. */
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  const reset = useCallback(() => {
    depth.current = 0;
    setActive(false);
  }, []);

  useEffect(() => {
    if (disabled) reset();
  }, [disabled, reset]);

  // Window guard: a file dropped outside the zone (sidebar, header) must not
  // replace the page with the file. Also clears a stuck overlay when the drag
  // ends outside the window.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (hasFileDrag(e.dataTransfer)) e.preventDefault();
    };
    const end = () => reset();
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    window.addEventListener("dragend", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
      window.removeEventListener("dragend", end);
      window.removeEventListener("blur", end);
    };
  }, [reset]);

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    depth.current += 1;
    if (!active) setActive(true);
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFileDrag(e.dataTransfer)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setActive(false);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    const dt = e.dataTransfer;
    reset();
    void collectDroppedFiles(dt).then((files) => {
      if (files.length) onFiles(files);
    });
  };

  // The intake strips inside the zone handle their own drops and stop
  // propagation, so the bubbling onDrop above never runs for them; a successful
  // drop fires no dragleave and OS file drags fire no dragend, which would leave
  // the overlay up. Capture phase runs before the child's handler: clear it here.
  const onDropCapture = (e: React.DragEvent<HTMLDivElement>) => {
    if (hasFileDrag(e.dataTransfer)) reset();
  };

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDropCapture={onDropCapture}
      onDrop={onDrop}
      className={["relative", className].filter(Boolean).join(" ")}
      data-drop-active={active ? "true" : undefined}
    >
      {children}
      {active ? (
        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-sm border-2 border-dashed border-brand-orange/70 bg-background/80 backdrop-blur-[2px]"
        >
          <div className="flex flex-col items-center gap-2 px-6 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-full border border-brand-orange/40 bg-brand-orange-soft/60 text-brand-orange">
              <UploadCloud className="h-5 w-5" />
            </span>
            <p className="text-[13.5px] font-semibold text-brand-navy">{label}</p>
            {hint ? <p className="text-[11.5px] text-muted-foreground">{hint}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
