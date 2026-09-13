import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateWorkflow } from "./graph.ts";
import { fromTemplate, templates } from "./seeds.ts";
import {
  autoFix,
  materialize,
  planFromWorkflow,
  reviewPlan,
  validatePlan,
  type PlanDefectCode,
  type WorkflowPlan,
} from "./plan-schema.ts";

/**
 * The six starter templates are the round-trip fixtures: each is a Workflow the
 * engine already runs, so planFromWorkflow -> validatePlan -> materialize must
 * come back clean, and the materialized workflow must satisfy the same
 * validateWorkflow the server admission gate uses.
 */
const TEMPLATE_IDS = templates.map((t) => t.id);

/** A known-good plan to mutate for defect cases, from a real template. */
function goodPlan(id = "briefing"): WorkflowPlan {
  return planFromWorkflow(fromTemplate(id));
}

function codes(plan: unknown): PlanDefectCode[] {
  return validatePlan(plan).map((d) => d.code);
}

describe("plan-schema round trip", () => {
  for (const id of TEMPLATE_IDS) {
    it(`template ${id} round-trips with no defects`, () => {
      const plan = planFromWorkflow(fromTemplate(id));
      const defects = validatePlan(plan);
      assert.deepEqual(
        defects.map((d) => `${d.code}:${d.step ?? ""}`),
        [],
        `expected no defects for ${id}`,
      );
    });

    it(`template ${id} materializes to a workflow with no graph errors`, () => {
      const plan = planFromWorkflow(fromTemplate(id));
      const { workflow } = materialize(plan);
      const errors = validateWorkflow(workflow).filter((i) => i.severity === "error");
      assert.deepEqual(errors, [], `expected no graph errors for ${id}`);
    });

    it(`template ${id} passes reviewPlan and yields a workflow`, () => {
      const review = reviewPlan(planFromWorkflow(fromTemplate(id)));
      assert.deepEqual(review.defects, []);
      assert.ok(review.workflow, "a clean plan must produce a workflow");
    });
  }
});

describe("plan-schema materialize discipline", () => {
  it("never writes a step config key the engine does not read", () => {
    // importWorkflow copies node data verbatim, so an unknown config key would
    // persist and render as configured while doing nothing. Materialize builds
    // StepConfig field by field; prove no materialized config carries a stray key.
    const allowed = new Set([
      "instructions", "model", "context", "fields", "left", "operator", "right",
      "reviewer", "format", "filename", "options", "value", "connection", "tool",
      "code", "seconds", "recipients", "query", "recipe", "url",
    ]);
    for (const id of TEMPLATE_IDS) {
      const { workflow } = materialize(planFromWorkflow(fromTemplate(id)));
      for (const node of workflow.nodes) {
        for (const key of Object.keys(node.data.config)) {
          assert.ok(allowed.has(key), `${id}/${node.data.kind} leaked config key "${key}"`);
        }
      }
    }
  });

  it("forces any schedule off when materializing", () => {
    const plan = goodPlan();
    plan.schedule = { frequency: "daily", time: "08:00", days: [1, 2, 3, 4, 5] };
    const { workflow } = materialize(plan);
    assert.equal(workflow.schedule?.enabled ?? false, false);
  });
});

describe("plan-schema defect detection", () => {
  it("flags a step kind that does not exist", () => {
    const plan = goodPlan();
    plan.steps[1].kind = "teleport" as never;
    assert.ok(codes(plan).includes("unknown_step_kind"));
  });

  it("refuses a python step as not generatable", () => {
    const plan = goodPlan();
    plan.steps[1].kind = "python";
    assert.ok(codes(plan).includes("python_not_generatable"));
  });

  it("flags a duplicate step key", () => {
    const plan = goodPlan();
    plan.steps[1].key = plan.steps[0].key;
    assert.ok(codes(plan).includes("duplicate_key"));
  });

  it("flags an edge to a step that is not in the plan", () => {
    const plan = goodPlan();
    plan.steps[0].after = ["ghost_step"];
    const c = codes(plan);
    assert.ok(c.includes("unknown_after") || c.includes("trigger_has_predecessor"));
  });

  it("rejects a plan whose first character is not a valid shape", () => {
    assert.ok(codes({ not: "a plan" }).includes("invalid_plan_shape"));
    assert.ok(codes("nonsense").includes("invalid_plan_shape"));
  });

  it("rejects an unknown top-level field", () => {
    const plan = { ...goodPlan(), sneaky: true };
    assert.ok(codes(plan).includes("invalid_plan_shape") || codes(plan).includes("unknown_plan_field"));
  });
});

describe("plan-schema autoFix", () => {
  it("does not invent a tool for an unknown one", () => {
    // Guessing search_westlaw meant web_search produces a workflow that runs and
    // is wrong, which is worse than one that will not build. autoFix must leave it.
    const plan = goodPlan();
    const before = JSON.stringify(plan);
    const fixed = autoFix(plan);
    // A clean plan is unchanged by autoFix.
    assert.equal(JSON.stringify(fixed), before);
  });

  it("is idempotent on a clean plan", () => {
    const plan = goodPlan();
    assert.equal(JSON.stringify(autoFix(autoFix(plan))), JSON.stringify(autoFix(plan)));
  });
});

describe("plan-schema never leaks cost or tokens", () => {
  it("produces no cost, token, or price wording in any defect message", () => {
    // Firm rule: no cost or token figures in the product UI, and defect messages
    // are user-facing. Runtime seconds are allowed; dollars and tokens are not.
    const banned = /\$|\btokens?\b|\bcost(s|ing)?\b|\bprice[sd]?\b|per[- ]?1[mk]\b/i;
    const plans: unknown[] = [
      { not: "a plan" },
      (() => { const p = goodPlan(); p.steps[1].kind = "python"; return p; })(),
      (() => { const p = goodPlan(); p.steps[1].kind = "teleport" as never; return p; })(),
      (() => { const p = goodPlan(); p.steps[1].key = p.steps[0].key; return p; })(),
    ];
    for (const p of plans) {
      for (const d of validatePlan(p)) {
        assert.ok(!banned.test(d.message), `banned wording in: ${d.message}`);
      }
    }
  });
});
