import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isValidElement, memo, type ReactNode } from "react";
import { useSmoothText } from "@/lib/use-smooth-text";
import { MermaidDiagram } from "./MermaidDiagram";

type CiteHandler = (ref: string) => void;

function AnswerMarkdownImpl({
  text,
  onCite,
  selectedRef,
  streaming,
  citeLabels,
}: {
  text: string;
  onCite: CiteHandler;
  selectedRef?: string | null;
  streaming?: boolean;
  citeLabels?: Record<string, string>;
}) {
  // Smooth, constant-rate reveal so chunky deltas read as one continuous
  // left-to-right stream.
  const shown = useSmoothText(text, Boolean(streaming));

  return (
    <div
      className={[
        "wr-memo w-full min-w-0 text-[14px] leading-[1.6] text-foreground/90 [overflow-wrap:anywhere] [word-break:break-word]",
        "[&_h1]:mt-0 [&_h1]:mb-2.5 [&_h1]:text-[19px] [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1]:text-brand-navy",
        "[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-[15.5px] [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-brand-navy [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-1",
        "[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:uppercase [&_h3]:tracking-[0.06em] [&_h3]:text-brand-navy/85",
        "[&_p]:my-2.5 [&_p]:leading-[1.6]",
        "[&_strong]:font-semibold [&_strong]:text-brand-navy",
        "[&_em]:text-foreground/80",
        "[&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_ul]:marker:text-brand-navy/40",
        "[&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:space-y-1 [&_ol]:marker:text-brand-navy/60 [&_ol]:marker:font-semibold",
        "[&_li]:pl-1 [&_li]:leading-[1.55]",
        "[&_a]:text-primary [&_a]:underline-offset-2 hover:[&_a]:underline [&_a]:break-words",
        "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-brand-orange/60 [&_blockquote]:bg-brand-orange-soft/30 [&_blockquote]:px-3 [&_blockquote]:py-1 [&_blockquote]:text-[13.5px] [&_blockquote]:text-foreground/85",
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12.5px] [&_code]:font-mono [&_code]:break-words",
        "[&_pre]:overflow-x-auto",
        "[&_hr]:my-4 [&_hr]:border-border",
        "[&>*:has(>table)]:overflow-x-auto",
        "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[13px]",
        "[&_th]:border [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_th]:text-brand-navy",
        "[&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top",
      ].join(" ")}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{mapNodes(children, onCite, selectedRef, citeLabels)}</p>,
          li: ({ children }) => (
            <li>{mapNodes(children, onCite, selectedRef, citeLabels)}</li>
          ),
          h2: ({ children }) => (
            <h2>{mapNodes(children, onCite, selectedRef, citeLabels)}</h2>
          ),
          h3: ({ children }) => (
            <h3>{mapNodes(children, onCite, selectedRef, citeLabels)}</h3>
          ),
          td: ({ children }) => (
            <td>{mapNodes(children, onCite, selectedRef, citeLabels)}</td>
          ),
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
        {shown}
      </ReactMarkdown>
    </div>
  );
}

export const AnswerMarkdown = memo(AnswerMarkdownImpl);

function mapNodes(
  children: ReactNode,
  onCite: CiteHandler,
  selectedRef: string | null | undefined,
  citeLabels?: Record<string, string>,
): ReactNode {
  if (Array.isArray(children))
    return children.map((c, i) => (
      <span key={i}>{mapNodes(c, onCite, selectedRef, citeLabels)}</span>
    ));
  if (typeof children === "string")
    return splitCitations(children, onCite, selectedRef, citeLabels);
  return children;
}

function splitCitations(
  text: string,
  onCite: CiteHandler,
  selectedRef: string | null | undefined,
  citeLabels?: Record<string, string>,
): ReactNode {
  const parts: ReactNode[] = [];
  const re = /(\[S\d+\])+/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    const refs = [...m[0].matchAll(/\[S(\d+)\]/g)].map((r) => "S" + r[1]);
    // Footnote-style: compact superscript numbers, comma-grouped, muted. Keeps
    // the prose uncluttered; the source name (if any) lives on hover, and the
    // number opens the source panel.
    parts.push(
      <sup
        key={key++}
        className="mx-[1.5px] whitespace-nowrap align-super text-[10px] font-medium leading-none tabular-nums"
      >
        {refs.map((r, i) => {
          const active = selectedRef === r;
          const label = citeLabels?.[r] ?? `View source ${r}`;
          return (
            <span key={r}>
              {i > 0 && <span className="text-brand-navy/30">,</span>}
              <span
                role="button"
                tabIndex={0}
                onClick={() => onCite(r)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onCite(r);
                  }
                }}
                title={label}
                className={[
                  "cursor-pointer transition-colors",
                  active
                    ? "font-semibold text-brand-orange"
                    : "text-brand-navy/55 hover:text-brand-navy hover:underline",
                ].join(" ")}
              >
                {r.slice(1)}
              </span>
            </span>
          );
        })}
      </sup>,
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}
