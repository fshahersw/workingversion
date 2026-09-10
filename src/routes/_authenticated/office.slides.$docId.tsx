// /office/slides/:docId — Slides. The retained Konva-based renderer mounts
// full-bleed inside the platform shell. The deck engine (Node worker running
// pptx-engine + pptx-render with real font shaping) runs in the Office engine
// service; the platform host in src/office/slides/web/host bridges the
// renderer's IPC to it and to the platform (revisions, assistant, web search,
// per-document chat).
import { createFileRoute, Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { AlertCircle, ArrowLeft, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";

import { AppShell } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated/office/slides/$docId")({
  ssr: false,
  head: () => ({ meta: [{ title: "Slides — Seeger Weiss" }] }),
  component: SlidesPage,
});

function SlidesPage() {
  const { docId } = Route.useParams();
  const navigate = useNavigate();
  const [Mount, setMount] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  useBlocker({
    shouldBlockFn: () => {
      if (!dirtyRef.current) return false;
      return !window.confirm("This deck has unsaved changes. Leave without saving?");
    },
    enableBeforeUnload: false,
  });

  useEffect(() => {
    // One AbortController per effect run: a boot that loses its effect (route
    // change, React development double-mount) stops at its next checkpoint and
    // never installs itself; only a boot that completed is torn down.
    const controller = new AbortController();
    let booted = false;
    setMount(null);
    setError(null);
    dirtyRef.current = false;
    const onOpen = (event: Event) => {
      const id = (event as CustomEvent<{ docId?: string }>).detail?.docId;
      if (id) void navigate({ to: "/office/slides/$docId", params: { docId: id } });
    };
    window.addEventListener("sw-office-open", onOpen);
    const boot = async () => {
      const { bootSlides } = await import("@/office/slides/platform/boot");
      if (controller.signal.aborted) return;
      const mod = await bootSlides(
        {
          docId,
          navigateTo: (id) => {
            if (id) void navigate({ to: "/office/slides/$docId", params: { docId: id } });
            else void navigate({ to: "/office/slides" });
          },
          onDirtyChange: (dirty) => {
            dirtyRef.current = dirty;
          },
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      booted = true;
      setMount(() => mod.SlidesMount);
    };
    boot().catch((err: unknown) => {
      if (!controller.signal.aborted)
        setError(err instanceof Error ? err.message : "The deck could not open.");
    });
    return () => {
      controller.abort();
      window.removeEventListener("sw-office-open", onOpen);
      if (booted) void import("@/office/slides/platform/boot").then((b) => b.teardownSlides());
    };
  }, [docId, navigate]);

  return (
    <AppShell>
      <div className="sw-slides-root h-full min-h-0 w-full overflow-hidden">
        {error ? (
          <div className="mx-auto max-w-md px-6 py-16 text-center">
            <AlertCircle className="mx-auto h-6 w-6 text-destructive" />
            <p className="mt-3 text-[13.5px] text-foreground">{error}</p>
            <Link
              to="/office/slides"
              className="mt-4 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-brand-navy hover:underline"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Slides
            </Link>
          </div>
        ) : Mount ? (
          <Mount key={docId} />
        ) : (
          <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening the deck…
          </div>
        )}
      </div>
    </AppShell>
  );
}
