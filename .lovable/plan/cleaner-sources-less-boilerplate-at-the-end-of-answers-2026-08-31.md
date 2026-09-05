# Cleaner sources, less boilerplate at the end of answers

Two focused changes to the research side: keep low-value websites out of results, and stop the writer from tacking an "Open questions / confirm on the docket" list onto nearly every answer.

## 1. Junk-domain exclusion

Add one shared blocklist used by every web search path, covering:

- Social/UGC: facebook, instagram, x.com/twitter, tiktok, reddit, quora, pinterest, linkedin, threads, youtube, snapchat, tumblr
- Content farms / aggregators: medium, substack (generic), blogspot, wordpress.com, wikihow, scribd, coursehero, studocu, slideshare, ezinearticles
- Lead-gen / directories / marketing: avvo, justia lawyer directories, findlaw directories, lawyers.com, superlawyers, legalzoom, "free case review" mills, classaction.org-style ad pages
- Junk news portals: msn, yahoo aggregate, dailymail, buzzfeed, newsbreak, ground.news, patch, prnewswire/businesswire press-release wire pages
- Non-English/spam TLD noise and shopping/AI-slop hosts

Applied in two layers so nothing leaks through:

1. Sent to Tavily as `exclude_domains` on every search request (provider-side filter).
2. A local hard drop in the result mapper/ranker, so any excluded host that still comes back (redirects, syndication) is discarded before it can be cited.

Existing tier scoring stays as-is — this is a separate, harder filter. Genuinely useful trade press (Law360, Reuters, Bloomberg) is not blocked; it just keeps its current tier-3 ranking penalty.

## 2. Writer prompt: kill the reflexive closing list

The instruction currently reads "include ONLY when genuinely time-sensitive…", which the model treats as a default. Rewrite it so the list is off by default and allowed only in narrow cases:

- Default: end on the substance — no closing list, no disclaimer, no "verify against the docket" paragraph.
- Allowed at most one short line (not a headed section, max two items) and only when a specific fact the answer depends on is genuinely unresolved in the retrieved sources.
- Explicitly forbid the literal heading "Open questions / confirm on the docket" as a recurring template, and forbid closing lists on short/conversational answers entirely.

Same edit applied consistently in all three places the rule appears so the prompts don't contradict each other.

## Technical notes

- New shared list (e.g. `EXCLUDED_HOSTS` + `isExcludedHost()`) in `src/lib/agents/web-rank.ts`; imported by `src/lib/agents/tavily.server.ts` for `exclude_domains` and by the ranker's filter loop.
- Tavily caps `exclude_domains` length, so the provider-side list carries the highest-value entries and the local filter carries the full regex.
- Prompt edits: `src/lib/agents/prompts.ts` (writer rule near line 258, plus the registry line that references the closing list) and `CITATION_CONTRACT` in `src/lib/system-prompt.ts`.
- No backend, schema, or UI changes; the fact-check chip in `ChatView.tsx` is untouched.

## Verification

Run a short conversational query and a docket query on the Tavily engine; confirm no excluded hosts appear in the source panel and that the short answer ends without a closing list.
