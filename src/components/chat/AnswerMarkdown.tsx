import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink } from "lucide-react";
import { isValidElement, memo, useCallback, useMemo, useRef, type ReactNode } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { Source } from "@/lib/chat-types";
import { splitMarkdownBlocks } from "@/lib/markdown-blocks";
import { cellClassFor } from "@/lib/markdown-table-cells";
import { useSmoothText } from "@/lib/use-smooth-text";
import { hostOf } from "@/lib/host";
import { Favicon } from "./Favicon";
import { MermaidDiagram } from "./MermaidDiagram";

type CiteHandler = (ref: string) => void;

/** Everything a citation marker needs to render and describe itself. */
type CiteContext = {
  onCite: CiteHandler;
  selectedRef: string | null | undefined;
  citeLabels?: Record<string, string>;
  sourcesByRef?: Record<string, Source>;
};

function AnswerMarkdownImpl({
  text,
  onCite,
  selectedRef,
  streaming,
  citeLabels,
  sourcesByRef,
}: {
  text: string;
  onCite: CiteHandler;
  selectedRef?: string | null;
  streaming?: boolean;
  /** Plain tooltip labels per ref (used by the document summarizer views). */
  citeLabels?: Record<string, string>;
  /** Full sources per ref: turns each marker into a hover card with the site,
   *  title, date, and retrieved passage. Memoize at the call site. */
  sourcesByRef?: Record<string, Source>;
}) {
  // Smooth, constant-rate reveal so chunky deltas read as one continuous
  // left-to-right stream.
  const shown = useSmoothText(text, Boolean(streaming));

  // Callers usually pass an inline arrow for onCite; route through a ref so the
  // memoized blocks below keep their identity across parent re-renders.
  const onCiteRef = useRef(onCite);
  onCiteRef.current = onCite;
  const stableCite = useCallback<CiteHandler>((ref) => onCiteRef.current(ref), []);

  const ctx = useMemo<CiteContext>(
    () => ({ onCite: stableCite, selectedRef, citeLabels, sourcesByRef }),
    [stableCite, selectedRef, citeLabels, sourcesByRef],
  );

  // Only the block the stream is appending to is re-parsed each frame.
  const blocks = useMemo(() => splitMarkdownBlocks(shown), [shown]);

  return (
    <div
      className={[
        // Slightly more compact than before (14 px / 1.6) so a research answer
        // reads like a memo, not a chat bubble; the column itself is widened
        // in ChatView. Word-breaking stays on prose only; table cells opt out
        // below so an atomic value (a date, a docket number) never wraps.
        "wr-memo w-full min-w-0 text-[14px] leading-[1.6] text-foreground/90 [overflow-wrap:anywhere] [word-break:break-word]",
        "[&_h1]:mt-0 [&_h1]:mb-2 [&_h1]:text-[18.5px] [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1]:text-brand-navy",
        "[&_h2]:mt-4.5 [&_h2]:mb-1.5 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-brand-navy [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-1",
        "[&_h3]:mt-3.5 [&_h3]:mb-1 [&_h3]:text-[12.5px] [&_h3]:font-semibold [&_h3]:uppercase [&_h3]:tracking-[0.06em] [&_h3]:text-brand-navy/85",
        "[&_p]:my-2 [&_p]:leading-[1.6]",
        "[&_strong]:font-semibold [&_strong]:text-brand-navy",
        "[&_em]:text-foreground/80",
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-0.5 [&_ul]:marker:text-brand-navy/40",
        "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:space-y-0.5 [&_ol]:marker:text-brand-navy/60 [&_ol]:marker:font-semibold",
        "[&_li]:pl-1 [&_li]:leading-[1.55]",
        "[&_a]:text-primary [&_a]:underline-offset-2 hover:[&_a]:underline [&_a]:break-words",
        "[&_blockquote]:my-2.5 [&_blockquote]:border-l-2 [&_blockquote]:border-brand-orange/60 [&_blockquote]:bg-brand-orange-soft/30 [&_blockquote]:px-3 [&_blockquote]:py-1 [&_blockquote]:text-[13px] [&_blockquote]:text-foreground/85",
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px] [&_code]:font-mono [&_code]:break-words",
        "[&_pre]:overflow-x-auto",
        "[&_hr]:my-3.5 [&_hr]:border-border",
        // Tables: the scroll wrapper is rendered by the `table` component below
        // (a :has() selector on the parent never matched, which is why columns
        // used to collapse). Auto layout + per-cell min widths + nowrap on
        // atomic cells; wider than the column => horizontal scroll, not crush.
        "[&_table]:my-0 [&_table]:min-w-full [&_table]:border-collapse [&_table]:text-[12.5px] [&_table]:leading-[1.45] [&_table]:[table-layout:auto]",
        "[&_th]:border [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:align-bottom [&_th]:font-semibold [&_th]:text-brand-navy [&_th]:[overflow-wrap:normal] [&_th]:[word-break:normal]",
        "[&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top [&_td]:[overflow-wrap:normal] [&_td]:[word-break:normal]",
        "[&_tbody_tr:nth-child(even)_td]:bg-muted/20",
      ].join(" ")}
    >
      {blocks.map((block, i) => (
        <MarkdownBlock key={i} text={block} ctx={ctx} />
      ))}
    </div>
  );
}

