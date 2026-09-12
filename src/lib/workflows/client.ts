import type { Workflow, WorkflowRun, RunInputs } from "./types";
export type Capabilities = {
  enabled: boolean;
  queue: boolean;
  scheduler: boolean;
  python: boolean;
  groups: string[];
  note: string;
};
export async function request<T>(view = "", body?: unknown): Promise<T> {
  const response = await fetch("/api/workflows" + (view ? "?" + view : ""), {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Workflow request failed (${response.status}).`);
  return data as T;
}
export const workflowClient = {
  capabilities: () => request<Capabilities>("view=capabilities"),
  list: () => request<Workflow[]>(),
  runs: () => request<WorkflowRun[]>("view=runs"),
  run: (id: string) => request<WorkflowRun>("view=run&id=" + encodeURIComponent(id)),
  save: (flow: Workflow) =>
    request<Workflow>("", { action: "save", id: flow.id, revision: flow.revision || 0, flow }),
  change: (flow: Workflow, action: "publish" | "share" | "schedule" | "delete", value?: unknown) =>
    request<Workflow>("", { action, id: flow.id, revision: flow.revision || 0, value }),
  start: (flow: Workflow, inputs: RunInputs, published: boolean, requestId: string) =>
    request<WorkflowRun>("", { action: "start", id: flow.id, inputs, published, requestId }),
  cancel: (id: string) => request<WorkflowRun>("", { action: "cancel", id }),
  review: (id: string, approved: boolean, notes: string) =>
    request<WorkflowRun>("", { action: "review", id, approved, notes }),
};
