// Invoked as a genuinely separate process to prove there is no module-cache dependency.
import { createInterpreterRunner } from "../../src/lib/agents/interpreter-registry";
import { createInterpreterStore } from "../../src/lib/agents/interpreter-store.server";
import { localDynamoClient } from "./dynamo-fixture";
const [table, mode] = process.argv.slice(2);
if (!table?.startsWith("office-local-test-") || !["write", "read"].includes(mode))
  throw new Error("Invalid fixture arguments");
const client = localDynamoClient();
try {
  const out = await createInterpreterRunner(createInterpreterStore(client, table, "local"))(
    "process-owner",
    "office:process",
    async (state) => {
      if (mode === "write") {
        state.session = { id: "fixture-remote-session", startedAt: Date.now() };
        state.seenFiles.add("source.docx");
        state.baselinedFor = state.session.id;
        await state.checkpoint!();
      }
      return { id: state.session?.id, files: [...state.seenFiles], baseline: state.baselinedFor };
    },
  );
  process.stdout.write(JSON.stringify(out));
} finally {
  client.destroy();
}
