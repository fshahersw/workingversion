import { Loader2, ListChecks } from "lucide-react";

/** The live research narration. While active it shows ONLY the current step as a
 *  single evolving status line (not the whole accumulated trail); once done it
 *  collapses into a "Steps taken" disclosure with the full list. This never
 *  contains the answer — the final answer streams on a separate channel. */
export function ThinkingStream({ text, active }: { text: string; active: boolean }) {
  if (!text.trim()) return null;
  const steps = text.split("\n").map((l) => l.trim()).filter(Boolean);

  if (active) {
    const current = steps[steps.length - 1] ?? "";
    return (
      <div className="mb-3 flex items-center gap-2 rounded-xl border border-brand-orange/25 bg-gradient-to-b from-brand-orange-soft/25 to-transparent px-3 py-2">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-brand-orange" strokeWidth={2.2} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] leading-relaxed text-foreground/75">
          {current}
        </span>
      </div>
    );
  }

  return (
    <details className="group mb-3 rounded-xl border border-border/60 bg-muted/20 transition-colors open:bg-muted/30">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground">
        <ListChecks className="h-3.5 w-3.5 text-brand-navy/50" strokeWidth={1.9} />
        Steps taken
        <span className="ml-auto text-[10px] normal-case tracking-normal opacity-50 group-open:hidden">
          {steps.length}
        </span>
      </summary>
      <ul className="wr-app-scroll ml-1 max-h-56 list-disc space-y-1 overflow-y-auto pb-3 pl-6 pr-3 text-[12.5px] leading-relaxed text-foreground/55 marker:text-brand-navy/30">
        {steps.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </details>
  );
}
