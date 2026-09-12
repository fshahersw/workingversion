import assert from "node:assert/strict";
import { test } from "node:test";

import type { Round } from "../chat-types.ts";
import { normalizeChoiceRequest, summarizeResearchActivity } from "./research-activity.ts";

const rounds: Round[] = [
  {
    round: 1,
    phase: "Reviewing authorities",
    reasoning: "",
    startedAt: 1_000,
    completedAt: 4_000,
    done: true,
    dispatch: [],
    agents: {
      legal: {
        agent: "legal_research",
        focus: "controlling law",
        status: "done",
        tools: [
          { id: "a", tool: "web_search", hits: 4 },
          { id: "b", tool: "fetch_page", hits: 1 },
        ],
      },
    },
  },
];

test("research activity aggregates compact phase counts and elapsed time", () => {
  assert.deepEqual(summarizeResearchActivity(rounds, true, 9_000), {
    phase: "Reviewing authorities",
    rounds: 1,
    agents: 1,
    tools: 2,
    elapsedMs: 3_000,
    done: true,
  });
});

test("choice normalization accepts only complete data-driven requests", () => {
  const choice = normalizeChoiceRequest({
    request_id: "scope",
    question: "Which record should be reviewed?",
    choices: [
      { value: "all", text: "All records" },
      { value: "selected", text: "Selected records", description: "Use the active set." },
    ],
  });
  assert.ok(choice);
  assert.equal(choice.options.length, 2);
  assert.equal(choice.options[1]?.label, "Selected records");
  assert.equal(normalizeChoiceRequest({ id: "bad", prompt: "Missing options" }), null);
  assert.equal(
    normalizeChoiceRequest({ id: "x", prompt: "p", recommendedId: "missing", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] })?.recommendedId,
    undefined,
    "a recommendedId naming no option is dropped",
  );

  const rich = normalizeChoiceRequest({
    id: "forum",
    prompt: "Which docket?",
    description: "Federal and state calendars differ.",
    recommendedId: "both",
    allowOther: true,
    otherPlaceholder: "Name the proceeding",
    options: [
      { id: "federal", label: "Federal MDL" },
      { id: "state", label: "State coordinated" },
      { id: "both", label: "Both tracks" },
    ],
  });
  assert.ok(rich);
  assert.equal(rich.recommendedId, "both");
  assert.equal(rich.allowOther, true);
  assert.equal(rich.description, "Federal and state calendars differ.");
});
