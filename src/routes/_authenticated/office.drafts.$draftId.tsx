// /office/drafts/:draftId — the Writer. The full Writer renderer (ribbon,
// paginated page, tracked changes, comments, assistant panel) mounts full-bleed
// inside the platform shell; the sidebar stays as the way back to the rest of
// the platform. The renderer's Electron surface is provided by the platform
// adapter (Library storage, Cognito session, platform assistant + web search).
import { createFileRoute, Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { AlertCircle, ArrowLeft, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";

import { AppShell } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated/office/drafts/$draftId")({
  ssr: false,
  head: () => ({ meta: [{ title: "Writer — Seeger Weiss" }] }),
  component: WriterPage,
});

function WriterPage() {
  const { draftId } = Route.useParams();
  const navigate = useNavigate();
  const [Mount, setMount] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  // In-app navigation guard: the Writer reports its unsaved-changes flag through
  // the adapter; a sidebar click while dirty gets the same confirm as closing a tab.
  useBlocker({
    shouldBlockFn: () => {
      if (!dirtyRef.current) return false;
      return !window.confirm("This document has unsaved changes. Leave without saving?");
    },
    enableBeforeUnload: false,
  });

  useEffect(() => {
    let alive = true;
    setMount(null);
    setError(null);
    dirtyRef.current = false;
    const boot = async () => {
      const adapter = await import("@/writer/platform/adapter");
      adapter.installPlatformAdapter({
        draftId,
        navigateTo: (id) => {
          if (id) void navigate({ to: "/office/drafts/$draftId", params: { draftId: id } });
          else void navigate({ to: "/office/drafts" });
        },
        onDirtyChange: (dirty) => {
          dirtyRef.current = dirty;
        },
      });
      const mod = await import("@/writer/platform/WriterMount");
      if (alive) setMount(() => mod.WriterMount);
    };
    boot().catch((err: unknown) => {
      if (alive) setError(err instanceof Error ? err.message : "The Writer could not open.");
    });
    return () => {
      alive = false;
      void import("@/writer/platform/adapter").then((a) => a.teardownPlatformAdapter());
    };
  }, [draftId, navigate]);

  return (
    <AppShell>
      <div className="sw-writer-root h-full min-h-0 w-full overflow-hidden">
        {error ? (
          <div className="mx-auto max-w-md px-6 py-16 text-center">
            <AlertCircle className="mx-auto h-6 w-6 text-destructive" />
            <p className="mt-3 text-[13.5px] text-foreground">{error}</p>
            <Link
              to="/office/drafts"
              className="mt-4 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-brand-navy hover:underline"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Drafts
            </Link>
          </div>
        ) : Mount ? (
          <Mount key={draftId} />
        ) : (
          <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening the Writer…
          </div>
        )}
      </div>
    </AppShell>
  );
}
