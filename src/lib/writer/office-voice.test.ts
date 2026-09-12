import test from "node:test";
import assert from "node:assert/strict";
import { VoiceTaskRouter, type VoiceTaskAdapter } from "../../office/shared/voice-task-router.ts";

function fixture() {
  const calls: string[] = [];
  let busy = false,
    available = true;
  const adapter: VoiceTaskAdapter = {
    available: () => available,
    status: () => ({
      busy,
      stopping: false,
      turn: 1,
      pending: 0,
      response: "Actual task response",
    }),
    start: (text) => {
      calls.push(`start:${text}`);
      busy = true;
    },
    steer: (text) => {
      calls.push(`steer:${text}`);
      return { accepted: true };
    },
    stop: () => {
      calls.push("stop");
      busy = false;
    },
  };
  const router = new VoiceTaskRouter(adapter);
  return {
    router,
    calls,
    busy: (v: boolean) => {
      busy = v;
    },
    available: (v: boolean) => {
      available = v;
    },
    run: (id: string, name: string, input = {}) => JSON.parse(router.dispatch(id, name, input)),
  };
}
test("voice reads real status without authorizing an edit", () => {
  const f = fixture();
  assert.equal(f.run("1", "task_status").response, "Actual task response");
  assert.match(f.run("2", "start_task", { instruction: "Edit" }).error, /spoken/);
  assert.deepEqual(f.calls, []);
});
test("new speech authorizes one submitted task, never a completion claim", () => {
  const f = fixture();
  f.router.heardUser();
  const r = f.run("1", "start_task", { instruction: "Draft a summary" });
  assert.equal(r.submitted, true);
  assert.match(r.note, /does not mean work is complete/);
  assert.deepEqual(f.calls, ["start:Draft a summary"]);
});
test("duplicate provider tool IDs return the original result without rerunning", () => {
  const f = fixture();
  f.router.heardUser();
  const r = f.run("1", "start_task", { instruction: "Draft" });
  assert.deepEqual(f.run("1", "start_task", { instruction: "Draft" }), r);
  assert.equal(f.calls.length, 1);
});
test("another tool ID in the same utterance cannot duplicate a write", () => {
  const f = fixture();
  f.router.heardUser();
  f.run("1", "start_task", { instruction: "Draft" });
  f.busy(false);
  assert.match(f.run("2", "start_task", { instruction: "Draft" }).error, /new spoken/);
  assert.equal(f.calls.length, 1);
});
test("renewal history cannot authorize new work", () => {
  const f = fixture();
  f.router.heardUser();
  f.router.renew();
  assert.match(f.run("1", "start_task", { instruction: "Repeat history" }).error, /new spoken/);
});
test("running tasks accept explicit steering instead of a competing task", () => {
  const f = fixture();
  f.busy(true);
  f.router.heardUser();
  assert.match(f.run("1", "start_task", { instruction: "Change tone" }).error, /already/);
  assert.equal(f.run("2", "steer_task", { instruction: "Change tone" }).accepted, true);
  assert.deepEqual(f.calls, ["steer:Change tone"]);
});
test("voice is revoked if the document or mode changes", () => {
  const f = fixture();
  f.router.heardUser();
  f.available(false);
  assert.match(f.run("1", "start_task", { instruction: "Edit" }).error, /changed/);
  assert.deepEqual(f.calls, []);
});
test("unknown tools and oversized input cannot execute", () => {
  const f = fixture();
  f.router.heardUser();
  assert.match(f.run("1", "execute_python").error, /Unknown/);
  assert.match(f.run("2", "start_task", { instruction: "x".repeat(2001) }).error, /2,000/);
  assert.deepEqual(f.calls, []);
});
test("explicit stop acknowledges retained edits", () => {
  const f = fixture();
  f.router.heardUser();
  assert.match(f.run("1", "stop_task").note, /Earlier edits remain/);
  assert.deepEqual(f.calls, ["stop"]);
});

test("failed acknowledgments do not turn into repeated writes", () => {
  let calls = 0;
  const router = new VoiceTaskRouter({
    available: () => true,
    status: () => ({ busy: false, stopping: false, turn: 0, pending: 0, response: "" }),
    start: () => {
      calls++;
      throw new Error("Unavailable");
    },
    stop: () => {},
    steer: () => ({ accepted: false }),
  });
  router.heardUser();
  const first = router.dispatch("1", "start_task", { instruction: "Draft" });
  assert.match(first, /could not acknowledge/);
  assert.equal(router.dispatch("1", "start_task", { instruction: "Draft" }), first);
  assert.match(router.dispatch("2", "start_task", { instruction: "Draft" }), /new spoken/);
  assert.equal(calls, 1);
});
