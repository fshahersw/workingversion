import { useEffect, useRef } from "react";
import { Brain, ChevronRight } from "lucide-react";

/** The model's live adaptive-thinking reasoning. While active it streams into a
 *  muted, auto-scrolling panel (the frontier "thinking" feel) and fills the
 *  otherwise-silent synthesis gap; when done it collapses to a disclosure you can
 *  reopen. Distinct from ThinkingStream (the short per-step narration lines). This
 *  never contains the answer — that streams on its own channel. */
export function ReasoningStream({ text, active }: { text: string; active: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [text, active]);
  if (!text.trim()) return null;

  if (active) {
    return (
      <div className="mb-2.5 rounded-lg border border-brand-navy/15 bg-brand-blue-soft/20 px-2.5 py-1.5">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-brand-navy/70">
          <Brain className="h-3.5 w-3.5 animate-pulse text-brand-navy/60" strokeWidth={2} />
          Thinking
        </div>
        <div
          ref={boxRef}
          className="wr-app-scroll max-h-32 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/45"
        >
          {text}
        </div>
      </div>
    );
  }

  return (
    <details className="group mb-2.5 rounded-lg border border-border/60 bg-muted/20 transition-colors open:bg-muted/30">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground">
        <Brain className="h-3.5 w-3.5 text-brand-navy/50" strokeWidth={1.9} />
        Reasoning
        <ChevronRight className="ml-auto h-3.5 w-3.5 transition-transform group-open:rotate-90" strokeWidth={2} />
      </summary>
      <div className="wr-app-scroll ml-1 max-h-64 overflow-y-auto whitespace-pre-wrap px-2.5 pb-2.5 pr-3 text-[12px] leading-relaxed text-foreground/55">
        {text}
      </div>
    </details>
  );
}
