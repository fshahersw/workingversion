/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { blankWorkflow, fromTemplate, templates } from "../../src/lib/workflows/seeds";
import { appTemplates, createAppWorkflow } from "../../src/lib/workflows/app-templates";
import { firmRoles } from "../../src/lib/workflows/practice-templates";
import { validateWorkflow } from "../../src/lib/workflows/graph";
import { advanceRun, createRun, conditionMatches, reviewRun } from "../../src/lib/workflows/engine";
import {
  inputsSchema,
  permission,
  authorize,
  validateSharing,
  canReadRun,
  canReview,
  assertSameOrigin,
  assertRunnable,
} from "../../src/lib/workflows/policy";
import { makeStep } from "../../src/lib/workflows/catalog";
import { documentChunks, createGroundedAdapter } from "../../src/lib/workflows/grounded-adapter";
import { nextScheduledRun } from "../../src/lib/workflows/schedule";
import { artifactBlob, reportDocumentBlob, readSourceFile } from "../../src/lib/workflows/files";
import JSZip from "jszip";
import { isAnalysisReport } from "../../src/lib/workflows/recipes";
import type { RunInputs } from "../../src/lib/workflows/types";

// Synthetic inputs exist only inside tests. The production catalog never imports them.
const input: RunInputs = {
  text: "Client ID: QA-1\nPlaintiff: Test Person\nProduct: Recorded product\nNo date was supplied.",
  matter: "Unit test",
  selection: "Attorney review",
  files: [],
};
const owner = { sub: crypto.randomUUID(), email: "owner@example.test", groups: ["Litigation"] };
const teammate = {
  sub: crypto.randomUUID(),
  email: "reviewer@example.test",
  groups: ["Litigation"],
};
const stranger = { sub: crypto.randomUUID(), email: "outsider@example.test", groups: [] };

