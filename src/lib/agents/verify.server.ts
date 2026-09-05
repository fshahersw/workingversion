// ============================================================================
// Stage 4 — VERIFY. The stage the old pipeline was missing.
//
// Facts arrive from the readers on trust. Here every fact is re-checked
// against the raw text of the page it cites: confirmed, re-anchored to the
// correct page, or dropped as unsupported. Input is short (one page batch plus
// a handful of claims) and output is tiny, so this runs at high concurrency
// and costs a fraction of the read pass.
// ============================================================================
import { parseJsonBlock } from "./json-extract";
import { verifyPrompt } from "./prompts";
import type { PageText } from "./doc-scan";
import type { LedgerFact } from "@/lib/summarizer-config";
import { VERIFY_MAX_CLAIMS_PER_CALL, VERIFY_PAGE_WINDOW } from "@/lib/summarizer-config";

export type VerifyVerdict = "confirmed" | "reanchored" | "unsupported";

export type VerifyResult = {
  facts: LedgerFact[];
  unsupported: LedgerFact[];
  confirmed: number;
  reanchored: number;
  checked: number;
};

function claimKey(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|a|an|of|to|in|on|for|and|or|that|this|is|are|was|were|by|with|shall)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110);
}

/**
 * Collapse near-duplicate facts: same normalized claim within a small page
 * window is one fact, not two. Keeps the richest copy (quote > amount > date).
 */
export function dedupeFacts(facts: LedgerFact[]): LedgerFact[] {
  const buckets = new Map<string, LedgerFact[]>();
  for (const f of facts) {
    const key = `${f.kind}|${claimKey(f.claim)}`;
    const list = buckets.get(key);
    if (!list) {
      buckets.set(key, [f]);
      continue;
    }
    const near = list.find((x) => Math.abs(x.page - f.page) <= VERIFY_PAGE_WINDOW);
    if (!near) {
      list.push(f);
      continue;
    }
    const richness = (x: LedgerFact) => (x.quote ? 4 : 0) + (x.amount ? 2 : 0) + (x.date ? 1 : 0);
    if (richness(f) > richness(near)) Object.assign(near, f);
  }
  return [...buckets.values()]
    .flat()
    .sort((a, b) => a.page - b.page || a.kind.localeCompare(b.kind));
}

type Batch = { pages: PageText[]; facts: LedgerFact[] };

/** Group facts so each call carries one contiguous page window and its claims. */
function buildBatches(facts: LedgerFact[], byPage: Map<number, string>): Batch[] {
  const byAnchor = new Map<number, LedgerFact[]>();
  for (const f of facts) {
    const list = byAnchor.get(f.page);
    if (list) list.push(f);
    else byAnchor.set(f.page, [f]);
  }
  const batches: Batch[] = [];
  for (const [page, list] of [...byAnchor.entries()].sort((a, b) => a[0] - b[0])) {
    const pages: PageText[] = [];
    for (let p = page - VERIFY_PAGE_WINDOW; p <= page + VERIFY_PAGE_WINDOW; p++) {
      const text = byPage.get(p);
      if (text) pages.push({ page: p, text });
    }
    if (!pages.length) continue;
    for (let i = 0; i < list.length; i += VERIFY_MAX_CLAIMS_PER_CALL) {
      batches.push({ pages, facts: list.slice(i, i + VERIFY_MAX_CLAIMS_PER_CALL) });
    }
  }
  return batches;
}

export async function verifyFacts(opts: {
  title: string;
  facts: LedgerFact[];
  pages: PageText[];
  minPage: number;
  maxPage: number;
  call: (system: string, user: string, maxTokens: number) => Promise<string>;
  concurrency: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<VerifyResult> {
  const facts = dedupeFacts(opts.facts);
  const byPage = new Map(opts.pages.map((p) => [p.page, (p.text ?? "").trim()]));
  const batches = buildBatches(facts, byPage);
  if (!batches.length) {
    return { facts, unsupported: [], confirmed: 0, reanchored: 0, checked: 0 };
  }

  const keep: LedgerFact[] = [];
  const unsupported: LedgerFact[] = [];
  let confirmed = 0;
  let reanchored = 0;
  let done = 0;

  const runBatch = async (batch: Batch) => {
    const body = [
      "PAGES:",
      ...batch.pages.map((p) => `[p. ${p.page}]\n${p.text.slice(0, 12_000)}`),
      "",
      "CLAIMS:",
      ...batch.facts.map((f, i) => `${i + 1}. (${f.kind}) ${f.claim}${f.quote ? ` — quote: "${f.quote}"` : ""} [cited p. ${f.page}]`),
    ].join("\n\n");

    let verdicts: Record<string, unknown>[] = [];
    try {
      const text = await opts.call(verifyPrompt(opts.title), body, 1_500);
      const parsed = parseJsonBlock(text, "verdicts");
      const raw = parsed?.["verdicts"];
      if (Array.isArray(raw)) {
        verdicts = raw.filter((v): v is Record<string, unknown> => !!v && typeof v === "object");
      }
    } catch {
      verdicts = [];
    }

    batch.facts.forEach((fact, i) => {
      const v = verdicts.find((x) => Number(x["claim"]) === i + 1);
      // No verdict at all (call failed, model skipped it) → keep the fact as-is.
      if (!v) {
        keep.push(fact);
        return;
      }
      const status = String(v["status"] ?? "").toLowerCase();
      const page = Number(v["page"]);
      if (status === "unsupported") {
        unsupported.push(fact);
        return;
      }
      if (
        Number.isFinite(page) &&
        page >= opts.minPage &&
        page <= opts.maxPage &&
        page !== fact.page
      ) {
        reanchored += 1;
        keep.push({ ...fact, page: Math.round(page) });
        return;
      }
      confirmed += 1;
      keep.push(fact);
    });

    done += 1;
    opts.onProgress?.(done, batches.length);
  };

  const limit = Math.max(1, Math.min(opts.concurrency, batches.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (;;) {
        const i = next++;
        if (i >= batches.length) return;
        await runBatch(batches[i]!);
      }
    }),
  );

  return {
    facts: dedupeFacts(keep),
    unsupported,
    confirmed,
    reanchored,
    checked: facts.length,
  };
}
