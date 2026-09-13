import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseDepAnalysis } from "../../src/lib/pile/deposition-analysis";

const qaUser = {
  sub: "discovery-qa",
  name: "Discovery QA",
  email: "qa@example.test",
  role: "user",
  groups: [],
};

test("graph list, provenance filters, source navigation, export, and empty-filter recovery", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // TanStack owns HTML routes. Serve the component entry only inside this test.
  await page.route("**/tests/discovery/graph.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: readFileSync("tests/discovery/graph.html", "utf8"),
    }),
  );
  await page.goto("/tests/discovery/graph.html");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByText("4 relationships", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Evidence filter" }).selectOption("source_matched");
  await expect(page.getByText("3 relationships", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Search knowledge graph" }).fill("safety memorandum");
  await page
    .getByRole("region", { name: "Relationship list" })
    .getByRole("button", { name: /Jane Smith reviewed Safety/ })
    .click();
  await expect(page.getByRole("region", { name: "Relationship evidence" })).toBeVisible();
  await page.getByRole("button", { name: "Open 1:4" }).click();
  await expect(page.getByLabel("Opened citation")).toHaveText("Smith.txt 1:4");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toBe("deposition-relationships.csv");
  await page.getByRole("combobox", { name: "Evidence filter" }).selectOption("needs_review");
  await page.getByRole("textbox", { name: "Search knowledge graph" }).fill("");
  await page
    .getByRole("region", { name: "Relationship list" })
    .getByRole("button", { name: /Acme Corporation approved/ })
    .click();
  await expect(
    page.getByText("No supporting quotation was stored", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open 9:3" })).toHaveCount(0);
  await page.getByRole("button", { name: "Reset graph filters" }).click();
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await page.getByRole("button", { name: /View options/ }).click();
  for (const name of [/^Person \d+$/, /^Org \d+$/, /^Doc \d+$/, /^Theme \d+$/, /^Event \d+$/])
    await page.getByRole("button", { name }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByText("No entities match these filters.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Reset graph filters" }).click();
  await expect(page.getByText("No entities match these filters.", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: ".discovery.local/graph-desktop.png" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.screenshot({ path: ".discovery.local/graph-laptop.png" });
  expect(errors).toEqual([]);
});

test("native Discovery tabs open without seeded records or backend writes", async ({ page }) => {
  page.on("pageerror", (error) => console.error("Discovery browser:", error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("Discovery console:", message.text());
  });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path === "/api/auth/me" ? { user: qaUser } : {} });
  });
  await page.route("**/_serverFn/**", (route) =>
    route.fulfill({ json: { result: [], context: {} } }),
  );
  await page.goto("/docs?tab=deposition");
  await expect(page.getByRole("button", { name: "Read transcript", exact: true })).toBeVisible();
  await page.screenshot({ path: ".discovery.local/depositions-native.png" });
  await page.getByRole("tab", { name: /Working set/i }).click();
  await page.getByRole("tab", { name: /Tabular review/i }).click();
  await expect(page.getByText("No tables yet. Name one above to begin.")).toBeVisible();
});

test("completed deposition survives an analysis-save outage and retries without another model call", async ({
  page,
}) => {
  let modelCalls = 0;
  let analysisWrites = 0;
  let saveUnavailable = true;
  let pageLoads = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) pageLoads++;
  });
  const analysis = {
    summary: "Jane Smith described reviewing the safety memorandum in 2019.",
    admissions: [
      {
        title: "Reviewed safety memorandum",
        summary: "The witness described the review.",
        quote: "I reviewed the safety memorandum in 2019.",
        cite: "1:4",
        fileName: "Smith.txt",
      },
    ],
    graph: {
      nodes: [
        { id: "jane", label: "Jane Smith", kind: "person" },
        { id: "memo", label: "Safety memorandum", kind: "doc" },
      ],
      edges: [
        {
          from: "jane",
          to: "memo",
          label: "reviewed",
          quote: "I reviewed the safety memorandum in 2019.",
          cite: "1:4",
          fileName: "Smith.txt",
        },
      ],
    },
  };
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/pile/ask") {
      modelCalls++;
      return route.fulfill({
        contentType: "text/event-stream",
        body: `event: delta\ndata: ${JSON.stringify({ text: JSON.stringify(analysis) })}\n\nevent: done\ndata: {}\n\n`,
      });
    }
    if (path === "/api/discovery/analyze") {
      const input = route.request().postDataJSON();
      return route.fulfill({
        json:
          input.action === "scan"
            ? {
                complete: true,
                note: "",
                findings: [
                  {
                    finding: "Smith reviewed the safety memorandum in 2019.",
                    quote: "I reviewed the safety memorandum in 2019.",
                    page: input.pages[0].page,
                  },
                ],
              }
            : { answer: "Smith described reviewing the memorandum [S1]." },
      });
    }
    return route.fulfill({ json: path === "/api/auth/me" ? { user: qaUser } : {} });
  });
  await page.route("**/_serverFn/**", (route) => {
    const encoded = new URL(route.request().url()).pathname.split("/").pop()!;
    const name = JSON.parse(Buffer.from(decodeURIComponent(encoded), "base64url").toString())
      .export as string;
    if (name.startsWith("saveWorkspaceAnalysisFn_")) {
      analysisWrites++;
      return saveUnavailable
        ? route.fulfill({
            status: 503,
            contentType: "text/plain",
            body: "Analysis storage is temporarily unavailable.",
          })
        : route.fulfill({
            json: {
              result: { ok: true, analysis: { updatedAt: new Date().toISOString() } },
              context: {},
            },
          });
    }
    const result = name.startsWith("createUploadFn_")
      ? { uploadUrl: new URL("/api/qa-upload", page.url()).href, s3Key: "qa-only/Smith.txt" }
      : name.startsWith("saveWorkspaceFn_")
        ? {
            itemId: "qa-workspace",
            kbWorkspaceId: "qa-kb",
            status: "ready",
            stage: "ready",
            documents: [],
            pendingCount: 0,
            docCount: 1,
            chunkCount: 1,
          }
        : [];
    return route.fulfill({ json: { result, context: {} } });
  });
  await page.goto("/docs?tab=deposition");
  await page
    .getByRole("button", { name: "Choose deposition transcripts" })
    .locator('input[type="file"]')
    .setInputFiles({
      name: "Smith.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "DEPOSITION OF JANE SMITH\n1\n1 Q. Who employed you?\n2 A. I worked at Acme Corporation.\n3 Q. What did you review?\n4 A. I reviewed the safety memorandum in 2019.\n5 Q. What did you discuss?\n6 A. We discussed the safety review and the recall process.",
      ),
    });
  await page.getByRole("button", { name: "Read 1 transcript", exact: true }).click();
  await expect(page.getByRole("button", { name: "Re-run", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("analysis not saved", { exact: false })).toBeVisible({
    timeout: 20_000,
  });
  const callsBeforeRetry = modelCalls;
  expect(analysisWrites).toBeGreaterThanOrEqual(3);
  expect(callsBeforeRetry).toBeGreaterThan(0);
  await page.screenshot({ path: ".discovery.local/deposition-save-recovery.png" });
  saveUnavailable = false;
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(page.getByText("analysis not saved", { exact: false })).toHaveCount(0);
  await expect(page.getByText(/Saved · analysis \d/)).toBeVisible();
  await expect.poll(() => analysisWrites).toBeGreaterThan(3);
  expect(modelCalls).toBe(callsBeforeRetry);
  expect(pageLoads).toBe(1);
  await page.getByRole("button", { name: /^Connections/ }).click();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page
    .getByRole("region", { name: "Relationship list" })
    .getByRole("button", { name: /Jane Smith reviewed/ })
    .click();
  await page.getByRole("button", { name: "Open 1:4" }).click();
  await page.screenshot({ path: ".discovery.local/deposition-graph-native.png" });
  // The deposition tab always asks over the whole record; the scan-scope
  // control and coverage bar live only on the Working Set tab now.
  await expect(page.getByRole("combobox", { name: "Query coverage" })).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Ask", exact: true })
    .fill("When did Smith review the memorandum?");
  await page.locator("form").getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText("Draft synthesis", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Admissions/ }).click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Admissions", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Timeline", exact: true })).not.toBeChecked();
  await page.getByRole("combobox", { name: "Export format" }).selectOption("csv");
  const selectedExport = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export 1 section", exact: true }).click();
  const csv = await selectedExport;
  expect(csv.suggestedFilename()).toBe("deposition-admissions.csv");
  const exported = readFileSync((await csv.path())!, "utf8");
  expect(exported).toContain("Smith.txt");
  expect(exported).toContain("source_matched");
  await page.screenshot({ path: ".discovery.local/deposition-discovery-coverage.png" });
});

