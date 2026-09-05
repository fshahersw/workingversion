import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Briefcase, Check, ChevronDown, Search, X } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { MatterScope } from "@/lib/chat-types";
import { mattersQueryOptions } from "@/lib/workspace";

export function MatterScopePicker({
  value,
  onChange,
  disabled,
}: {
  value: MatterScope | null;
  onChange: (m: MatterScope | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { data: matters, isLoading } = useQuery({
    ...mattersQueryOptions,
    enabled: open,
  });

  const list = useMemo(() => {
    const all = matters ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((m) =>
      `${m.shortName} ${m.caseName} ${m.docketNumber} ${m.mdlNumber ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [matters, query]);

  return (
    <div className="flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Scope research to a matter"
            title="Scope research to a matter"
            className={[
              "inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium transition-colors",
              value
                ? "border-brand-navy/25 bg-brand-blue-soft text-brand-navy"
                : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-brand-navy",
              disabled ? "opacity-60" : "",
            ].join(" ")}
          >
            <Briefcase className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
            <span className="max-w-[150px] truncate">
              {value ? value.label : "All matters"}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="w-[320px] rounded-lg border-border bg-card p-0 shadow-[0_20px_50px_-18px_rgba(31,42,94,0.35)]"
        >
          <div className="border-b border-border px-3 py-2">
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search matters…"
                className="w-full bg-transparent text-[12.5px] placeholder:text-muted-foreground/70 focus:outline-none"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto p-1.5">
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold text-brand-navy">
                  All matters
                </div>
                <div className="text-[10.5px] text-muted-foreground">
                  Search the full corpus and the open web
                </div>
              </div>
              {!value && <Check className="h-3.5 w-3.5 text-brand-navy" />}
            </button>
            {isLoading ? (
              <p className="px-2 py-3 text-[11.5px] text-muted-foreground">
                Loading matters…
              </p>
            ) : list.length === 0 ? (
              <p className="px-2 py-3 text-[11.5px] text-muted-foreground">
                No matters match “{query}”.
              </p>
            ) : (
              list.map((m) => (
                <button
                  key={m.matterId}
                  type="button"
                  onClick={() => {
                    onChange({
                      matterId: m.matterId,
                      label: `${m.shortName} (${m.docketNumber})`,
                    });
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[12.5px] font-semibold text-brand-navy">
                        {m.shortName}
                      </span>
                      {m.mdlNumber && (
                        <span className="shrink-0 rounded bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground">
                          MDL {m.mdlNumber}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[10.5px] text-muted-foreground">
                      {m.docketNumber} · {m.courtName ?? m.courtId} ·{" "}
                      {m.documents.toLocaleString()} docs
                    </div>
                  </div>
                  {value?.matterId === m.matterId && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-brand-navy" />
                  )}
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
      {value && (
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-label="Clear matter scope"
          title="Clear matter scope"
          className="ml-0.5 grid h-7 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-brand-navy"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
