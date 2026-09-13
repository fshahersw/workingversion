import type {} from "./voice.harness";
import type {} from "./conversation.harness";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
test.beforeEach(async ({ page }) => {
  await page.route("**/tests/office/conversation.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: readFileSync(new URL("./conversation.html", import.meta.url), "utf8"),
    }),
  );
  await page.goto("/tests/office/conversation.html");
  await page.waitForFunction(() => typeof window.verifyOfficeConversation === "function");
});
test("steering settles the in-flight write once, skips the second, and retains paired results", async ({
  page,
}) => {
  const r = await page.evaluate(() => window.verifyOfficeConversation("steer"));
  expect(r.writes).toEqual(["first"]);
  expect(r.contexts).toBe(1);
  expect(r.requests).toHaveLength(2);
  const messages = r.requests![1].messages;
  const tools = messages.find((m) => m.role === "tool")!.results;
  expect(tools.map((t) => t.id)).toEqual(["first", "second"]);
  expect(tools[1].isError).toBe(true);
  expect(JSON.stringify(messages.at(-1))).toContain("focus on the conclusion");
  expect(r.done).toBe(1);
  expect(r.applied).toHaveLength(1);
});
test("a direction during a text response gets another turn before completion", async ({ page }) => {
  const r = await page.evaluate(() => window.verifyOfficeConversation("no-tools"));
  expect(r.beforeFinal).toEqual({ busy: true, done: 0 });
  expect(JSON.stringify(r.requests![1].messages.at(-1))).toContain("current selection");
});
for (const kind of ["cancel", "reset"])
  test(`${kind} discards queued directions and cannot run a second edit`, async ({ page }) => {
    const r = await page.evaluate((kind) => window.verifyOfficeConversation(kind), kind);
    expect(r.writes).toEqual(["first"]);
    expect(r.requests).toHaveLength(1);
    expect(r.pending).toBe(0);
    expect(r.busy).toBe(false);
  });
test("steering respects the run budget", async ({ page }) => {
  const r = await page.evaluate(() => window.verifyOfficeConversation("limit"));
  expect(r.requests![1].tools).toHaveLength(0);
  expect(r.done).toBe(1);
});
test("queue input and count are bounded and clearable", async ({ page }) => {
  const r = await page.evaluate(() => window.verifyOfficeConversation("queue"));
  expect(r).toEqual({
    accepted: [true, true, true, true, false],
    length: 4,
    cleared: 0,
    long: false,
  });
});
test("shared controls let the user queue and remove a direction during work", async ({ page }) => {
  await page.getByRole("textbox", { name: "Update the running task" }).fill("Keep every citation");
  await page.getByRole("button", { name: "Queue direction" }).click();
  await expect(page.getByText("1 queued")).toBeVisible();
  await expect(page.getByText("Keep every citation", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText("1 queued")).toHaveCount(0);
});

test("unconfigured live voice hides the Voice control without starting a microphone session", async ({
  page,
}) => {
  // The entry point is rendered only once the gateway is provisioned and
  // OFFICE_VOICE_ENABLED is set; until then no Voice button exists at all.
  await expect(page.getByRole("button", { name: "Voice", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Office task and voice controls" })).toBeVisible();
});

test("voice releases audio when the gateway is not configured", async ({ page }) => {
  const r = await page.evaluate(() => window.verifyOfficeVoice("no-grant"));
  expect(r.errors).toEqual(["Gateway is not configured"]);
  expect(r.audioClosed).toBe(1);
  expect(r.sockets).toHaveLength(0);
  expect(r.taskStops).toBe(0);
});
test("ending voice during the microphone permission wait stops a late stream", async ({ page }) => {
  const r = await page.evaluate(() => window.verifyOfficeVoice("cancel-microphone"));
  expect(r.trackStopped).toBe(1);
  expect(r.audioClosed).toBe(1);
  expect(r.sockets).toHaveLength(0);
});
test("barge-in flushes playback and ending voice leaves the task running", async ({ page }) => {
  const r = await page.evaluate(() => window.verifyOfficeVoice("audio"));
  expect(r.sourcesStopped).toBe(1);
  expect(r.trackStopped).toBe(1);
  expect(r.taskStops).toBe(0);
  expect(r.states).toContain("muted");
  expect(r.states.at(-1)).toBe("off");
  expect(r.speech).toEqual(["Check the document"]);
});
test("voice renews the grant with bounded history, without replaying work", async ({ page }) => {
  const r = await page.evaluate(() => window.verifyOfficeVoice("renew"));
  expect(r.grants).toBe(2);
  expect(r.sockets).toHaveLength(2);
  expect(r.states).toContain("reconnecting");
  expect(r.sockets[1].sent[0].resume).toContain("Check the document");
  expect(r.replay.error).toContain("new spoken");
  expect(r.audioClosed).toBe(1);
  expect(r.taskStops).toBe(0);
});

test("task failure is explicit in the voice status snapshot", async ({ page }) => {
  const r = await page.evaluate(() => window.verifyOfficeConversation("failure"));
  expect(r.status?.state).toBe("failed");
  expect(r.status?.error).toBe("Authorization failed");
  expect(r.status?.busy).toBe(false);
});
