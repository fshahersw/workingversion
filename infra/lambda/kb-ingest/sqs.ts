import { createSqsBatchHandler } from "./handler-core.ts";
import { parseIngestCompletionEvent } from "../../../src/lib/kb/ingest-events.ts";
import { handleAsyncIngestCompletion } from "../../../src/lib/kb/ingest-async.server.ts";

const processBatch = createSqsBatchHandler(async (body) => {
  await handleAsyncIngestCompletion(parseIngestCompletionEvent(body));
});

export const handler = processBatch;
