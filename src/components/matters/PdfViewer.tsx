import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Maximize, ZoomIn, ZoomOut } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";

import { Button } from "@/components/ui/button";
import { documentViewUrlQueryOptions } from "@/lib/workspace";

/**
 * In-page PDF viewer: pages render on a centered "paper" canvas inside a
 * scrollable pane. Documents always open at page 1, top, fit-to-width.
 * Pages rasterize progressively as they approach the viewport so long
 * filings stay fast.
 */
export function PdfViewer({
  documentId,
  title,
  fill = false,
}: {
  documentId: string;
  title?: string;
  /** Fill the parent's height instead of the default 70vh pane. */
  fill?: boolean;
}) {
  const { data, isLoading, error } = useQuery(documentViewUrlQueryOptions(documentId));

  if (isLoading) {
    return (
      <div
        className={`flex ${fill ? "h-full" : "h-[70vh]"} items-center justify-center rounded-lg border bg-muted/30`}
      >
        <Loader2 className="h-5 w-5 animate-spin text-brand-blue" />
      </div>
    );
  }
  if (error || !data?.url) {
    return (
      <div
        className={`flex ${fill ? "h-full" : "h-32"} items-center justify-center rounded-lg border border-dashed px-6 text-center text-xs text-muted-foreground`}
      >
        {data?.error ?? "Could not load the PDF."}
      </div>
    );
  }
  return <CanvasViewer url={data.url} title={title} fill={fill} />;
}

// ---------------------------------------------------------------------------

type Zoom = "fit" | number;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
const FIT_PADDING = 48; // horizontal breathing room around the paper

