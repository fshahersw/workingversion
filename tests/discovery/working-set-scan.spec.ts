import { test, expect } from "@playwright/test";

test("working set full text Ask covers every uploaded document and reuses completed sections", async ({
  page,
}) => {
  const scanned: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            sub: "qa-scan",
            name: "Review QA",
            email: "qa@example.test",
            role: "user",
            groups: [],
          },
        },
      });
    if (path === "/api/discovery/analyze") {
      const body = route.request().postDataJSON();
      if (body.action === "scan") {
        scanned.push(body.fileName);
        return route.fulfill({
          json: {
            complete: true,
            findings: [
              {
                finding: "The document reports notice in May.",
                quote: "Notice was received in May.",
                page: body.pages[0].page,
              },
            ],
          },
        });
      }
      return route.fulfill({ json: { answer: "Both documents report notice in May [S1] [S2]." } });
    }
    return route.fulfill({ json: {} });
  });
  await page.route("**/_serverFn/**", (route) =>
    route.fulfill({ json: { result: [], context: {} } }),
  );
  await page.goto("/docs?tab=workingset");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles([
      {
        name: "Notice.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(
          "Notice was received in May. The witness explained that the safety memorandum was circulated to the review team. The meeting occurred in the following month.",
        ),
      },
      {
        name: "Witness.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(
          "Notice was received in May. This separate witness described receiving a copy of the memorandum before the committee met and discussed the product risks.",
        ),
      },
    ]);
  await page.getByRole("button", { name: /Open working set/ }).click();
  await expect(page.getByRole("combobox", { name: "Query coverage" })).toBeEnabled({
    timeout: 30_000,
  });
  await page
    .getByPlaceholder("Ask a question about these documents…")
    .fill("Compare when notice was received in every document.");
  await page.locator("form").getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText("Text scan complete", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(scanned.sort()).toEqual(["Notice.txt", "Witness.txt"]);
  await page.getByText("Text scan complete", { exact: true }).click();
  await expect(page.getByText("2/2 sections", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Retry using completed sections" }).click();
  await expect(page.getByText("2 reused", { exact: true })).toBeVisible();
  expect(scanned.length).toBe(2);
  await page.screenshot({ path: ".discovery.local/working-set-full-scan.png" });
  expect(errors).toEqual([]);
});
