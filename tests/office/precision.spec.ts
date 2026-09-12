import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
test.beforeEach(async ({ page }) => {
  await page.route("**/tests/office/precision.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: readFileSync(new URL("./precision.html", import.meta.url), "utf8"),
    }),
  );
  await page.goto("/tests/office/precision.html");
  await page.waitForFunction(() => typeof window.officeVerify === "function");
});
test("replacement crosses formatting runs and a single Undo restores the original", async ({
  page,
}) => {
  const r = await page.evaluate(() => window.officeVerify("replace"));
  expect(r.result?.ok).toBe(true);
  expect(r.content).toBe("The application is denied.");
  expect(r.restored).toBe(true);
  expect(r.undone).toBe(true);
});
test("table-cell replacements share the same atomic transaction", async ({ page }) => {
  const r = await page.evaluate(() => window.officeVerify("table"));
  expect(r.result?.ok).toBe(true);
  expect(r.content).not.toContain("motion");
  expect(r.restored).toBe(true);
});
test("a later occurrence-count mismatch rolls back the entire command batch", async ({ page }) => {
  const r = await page.evaluate(() => window.officeVerify("atomic"));
  expect(r.result?.ok).toBe(false);
  expect(r.after).toEqual(r.before);
  expect(r.undone).toBe(false);
});
test("styling a split phrase retains its original bold and italic marks", async ({ page }) => {
  const r = await page.evaluate(() => window.officeVerify("style"));
  expect(r.result?.ok).toBe(true);
  expect(JSON.stringify(r.after)).toContain("bold");
  expect(JSON.stringify(r.after)).toContain("italic");
  expect(JSON.stringify(r.after)).toContain("#CC0000");
  expect(r.content).toBe("The motion is granted.");
  expect(r.restored).toBe(true);
});
test("real Mermaid rendering retains editable source and vector output", async ({ page }) => {
  const r = await page.evaluate(() => window.officeVerify("diagram"));
  expect(r.source).toContain("Evidence");
  expect(r.width).toBeGreaterThan(0);
  expect(r.svg).toBe(true);
  expect(r.base64).toBeGreaterThan(100);
});
