import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("document-guided suggestions are editable and add only chosen columns", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/tests/discovery/columns.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: readFileSync("tests/discovery/columns.html", "utf8"),
    }),
  );
  await page.route("**/api/discovery/analyze", (route) => {
    const body = route.request().postDataJSON();
    expect(body.context).toContain("Safety memo.txt");
    expect(body.context).toContain("Deposition.txt");
    expect(body.query).toContain("notice");
    return route.fulfill({
      json: {
        columns: [
          {
            name: "Notice recipient",
            kind: "list",
            question:
              "Who received notice? Include every distinct recipient with supporting quotes.",
            options: [],
            reason: "Compare who knew of the risk.",
          },
          {
            name: "Notice date",
            kind: "date",
            question: "When was notice received? Preserve uncertainty and conflicting dates.",
            options: [],
            reason: "Build a chronology of notice.",
          },
        ],
      },
    });
  });
  await page.goto("/tests/discovery/columns.html");
  await page
    .getByRole("textbox", { name: "Review objective" })
    .fill("Trace notice across both documents");
  await page.getByRole("button", { name: "Suggest columns", exact: true }).click();
  await expect(page.getByText(/covering all 2 documents/)).toBeVisible();
  await page.getByRole("textbox", { name: "Column 1 name" }).fill("People with notice");
  await page.getByRole("checkbox", { name: "Include Notice date" }).uncheck();
  await page.screenshot({ path: ".discovery.local/review-column-builder.png" });
  await page.getByRole("button", { name: "Add selected columns" }).click();
  await expect(page.getByLabel("Added columns")).toContainText("People with notice");
  await expect(page.getByLabel("Added columns")).not.toContainText("Notice date");
  expect(errors).toEqual([]);
});

test("column suggestion failures keep the review objective and do not invent a fallback", async ({
  page,
}) => {
  await page.route("**/tests/discovery/columns.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: readFileSync("tests/discovery/columns.html", "utf8"),
    }),
  );
  await page.route("**/api/discovery/analyze", (route) =>
    route.fulfill({ status: 401, json: { error: "Sign in again to generate columns" } }),
  );
  await page.goto("/tests/discovery/columns.html");
  await page.getByRole("textbox", { name: "Review objective" }).fill("Find risk disclosures");
  await page.getByRole("button", { name: "Suggest columns", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Sign in again");
  await expect(page.getByRole("textbox", { name: "Review objective" })).toHaveValue(
    "Find risk disclosures",
  );
  await expect(page.getByRole("button", { name: "Add selected columns" })).toHaveCount(0);
});