export const AnswerMarkdown = memo(AnswerMarkdownImpl);

/** One top-level markdown block. Memoized on its text + citation context, so
 *  finished blocks are not re-parsed while later ones stream. */
const MarkdownBlock = memo(function MarkdownBlock({ text, ctx }: { text: string; ctx: CiteContext }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p>{mapNodes(children, ctx)}</p>,
        li: ({ children }) => <li>{mapNodes(children, ctx)}</li>,
        h2: ({ children }) => <h2>{mapNodes(children, ctx)}</h2>,
        h3: ({ children }) => <h3>{mapNodes(children, ctx)}</h3>,
        // Scroll container per table: on overflow the table scrolls sideways
        // instead of squeezing a column to a few characters.
        table: ({ children }) => (
          <div className="wr-table-scroll my-3 max-w-full overflow-x-auto rounded-md border border-border/70 [scrollbar-width:thin] [&_table]:border-0 [&_td:first-child]:border-l-0 [&_td:last-child]:border-r-0 [&_th:first-child]:border-l-0 [&_th:last-child]:border-r-0 [&_tr:first-child_th]:border-t-0 [&_tr:last-child_td]:border-b-0">
            <table>{children}</table>
          </div>
        ),
        th: ({ children }) => <th className={cellClass(children, true)}>{mapNodes(children, ctx)}</th>,
        td: ({ children }) => <td className={cellClass(children, false)}>{mapNodes(children, ctx)}</td>,
        // A ```mermaid fenced block renders as a diagram; any other code block
        // falls through to the normal <pre> styling.
        pre: ({ children }) => {
          const child = Array.isArray(children) ? children[0] : children;
          if (isValidElement(child)) {
            const cprops = child.props as { className?: string; children?: ReactNode };
            if (typeof cprops.className === "string" && cprops.className.includes("language-mermaid")) {
              const raw = Array.isArray(cprops.children)
                ? cprops.children.join("")
                : String(cprops.children ?? "");
              return <MermaidDiagram chart={raw.trim()} />;
            }
          }
          return <pre>{children}</pre>;
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

/** Plain text of a cell's React children (citation markers excluded). */
function cellText(children: ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(cellText).join("");
  if (isValidElement(children)) return cellText((children.props as { children?: ReactNode }).children);
  return "";
}

/** Width policy per cell (src/lib/markdown-table-cells.ts): atomic values never wrap, prose gets a floor and a ceiling. */
function cellClass(children: ReactNode, header: boolean): string {
  const text = cellText(children).replace(/\[S\d+\]/g, "").trim();
  if (!text) return "";
  return cellClassFor(text, header);
}

function mapNodes(children: ReactNode, ctx: CiteContext): ReactNode {
  if (Array.isArray(children))
    return children.map((c, i) => <span key={i}>{mapNodes(c, ctx)}</span>);
  if (typeof children === "string") return splitCitations(children, ctx);
  return children;
}

function splitCitations(text: string, ctx: CiteContext): ReactNode {
  const parts: ReactNode[] = [];
  const re = /(\[S\d+\])+/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    const refs = [...m[0].matchAll(/\[S(\d+)\]/g)].map((r) => "S" + r[1]);
    // Footnote-style: compact superscript numbers, comma-grouped, muted. Keeps
    // the prose uncluttered; hovering a number shows the source card, clicking
    // it opens the source in the panel.
    parts.push(
      <sup
        key={key++}
        className="mx-[1.5px] whitespace-nowrap align-super text-[10px] font-medium leading-none tabular-nums"
      >
        {refs.map((r, i) => (
          <span key={r}>
            {i > 0 && <span className="text-brand-navy/30">,</span>}
            <CiteMarker refId={r} ctx={ctx} />
          </span>
        ))}
      </sup>,
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

function CiteMarker({ refId: r, ctx }: { refId: string; ctx: CiteContext }) {
  const active = ctx.selectedRef === r;
  const source = ctx.sourcesByRef?.[r];
  const label = ctx.citeLabels?.[r] ?? (source ? source.citation : `View source ${r}`);
  // The hover card stands in for the native tooltip once a source is known,
  // but it is pointer-only: the accessible name still has to say which source.
  const host = source ? hostOf(source.source_url) : null;
  const name = source
    ? `Source ${r.slice(1)}: ${source.citation}${host ? ` (${host})` : ""}`
    : label;
  const marker = (
    <span
      role="button"
      tabIndex={0}
      aria-label={name}
      onClick={() => ctx.onCite(r)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          ctx.onCite(r);
        }
      }}
      title={source ? undefined : label}
      className={[
        "cursor-pointer transition-colors",
        active
          ? "font-semibold text-brand-orange"
          : "text-brand-navy/55 hover:text-brand-navy hover:underline",
      ].join(" ")}
    >
      {r.slice(1)}
    </span>
  );
  if (!source) return marker;
  return (
    <HoverCard openDelay={250} closeDelay={120}>
      <HoverCardTrigger asChild>{marker}</HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="w-[320px] rounded-lg border-border bg-card p-0 text-left shadow-[0_18px_44px_-18px_rgba(31,42,94,0.35)]"
      >
        <SourceCard source={source} onOpen={() => ctx.onCite(r)} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** Compact source preview: site, title, date, and the retrieved passage. */
function SourceCard({ source, onOpen }: { source: Source; onOpen: () => void }) {
  const host = hostOf(source.source_url);
  const external = Boolean(source.source_url) && !source.source_url!.startsWith("/");
  const passage = (source.content ?? "").replace(/\s+/g, " ").trim();
  return (
    <div className="font-sans">
      <div className="flex items-start gap-2 border-b border-border/60 px-3 py-2.5">
        <Favicon host={host} src={source.favicon} className="mt-[2px]" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[12.5px] font-semibold leading-snug text-brand-navy">
            {source.citation}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px] text-muted-foreground/75">
            <span className="truncate">{host || source.authority || source.source_type}</span>
            {source.effective_date && <span className="tabular-nums">· {source.effective_date}</span>}
            <span className="tabular-nums">· {source.ref}</span>
          </div>
        </div>
      </div>
      {passage && (
        <p className="line-clamp-5 px-3 py-2.5 text-[12px] leading-[1.55] text-foreground/85">
          {passage}
        </p>
      )}
      <div className="flex items-center gap-3 border-t border-border/60 px-3 py-1.5 text-[10.5px]">
        <button
          type="button"
          onClick={onOpen}
          className="font-medium text-brand-navy/80 transition-colors hover:text-brand-navy"
        >
          Show in sources
        </button>
        {external && (
          <a
            href={source.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-muted-foreground/80 transition-colors hover:text-brand-orange"
          >
            Open <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
      </div>
    </div>
  );
}
