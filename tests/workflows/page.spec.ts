import { test, expect, type Page } from "@playwright/test";
import { createRun, advanceRun } from "../../src/lib/workflows/engine";
import type { Workflow, WorkflowRun } from "../../src/lib/workflows/types";
import JSZip from "jszip";

// Browser-only transport fixtures. The production app has no fixture flag or auth bypass.
async function workspace(page: Page, { enabled = true, conflict = false } = {}) {
  const flows = new Map<string, Workflow>(),
    runs = new Map<string, WorkflowRun>();
  const user = {
    sub: "50d5f0b2-aa96-4c65-8d6f-953a30fae6cb",
    name: "Workflow QA",
    email: "qa@example.test",
    groups: ["QA Litigation"],
    role: "user",
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (url.pathname === "/api/auth/me") return json({ user });
    if (url.pathname !== "/api/workflows") return json({});
    if (route.request().method() === "GET") {
      if (url.searchParams.get("view") === "capabilities")
        return json({
          enabled,
          queue: enabled,
          scheduler: enabled,
          python: false,
          groups: user.groups,
        });
      if (url.searchParams.get("view") === "runs") return json([...runs.values()]);
      if (url.searchParams.get("view") === "run")
        return json(runs.get(url.searchParams.get("id")!));
      if (url.searchParams.get("view") === "sources") return json([]);
      return json([...flows.values()]);
    }
    const b = route.request().postDataJSON();
    if (b.action === "save") {
      if (conflict && b.revision)
        return json({ error: "This workflow changed in another session." }, 409);
      const f = {
        ...b.flow,
        revision: (b.revision || 0) + 1,
        ownerId: user.sub,
        createdBy: user.name,
        access: "owner",
      };
      flows.set(f.id, f);
      return json(f);
    }
    const f = flows.get(b.id)!;
    if (b.action === "publish") {
      f.publishedAt = new Date().toISOString();
      f.publishedGraph = structuredClone({ nodes: f.nodes, edges: f.edges });
      f.version++;
      f.dirty = false;
      f.revision!++;
      return json(f);
    }
    if (b.action === "share") {
      f.sharing = b.value;
      f.revision!++;
      return json(f);
    }
    if (b.action === "schedule") {
      f.schedule = b.value;
      f.revision!++;
      return json(f);
    }
    if (b.action === "start") {
      const initial = createRun(f, b.inputs);
      initial.mode = "connected";
      initial.id = b.requestId;
      const run = await advanceRun(initial);
      runs.set(run.id, run);
      return json(run, 202);
    }
    if (b.action === "delete") {
      flows.delete(b.id);
      return json(f);
    }
    return json({ error: "Unexpected test operation" }, 400);
  });
  return { flows, runs };
}
test("native authenticated shell, usable catalog, and no seeded records", async ({ page }) => {
  await workspace(page);
  await page.goto("/workflows");
  await expect(page.getByRole("heading", { name: "Workflows", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Workflows", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("tab", { name: "Mini apps 11" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "My workflows 0" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Run history 0" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Load realistic sample/ })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Litigation stage" }).selectOption("Settlement");
  await expect(
    page.getByRole("heading", { name: "Settlement packet readiness", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: ".workflows.local/workflows-library.png" });
});
test("create, edit, save, publish, share, and run real source text", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await workspace(page);
  await page.goto("/workflows");
  await page.getByRole("button", { name: "New workflow", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Workflow name" }).fill("QA evidence process");
  await dialog.getByRole("button", { name: "Create blank workflow" }).click();
  await expect(page.getByRole("textbox", { name: "Workflow name" })).toHaveValue(
    "QA evidence process",
  );
  await page.getByRole("textbox", { name: "Workflow name" }).fill("QA evidence process revised");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Saved to workspace", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish version 1" }).click();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByRole("combobox", { name: "Who can access" }).selectOption("teams");
  await page.getByRole("checkbox", { name: "QA Litigation" }).check();
  await page.getByRole("button", { name: "Save access settings" }).click();
  await page.getByRole("button", { name: "Test run", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Source text", exact: true })
    .fill("Source QA-1. The complete source text must reach the final output.");
  await page.getByRole("button", { name: "Start test run" }).click();
  await expect(page.getByText("completed", { exact: true }).first()).toBeVisible();
  await page.locator("summary").filter({ hasText: "Event log" }).click();
  await expect(page.getByText("Workflow completed. Outputs are ready for review.")).toBeVisible();
  await page.getByRole("button", { name: "Close run panel" }).click();
  await page.screenshot({ path: ".workflows.local/workflows-builder.png" });
  expect(errors).toEqual([]);
});
test("save conflict preserves unsaved changes and offers export", async ({ page }) => {
  await workspace(page, { conflict: true });
  await page.goto("/workflows");
  await page.getByRole("button", { name: "New workflow", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Workflow name" })
    .fill("Conflict test");
  await page.getByRole("button", { name: "Create blank workflow" }).click();
  await page.getByRole("textbox", { name: "Workflow name" }).fill("Keep my unsaved work");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("This workflow changed in another session.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Workflow name" })).toHaveValue(
    "Keep my unsaved work",
  );
  await expect(page.getByRole("button", { name: "Export workflow", exact: true })).toBeVisible();
});
test("mini app opens its form, reads an upload, exports evidence and saves a Word document", async ({
  page,
}) => {
  const { runs } = await workspace(page);
  let officeBody: Buffer | null = null;
  await page.route("**/api/office/docs", async (route) => {
    officeBody = route.request().postDataBuffer();
    expect(route.request().headers()["x-office-kind"]).toBe("docx");
    return route.fulfill({
      json: { draftId: "qa-document", name: "Evidence report.docx", kind: "docx" },
    });
  });
  await page.goto("/workflows");
  await page.getByRole("textbox", { name: "Search workflows" }).fill("Custom intake extractor");
  await page.getByRole("button", { name: "Use mini app", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run app", exact: true })).toBeVisible();
  await page.getByLabel("Field labels to extract").fill("Client ID, Plaintiff, Product");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "fact-sheet.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "Client ID: QA-CONTENT-77\nPlaintiff: Test Person\nProduct: Documented product\n",
      ),
    });
  await expect(page.getByText("fact-sheet.txt", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Run app", exact: true }).click();
  await expect(page.getByText("Ready for review", { exact: true }).first()).toBeVisible();
  expect([...runs.values()][0].inputs.files[0].text).toContain("QA-CONTENT-77");
  await page.getByRole("button", { name: "Save to Office", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open in Word editor" })).toHaveAttribute(
    "href",
    "/office/drafts/qa-document",
  );
  const zip = await JSZip.loadAsync(officeBody!);
  expect(await zip.file("word/document.xml")!.async("string")).toContain("QA-CONTENT-77");
  await page.screenshot({ path: ".workflows.local/workflows-mini-app.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Run app", exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await page.screenshot({ path: ".workflows.local/workflows-mobile.png" });
});
test("deployment gate is visible, and real unauthenticated API access is denied", async ({
  page,
  request,
}) => {
  const response = await request.get("/api/workflows");
  expect(response.status()).toBe(401);
  await workspace(page, { enabled: false });
  await page.goto("/workflows");
  await expect(page.getByRole("heading", { name: "Workflows is not enabled here" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New workflow" })).toHaveCount(0);
});
