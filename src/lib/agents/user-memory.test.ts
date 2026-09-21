import assert from "node:assert/strict";
import { test } from "node:test";

import {
  USER_CONTEXT_CHARS,
  USER_MEMORY_MAX_ANCHORS,
  emptyUserMemory,
  mergeUserMemory,
  normalizeUserMemory,
  standingPreferences,
  userContextBlock,
} from "./user-memory.ts";

const NOW = new Date("2026-09-18T18:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const ledger = (entities: [string, string][], preferences: string[] = []) => ({
  entities: entities.map(([label, kind]) => ({ label, kind })),
  preferences,
});

test("mergeUserMemory promotes matter/court/judge/statute anchors and skips parties and dates", () => {
  const out = mergeUserMemory(
    emptyUserMemory(NOW),
    ledger([
      ["In re Roundup Products Liability Litigation, MDL 2741 (N.D. Cal.)", "matter"],
      ["Judge Vince Chhabria", "judge"],
      ["N.D. Cal.", "court"],
      ["Jane Doe (plaintiff)", "party"],
      ["March 3, 2026", "date"],
      ["28 U.S.C. § 1407", "statute"],
    ]),
    "conv-1",
    NOW,
  );
  const labels = out.anchors.map((a) => a.label);
  assert.ok(labels.some((l) => l.startsWith("In re Roundup")));
  assert.ok(labels.includes("Judge Vince Chhabria"));
  assert.ok(labels.includes("28 U.S.C. § 1407"));
  assert.ok(!labels.some((l) => l.includes("Jane Doe")));
  assert.ok(!labels.includes("March 3, 2026"));
  for (const a of out.anchors) assert.equal(a.chats, 1);
});

test("mergeUserMemory counts each conversation once and increments across chats", () => {
  let mem = mergeUserMemory(
    emptyUserMemory(NOW),
    ledger([["Zantac MDL 2924", "matter"]]),
    "conv-1",
    daysAgo(3),
  );
  mem = mergeUserMemory(mem, ledger([["Zantac MDL 2924", "matter"]]), "conv-1", daysAgo(2));
  assert.equal(mem.anchors[0]!.chats, 1, "same chat must not inflate the count");
  mem = mergeUserMemory(mem, ledger([["zantac mdl 2924", "matter"]]), "conv-2", daysAgo(1));
  assert.equal(mem.anchors.length, 1, "case-insensitive dedupe");
  assert.equal(mem.anchors[0]!.chats, 2);
  assert.equal(mem.anchors[0]!.lastChat, "conv-2");
});

test("a chat's first turn (no id yet) and its later turns count as ONE chat", () => {
  // Turn 1 arrives before the server has assigned a conversation id.
  let mem = mergeUserMemory(
    emptyUserMemory(NOW),
    ledger([["Zantac MDL 2924", "matter"]], ["keep this memo under a page"]),
    undefined as unknown as string,
    daysAgo(1),
  );
  assert.equal(mem.anchors[0]!.chats, 1);
  // Turn 2 of the same chat names itself: adopt the id, do not count again.
  mem = mergeUserMemory(mem, ledger([["Zantac MDL 2924", "matter"]], ["keep this memo under a page"]), "conv-1", NOW);
  assert.equal(mem.anchors[0]!.chats, 1);
  assert.equal(mem.anchors[0]!.lastChat, "conv-1");
  assert.equal(mem.preferences[0]!.chats, 1);
  assert.deepEqual(standingPreferences(mem), [], "a one-off instruction must not become standing");
  // A genuinely new chat (first turn, again id-less) does count.
  mem = mergeUserMemory(mem, ledger([["Zantac MDL 2924", "matter"]], ["keep this memo under a page"]), "", NOW);
  assert.equal(mem.anchors[0]!.chats, 2);
  assert.deepEqual(standingPreferences(mem), ["keep this memo under a page"]);
});

test("mergeUserMemory keeps the most recent anchors within the cap and drops stale ones", () => {
  let mem = emptyUserMemory(NOW);
  for (let i = 0; i < USER_MEMORY_MAX_ANCHORS + 5; i++) {
    mem = mergeUserMemory(
      mem,
      ledger([[`Matter ${i}`, "matter"]]),
      `c${i}`,
      daysAgo(USER_MEMORY_MAX_ANCHORS + 5 - i),
    );
  }
  assert.equal(mem.anchors.length, USER_MEMORY_MAX_ANCHORS);
  assert.equal(mem.anchors[0]!.label, `Matter ${USER_MEMORY_MAX_ANCHORS + 4}`, "most recent first");
  // A 200-day-old anchor is dropped on the next merge.
  const stale = mergeUserMemory(
    emptyUserMemory(NOW),
    ledger([["Old Matter", "matter"]]),
    "old",
    daysAgo(200),
  );
  const refreshed = mergeUserMemory(stale, ledger([["Fresh Matter", "matter"]]), "new", NOW);
  assert.deepEqual(
    refreshed.anchors.map((a) => a.label),
    ["Fresh Matter"],
  );
});

