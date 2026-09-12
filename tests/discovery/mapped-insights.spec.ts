import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

async function openGraph(page: Page) {
  await page.route("**/tests/discovery/graph.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: readFileSync("tests/discovery/graph.html", "utf8"),
    }),
  );
  await page.goto("/tests/discovery/graph.html#insights");
  await expect(page.getByRole("region", { name: "Mapped insights", exact: true })).toBeVisible();
}

async function expectFramed(page: Page, expectedCount?: number) {
  const selected = page.locator('[data-graph-node][aria-pressed="true"]');
  if (expectedCount) await expect(selected).toHaveCount(expectedCount);
  // Poll the real transformed bounds while the animated camera settles.
  await expect
    .poll(async () =>
      page.getByLabel("Knowledge graph canvas").evaluate((canvas) => {
        const box = canvas.getBoundingClientRect();
        const cards = [...canvas.querySelectorAll('[data-graph-node][aria-pressed="true"]')];
        return (
          cards.length > 0 &&
          cards.every((node) => {
            const rect = node.getBoundingClientRect();
            return (
              rect.left >= box.left + 15 &&
              rect.right <= box.right - 15 &&
              rect.top >= box.top + 15 &&
              rect.bottom <= box.bottom - 15
            );
          })
        );
      }),
    )
    .toBe(true);
}

test("insights map source-linked entities, frame them after resizing, and open the exact evidence", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openGraph(page);
  await page
    .getByRole("button", { name: "Map insight: Shared document: Safety memorandum", exact: true })
    .click();
  await expectFramed(page, 3);
  await expect(page.getByLabel("Current graph map")).toContainText(
    "Shared document: Safety memorandum",
  );
  await page.screenshot({ path: ".discovery.local/mapped-insights-desktop.png" });
  await page.setViewportSize({ width: 900, height: 720 });
  await expectFramed(page, 3);
  await page.screenshot({ path: ".discovery.local/mapped-insights-compact.png" });
  // Hide/reopen the inspector: its width/height changes must retain the focused group.
  await page.getByRole("button", { name: "Close mapped insights" }).click();
  await expectFramed(page, 3);
  await page.getByRole("button", { name: /^Mapped insights \d/ }).click();
  await expectFramed(page, 3);
  await page
    .getByRole("region", { name: "Mapped insights", exact: true })
    .getByRole("button", { name: /Robert Jones → Safety memorandum/ })
    .click();
  await expectFramed(page, 2);
  await page.getByRole("button", { name: "Open 1:2", exact: true }).click();
  await expect(page.getByLabel("Opened citation")).toHaveText("Jones.txt 1:2");
  await page.getByRole("button", { name: "Close relationship evidence" }).click();
  await expectFramed(page, 3);
  expect(errors).toEqual([]);
});

test("groups and source-matched paths map every member; recenter recovers after manual panning", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openGraph(page);
  await page.getByRole("button", { name: /^Groups \d/ }).click();
  await page
    .getByRole("button", { name: /^Map group:/ })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Mapped selection" })).toBeVisible();
  const count = await page.getByLabel("Current graph map").innerText();
  const memberCount = Number(count.match(/(\d+) entities/)?.[1]);
  expect(memberCount).toBeGreaterThan(1);
  await expectFramed(page, memberCount);
  await page.getByRole("button", { name: "Show full graph" }).click();
  await page.locator('[data-graph-node="jane"]').click();
  await page
    .getByRole("button", { name: /Map path/ })
    .first()
    .click();
  await expectFramed(page);
  await expect(page.getByRole("region", { name: "Mapped selection" })).toContainText(
    "original direction",
  );
  const box = await page.getByLabel("Knowledge graph canvas").boundingBox();
  await page.mouse.move(box!.x + 20, box!.y + 20);
  await page.mouse.wheel(650, 650);
  await page.getByRole("button", { name: "Recenter", exact: true }).click();
  await expectFramed(page);
  await page.getByRole("button", { name: "Use simple graph" }).click();
  await expect(page.getByLabel("Current graph map")).toHaveCount(0);
  await expect(page.locator("[data-graph-node]")).toHaveCount(4);
});

test("review insights retain paired source passages and do not treat unsupported links as patterns", async ({
  page,
}) => {
  await openGraph(page);
  await page
    .getByRole("group", { name: "Insight category" })
    .getByRole("button", { name: /^Review/ })
    .click();
  await page
    .getByRole("button", { name: "Map insight: Potential conflict: Timing of review", exact: true })
    .click();
  await expectFramed(page, 2);
  await page
    .getByRole("region", { name: "Mapped insights", exact: true })
    .getByRole("button", { name: /Jane Smith → Robert Jones/ })
    .click();
  const evidence = page.getByRole("region", { name: "Relationship evidence", exact: true });
  await expect(evidence).toContainText("Smith.txt");
  await expect(evidence).toContainText("Jones.txt");
  await expect(evidence.getByRole("button", { name: /^Open/ })).toHaveCount(2);
  await page.getByRole("button", { name: "Close relationship evidence" }).click();
  await expect(
    page.getByRole("button", {
      name: "Map insight: Potential conflict: Timing of review",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Map insight: 1 relationship needs source review", exact: true })
    .click();
  await expectFramed(page, 2);
  await page
    .getByRole("region", { name: "Mapped insights", exact: true })
    .getByRole("button", { name: /Acme Corporation → Safety memorandum/ })
    .click();
  await expect(evidence.getByRole("button", { name: /^Open/ })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Evidence filter" }).selectOption("source_matched");
  await expect(page.getByLabel("Current graph map")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Map insight: 1 relationship needs source review",
      exact: true,
    }),
  ).toHaveCount(0);
});
