import { shortDate, type TerminalRow } from "./useTerminalData";

export function FeatureShowcase({
  rows,
  onSelect,
}: {
  rows: TerminalRow[];
  onSelect: (row: TerminalRow) => void;
}) {
  // Prefer stories that actually carry an editorial picture so the top of the
  // page is always pictorial, then fall back to plain rows.
  const pool = rows.slice(0, 24).filter((r) => r.kind === "media");
  const ordered = [...pool.filter((r) => r.imageUrl), ...pool.filter((r) => !r.imageUrl)];
  const [main, ...side] = ordered.slice(0, 3);
  if (!main) return null;

  return (
    <div className="grid h-[210px] shrink-0 gap-px border-b border-border/70 bg-border/70 sm:h-[236px] lg:grid-cols-[minmax(0,1.8fr)_minmax(280px,0.85fr)]">
      <Feature row={main} onSelect={onSelect} size="main" />
      <div className="hidden grid-rows-2 gap-px bg-border/70 lg:grid">
        {side.map((r) => (
          <Feature key={r.id} row={r} onSelect={onSelect} size="side" />
        ))}
      </div>
    </div>
  );
}

function Feature({
  row,
  onSelect,
  size,
}: {
  row: TerminalRow;
  onSelect: (row: TerminalRow) => void;
  size: "main" | "side";
}) {
  const main = size === "main";
  return (
    <button
      type="button"
      onClick={() => onSelect(row)}
      className="group relative min-h-0 overflow-hidden bg-brand-navy text-left text-primary-foreground"
    >
      {row.imageUrl && (
        <img
          src={row.imageUrl}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
        />
      )}
      <span className="absolute inset-0 bg-gradient-to-b from-brand-navy/10 via-brand-navy/55 to-brand-navy/95" />
      <div className={`absolute inset-x-0 bottom-0 z-10 ${main ? "px-5 pb-4" : "px-4 pb-3"}`}>
        <div className="flex items-center gap-2 text-[9.5px] uppercase tracking-[0.06em] text-primary-foreground/80">
          {row.badge && <b className="text-primary-foreground">{row.badge}</b>}
          {row.source && <span>{row.source}</span>}
          {row.timestamp && <span>{shortDate(row.timestamp)}</span>}
        </div>
        <h2
          className={[
            "mt-1.5 font-display leading-[1.1] tracking-[-0.025em]",
            main ? "line-clamp-3 text-[24px]" : "line-clamp-3 text-[14px]",
          ].join(" ")}
        >
          {row.title}
        </h2>
        {main && row.bullets.length > 0 ? (
          <ul className="mt-1.5 space-y-[3px]">
            {row.bullets.slice(0, 3).map((b) => (
              <li
                key={b}
                className="relative line-clamp-1 pl-3 text-[11.5px] leading-[1.4] text-primary-foreground/85 before:absolute before:left-0 before:top-[7px] before:h-[3px] before:w-[3px] before:rounded-full before:bg-brand-orange"
              >
                {b}
              </li>
            ))}
          </ul>
        ) : null}
        {main && !row.bullets.length && row.detail && (
          <p className="mt-1.5 line-clamp-2 max-w-[780px] text-[12px] leading-[1.45] text-primary-foreground/85">
            {row.detail}
          </p>
        )}
      </div>
    </button>
  );
}
