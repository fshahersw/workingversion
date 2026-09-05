// ============================================================================
// Pure helpers for the subagent primitive — types, plan parsing, the bounded
// concurrency pool, and findings assembly. NO server/AWS imports, so this is
// unit-testable in isolation (node --test). The Bedrock-calling runner and the
// planner live in subagent.server.ts and build on these.
// ============================================================================

/** A delegation contract: the ONE sub-question a subagent owns, with optional
 *  tool guidance and an out-of-scope boundary so siblings never duplicate work. */
export type SubagentSpec = {
  objective: string;
  toolsHint?: string;
  boundaries?: string;
};

export type SubagentResult = {
  spec: SubagentSpec;
  /** Dense [S#]-cited findings digest, or "" if the subagent produced nothing. */
  findings: string;
  /** [S#] refs this subagent contributed to the shared SourceBook. */
  refs: string[];
  steps: number;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  ok: boolean;
  error?: string;
};

function trunc(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** Coerce a `plan_research` tool input into bounded, de-duplicated, valid specs.
 *  Drops empty/too-short objectives and near-duplicates; caps at `max`. */
export function parsePlan(input: unknown, max: number): SubagentSpec[] {
  const sq = (input as { subquestions?: unknown } | null | undefined)?.subquestions;
  if (!Array.isArray(sq)) return [];
  const specs: SubagentSpec[] = [];
  const seen = new Set<string>();
  for (const raw of sq) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const objective = typeof o["objective"] === "string" ? o["objective"].trim() : "";
    if (objective.length < 8) continue;
    const key = objective.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const spec: SubagentSpec = { objective: trunc(objective, 300) };
    if (typeof o["tools_hint"] === "string" && o["tools_hint"].trim())
      spec.toolsHint = trunc(o["tools_hint"].trim(), 200);
    if (typeof o["boundaries"] === "string" && o["boundaries"].trim())
      spec.boundaries = trunc(o["boundaries"].trim(), 200);
    specs.push(spec);
    if (specs.length >= max) break;
  }
  return specs;
}

/** Bounded-concurrency map that never rejects: each task returns its own result
 *  (tasks are expected to catch internally), order preserved. */
export async function mapPoolSettled<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, worker),
  );
  return out;
}

/** Assemble the successful subagents' findings into one cited digest, each under
 *  its objective heading, for the lead synthesizer. Failed/empty are dropped. */
export function assembleFindings(results: SubagentResult[]): string {
  return results
    .filter((r) => r.ok && r.findings.trim())
    .map((r) => `## ${r.spec.objective}\n${r.findings.trim()}`)
    .join("\n\n");
}
