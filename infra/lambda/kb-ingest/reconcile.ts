import { createScheduledReconcilerHandler } from "./handler-core.ts";
import { reconcileAsyncIngestJobs } from "../../../src/lib/kb/ingest-async.server.ts";

export const handler = createScheduledReconcilerHandler(reconcileAsyncIngestJobs);
