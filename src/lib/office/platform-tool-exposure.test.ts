import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";
import ts from "typescript";
import { getFirmGuide, listFirmGuides } from "./guides";
import type { AgentSkill } from "../../writer/packages/agent-core/src/skill";
import type { PlatformSkillOptions } from "../../office/shared/platform-skill";

// Exercise the real browser factory and dispatch seam without importing a DOM,
// cloud clients or TanStack's server-function transform into this unit process.
const source = readFileSync(new URL("../../office/shared/platform-skill.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("platform-skill.ts", source, ts.ScriptTarget.Latest, true);
let isolated = source;
for (const node of [...tree.statements].reverse()) {
  if (ts.isImportDeclaration(node)) isolated = isolated.slice(0, node.getFullStart()) + isolated.slice(node.end);
}
isolated = isolated.replaceAll('import("@/lib/office/tools.functions")', "Promise.resolve(guideApi)");
const compiled = (await transform(isolated, { loader: "ts", format: "esm" })).code
  .replace(/export\s*\{[\s\S]*?\};?\s*$/, "");
const createSkill = new Function("guideApi", "withToolContrast", "PLATFORM_TOOL_CONTRAST", `${compiled}\nreturn createPlatformSkill;`)(
  { officeGuideFn: async ({ data }: { data: { name: string } }) => {
    const guide = getFirmGuide(data.name);
    return guide ? { guide } : { guides: listFirmGuides() };
  } },
  (tools: unknown) => tools,
  {},
) as (options: PlatformSkillOptions) => AgentSkill;

describe("actual platform tool exposure", () => {
  test("template tools reflect editor hooks instead of advertising an unavailable capture", () => {
    const apply = async () => ({ output: "applied", mutated: true, summary: "Applied template" });
    for (const app of ["writer", "sheets", "slides"] as const) {
      const withoutHooks = createSkill({ app }).tools.map(tool => tool.name);
      assert.ok(!withoutHooks.includes("list_templates"));
      assert.ok(!withoutHooks.includes("apply_template"));
      assert.ok(!withoutHooks.includes("save_template"));
      const applyOnly = createSkill({ app, templates: { apply } }).tools.map(tool => tool.name);
      assert.ok(applyOnly.includes("list_templates"));
      assert.ok(applyOnly.includes("apply_template"));
      assert.ok(!applyOnly.includes("save_template"));
      const capture = async () => ({ format: "html" as const, html: "<p>Native</p>" });
      const complete = createSkill({ app, templates: { apply, capture } }).tools.map(tool => tool.name);
      assert.ok(complete.includes("save_template"));
      assert.equal(new Set(complete).size, complete.length);
      assert.ok(!createSkill({ app, templates: { apply, capture }, exclude: ["save_template"] }).tools.some(tool => tool.name === "save_template"));
    }
  });

  test("all three native editors discover and load the workflow through the real guide handler", async () => {
    const guide = getFirmGuide("native-office-workflow")!;
    assert.deepEqual(guide.apps, ["writer", "sheets", "slides"]);
    for (const app of guide.apps) {
      const skill = createSkill({ app });
      assert.ok(skill.tools.find(tool => tool.name === "load_firm_guide")?.description.includes(guide.id));
      const catalog = await skill.executeTool({ id: "catalog", name: "load_firm_guide", input: {} });
      assert.ok(catalog.output.includes(guide.id));
      const loaded = await skill.executeTool({ id: "workflow", name: "load_firm_guide", input: { name: guide.id } });
      assert.equal(loaded.output, guide.body);
      assert.equal(loaded.mutated, false);
      assert.notEqual(loaded.isError, true);
    }
  });
});
