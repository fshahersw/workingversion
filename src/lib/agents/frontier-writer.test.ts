import assert from "node:assert/strict";
import { test } from "node:test";

import type { EvidenceBundle, EvidenceItem, RequestContext } from "./frontier-contracts.ts";
import { normalizeRoutePlan } from "./frontier-router.ts";
import {
  buildWriterUser,
  renderEvidence,
  styleDirective,
  writerMaxTokens,
} from "./frontier-writer.ts";

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: "r1",
    conversationId: "c1",
    userMessage: "Rewrite this sentence more formally.",
    currentDateIso: "2026-09-10",
    recentMessages: [],
    ...overrides,
  };
}

function item(partial: Partial<EvidenceItem> & { id: string }): EvidenceItem {
  return {
    sourceType: "court_opinion",
    provider: "courtlistener",
    authorityLevel: 1,
    title: partial.id,
    url: `https://court.gov/${partial.id}`,
    retrievedAt: "2026-09-10T00:00:00Z",
    supports: [],
    contradicts: [],
    primarySource: true,
    currentVerified: true,
    confidence: 0.9,
    ...partial,
  };
}

test("fast direct-write: empty bundle asks for a direct answer and no citations", () => {
  const bundle: EvidenceBundle = { items: [] };
  const route = normalizeRoutePlan({ intent: "rewrite", complexity: "fast", needsTools: false });
  const user = buildWriterUser(ctx(), bundle, route);
  assert.match(user, /REQUEST: Rewrite this sentence more formally\./);
  assert.match(user, /No external sources were needed/);
  assert.doesNotMatch(user, /\[S1\]/);
  assert.match(user, /Write the answer now\./);
});

test("research write: sources render as [S#] with a citation instruction", () => {
  const bundle: EvidenceBundle = {
    items: [item({ id: "S1", title: "Order Granting X", eventDate: "2026-08-28" })],
    limitations: ["DocketBird unavailable"],
  };
  const route = normalizeRoutePlan({ intent: "docket_status", complexity: "standard", needsTools: true });
  const user = buildWriterUser(ctx({ userMessage: "Status of MDL 3047?" }), bundle, route);
  assert.match(user, /cite claims with \[S#\]/);
  assert.match(user, /\[S1\] Order Granting X/);
  assert.match(user, /event 2026-08-28/);
  assert.match(user, /RESEARCH LIMITATIONS/);
  assert.match(user, /DocketBird unavailable/);
});

test("conversation context is included for follow-ups", () => {
  const user = buildWriterUser(
    ctx({
      conversationSummary: "Discussing MDL 3047 status.",
      recentMessages: [
        { role: "user", content: "What is MDL 3047?" },
        { role: "assistant", content: "It is the social-media adolescent addiction MDL." },
      ],
    }),
    { items: [] },
    normalizeRoutePlan({ needsTools: false }),
  );
  assert.match(user, /CONVERSATION SUMMARY: Discussing MDL 3047 status\./);
  assert.match(user, /RECENT TURNS:/);
  assert.match(user, /social-media adolescent addiction MDL/);
});

test("writer notes are appended when provided", () => {
  const user = buildWriterUser(ctx(), { items: [] }, normalizeRoutePlan({ needsTools: false }), [
    "Keep it under 80 words.",
  ]);
  assert.match(user, /WRITER NOTES:/);
  assert.match(user, /Keep it under 80 words\./);
});

test("styleDirective differs by answer style", () => {
  assert.match(styleDirective("concise"), /few tight sentences/);
  assert.match(styleDirective("legal_memo"), /memorandum/);
  assert.match(styleDirective("research_report"), /research report/);
  assert.match(styleDirective("normal"), /direct answer/);
});

test("writerMaxTokens budgets reports highest and concise lowest", () => {
  assert.ok(writerMaxTokens("research_report") >= writerMaxTokens("legal_memo"));
  assert.ok(writerMaxTokens("legal_memo") > writerMaxTokens("normal"));
  assert.ok(writerMaxTokens("normal") > writerMaxTokens("concise"));
});

test("renderEvidence numbers items and includes url + meta", () => {
  const out = renderEvidence([
    item({ id: "S1", title: "First" }),
    item({ id: "S2", title: "Second", sourceType: "news", authorityLevel: 3, provider: "reuters" }),
  ]);
  assert.match(out, /\[S1\] First — courtlistener · court_opinion · L1/);
  assert.match(out, /\[S2\] Second — reuters · news · L3/);
  assert.match(out, /https:\/\/court\.gov\/S2/);
});
