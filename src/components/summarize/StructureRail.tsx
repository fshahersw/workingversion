import type { PileStructure } from "@/lib/pile/types";

export function StructureRail({ structure }: { structure: PileStructure }) {
  const hasAny =
    structure.inventory.length > 0 || structure.parties.length > 0 || structure.dates.length > 0;
  if (!hasAny) return null;

  return (
    <section className="mb-6">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-brand-navy/60">
          Structure
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>

      {structure.inventory.length > 0 && (
        <ul className="space-y-2">
          {structure.inventory.map((row) => (
            <li key={row.file} className="min-w-0">
              <p className="truncate text-[12.5px] font-medium text-foreground">{row.file}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {row.docType}
                <span className="tabular-nums"> · {row.pages} pp</span>
              </p>
            </li>
          ))}
        </ul>
      )}

      {structure.parties.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Parties
          </p>
          <div className="flex flex-wrap gap-1.5">
            {structure.parties.map((p) => (
              <span
                key={p}
                className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10.5px] text-foreground"
              >
                {p}
              </span>
            ))}
          </div>
        </div>
      )}

      {structure.dates.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Dates
          </p>
          <div className="flex flex-wrap gap-1.5">
            {structure.dates.map((d) => (
              <span
                key={d}
                className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10.5px] tabular-nums text-foreground"
              >
                {d}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
