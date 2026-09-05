import { useEffect, useRef, useState } from "react";

// Mermaid is a large, browser-only lib — lazy-load it (dynamic import) so it
// never runs during SSR and is only fetched when an answer actually contains a
// diagram. Rendered with securityLevel "strict" since the chart text is
// model-generated.
type MermaidApi = { initialize: (c: Record<string, unknown>) => void; render: (id: string, chart: string) => Promise<{ svg: string }> };
let mermaidPromise: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      const api = m.default as unknown as MermaidApi;
      api.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict", fontFamily: "inherit" });
      return api;
    });
  }
  return mermaidPromise;
}

let counter = 0;

export function MermaidDiagram({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    loadMermaid()
      .then(async (mermaid) => {
        try {
          const { svg } = await mermaid.render(`mmd-${++counter}`, chart);
          if (!cancelled && ref.current) ref.current.innerHTML = svg;
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : "Could not render diagram");
        }
      })
      .catch(() => {
        if (!cancelled) setError("Diagram renderer failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (error) {
    // Fall back to the raw diagram source rather than showing nothing.
    return (
      <pre className="my-3 overflow-x-auto rounded-md border border-border bg-muted/40 p-2 text-[12px] text-muted-foreground">
        {chart}
      </pre>
    );
  }

  return (
    <div
      ref={ref}
      className="my-4 flex justify-center overflow-x-auto rounded-lg border border-border/60 bg-card px-2 py-3 [&_svg]:h-auto [&_svg]:max-w-full"
    />
  );
}
