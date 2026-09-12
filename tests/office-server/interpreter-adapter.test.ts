// Separate suite: mocking the SDK here must not affect the platform unit process.
import { expect, mock, test } from "bun:test";
import { memoryInterpreterStore } from "../support/interpreter-store-fixture";
import {
  interpreterState,
  withInterpreterOwner,
  withInterpreterScope,
} from "../../src/lib/agents/interpreter-context.server";

let reply: () => Promise<unknown>;
let requests: { name?: string; sessionId?: string }[] = [];
let maxAttempts: number | undefined;
class Command {
  constructor(public input: { name?: string; sessionId?: string }) {}
}
mock.module("@aws-sdk/client-bedrock-agentcore", () => ({
  BedrockAgentCoreClient: class {
    constructor(config: { maxAttempts?: number }) {
      maxAttempts = config.maxAttempts;
    }
    async send(command: Command) {
      requests.push(command.input);
      return reply();
    }
  },
  StartCodeInterpreterSessionCommand: Command,
  StopCodeInterpreterSessionCommand: Command,
  InvokeCodeInterpreterCommand: Command,
}));
const { runPython } = await import("../../src/lib/agents/code-interpreter.server");
const stream = (...events: unknown[]) => ({
  stream: (async function* () {
    yield* events;
  })(),
});
const result = (taskStatus: string) => ({
  result: { content: [{ type: "text", text: "output" }], structuredContent: { taskStatus } },
});
async function setup() {
  requests = [];
  const { store } = memoryInterpreterStore();
  const scope = `office:${crypto.randomUUID()}`;
  const run = <T>(work: () => Promise<T>) =>
    withInterpreterOwner("adapter-owner", () => withInterpreterScope(scope, work), store);
  await run(async () => {
    const state = interpreterState();
    state.session = { id: "existing-session", startedAt: Date.now() };
    state.baselinedFor = state.session.id;
  });
  return run;
}

test.each(["failed", "canceled"])(
  "confirmed %s reports an error and permits a correction in the same workspace",
  async (status) => {
    const run = await setup();
    reply = async () => stream(result(status));
    expect((await run(() => runPython("invalid()"))).isError).toBe(true);
    reply = async () => stream(result("completed"));
    expect((await run(() => runPython("corrected()"))).isError).toBe(false);
    expect(requests.map((r) => r.sessionId)).toEqual(["existing-session", "existing-session"]);
    expect(maxAttempts).toBe(1);
  },
);

const ambiguous: [string, () => Promise<unknown>][] = [
  ["empty stream", async () => stream()],
  ["unfinished execution", async () => stream(result("working"))],
  ["service exception", async () => stream(result("completed"), { internalServerException: {} })],
  [
    "lost transport",
    async () => {
      throw new Error("connection lost after submission");
    },
  ],
];
test.each(ambiguous)(
  "%s blocks later operations without issuing another SDK request",
  async (_name, respond) => {
    const run = await setup();
    reply = respond;
    await expect(run(() => runPython("may_have_written_files()"))).rejects.toThrow();
    const sent = requests.length;
    await expect(run(() => runPython("must_not_replay()"))).rejects.toThrow("blocked");
    expect(sent).toBe(1);
    expect(requests).toHaveLength(sent);
  },
);
