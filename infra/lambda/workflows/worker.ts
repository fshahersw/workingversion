import { processWorkflowRun } from "../../../src/lib/workflows/worker.server";
import { idSchema } from "../../../src/lib/workflows/policy";

export async function handler(event: { Records: { messageId: string; body: string }[] }) {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      await processWorkflowRun(idSchema.parse(JSON.parse(record.body).runId));
    } catch (error) {
      console.error("Workflow queue processing failed", {
        messageId: record.messageId,
        errorType: error instanceof Error ? error.name : "Unknown",
      });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
