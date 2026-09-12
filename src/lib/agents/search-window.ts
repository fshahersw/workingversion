export const asksForRecentSources = (query: string) =>
  /\b(latest|recent|recently|today|this (week|month|year)|last (week|month|year)|current|news|breaking|update[sd]?)\b/i.test(
    query,
  );

/** Internal policy: an undated Office authority search has no arbitrary date floor. */
export function searchWindow(options: {
  unrestricted?: boolean;
  publishedAfter?: string;
  now?: number;
}) {
  if (options.publishedAfter) return options.publishedAfter;
  if (options.unrestricted) return undefined;
  return new Date((options.now ?? Date.now()) - 30 * 86_400_000).toISOString().slice(0, 10);
}
