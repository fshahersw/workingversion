import { Check, CornerDownLeft } from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { ChoiceAnswer, ChoiceRequest } from "@/lib/chat-types";

export function StructuredChoicePanel({
  request,
  disabled,
  onSelect,
}: {
  request: ChoiceRequest;
  disabled?: boolean;
  onSelect: (answer: ChoiceAnswer) => void;
}) {
  // Rule ids ("forum", "deliverable") repeat across messages, so the DOM id
  // that labels the section must come from React, not from the request.
  const headingId = useId();
  const [selected, setSelected] = useState<string | null>(request.answered?.optionId ?? null);
  const [otherText, setOtherText] = useState(request.answered?.text ?? "");
  const answered = request.answered;

  useEffect(() => {
    if (request.answered) {
      setSelected(request.answered.optionId);
      setOtherText(request.answered.text ?? "");
    }
  }, [request.answered]);

  if (answered) {
    return (
      <section className="not-prose my-3 border border-border bg-slate-50/45 px-3 py-2.5">
        <p className="text-[12px] text-muted-foreground">
          You chose{" "}
          <span className="font-medium text-brand-navy">{answered.label}</span>
        </p>
      </section>
    );
  }

  // The attorney asked something else instead of answering: the question is
  // closed, so show a receipt rather than a form that can no longer be used.
  if (request.dismissed) {
    return (
      <section
        className="not-prose my-3 border border-border bg-slate-50/45 px-3 py-2.5"
        aria-label="Skipped question"
      >
        <p className="text-[12px] text-muted-foreground">
          <span className="font-medium text-brand-navy">Skipped</span> — you moved on without
          answering.
        </p>
        {request.prompt ? (
          <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground/80">
            {request.prompt}
          </p>
        ) : null}
      </section>
    );
  }

  function pick(optionId: string, label: string, text?: string) {
    if (disabled || selected !== null) return;
    setSelected(optionId);
    onSelect({
      id: request.id,
      optionId,
      label,
      ...(text ? { text } : {}),
    });
  }

  function submitOther() {
    const text = otherText.trim();
    if (!text) return;
    pick("other", text, text);
  }

  return (
    <section
      className="not-prose my-3 border border-border bg-slate-50/45"
      aria-labelledby={headingId}
    >
      <div className="border-b border-border px-3 py-2.5">
        <p
          id={headingId}
          className="text-[12.5px] font-semibold leading-snug text-brand-navy"
        >
          {request.prompt}
        </p>
        {request.description ? (
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
            {request.description}
          </p>
        ) : null}
      </div>
      <div className="divide-y divide-border/70">
        {request.options.map((option) => {
          const active = selected === option.id;
          const recommended = request.recommendedId === option.id;
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled || selected !== null}
              onClick={() => pick(option.id, option.label)}
              className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-70"
            >
              <span
                className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center border ${
                  active
                    ? "border-brand-navy bg-brand-navy text-white"
                    : "border-slate-300 bg-white"
                }`}
              >
                {active ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
              </span>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-[12.5px] font-medium text-foreground">
                    {option.label}
                  </span>
                  {recommended ? (
                    <span className="rounded-sm bg-brand-navy/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-brand-navy">
                      Recommended
                    </span>
                  ) : null}
                </span>
                {option.description ? (
                  <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
        {request.allowOther ? (
          <div className="flex items-start gap-3 px-3 py-2.5">
            <span
              className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center border ${
                selected === "other"
                  ? "border-brand-navy bg-brand-navy text-white"
                  : "border-slate-300 bg-white"
              }`}
            >
              {selected === "other" ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-medium text-foreground">Other</p>
              <div className="mt-1.5 flex gap-2">
                <input
                  type="text"
                  value={otherText}
                  disabled={disabled || selected !== null}
                  placeholder={request.otherPlaceholder || "Specify"}
                  onChange={(e) => setOtherText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitOther();
                    }
                  }}
                  className="h-8 min-w-0 flex-1 border border-border bg-white px-2 text-[12.5px] text-foreground placeholder:text-muted-foreground/80 focus:border-primary/40 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={disabled || selected !== null || !otherText.trim()}
                  onClick={submitOther}
                  className="inline-flex h-8 items-center gap-1 border border-border bg-white px-2 text-[11.5px] font-medium text-brand-navy hover:bg-muted/40 disabled:opacity-40"
                >
                  <CornerDownLeft className="h-3 w-3" strokeWidth={2} />
                  Use
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