test("standingPreferences requires repetition unless the wording is durable", () => {
  let mem = mergeUserMemory(
    emptyUserMemory(NOW),
    ledger(
      [],
      [
        "Always give Bluebook citations",
        "Keep this answer under a page",
        "Focus on New Jersey courts",
      ],
    ),
    "conv-1",
    NOW,
  );
  assert.deepEqual(standingPreferences(mem), ["Always give Bluebook citations"]);
  mem = mergeUserMemory(mem, ledger([], ["focus on new jersey courts"]), "conv-2", NOW);
  const standing = standingPreferences(mem);
  assert.ok(standing.includes("Always give Bluebook citations"));
  assert.ok(standing.includes("Focus on New Jersey courts"));
  assert.ok(!standing.includes("Keep this answer under a page"));
});

test("normalizeUserMemory tolerates garbage and enforces kinds and caps", () => {
  const out = normalizeUserMemory(
    {
      anchors: [
        { label: "Good", kind: "matter", chats: "3", lastSeen: "not-a-date" },
        { label: "Bad kind", kind: "party" },
        { label: "", kind: "matter" },
        null,
      ],
      preferences: [{ text: "  Always cite  " }, { text: "always cite" }, 42],
      updatedAt: 12,
    },
    NOW,
  );
  assert.equal(out.anchors.length, 1);
  assert.equal(out.anchors[0]!.chats, 3);
  assert.equal(out.anchors[0]!.lastSeen, NOW.toISOString());
  assert.equal(out.preferences.length, 1);
  assert.equal(out.updatedAt, NOW.toISOString());
  assert.deepEqual(normalizeUserMemory(undefined, NOW).anchors, []);
});

test("userContextBlock renders anchors, standing preferences and recent chats within budget", () => {
  let mem = mergeUserMemory(
    emptyUserMemory(NOW),
    ledger([["In re Roundup, MDL 2741", "matter"]], ["Always give Bluebook citations"]),
    "c1",
    daysAgo(1),
  );
  mem = mergeUserMemory(
    mem,
    ledger([
      ["In re Roundup, MDL 2741", "matter"],
      ["Judge Chhabria", "judge"],
    ]),
    "c2",
    NOW,
  );
  const block = userContextBlock(
    mem,
    [
      { title: "Roundup bellwether schedule", updatedAt: NOW.toISOString() },
      { title: "New research", updatedAt: NOW.toISOString() },
      { title: "Current question title", updatedAt: NOW.toISOString() },
    ],
    NOW,
    { excludeTitle: "Current question title" },
  );
  assert.ok(block.startsWith("ATTORNEY CONTEXT FROM EARLIER CHATS"));
  assert.ok(block.includes("In re Roundup, MDL 2741 (2 chats, today)"));
  assert.ok(block.includes("Judge Chhabria (today)"));
  assert.ok(block.includes("Standing preferences: Always give Bluebook citations"));
  assert.ok(block.includes('"Roundup bellwether schedule" (today)'));
  assert.ok(!block.includes("New research"));
  assert.ok(!block.includes("Current question title"));
  assert.ok(block.length <= USER_CONTEXT_CHARS);
});

test("userContextBlock is empty when there is nothing to say", () => {
  assert.equal(userContextBlock(emptyUserMemory(NOW), [], NOW), "");
  assert.equal(
    userContextBlock(
      emptyUserMemory(NOW),
      [{ title: "New research", updatedAt: NOW.toISOString() }],
      NOW,
    ),
    "",
  );
});

test("userContextBlock never exceeds the character ceiling", () => {
  let mem = emptyUserMemory(NOW);
  for (let i = 0; i < 12; i++) {
    mem = mergeUserMemory(
      mem,
      ledger([
        [
          `In re Very Long Matter Name Number ${i} Products Liability Litigation, MDL ${3000 + i} (D.N.J.)`,
          "matter",
        ],
      ]),
      `c${i}`,
      NOW,
    );
  }
  const recent = Array.from({ length: 6 }, (_, i) => ({
    title: `A fairly long conversation title about bellwether scheduling and Daubert rulings number ${i}`,
    updatedAt: NOW.toISOString(),
  }));
  const block = userContextBlock(mem, recent, NOW);
  assert.ok(block.length <= USER_CONTEXT_CHARS);
});
