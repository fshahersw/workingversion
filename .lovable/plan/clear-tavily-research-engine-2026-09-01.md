# Clear Tavily Research Engine

## Goal
Remove the `RESEARCH_ENGINE` runtime secret so the platform falls back to the default multi-agent research engine instead of Tavily.

## Why
The user has asked to stop using Tavily as the active research engine. Deleting the secret (rather than setting it to an empty string) is the cleanest way to disable it, because the code likely checks `process.env.RESEARCH_ENGINE === "tavily"` or similar.

## Steps
1. Delete the `RESEARCH_ENGINE` runtime secret via `secrets--delete_secret`.
2. Verify the secret is no longer listed in `secrets--fetch_secrets`.
3. Confirm the research route will load the default engine on the next request.

## Impact
- No code changes are required.
- Existing research UI and routes remain unchanged.
- The next research query will use the multi-agent (non-Tavily) pipeline.
