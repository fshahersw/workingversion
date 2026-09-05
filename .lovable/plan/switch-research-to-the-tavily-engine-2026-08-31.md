# Switch research to the Tavily engine

The Tavily research engine is already fully built and gated behind a single config flag. Nothing in the app code needs to change — the switch is a configuration change plus verification.

## Current state (verified)

- `tavilyEngineEnabled()` returns true only when `RESEARCH_ENGINE` equals `tavily` **and** a Tavily key is present.
- The Tavily key is configured.
- `RESEARCH_ENGINE` is currently unset, so research still runs the multi-agent / DocketBird loop.
- The orchestrator already branches on the flag: one Tavily advanced search per research angle, with the grounded answer fast-path for simple queries, and favicons/relevance feeding the right-hand source panel.

## Steps

1. Set the `RESEARCH_ENGINE` config value to `tavily`.
2. Restart the dev server so the new value is picked up by server functions.
3. Run a live check on `/research` with a real query (e.g. an MDL question) and confirm:
   - the run logs report `engine: tavily`
   - sources appear in the right panel with favicons and relevance scores
   - answer latency lands in the few-seconds range rather than the old multi-round time

## Notes

- Reverting is equally simple: clear or change `RESEARCH_ENGINE` and restart; the multi-agent path is untouched.
- Discovery/Doc Search, the summarizer, and the Home intel feeds are unaffected — this flag only governs the research agent path.
