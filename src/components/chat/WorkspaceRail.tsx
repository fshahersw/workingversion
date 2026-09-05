import { AnimatePresence, motion } from "framer-motion";
import { Bell, BellOff, ExternalLink, Pin as PinIcon, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { SourcePanel } from "./SourcePanel";
import { SourceReader } from "./SourceReader";
import type { MatterScope, Source } from "@/lib/chat-types";
import {
  addPin,
  deletePin,
  deleteWatch,
  listPins,
  listWatches,
  markWatchHitsSeen,
  setWatchActive,
  type Pin,
  type Watch,
} from "@/lib/research-workspace";

type Tab = "sources" | "pins" | "watch";

/**
 * Right-hand workspace: sources, pinned passages and watched questions,
 * with an inline reading pane for any source.
 */
export function WorkspaceRail({
  sources,
  selectedRef,
  selectedQuote,
  citedRefs,
  onClearSelect,
  conversationId,
  matter,
  reloadKey = 0,
}: {
  sources: Source[];
  selectedRef: string | null;
  selectedQuote?: string;
  citedRefs?: Set<string>;
  onClearSelect: () => void;
  conversationId: string | null;
  matter: MatterScope | null;
  reloadKey?: number;
}) {
  const [tab, setTab] = useState<Tab>("sources");
  const [reading, setReading] = useState<Source | null>(null);
  const [pins, setPins] = useState<Pin[]>([]);
  const [watches, setWatches] = useState<Watch[]>([]);

  const refresh = useCallback(async () => {
    const [p, w] = await Promise.all([listPins(), listWatches()]);
    setPins(p);
    setWatches(w);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadKey]);

  useEffect(() => {
    if (selectedRef) setTab("sources");
  }, [selectedRef]);

  const unseen = watches.reduce((n, w) => n + w.unseen, 0);

  const pin = useCallback(
    async (source: Source, quote?: string) => {
      const text = (quote || source.content || source.citation || "").trim();
      if (!text) return;
      const created = await addPin({
        conversationId,
        matter,
        quote: text.slice(0, 2000),
        source,
      });
      if (!created) {
        toast.error("Could not pin that passage.");
        return;
      }
      setPins((prev) => [created, ...prev]);
      toast.success("Pinned");
    },
    [conversationId, matter],
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[oklch(0.995_0.002_260)]">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/50 px-2 py-1.5">
        <TabButton active={tab === "sources"} onClick={() => setTab("sources")}>
          Sources
          {sources.length > 0 && <Count>{sources.length}</Count>}
        </TabButton>
        <TabButton active={tab === "pins"} onClick={() => setTab("pins")}>
          Pins
          {pins.length > 0 && <Count>{pins.length}</Count>}
        </TabButton>
        <TabButton active={tab === "watch"} onClick={() => setTab("watch")}>
          Watchlist
          {unseen > 0 && <Count accent>{unseen}</Count>}
        </TabButton>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "sources" && (
          <SourcePanel
            sources={sources}
            selectedRef={selectedRef}
            selectedQuote={selectedQuote}
            citedRefs={citedRefs}
            onClearSelect={onClearSelect}
            onRead={setReading}
            onPin={(s) => void pin(s)}
          />
        )}

        {tab === "pins" && (
          <div className="wr-app-scroll h-full overflow-y-auto px-3 py-3">
            {pins.length === 0 ? (
              <Empty
                icon={<PinIcon className="h-[18px] w-[18px] text-primary" />}
                title="No pinned passages"
                body="Pin a source or a highlighted passage to keep it here."
              />
            ) : (
              <div className="space-y-2">
                {pins.map((p) => (
                  <div
                    key={p.id}
                    className="group rounded-lg border border-border/60 bg-card px-3 py-2.5"
                  >
                    <p className="line-clamp-5 text-[12px] leading-[1.55] text-foreground/90">
                      {p.quote}
                    </p>
                    <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-muted-foreground/70">
                      <span className="truncate">
                        {p.citation || p.sourceRef || "Manual note"}
                      </span>
                      {p.sourceUrl && !p.sourceUrl.startsWith("/") && (
                        <a
                          href={p.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 transition-colors hover:text-brand-orange"
                        >
                          Open <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={async () => {
                          await deletePin(p.id);
                          setPins((prev) => prev.filter((x) => x.id !== p.id));
                        }}
                        className="ml-auto opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                        aria-label="Remove pin"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "watch" && (
          <div className="wr-app-scroll h-full overflow-y-auto px-3 py-3">
            {watches.length === 0 ? (
              <Empty
                icon={<Bell className="h-[18px] w-[18px] text-primary" />}
                title="No watched questions"
                body="Use Watch on an answer to be alerted when new authority appears."
              />
            ) : (
              <div className="space-y-2">
                {watches.map((w) => (
                  <div
                    key={w.id}
                    className="group rounded-lg border border-border/60 bg-card px-3 py-2.5"
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-2 text-[12px] font-medium leading-snug text-brand-navy">
                          {w.label || w.question}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px] text-muted-foreground/70">
                          {w.matterLabel && <span>{w.matterLabel} ·</span>}
                          <span>
                            {w.active ? "Active" : "Paused"}
                            {w.lastCheckedAt
                              ? ` · checked ${new Date(w.lastCheckedAt).toLocaleDateString()}`
                              : " · not yet checked"}
                          </span>
                        </div>
                      </div>
                      {w.unseen > 0 && (
                        <button
                          type="button"
                          onClick={async () => {
                            await markWatchHitsSeen(w.id);
                            setWatches((prev) =>
                              prev.map((x) =>
                                x.id === w.id ? { ...x, unseen: 0 } : x,
                              ),
                            );
                          }}
                          className="shrink-0 rounded-full bg-brand-orange/15 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-brand-orange"
                        >
                          {w.unseen} new
                        </button>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-[10.5px] text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={async () => {
                          await setWatchActive(w.id, !w.active);
                          setWatches((prev) =>
                            prev.map((x) =>
                              x.id === w.id ? { ...x, active: !x.active } : x,
                            ),
                          );
                        }}
                        className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
                      >
                        {w.active ? (
                          <>
                            <BellOff className="h-2.5 w-2.5" /> Pause
                          </>
                        ) : (
                          <>
                            <Bell className="h-2.5 w-2.5" /> Resume
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await deleteWatch(w.id);
                          setWatches((prev) =>
                            prev.filter((x) => x.id !== w.id),
                          );
                        }}
                        className="inline-flex items-center gap-1 transition-colors hover:text-destructive"
                      >
                        <Trash2 className="h-2.5 w-2.5" /> Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <AnimatePresence>
        {reading && (
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
            className="absolute inset-0 z-10"
          >
            <SourceReader
              source={reading}
              quote={reading.ref === selectedRef ? selectedQuote : undefined}
              onBack={() => setReading(null)}
              onPin={(s, q) => void pin(s, q)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11.5px] font-medium transition-colors ${
        active
          ? "bg-brand-blue-soft/50 text-brand-navy"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function Count({
  children,
  accent,
}: {
  children: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <span
      className={`tabular-nums ${accent ? "text-brand-orange" : "text-muted-foreground/50"}`}
    >
      {children}
    </span>
  );
}

function Empty({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-full bg-brand-blue-soft">
        {icon}
      </div>
      <h3 className="mt-3 text-[13px] font-semibold text-brand-navy">{title}</h3>
      <p className="mt-1 max-w-xs text-[11.5px] text-muted-foreground">{body}</p>
    </div>
  );
}
