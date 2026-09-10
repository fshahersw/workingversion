// Clarification card: the assistant asks the user to choose between options
// before doing work that would otherwise be a guess. Rendered by the platform
// skill into the assistant panel (just above the composer) through its own
// React root, so it works in every editor without touching the vendored
// panels. Keyboard: 1-9 pick an option, Enter submits, Esc skips.
import { useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

export type ClarifyQuestion = {
  id: string;
  label: string;
  description?: string;
  options: string[];
  multi?: boolean;
};

export type ClarifyAnswer = {
  cancelled: boolean;
  /** One line per question: "label: choice[, choice]" */
  answers: string;
};

const STYLE_ID = "sw-clarify-style";
const CSS = `
.sw-clarify{margin:8px 12px 4px;border:1px solid var(--border,#e3e6ea);border-radius:12px;background:var(--surface,#fff);box-shadow:var(--shadow-menu,0 8px 24px rgb(0 0 0 / 12%));font:13px/1.45 var(--gs-font-sans,system-ui,sans-serif);color:var(--text,#242424);overflow:hidden}
.sw-clarify header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px 6px}
.sw-clarify header h4{margin:0;font-size:14px;font-weight:600}
.sw-clarify header button{border:0;background:transparent;color:var(--text-secondary,#606366);font-size:16px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px}
.sw-clarify header button:hover{background:var(--hover,#f5f5f5)}
.sw-clarify .q{padding:4px 14px 8px}
.sw-clarify .q p{margin:4px 0 8px;color:var(--text-secondary,#606366)}
.sw-clarify .opt{display:flex;align-items:flex-start;gap:10px;width:100%;text-align:left;border:1px solid var(--border,#e3e6ea);background:var(--surface-subtle,#f6f7f9);border-radius:10px;padding:10px 12px;margin:6px 0;cursor:pointer;color:inherit;font:inherit}
.sw-clarify .opt:hover{border-color:var(--border-hover,#d3d7dd);background:var(--bg-hover,#f5f5f5)}
.sw-clarify .opt[aria-checked="true"]{border-color:var(--color-ai-action,#e8663f);background:var(--surface,#fff);box-shadow:inset 0 0 0 1px var(--color-ai-action,#e8663f)}
.sw-clarify .opt .k{flex:0 0 auto;min-width:20px;height:20px;border-radius:5px;border:1px solid var(--border-strong,#d9d9d9);font-size:11px;display:inline-flex;align-items:center;justify-content:center;color:var(--text-tertiary,#909499);margin-top:1px}
.sw-clarify .opt .t{flex:1 1 auto}
.sw-clarify .other{width:100%;box-sizing:border-box;border:1px solid var(--border,#e3e6ea);border-radius:10px;padding:9px 12px;font:inherit;color:inherit;background:var(--surface,#fff);margin:6px 0 2px}
.sw-clarify footer{display:flex;justify-content:flex-end;gap:8px;padding:8px 14px 12px}
.sw-clarify footer button{border:1px solid var(--border,#e3e6ea);background:var(--surface,#fff);color:var(--text,#242424);border-radius:8px;padding:7px 14px;font:inherit;cursor:pointer}
.sw-clarify footer button.primary{background:var(--color-btn-primary,#232425);color:var(--color-btn-primary-text,#fff);border-color:transparent}
.sw-clarify footer button:disabled{opacity:.5;cursor:default}
.sw-clarify .steps{color:var(--text-tertiary,#909499);font-size:12px;margin-right:auto;align-self:center}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

function Card({
  questions,
  onDone,
}: {
  questions: ClarifyQuestion[];
  onDone: (answer: ClarifyAnswer) => void;
}) {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<Record<string, Set<number>>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const q = questions[index]!;
  const chosen = picked[q.id] ?? new Set<number>();
  const otherText = other[q.id] ?? "";
  const canSubmit = chosen.size > 0 || otherText.trim().length > 0;
  const last = index === questions.length - 1;

  const answerText = useMemo(() => {
    return questions
      .map((question) => {
        const set = picked[question.id] ?? new Set<number>();
        const parts = [...set].sort().map((i) => question.options[i]!);
        const free = (other[question.id] ?? "").trim();
        if (free) parts.push(`Other: ${free}`);
        return `${question.label}: ${parts.length ? parts.join(", ") : "(skipped)"}`;
      })
      .join("\n");
  }, [questions, picked, other]);

  const toggle = (i: number) => {
    setPicked((prev) => {
      const next = new Set(prev[q.id] ?? []);
      if (q.multi) {
        if (next.has(i)) next.delete(i);
        else next.add(i);
      } else {
        next.clear();
        next.add(i);
      }
      return { ...prev, [q.id]: next };
    });
  };
  const advance = () => {
    if (last) onDone({ cancelled: false, answers: answerText });
    else setIndex(index + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (e.key === "Escape") {
        e.preventDefault();
        onDone({ cancelled: true, answers: "" });
      } else if (e.key === "Enter" && !e.shiftKey && (typing ? target?.closest(".sw-clarify") : true)) {
        if (canSubmit) {
          e.preventDefault();
          advance();
        }
      } else if (!typing && /^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (i < q.options.length) {
          e.preventDefault();
          toggle(i);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, canSubmit, q.id, q.options.length, q.multi, answerText]);

  return (
    <div className="sw-clarify" role="group" aria-label="Assistant question">
      <header>
        <h4>{q.label}</h4>
        <button type="button" aria-label="Skip" title="Skip (Esc)" onClick={() => onDone({ cancelled: true, answers: "" })}>
          ×
        </button>
      </header>
      <div className="q">
        {q.description && <p>{q.description}</p>}
        <div role={q.multi ? "group" : "radiogroup"}>
          {q.options.map((option, i) => (
            <button
              type="button"
              key={i}
              className="opt"
              role={q.multi ? "checkbox" : "radio"}
              aria-checked={chosen.has(i)}
              onClick={() => toggle(i)}
            >
              <span className="t">{option}</span>
              <span className="k" aria-hidden="true">
                {i + 1}
              </span>
            </button>
          ))}
        </div>
        <input
          className="other"
          type="text"
          placeholder="Other: type your own answer"
          value={otherText}
          onChange={(e) => setOther((prev) => ({ ...prev, [q.id]: e.target.value }))}
        />
      </div>
      <footer>
        {questions.length > 1 && (
          <span className="steps">
            {index + 1} of {questions.length}
          </span>
        )}
        <button type="button" onClick={() => onDone({ cancelled: true, answers: "" })}>
          Skip
        </button>
        <button type="button" className="primary" disabled={!canSubmit} onClick={advance}>
          {last ? "Submit" : "Next"}
        </button>
      </footer>
    </div>
  );
}

/** Find the assistant composer to anchor the card above; null falls back to a floating card. */
function findAnchor(): HTMLElement | null {
  const composers = [...document.querySelectorAll<HTMLElement>(".ai-composer")].filter(
    (el) => el.offsetParent !== null,
  );
  return composers.at(-1) ?? null;
}

let active: { root: Root; host: HTMLElement } | null = null;

export function askClarification(
  questions: ClarifyQuestion[],
  signal?: AbortSignal,
): Promise<ClarifyAnswer> {
  ensureStyle();
  if (active) {
    active.root.unmount();
    active.host.remove();
    active = null;
  }
  return new Promise<ClarifyAnswer>((resolve) => {
    const host = document.createElement("div");
    host.className = "sw-clarify-host";
    const anchor = findAnchor();
    if (anchor?.parentElement) anchor.parentElement.insertBefore(host, anchor);
    else {
      host.style.cssText = "position:fixed;right:16px;bottom:16px;width:420px;max-width:calc(100vw - 32px);z-index:9999";
      document.body.appendChild(host);
    }
    const root = createRoot(host);
    active = { root, host };
    let settled = false;
    const finish = (answer: ClarifyAnswer) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      root.unmount();
      host.remove();
      if (active?.host === host) active = null;
      resolve(answer);
    };
    const onAbort = () => finish({ cancelled: true, answers: "" });
    signal?.addEventListener("abort", onAbort, { once: true });
    root.render(<Card questions={questions} onDone={finish} />);
    host.scrollIntoView({ block: "nearest" });
  });
}
