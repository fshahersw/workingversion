import { Check } from "lucide-react";
import { useState } from "react";

import type { ChoiceRequest } from "@/lib/chat-types";

export function StructuredChoicePanel({
  request,
  disabled,
  onSelect,
}: {
  request: ChoiceRequest;
  disabled?: boolean;
  onSelect: (optionId: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <section
      className="not-prose my-3 border border-border bg-slate-50/45"
      aria-labelledby={`choice-${request.id}`}
    >
      <div className="border-b border-border px-3 py-2.5">
        <p
          id={`choice-${request.id}`}
          className="text-[12.5px] font-semibold leading-snug text-brand-navy"
        >
          {request.prompt}
        </p>
      </div>
      <div className="divide-y divide-border/70">
        {request.options.map((option) => {
          const active = selected === option.id;
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled || selected !== null}
              onClick={() => {
                setSelected(option.id);
                onSelect(option.id);
              }}
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
                <span className="block text-[12.5px] font-medium text-foreground">
                  {option.label}
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
      </div>
    </section>
  );
}
