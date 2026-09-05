# Roll back to last published codebase state

## Goal
Revert the preview workspace to the exact codebase state that is currently live on the published site, undoing only the unpublished Tavily source-selection hardening edits.

## Likely rollback targets (most recent first)

The recent unpublished edits are the Tavily source-selection improvements in message #918. The published site almost certainly corresponds to one of these earlier points:

1. **Recommended target — message #914** (junk-domain exclusions + writer prompt cleanup). This is the last stable, user-requested change before the source-selection complaint and hardening edits. If the site was published after the junk-domain/writer-prompt work but before the conflict-ranking work, this is the match.
2. **Fallback target — message #907** (Tavily engine enabled). Use this if you published immediately after flipping `RESEARCH_ENGINE=tavily` and before any further Tavily tuning.
3. **Conservative fallback — message #904** (writer switched to Sonnet 5). Use this if you are unsure when you last published and want the safest pre-Tavily-tuning state.

## Rollback steps

1. Open **History** in the project UI (or use the chat revert button under the target message).
2. Select the target message (#914 recommended, #907 fallback, #904 conservative fallback).
3. Click **Revert**. This restores the workspace file tree to that point; later messages become archived but can be re-applied.
4. After revert, run a build/typecheck to confirm the workspace compiles.
5. Optionally verify by opening `/research` and sending a test query to confirm the research engine still responds.

## Secret alignment

Secrets are not versioned with code. After reverting, decide whether the runtime config should also match the reverted code:

- If reverting to **#914 or later**: keep `RESEARCH_ENGINE=tavily` and `BEDROCK_WRITER_MODEL=us.anthropic.claude-sonnet-5` as-is, because those were already set before the source-selection edits.
- If reverting to **#907 or earlier**: keep `RESEARCH_ENGINE=tavily` (it was set at #907) but note that the junk-domain exclusion list and writer-prompt cleanup from #914 will be gone.
- If reverting to **#904 or earlier**: clear `RESEARCH_ENGINE` so the app falls back to the default AgentCore/DocketBird engine, matching the pre-Tavily code state.

## Verification

- Build passes with no new errors.
- `/research` route loads and a sample query streams a response.
- If Tavily remains enabled, sources still include favicons and relevance scores (the baseline Tavily integration from #896 is intact).