test("strict transcript extraction rejects over-limit text instead of omitting the ending", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.goto("/auth");
  const result = await page.evaluate(async () => {
    const { extractFile } = await import("/src/lib/extract-text.ts");
    const file = new File(
      [`${"a".repeat(2500)}\n\n${"b".repeat(2500)}\n\nimportant final testimony`],
      "long.txt",
      { type: "text/plain" },
    );
    try {
      await extractFile(file, undefined, undefined, { maxPages: 1, requireComplete: true });
      return "silently accepted";
    } catch (error) {
      return (error as Error).message;
    }
  });
  expect(result).toContain("Split the document before analysis");
});

test("a saved deposition reopens from checkpointed pages when the search index failed", async ({
  page,
}) => {
  let modelCalls = 0;
  const savedAnalysis = parseDepAnalysis(
    JSON.stringify({
      summary: "Jane Smith reviewed the safety memorandum in 2019.",
      graph: {
        nodes: [
          { id: "jane", label: "Jane Smith", kind: "person" },
          { id: "memo", label: "Safety memorandum", kind: "doc" },
        ],
        edges: [
          {
            from: "jane",
            to: "memo",
            label: "reviewed",
            quote: "I reviewed the safety memorandum in 2019.",
            fileName: "Smith.txt",
            cite: "1:2",
          },
        ],
      },
    }),
  );
  await page.addInitScript(() => sessionStorage.setItem("kb:reloadDeposition", "qa-saved"));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/pile/ask") modelCalls++;
    return route.fulfill({ json: path === "/api/auth/me" ? { user: qaUser } : {} });
  });
  await page.route("**/_serverFn/**", (route) => {
    const encoded = new URL(route.request().url()).pathname.split("/").pop()!;
    const name = JSON.parse(Buffer.from(decodeURIComponent(encoded), "base64url").toString())
      .export as string;
    const result = name.startsWith("getWorkspaceFn_")
      ? {
          itemId: "qa-saved",
          name: "Saved testimony",
          surface: "deposition",
          status: "error",
          kbWorkspaceId: "qa-kb",
          docs: [],
          recoverableDocs: [{ docId: "qa-doc", fileName: "Smith.txt", pageCount: 1 }],
        }
      : name.startsWith("getWorkspacePagesFn_")
        ? [
            {
              page: 1,
              text: "DEPOSITION OF JANE SMITH\n1\n1 Q. What did you review?\n2 A. I reviewed the safety memorandum in 2019.\n3 Q. Who employed you?\n4 A. I worked at Acme Corporation.\n5 Q. Did you attend the meeting?\n6 A. I attended the recall meeting.",
            },
          ]
        : name.startsWith("getWorkspaceAnalysisFn_")
          ? {
              version: 1,
              runId: "06b50748-f700-4566-a66b-2dc2fc99737b",
              runStartedAt: Date.now(),
              savedAt: new Date().toISOString(),
              complete: true,
              instructions: "",
              transcripts: [
                {
                  docId: "qa-doc",
                  fileName: "Smith.txt",
                  witness: "Jane Smith",
                  citeReady: true,
                  lineCount: 2,
                },
              ],
              passes: { case: "done", record: "done", connections: "done", cross: "done" },
              analysis: savedAnalysis,
            }
          : [];
    return route.fulfill({ json: { result, context: {} } });
  });
  await page.goto("/docs?tab=deposition");
  await expect(page.getByText("Analysis saved · index failed", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /^Connections/ }).click();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page
    .getByRole("region", { name: "Relationship list" })
    .getByRole("button", { name: /Jane Smith reviewed/ })
    .click();
  await expect(page.getByRole("button", { name: "Open 1:2" })).toBeVisible();
  expect(modelCalls).toBe(0);
});
