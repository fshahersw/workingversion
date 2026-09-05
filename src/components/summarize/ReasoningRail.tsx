import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Check } from "lucide-react";

import type { Gap, Phase, Step } from "@/lib/use-summarizer";

const EASE = [0.22, 0.61, 0.36, 1] as const;

export function ReasoningRail({
  steps,
  phase,
  questions = [],
  gaps = [],
}: {
  steps: Step[];
  phase: Phase;
  questions?: string[];
  gaps?: Gap[];
}) {
  const live = phase === "reading" || phase === "thinking" || phase === "writing";

  return (
    <div className="relative">
      <div className="sticky top-0 z-[1] mb-3 flex items-center gap-2 bg-card/95 py-1 backdrop-blur supports-[backdrop-filter]:bg-card/70">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-brand-navy/60">
          Reasoning
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>

      {!steps.length && live && (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Each pass over the document appears here — what was read, what it found, and how the
          findings were folded together into the final memo.
        </p>
      )}

      {questions.length > 0 && (
        <div className="mb-4 rounded-lg border border-border bg-muted/40 p-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-navy/60">
            Questions this read must answer
          </p>
          <ol className="list-decimal space-y-1 pl-4 text-[11.5px] leading-[1.5] text-muted-foreground">
            {questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
        </div>
      )}

      <div className="relative">
        {steps.length > 0 && (
          <div className="absolute bottom-1 top-1 left-[5.5px] w-px bg-border" />
        )}
        <div className="space-y-3">
          <AnimatePresence initial={false}>
            {steps.map((s, i) => (
              <motion.div
                key={s.id}
                layout
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.26, ease: EASE, delay: Math.min(i, 6) * 0.02 }}
                className="flex items-start gap-2.5"
              >
                <span className="relative mt-[3px] grid h-3 w-3 shrink-0 place-items-center">
                  {s.status === "done" ? (
                    <span className="z-[1] grid h-3 w-3 place-items-center rounded-full bg-brand-navy ring-4 ring-background">
                      <Check className="h-2 w-2 text-white" strokeWidth={3.5} />
                    </span>
                  ) : s.status === "error" ? (
                    <AlertCircle className="z-[1] h-3.5 w-3.5 bg-background text-destructive" />
                  ) : (
                    <>
                      <span className="absolute inline-flex h-3 w-3 animate-ping rounded-full bg-brand-orange opacity-40" />
                      <span className="relative z-[1] inline-flex h-[9px] w-[9px] rounded-full bg-brand-orange ring-4 ring-background" />
                    </>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span
                      className={`text-[12.5px] font-semibold ${
                        s.status === "running"
                          ? "wr-shimmer"
                          : s.status === "error"
                            ? "text-destructive"
                            : "text-foreground"
                      }`}
                    >
                      {s.label}
                    </span>
                    {s.meta && (
                      <span className="rounded-full bg-muted px-1.5 py-[1px] text-[9.5px] font-medium tabular-nums text-muted-foreground">
                        {s.meta}
                      </span>
                    )}
                  </div>
                  {s.detail && (
                    <p className="mt-1 line-clamp-3 text-[11.5px] leading-[1.5] text-muted-foreground">
                      {s.detail}
                    </p>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {live && (
            <div className="flex items-center gap-2.5">
              <span className="ml-[1px] h-[7px] w-[7px] shrink-0 animate-pulse rounded-full bg-brand-orange ring-4 ring-background" />
              <span className="wr-shimmer text-[11.5px] font-medium">
                {phase === "reading"
                  ? "Extracting text…"
                  : phase === "writing"
                    ? "Writing the memo…"
                    : "Working through the document…"}
              </span>
            </div>
          )}
        </div>
      </div>

      {gaps.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-300/60 bg-amber-50/60 p-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-700">
            Dropped — could not be verified on the cited page
          </p>
          <ul className="space-y-1 text-[11.5px] leading-[1.5] text-amber-900/80">
            {gaps.map((g, i) => (
              <li key={i}>
                {g.claim} <span className="tabular-nums opacity-70">[p. {g.page}]</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
