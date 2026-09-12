import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { AppShell } from "@/components/app-shell";
import { WorkflowsPage } from "@/lib/workflows/WorkflowsPage";

export const Route = createFileRoute("/_authenticated/workflows")({
  validateSearch: (search: Record<string, unknown>): { workflow?: string } => ({
    workflow:
      typeof search.workflow === "string" && /^[a-f0-9-]{36}$/i.test(search.workflow)
        ? search.workflow
        : undefined,
  }),
  component: WorkflowsRoute,
});
function WorkflowsRoute() {
  const { user } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const onNavigate = useCallback(
    (id?: string) => {
      void navigate({ to: "/workflows", search: { workflow: id } });
    },
    [navigate],
  );
  const name = user.name || user.email;
  return (
    <AppShell>
      <WorkflowsPage
        currentUser={{
          name,
          initials: name
            .split(/[ .@]+/)
            .slice(0, 2)
            .map((p) => p[0])
            .join("")
            .toUpperCase(),
        }}
        initialWorkflowId={search.workflow}
        onNavigate={onNavigate}
      />
    </AppShell>
  );
}
