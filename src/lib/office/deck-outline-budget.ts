// ============================================================================
// Context budget for the Slides deck outline (pure; no DOM, no model).
//
// The Slides skill prepends a "<deck outline>" to EVERY user message: one
// header per page plus one line per element. Writer bounds its equivalent
// (buildDocumentContext: 24k chars, tighter previews, then middle elision) but
// the deck outline was unbounded, so a 40-page × 12-element deck put ~35k chars
// (~9k tokens) into each turn and into history. This module applies the same
// three-pass discipline:
//
//   1. everything fits             -> unchanged (small decks are byte-identical)
//   2. compact the non-focus pages -> one summary line each (title, element
//                                     count, main fills); the focus window
//                                     (current page ± N, plus first/last) keeps
//                                     full element lines
//   3. still over                  -> elide runs of non-focus pages entirely,
//                                     widest-from-focus first, with a marker the
//                                     model can act on (read_slide by index)
//
// The focus window is never compacted or elided: the page the user is looking
// at (and its neighbours) always arrives in full. That is the floor: when the
// focus pages alone exceed the budget (7 pages × 15 elements ≈ 9k chars), the
// result is the focus pages plus markers and may exceed maxChars slightly.
// ============================================================================

export type OutlineSlide = {
  /** e.g. "Page 3 (slideIndex=2):" — always kept when the page is shown */
  header: string;
  /** full detail lines (main fills, one line per element) */
  lines: string[];
  /** one-line compact form, e.g. `  "Title preview" · 9 elements · fills #fff×3` */
  summary: string;
};

export type FitOptions = {
  /** total character budget for the page section (default 24_000, Writer parity) */
  maxChars?: number;
  /** pages on each side of the current page kept in full (default 2) */
  window?: number;
  /** current page index (0-based) */
  current: number;
  /** extra page indexes to keep in full (e.g. pages whose elements are selected) */
  pinned?: readonly number[];
};

export type FitResult = {
  lines: string[];
  /** pages rendered as a single summary line */
  compacted: number;
  /** pages dropped behind an elision marker */
  elided: number;
  /** which pass produced the result: 1 = full, 2 = compacted, 3 = elided */
  pass: 1 | 2 | 3;
};

export const DECK_OUTLINE_MAX_CHARS = 24_000;
export const DECK_OUTLINE_FOCUS_WINDOW = 2;

const size = (lines: readonly string[]) => lines.reduce((n, l) => n + l.length + 1, 0);

function focusSet(count: number, opts: FitOptions): Set<number> {
  const window = opts.window ?? DECK_OUTLINE_FOCUS_WINDOW;
  const focus = new Set<number>();
  if (count === 0) return focus;
  const cur = Math.min(Math.max(0, opts.current), count - 1);
  for (let i = cur - window; i <= cur + window; i++) if (i >= 0 && i < count) focus.add(i);
  focus.add(0);
  focus.add(count - 1);
  for (const p of opts.pinned ?? []) if (p >= 0 && p < count) focus.add(p);
  return focus;
}

/** Marker for a run of hidden pages [from, to] (0-based, inclusive). */
export function elisionMarker(from: number, to: number): string {
  const n = to - from + 1;
  return from === to
    ? `…(page ${from + 1} (slideIndex=${from}) not shown; read_slide(${from}) to inspect)…`
    : `…(${n} pages not shown: pages ${from + 1}–${to + 1}, slideIndex ${from}–${to}; read_slide(<index>) to inspect; never guess their contents)…`;
}

export function fitDeckOutline(slides: readonly OutlineSlide[], opts: FitOptions): FitResult {
  const max = opts.maxChars ?? DECK_OUTLINE_MAX_CHARS;
  const full = slides.flatMap((s) => [s.header, ...s.lines]);
  if (size(full) <= max) return { lines: full, compacted: 0, elided: 0, pass: 1 };

  const focus = focusSet(slides.length, opts);
  const render = (mode: (i: number) => "full" | "compact" | "hide"): { lines: string[]; compacted: number; elided: number } => {
    const out: string[] = [];
    let compacted = 0;
    let elided = 0;
    let runStart = -1;
    const flush = (end: number) => {
      if (runStart >= 0) {
        out.push(elisionMarker(runStart, end));
        elided += end - runStart + 1;
        runStart = -1;
      }
    };
    slides.forEach((s, i) => {
      const m = mode(i);
      if (m === "hide") {
        if (runStart < 0) runStart = i;
        return;
      }
      flush(i - 1);
      out.push(s.header);
      if (m === "full") out.push(...s.lines);
      else {
        out.push(s.summary);
        compacted++;
      }
    });
    flush(slides.length - 1);
    return { lines: out, compacted, elided };
  };

  // Pass 2: compact every non-focus page.
  const pass2 = render((i) => (focus.has(i) ? "full" : "compact"));
  if (size(pass2.lines) <= max) return { ...pass2, pass: 2 };

  // Pass 3: hide non-focus pages, farthest from the current page first, until
  // the budget holds (or only focus pages remain).
  const cur = Math.min(Math.max(0, opts.current), Math.max(0, slides.length - 1));
  const candidates = slides
    .map((_, i) => i)
    .filter((i) => !focus.has(i))
    .sort((a, b) => Math.abs(b - cur) - Math.abs(a - cur));
  const hidden = new Set<number>();
  let result = pass2;
  for (const i of candidates) {
    hidden.add(i);
    result = render((j) => (focus.has(j) ? "full" : hidden.has(j) ? "hide" : "compact"));
    if (size(result.lines) <= max) break;
  }
  return { ...result, pass: 3 };
}
