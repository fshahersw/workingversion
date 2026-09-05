# RESULT Plan A comprehensiveness gate — ok (committed, root-caused, retuned so it fires)

- ran:
  - Reviewed the working-tree diff (coverage.server.ts + streamConverseToolLoop gate hook + research-agent wiring + orchestrate.ts Supabase removal). `tsc` clean, `npm test` 83 pass.
  - Committed as two commits (admin SSO, my co-author trailer):
    - `7970aaf` Remove legacy Supabase anon bearer; /api is Cognito-cookie only
    - `87b3353` Comprehensiveness gate: pre-synthesis coverage check + bounded re-query (Think/report, BEDROCK_COVERAGE_GATE)
  - A/B, `deep` cases N=3 (gate OFF vs ON). [Note: I ran the `deep` lens, not the full `"" 3` — the full run was cancelled by Firas at ~min 1 once the root cause below was clear.]
  - Root-caused the null result, **retuned the gate**, and validated it live.

- output:
  - **Original A/B (deep, N=3):** OFF → avgScore 77 / verify 43 / tierPass 100 / termRecall 81; ON → 82 / 46 / 100 / 90. **But `gate_requeried=false` on all 9/9 cases, 0 `coverage_gap` events** → the ON/OFF deltas are N=3 noise, NOT the gate. INCONCLUSIVE as-was.
  - **Root cause (timing, not coverage):** the gate only consulted if the model stopped researching before ~`start+20s` (`researchDeadline = start+30s` minus `GATE_MIN_MS 10s`, `bedrock-stream-tools.server.ts`). Think research runs 30–50s (research_loop total 52–81k ms), so the model always stopped past the window → the gate was time-skipped every case. Its clean-pass path also emitted no log, so "skipped" was indistinguishable from "ran and found full coverage."
  - **Retune (`343fab6`):** (1) drop the `researchMsLeft>10s` consult precondition — the audit is itself ~6s hard-capped + fail-safe; (2) on a found gap, grant a bounded ONE-TIME deadline extension (`GATE_REQUERY_BUDGET_MS 25s`) so the re-query round + synthesis have time even when research ran long — `gateFired` still caps it to one round; (3) add a `coverage_check` log (consulted/covered/missing) so the pass path is observable.
  - **Validation (deep, gate ON, N=1) after retune:** `coverage_check consulted=true covered=false` then `gate_requeried=true` on **3/3**; each re-query pulled the genuinely missing material (comparative talc MDL 2738 Rule 702 rulings; AFFF MDL 2873 bellwether schedule + contractor-defense ruling; MDL 3060 status + formaldehyde/uterine-cancer epidemiology). Sources 23/29/49, steps=5 (the extra round ran), scores 88/86/90, latency ~75–82s.

- outcome: **Plan A is shipped and now works.** tsc clean, 83 tests pass. The gate was inert due to a timing mis-tune (the reason the A/B looked flat); it is retuned, consults on every Think/report voluntary stop, fires when a real gap exists, and closes it in one bounded round. Latency rises ~5–12s on cases that re-query — the accepted quality-over-latency trade for this phase.

- follow-up (desktop's call):
  1. A **meaningful A/B is now possible** (the gate finally acts): re-run `BEDROCK_COVERAGE_GATE=0` vs `=1`, full set `"" 3`, and read the verify-rate/term-recall delta — only now is a delta attributable. I did not run it (it's ~40–70 min; Firas deferred). Ping me "check handoff" with a REQUEST and I'll run it under admin SSO.
  2. Consider whether the 25s one-round extension should scale by mode (report vs think), and whether to cap total gate re-queries at one across the whole loop (currently is) vs allow a second on a still-open gap.
  3. Then decide B (parallel subagents) vs. banking A.

- note: also committed `a5289db` (fix duplicate React keys in the Discovery deposition-analysis ask — re-index finding ids on merge) from a separate bug Firas reported; unrelated to Plan A, flagged so the tree diff is expected.
