// Shared JSON extraction for model responses.
//
// Reader models are inconsistent about fencing: some emit ```json blocks, some
// emit a bare object, some wrap the object in prose. A fence-only parser
// silently drops the whole payload, so we scan for a balanced-brace object
// anchored on the expected key.

export function findJsonSpan(text: string, key = "facts"): { start: number; end: number } | null {
  const needle = new RegExp(`\\{\\s*"${key}"`);
  let from = 0;
  let best: { start: number; end: number } | null = null;
  for (;;) {
    const m = needle.exec(text.slice(from));
    if (!m) break;
    const start = from + m.index;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (esc) {
        esc = false;
        continue;
      }
      if (inStr) {
        if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end !== -1) best = { start, end };
    from = start + 1;
  }
  return best;
}

export function parseJsonBlock(text: string, key = "facts"): Record<string, unknown> | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  const candidates = fences.reverse();
  const span = findJsonSpan(text, key);
  if (span) candidates.push(text.slice(span.start, span.end));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Remove the JSON payload from a prose response, fenced or bare. */
export function stripJsonBlock(text: string, key = "facts"): string {
  let out = text.replace(/```(?:json)?\s*[\s\S]*?```\s*$/g, "").trim();
  const span = findJsonSpan(out, key);
  if (span) out = (out.slice(0, span.start) + out.slice(span.end)).trim();
  return out.replace(/```(?:json)?\s*$/g, "").trim();
}
