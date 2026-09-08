import { Bookmark, BookmarkCheck, History, Loader2, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  deleteConversation,
  keepConversation,
  listConversations,
  type ConversationSummary,
} from "@/lib/chat/history";

function relative(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Compact list of the signed-in user's saved research conversations. */
export function ConversationHistory({
  activeId,
  onOpen,
}: {
  activeId?: string | null;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<ConversationSummary[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setItems(await listConversations());
    setLoading(false);
  }, []);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void refresh();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          title="History"
          aria-label="Conversation history"
          className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-brand-navy"
        >
          <History className="h-[15px] w-[15px]" strokeWidth={1.85} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-[320px] rounded-xl p-1.5"
      >
        <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Recent research
        </div>
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-[12.5px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="px-2 py-3 text-[12.5px] text-muted-foreground">
            No saved conversations yet.
          </div>
        ) : (
          <div className="wr-app-scroll max-h-[320px] overflow-y-auto">
            {items.map((c) => (
              <div
                key={c.id}
                className={`group flex items-center gap-1 rounded-lg px-1 ${
                  c.id === activeId ? "bg-muted/70" : "hover:bg-muted/60"
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onOpen(c.id);
                  }}
                  className="min-w-0 flex-1 px-1.5 py-2 text-left"
                >
                  <div className="truncate text-[13px] leading-snug text-foreground">
                    {c.title}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {c.matterLabel ? `${c.matterLabel} · ` : ""}
                    {relative(c.updatedAt)}
                  </div>
                </button>
                <button
                  type="button"
                  aria-label={c.saved ? "Saved (kept)" : "Keep conversation"}
                  title={c.saved ? "Kept — won't expire" : "Keep (save past the 3-day default)"}
                  onClick={async () => {
                    if (c.saved) return;
                    await keepConversation(c.id);
                    setItems((prev) =>
                      prev.map((x) => (x.id === c.id ? { ...x, saved: true } : x)),
                    );
                  }}
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-background hover:text-brand-navy ${
                    c.saved
                      ? "text-brand-navy"
                      : "text-muted-foreground/0 group-hover:text-muted-foreground"
                  }`}
                >
                  {c.saved ? (
                    <BookmarkCheck className="h-3.5 w-3.5" strokeWidth={1.85} />
                  ) : (
                    <Bookmark className="h-3.5 w-3.5" strokeWidth={1.85} />
                  )}
                </button>
                <button
                  type="button"
                  aria-label="Delete conversation"
                  onClick={async () => {
                    if (await deleteConversation(c.id)) {
                      setItems((prev) => prev.filter((x) => x.id !== c.id));
                    }
                  }}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground/0 transition-colors group-hover:text-muted-foreground hover:bg-background hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.85} />
                </button>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
