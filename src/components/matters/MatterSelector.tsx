import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Briefcase, FileText, Scale } from "lucide-react";

import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { mattersQueryOptions } from "@/lib/workspace";

export function MatterSelector({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const { data: matters, isLoading } = useQuery({ ...mattersQueryOptions, enabled: open });
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "m") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const list = useMemo(() => matters ?? [], [matters]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder="Search matters by name, docket number, or MDL…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="max-h-[340px]">
        <CommandEmpty>
          <div className="flex flex-col items-center gap-1.5 py-8">
            <Briefcase className="h-5 w-5 text-muted-foreground/50" />
            <p className="text-[13px] text-muted-foreground">
              {isLoading ? "Loading matters…" : "No matters match your search."}
            </p>
          </div>
        </CommandEmpty>
        <CommandGroup heading="Active matters">
          {list.map((m) => (
            <CommandItem
              key={m.matterId}
              value={`${m.shortName} ${m.caseName} ${m.docketNumber} ${m.mdlNumber ?? ""}`}
              onSelect={() => {
                onOpenChange(false);
                navigate({ to: "/matters/$slug", params: { slug: m.slug } });
              }}
              className="cursor-pointer transition-colors aria-selected:bg-brand-blue-soft/70"
            >
              <div className="flex w-full min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-brand-blue-soft/60 text-brand-navy">
                  <Briefcase className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] font-semibold tracking-[-0.005em] text-foreground">
                      {m.shortName}
                    </span>
                    {m.mdlNumber ? (
                      <span className="shrink-0 rounded-md border border-border/60 bg-muted/70 px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                        MDL {m.mdlNumber}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {m.docketNumber} · {m.courtName ?? m.courtId}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3 tabular-nums text-[11px] text-muted-foreground/80">
                  <span className="flex items-center gap-1" title="Documents">
                    <FileText className="h-3 w-3" strokeWidth={1.75} />
                    {m.documents.toLocaleString()}
                  </span>
                  <span className="flex items-center gap-1" title="Docket entries">
                    <Scale className="h-3 w-3" strokeWidth={1.75} />
                    {m.entries.toLocaleString()}
                  </span>
                </div>
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
