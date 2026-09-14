import { createSqsBatchHandler } from "./handler-core.ts";
import { parseIngestCompletionEvent } from "../../../src/lib/kb/ingest-events.ts";
import { handleAsyncIngestCompletion } from "../../../src/lib/kb/ingest-async.server.ts";
import { handleTextIngest, parseTextIngestMessage } from "../../../src/lib/kb/ingest-text.server.ts";

const processBatch = createSqsBatchHandler(async (body) => {
  // Two producers share this queue: Bedrock Data Automation completions (BDA
  // EventBridge envelope or the compact reconciliation message) and the
  // no-BDA text-ingest lane (kind:"text"). Peek the discriminator, then hand
  // to the exact parser + handler; a malformed body fails the strict parse.
  let kind: unknown;
  try {
    kind = (JSON.parse(body) as { kind?: unknown } | null)?.kind;
  } catch {
    kind = undefined;
  }
  if (kind === "text") {
    await handleTextIngest(parseTextIngestMessage(body));
    return;
  }
  await handleAsyncIngestCompletion(parseIngestCompletionEvent(body));
});

export const handler = processBatch;
