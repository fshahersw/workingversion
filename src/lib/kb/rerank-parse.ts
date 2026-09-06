// Pure parser for Bedrock Rerank responses. No imports so it is node-testable
// on its own (search.server.ts, which pulls in the Aurora/Bedrock deps, is not).

/** Parse a Bedrock Rerank response into an index order; identity fallback on any
 *  unexpected shape so a rerank hiccup never drops results. */
export function parseRerankOrder(json: unknown, n: number): number[] {
  const results = (json as { results?: { index?: unknown }[] } | null)?.results ?? [];
  const order = results
    .map((r) => Number(r.index))
    .filter((i) => Number.isInteger(i) && i >= 0 && i < n);
  return order.length ? order : Array.from({ length: n }, (_, i) => i);
}