function CanvasViewer({ url, title, fill }: { url: string; title?: string; fill: boolean }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [baseWidth, setBaseWidth] = useState(612); // letter width until page 1 loads
  const [paneWidth, setPaneWidth] = useState(0);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");

  const paneRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);

  // Load the document.
  useEffect(() => {
    let cancelled = false;
    setPdf(null);
    setLoadError(null);
    setZoom("fit");
    setCurrentPage(1);
    setPageInput("1");
    pageRefs.current = [];

    (async () => {
      try {
        const { ensurePromiseWithResolvers } = await import("@/lib/pdf-compat");
        ensurePromiseWithResolvers();
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const { configurePdfjsWorker } = await import("@/lib/pdf-worker");
        await configurePdfjsWorker(pdfjs);

        let doc: PDFDocumentProxy;
        try {
          doc = await pdfjs.getDocument({ url, verbosity: 0 }).promise;
        } catch {
          // Some presigned hosts don't send CORS headers for XHR-in-worker;
          // fetch the bytes ourselves and hand them over.
          const buf = await (await fetch(url)).arrayBuffer();
          doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
        }
        if (cancelled) {
          void doc.destroy();
          return;
        }
        pdfRef.current = doc;
        const first = await doc.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        first.cleanup();
        if (!cancelled) {
          setBaseWidth(vp.width);
          setPdf(doc);
        }
      } catch (err) {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : "Could not render the PDF.");
      }
    })();

    return () => {
      cancelled = true;
      const doc = pdfRef.current;
      pdfRef.current = null;
      if (doc) void doc.destroy();
    };
  }, [url]);

  // Track pane width so fit-to-width stays exact on resize.
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPaneWidth(el.clientWidth));
    ro.observe(el);
    setPaneWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [pdf]);

  const fitScale = paneWidth > 0 ? Math.max(0.25, (paneWidth - FIT_PADDING) / baseWidth) : 1;
  const scale = zoom === "fit" ? fitScale : zoom;
  const zoomPct = Math.round(scale * 100);
  const pageCount = pdf?.numPages ?? 0;

  const stepZoom = (dir: 1 | -1) => {
    const target =
      dir === 1
        ? ZOOM_STEPS.find((s) => s > scale + 0.01)
        : [...ZOOM_STEPS].reverse().find((s) => s < scale - 0.01);
    setZoom(target ?? scale);
  };

  const goToPage = useCallback(
    (n: number) => {
      if (!pdf) return;
      const clamped = Math.min(Math.max(1, Math.round(n)), pdf.numPages);
      setCurrentPage(clamped);
      setPageInput(String(clamped));
      pageRefs.current[clamped - 1]?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [pdf],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      goToPage(currentPage + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      goToPage(currentPage - 1);
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      stepZoom(1);
    } else if (e.key === "-") {
      e.preventDefault();
      stepZoom(-1);
    }
  };

  if (loadError) {
    return (
      <div
        className={`flex ${fill ? "h-full" : "h-32"} items-center justify-center rounded-lg border border-dashed px-6 text-center text-xs text-muted-foreground`}
      >
        {loadError}
      </div>
    );
  }

  return (
    <div
      className={`overflow-hidden rounded-lg border bg-card shadow-sm ${fill ? "flex h-full min-h-0 flex-col" : ""}`}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {title ?? "Document preview"}
        </span>
        {pdf && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={currentPage <= 1}
              onClick={() => goToPage(currentPage - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
              <input
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") goToPage(Number(pageInput) || 1);
                }}
                onBlur={() => setPageInput(String(currentPage))}
                className="h-6 w-9 rounded border bg-card text-center text-[11px] tabular-nums text-foreground outline-none focus:border-brand-blue"
                aria-label="Page number"
              />
              / {pageCount}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={currentPage >= pageCount}
              onClick={() => goToPage(currentPage + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>

            <span className="mx-1 h-4 w-px bg-border" />

            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => stepZoom(-1)}
              disabled={zoomPct <= 50}
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <span className="w-10 text-center text-[11px] tabular-nums text-muted-foreground">
              {zoomPct}%
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => stepZoom(1)}
              disabled={zoomPct >= 300}
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={zoom === "fit" ? "secondary" : "ghost"}
              size="icon"
              className="h-6 w-6"
              title="Fit to width"
              onClick={() => setZoom("fit")}
            >
              <Maximize className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {/* Page pane */}
      <div
        ref={paneRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className={`${fill ? "min-h-0 flex-1" : "h-[70vh]"} overflow-y-auto bg-muted/50 px-4 py-4 outline-none focus-visible:ring-1 focus-visible:ring-brand-blue/40`}
      >
        {!pdf ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-brand-blue" />
            Preparing document…
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            {Array.from({ length: pdf.numPages }, (_, i) => (
              <PdfPage
                key={`${i + 1}@${scale.toFixed(3)}`}
                pdf={pdf}
                pageNumber={i + 1}
                scale={scale}
                paneRef={paneRef}
                registerRef={(el) => {
                  pageRefs.current[i] = el;
                }}
                onBecomeCurrent={() => {
                  setCurrentPage(i + 1);
                  setPageInput(String(i + 1));
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PdfPage({
  pdf,
  pageNumber,
  scale,
  paneRef,
  registerRef,
  onBecomeCurrent,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  paneRef: React.RefObject<HTMLDivElement | null>;
  registerRef: (el: HTMLDivElement | null) => void;
  onBecomeCurrent: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  // Render only while near the viewport; track the page nearest the top as "current".
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let cancelled = false;
    let rendered = false;

    const render = async () => {
      if (rendered || cancelled) return;
      rendered = true;
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale });
        setSize({ w: viewport.width, h: viewport.height });
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) {
          page.cleanup();
          return;
        }
        canvas.width = Math.round(viewport.width * dpr);
        canvas.height = Math.round(viewport.height * dpr);
        canvas.style.width = `${Math.round(viewport.width)}px`;
        canvas.style.height = `${Math.round(viewport.height)}px`;
        await page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;
        page.cleanup();
      } catch {
        /* page destroyed mid-render */
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) void render();
          if (entry.isIntersecting && entry.boundingClientRect.top >= 0) {
            const paneTop = paneRef.current?.getBoundingClientRect().top ?? 0;
            if (entry.boundingClientRect.top - paneTop < entry.boundingClientRect.height)
              onBecomeCurrent();
          }
        }
      },
      { root: paneRef.current, rootMargin: "600px 0px" },
    );
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [pdf, pageNumber, scale, paneRef, onBecomeCurrent]);

  return (
    <div
      ref={(el) => {
        wrapRef.current = el;
        registerRef(el);
      }}
      className="shrink-0 overflow-hidden rounded-[2px] bg-white shadow-md ring-1 ring-black/5"
      style={
        size
          ? { width: size.w, height: size.h }
          : { width: Math.round(612 * scale), height: Math.round(792 * scale) }
      }
    >
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
