import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildQuickAnswerPrompt,
  formatQuickAnswer,
  quickAnswerEnabled,
  quickWebAnswer,
  renderQuickAnswerBlock,
  type QuickAnswerGenerate,
  type QuickAnswerSource,
} from "./web-quick-answer.server.ts";

const SOURCES: QuickAnswerSource[] = [
  {
    ref: "S1",
    title: "Case management order No. 12",
    url: "https://example.com/cmo12",
    evidence: "The court set the first bellwether trial for March 2026.",
    date: "2025-11-02",
  },
  {
    ref: "S2",
    title: "Law360 coverage",
    url: "https://law360.example/story",
    evidence: "Plaintiffs' leadership was appointed in October.",
  },
];

const ON = { WEB_QUICK_ANSWER: "on" } as NodeJS.ProcessEnv;

test("quickAnswerEnabled reads the flag and is off by default", () => {
  assert.equal(quickAnswerEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(quickAnswerEnabled({ WEB_QUICK_ANSWER: "off" } as NodeJS.ProcessEnv), false);
  assert.equal(quickAnswerEnabled({ WEB_QUICK_ANSWER: "on" } as NodeJS.ProcessEnv), true);
  assert.equal(quickAnswerEnabled({ WEB_QUICK_ANSWER: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(quickAnswerEnabled({ WEB_QUICK_ANSWER: "TRUE" } as NodeJS.ProcessEnv), true);
});

test("buildQuickAnswerPrompt embeds the question, numbered sources, and rules", () => {
  const { system, user } = buildQuickAnswerPrompt("bellwether trial date", SOURCES);
  assert.match(system, /at most three sentences/i);
  assert.match(system, /\[S#\]|square brackets/i);
  assert.match(user, /QUESTION: bellwether trial date/);
  assert.match(user, /\[S1\] Case management order No\. 12, 2025-11-02/);
  assert.match(user, /\[S2\] Law360 coverage/);
  assert.match(user, /first bellwether trial for March 2026/);
});

test("buildQuickAnswerPrompt caps sources at six and truncates long evidence", () => {
  const many: QuickAnswerSource[] = Array.from({ length: 9 }, (_, i) => ({
    ref: `S${i + 1}`,
    title: `Source ${i + 1}`,
    url: `https://example.com/${i + 1}`,
    evidence: "x".repeat(2_000),
  }));
  const { user } = buildQuickAnswerPrompt("q", many);
  assert.ok(user.includes("[S6]"), "keeps the sixth source");
  assert.ok(!user.includes("[S7]"), "drops the seventh source");
  assert.ok(user.includes("…"), "truncates over-budget evidence");
});

test("formatQuickAnswer maps citations that resolve and preserves order", () => {
  const out = formatQuickAnswer(
    "The first bellwether is set for March 2026 [S1]. Leadership was named earlier [S2].",
    SOURCES,
  );
  assert.ok(out);
  assert.deepEqual(out!.citations, ["S1", "S2"]);
  assert.match(out!.text, /March 2026 \[S1\]/);
});

test("formatQuickAnswer strips unknown tags but keeps the grounded prose", () => {
  const out = formatQuickAnswer("A holding on point [S1], and an invented one [S9].", SOURCES);
  assert.ok(out);
  assert.deepEqual(out!.citations, ["S1"]);
  assert.ok(!out!.text.includes("[S9]"), "hallucinated tag removed");
  assert.ok(out!.text.includes("[S1]"));
});

test("formatQuickAnswer rejects empty, INSUFFICIENT, and fully ungrounded answers", () => {
  assert.equal(formatQuickAnswer("", SOURCES), null);
  assert.equal(formatQuickAnswer("   ", SOURCES), null);
  assert.equal(formatQuickAnswer("INSUFFICIENT", SOURCES), null);
  assert.equal(formatQuickAnswer("A confident claim with no citation.", SOURCES), null);
  assert.equal(formatQuickAnswer("Cites a phantom source only [S8].", SOURCES), null);
});

test("quickWebAnswer returns null when the flag is off", async () => {
  const generate: QuickAnswerGenerate = async () => "Answer [S1].";
  const out = await quickWebAnswer({
    query: "bellwether date",
    sources: SOURCES,
    generate,
    env: {} as NodeJS.ProcessEnv,
  });
  assert.equal(out, null);
});

test("quickWebAnswer returns null below the source floor", async () => {
  let called = false;
  const generate: QuickAnswerGenerate = async () => {
    called = true;
    return "Answer [S1].";
  };
  const out = await quickWebAnswer({
    query: "bellwether date",
    sources: [SOURCES[0]!],
    generate,
    env: ON,
  });
  assert.equal(out, null);
  assert.equal(called, false, "no model call when there is too little to synthesize");
});

test("quickWebAnswer synthesizes a grounded answer with an injected generator", async () => {
  const seen: { system: string; user: string; maxTokens: number } = {
    system: "",
    user: "",
    maxTokens: 0,
  };
  const generate: QuickAnswerGenerate = async (args) => {
    seen.system = args.system;
    seen.user = args.user;
    seen.maxTokens = args.maxTokens;
    return "The first bellwether trial is set for March 2026 [S1].";
  };
  const out = await quickWebAnswer({
    query: "first bellwether trial date",
    sources: SOURCES,
    generate,
    env: ON,
  });
  assert.ok(out);
  assert.deepEqual(out!.citations, ["S1"]);
  assert.ok(seen.maxTokens > 0 && seen.maxTokens <= 512, "uses a small output budget");
  assert.match(seen.user, /first bellwether trial date/);
  assert.match(renderQuickAnswerBlock(out!), /^\*\*Quick answer:\*\* /);
});

test("quickWebAnswer fails open to null when the generator throws", async () => {
  const generate: QuickAnswerGenerate = async () => {
    throw new Error("model unavailable");
  };
  const out = await quickWebAnswer({
    query: "bellwether date",
    sources: SOURCES,
    generate,
    env: ON,
  });
  assert.equal(out, null);
});

test("quickWebAnswer aborts and returns null when the time budget elapses", async () => {
  const generate: QuickAnswerGenerate = ({ signal }) =>
    new Promise<string>((_resolve, reject) => {
      // Never resolves on its own; only the timeout abort settles it.
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const started = Date.now();
  const out = await quickWebAnswer({
    query: "bellwether date",
    sources: SOURCES,
    generate,
    env: ON,
    timeoutMs: 50,
  });
  assert.equal(out, null);
  assert.ok(Date.now() - started < 1_000, "settles quickly on timeout");
});
