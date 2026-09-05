// Direct integration test of the chat/memory layer against the live sw-dev-app
// table (bypasses the server-fn/auth layer; uses a throwaway test principal).
//   AWS_PROFILE=AdministratorAccess-475976462949 AWS_REGION=us-east-1 bun run scripts/test-chat.ts
import {
  createConversation,
  appendMessage,
  getConversation,
  listConversations,
  saveConversation,
  saveOutput,
  deleteConversation,
} from "../src/lib/chat/chat.server";

const P = `test-principal-${Date.now()}`;

async function main() {
  const c = await createConversation(P, "Daubert prep chat");
  console.log("created:", c.convId, "| saved:", c.saved);

  const m1 = await appendMessage(P, c.convId, "user", "What is the Daubert standard?");
  await appendMessage(P, c.convId, "assistant", "It is the federal test for expert admissibility.");

  const g = await getConversation(P, c.convId);
  console.log("messages:", g.messages.length, "| roles:", g.messages.map((m) => m.role).join(","));

  const list = await listConversations(P);
  console.log("listed:", list.length, "| this one saved?:", list.find((x) => x.convId === c.convId)?.saved);

  const out = await saveOutput(P, c.convId, m1.msgId);
  console.log("saved output item:", out.itemId);

  await saveConversation(P, c.convId);
  const g2 = await getConversation(P, c.convId);
  console.log("after save -> conversation.saved:", g2.conversation.saved, "(ttl cleared)");

  await deleteConversation(P, c.convId);
  await deleteConversation(P, c.convId).catch(() => {}); // idempotent-ish
  console.log("cleanup done for principal", P);
  console.log("NOTE: the saved output ITEM is left in the table (belongs to the test principal); harmless.");
}

main().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