describe("templates are definitions, never seeded case records", () => {
  test("all legal apps and foundational patterns form valid graphs", () => {
    expect(appTemplates.length).toBe(56);
    expect(firmRoles.length).toBe(15);
    for (const template of appTemplates) {
      const flow = createAppWorkflow(template.id, true);
      expect(validateWorkflow(flow).filter((i) => i.severity === "error")).toEqual([]);
      expect(flow.createdBy).toBe("");
      expect(flow.schedule.enabled).toBe(false);
      expect(flow.sharing.visibility).toBe("private");
      expect(flow.version).toBe(0);
      expect(template.guide?.reviewChecks.length).toBeGreaterThan(0);
      expect(JSON.stringify(flow)).not.toMatch(/Mark Garner|Scott Siegal|@example\.com|SYNTHETIC/);
    }
    for (const t of templates)
      expect(validateWorkflow(fromTemplate(t.id)).filter((i) => i.severity === "error")).toEqual(
        [],
      );
  });
  test("invalid and oversized source sets fail without truncation", () => {
    expect(() => inputsSchema.parse({ ...input, text: "x".repeat(1_000_001) })).toThrow();
    const f = { id: "same", name: "file.txt", text: "Data", size: 4 };
    expect(() => inputsSchema.parse({ ...input, files: [f, f] })).toThrow();
    expect(() => inputsSchema.parse({ ...input, files: [{ ...f, text: "" }] })).toThrow();
  });
});
describe("permissions and decisions", () => {
  const access = {
    owner: owner.sub,
    sharing: { visibility: "teams" as const, teams: ["Litigation"], permission: "run" as const },
  };
  test("group grants do not become ownership or editing rights", () => {
    expect(permission(owner, access)).toBe("owner");
    expect(permission(teammate, access)).toBe("run");
    expect(() => authorize(teammate, access, "edit")).toThrow();
    expect(() => authorize(stranger, access)).toThrow();
    expect(permission(owner, { ...access, deleted: true })).toBeUndefined();
  });
  test("users cannot grant arbitrary groups or inherit another user’s document access", () => {
    expect(() => validateSharing({ ...access.sharing, teams: ["Finance"] }, owner)).toThrow();
    expect(canReadRun(teammate, owner.sub, stranger.sub, [])).toBe(false);
    expect(canReadRun(teammate, owner.sub, stranger.sub, [teammate.email])).toBe(true);
  });
  test("mutations require matching browser origin and JSON", () => {
    expect(() =>
      assertSameOrigin(
        new Request("https://app.example.test/api/workflows", {
          method: "POST",
          headers: { origin: "https://evil.test", "content-type": "application/json" },
        }),
      ),
    ).toThrow();
    expect(() =>
      assertSameOrigin(
        new Request("https://app.example.test/api/workflows", {
          method: "POST",
          headers: {
            origin: "https://app.example.test",
            "content-type": "application/json",
            "sec-fetch-site": "same-origin",
          },
        }),
      ),
    ).not.toThrow();
  });
  test("unknown condition inputs stop instead of taking a false branch", () => {
    const step = makeStep("condition", 1, { x: 0, y: 0 });
    expect(() => conditionMatches(step, {})).toThrow("missing or unknown");
    step.data.config.operator = "exists";
    expect(conditionMatches(step, {})).toBe(false);
  });
});
describe("durable engine behavior", () => {
  test("checkpoints are awaited; restarting never repeats a completed step", async () => {
    const flow = blankWorkflow();
    const initial = createRun(flow, input);
    let writes = 0;
    const first = await advanceRun(initial, {
      maxSteps: 1,
      onUpdate: async () => {
        await Promise.resolve();
        writes++;
      },
    });
    expect(first.status).toBe("running");
    expect(first.results.start.status).toBe("completed");
    expect(writes).toBeGreaterThan(1);
    const startTime = first.results.start.endedAt;
    const completed = await advanceRun(first, { maxSteps: 1 });
    expect(completed.status).toBe("completed");
    expect(completed.results.start.endedAt).toBe(startTime);
    expect(completed.results.finish.output).toMatchObject({
      text: expect.stringContaining("QA-1"),
    });
  });
  test("review requires the assigned real principal, and resumes with an audit decision", async () => {
    const flow = blankWorkflow();
    const review = makeStep("review", 2, { x: 0, y: 80 });
    review.data.config.reviewer = teammate.email;
    flow.nodes.splice(1, 0, review);
    flow.edges = [
      { id: "a", source: "start", target: review.id },
      { id: "b", source: review.id, target: "finish" },
    ];
    const waiting = await advanceRun(createRun(flow, input));
    expect(waiting.status).toBe("waiting");
    expect(canReview(owner, owner.sub, waiting)).toBe(false);
    expect(canReview(teammate, owner.sub, waiting)).toBe(true);
    const approved = reviewRun(waiting, true, teammate.email, "Reviewed source text.");
    const completed = await advanceRun(approved);
    expect(completed.status).toBe("completed");
    expect(JSON.stringify(completed.results.finish.output)).toContain("QA-1");
    expect(approved.logs.at(-1)?.message).toContain(teammate.email);
    expect(() => reviewRun(approved, true, owner.email, "")).toThrow();
  });
  test("missing services fail instead of manufacturing an AI result", async () => {
    const f = fromTemplate("deposition");
    const r = await advanceRun(createRun(f, input));
    expect(r.status).toBe("failed");
    expect(r.logs.at(-1)?.message).toContain("server analysis");
  });
  test("recipe reports can run with source input and create real downloadable artifact content", async () => {
    const f = createAppWorkflow("pfs-completeness");
    const r = await advanceRun(createRun(f, input));
    expect(r.status).toBe("completed");
    expect(r.artifacts.length).toBeGreaterThan(0);
    expect(r.artifacts.some((a) => a.format === "docx")).toBe(true);
    expect(r.artifacts.map((a) => a.content).join("\n")).toContain("QA-1");
  });
  test("required app fields are validated server-side", () => {
    const f = createAppWorkflow("web-research");
    expect(() => assertRunnable(f, input)).toThrow();
  });
  test("source warnings need acknowledgement and supplied context is not dropped beside uploads", async () => {
    const source = {
      id: "file-1",
      name: "source.txt",
      text: "File evidence",
      size: 13,
      metadata: {
        format: "text",
        warnings: ["Page needs review"],
        extractedAt: new Date().toISOString(),
      },
    };
    const values = { ...input, files: [source] };
    expect(() => assertRunnable(createAppWorkflow("pfs-completeness"), values)).toThrow(
      "acknowledge",
    );
    const step = makeStep("files", 1, { x: 0, y: 0 });
    const { executeLocalStep } = await import("../../src/lib/workflows/engine");
    const output = await executeLocalStep(step, {
      inputs: values,
      files: values.files,
      values: {},
    });
    expect(JSON.stringify(output)).toContain("File evidence");
    expect(JSON.stringify(output)).toContain("QA-1");
    expect(() =>
      assertRunnable(createAppWorkflow("pfs-completeness"), {
        ...values,
        fields: { coverageAcknowledged: "true" },
      }),
    ).not.toThrow();
  });
  test("Word exports contain source evidence, and source ingestion preserves complete text", async () => {
    const source = await readSourceFile(
      new File([input.text], "fact-sheet.txt", { type: "text/plain" }),
    );
    expect(source.text).toBe(input.text);
    expect(source.metadata?.sha256).toHaveLength(64);
    const run = await advanceRun(
      createRun(createAppWorkflow("pfs-completeness"), { ...input, text: "", files: [source] }),
    );
    const report = Object.values(run.results)
      .map((r) => r.output)
      .find(isAnalysisReport)!;
    const docx = await reportDocumentBlob(report);
    const archive = await JSZip.loadAsync(await docx.arrayBuffer());
    const xml = await archive.file("word/document.xml")!.async("string");
    expect(xml).toContain("QA-1");
    expect(xml).toContain("Source / evidence");
    const artifact = await artifactBlob(run.artifacts.find((a) => a.format === "docx")!);
    expect(
      await (await JSZip.loadAsync(await artifact.arrayBuffer()))
        .file("word/document.xml")!
        .async("string"),
    ).toContain("QA-1");
  });
});
describe("grounded analysis", () => {
  test("every physical source line is covered, including long lines and later pages", () => {
    const text = "[Page 1]\n" + "A".repeat(250) + "\n[Page 2]\nFinal evidence.";
    const chunks = documentChunks(
      [{ id: "source", name: "source.txt", text, size: text.length }],
      100,
    );
    expect(chunks.some((c) => c.page === 2 && c.text.includes("Final evidence."))).toBe(true);
    expect(
      chunks
        .map((c) => c.text)
        .join("")
        .match(/A/g)?.length,
    ).toBe(250);
  });
  test("invented quotes and invalid line anchors never enter the report", async () => {
    const step = makeStep("recipe", 1, { x: 0, y: 0 });
    step.data.config.model = "bedrock";
    const adapter = createGroundedAdapter({
      analyze: async (req) => ({
        findings: [
          {
            topic: "Fact",
            value: "Invented",
            sourceId: req.chunk.sourceId,
            line: req.chunk.startLine,
            quote: "This is not in the source.",
          },
        ],
      }),
    });
    await expect(
      adapter.executeStep!(step, { inputs: input, values: {}, files: [] }),
    ).rejects.toThrow("not present");
  });
  test("daily schedule advances across daylight saving using the chosen time zone", () => {
    const schedule = {
      enabled: true,
      frequency: "daily" as const,
      time: "09:00",
      timezone: "America/New_York",
      days: [],
    };
    const next = nextScheduledRun(schedule, new Date("2026-03-07T15:00:00Z"));
    expect(next).toBe("2026-03-08T13:00:00.000Z");
  });
});
