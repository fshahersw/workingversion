export type KbIngestAction = "sync" | "prepare" | "start" | "status" | "status-batch";

export function kbIngestAction(body: unknown): KbIngestAction {
  if (!body || typeof body !== "object") return "sync";
  const action = (body as { action?: unknown }).action;
  if (action === undefined || action === "sync") return "sync";
  if (
    action === "prepare" ||
    action === "start" ||
    action === "status" ||
    action === "status-batch"
  ) {
    return action;
  }
  throw new Error("invalid ingest action");
}
