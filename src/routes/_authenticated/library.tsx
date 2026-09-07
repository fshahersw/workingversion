import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Bookmark,
  BookmarkCheck,
  Download,
  FileText,
  FolderOpen,
  Layers,
  Loader2,
  MessageSquare,
  Mic,
  Table2,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import {
  deleteConversation,
  keepConversation,
  listConversations,
  type ConversationSummary,
} from "@/lib/chat/history";
import {
  createUploadFn,
  deleteLibraryItemFn,
  getDownloadUrlFn,
  getLibraryItemFn,
  listItemsFn,
  registerUploadFn,
} from "@/lib/library/library.functions";
import { discoveryTabFor, stashWorkspaceHandoff } from "@/lib/kb/workspace-handoff";
import { deleteWorkspaceFn, listWorkspacesFn } from "@/lib/kb/workspace.functions";
import type { WorkspaceSummary, WorkspaceSurface } from "@/lib/kb/workspace.server";

export const Route = createFileRoute("/_authenticated/library")({
  ssr: false,
  component: LibraryPage,
});

type ItemKind = "output" | "prompt" | "file";
type LibItem = {
  itemId: string;
  kind: string;
  name: string;
  createdAt: string;
  preview?: string;
  contentType?: string;
  size?: number;
};

const TABS = [
  { key: "workingset", label: "Working Sets", icon: Layers },
  { key: "deposition", label: "Depositions", icon: Mic },
  { key: "review", label: "Tabular Review", icon: Table2 },
  { key: "chats", label: "Chat history", icon: MessageSquare },
  { key: "output", label: "Saved outputs", icon: Bookmark },
  { key: "prompt", label: "Prompts", icon: FileText },
  { key: "file", label: "Uploads", icon: Upload },
] as const;
type TabKey = (typeof TABS)[number]["key"];
const SURFACE_TABS = new Set<TabKey>(["workingset", "deposition", "review"]);

function relative(iso: string): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function prettySize(bytes?: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function LibraryPage() {
  const [tab, setTab] = useState<TabKey>("workingset");
  return (
    <AppShell>
      <div className="mx-auto flex h-full w-full max-w-[900px] flex-col px-4 py-6 sm:px-6">
        <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-foreground">Library</h1>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          Saved conversations, outputs, and uploads. Chats auto-expire after 3 days unless kept.
        </p>

        <div className="mt-4 flex flex-wrap gap-1 border-b border-border/60">
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12.5px] font-medium transition-colors ${
                  active
                    ? "border-brand-navy text-brand-navy"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <t.icon className="h-3.5 w-3.5" strokeWidth={1.9} />
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="wr-app-scroll mt-4 min-h-0 flex-1 overflow-y-auto">
          {tab === "chats" ? (
            <ChatsList />
          ) : SURFACE_TABS.has(tab) ? (
            <WorkspacesList surface={tab as WorkspaceSurface} />
          ) : (
            <ItemsList kind={tab as ItemKind} />
          )}
        </div>
      </div>
    </AppShell>
  );
}

function WorkspacesList({ surface }: { surface: WorkspaceSurface }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<WorkspaceSummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await listWorkspacesFn({ data: { surface } })) as WorkspaceSummary[]);
    } catch {
      setItems([]);
    }
  }, [surface]);
  useEffect(() => {
    void load();
  }, [load]);

  const openWorkspace = (id: string) => {
    stashWorkspaceHandoff(surface, id);
    void navigate({ to: "/docs", search: { tab: discoveryTabFor(surface) } });
  };
  const remove = async (id: string) => {
    setBusyId(id);
    try {
      await deleteWorkspaceFn({ data: { itemId: id } });
      await load();
      toast.success("Workspace deleted");
    } catch {
      toast.error("Could not delete workspace");
    } finally {
      setBusyId(null);
    }
  };

  if (!items) return <Loading />;
  if (!items.length) {
    return (
      <EmptyState label="No saved workspaces yet. Save a working set from Discovery to see it here." />
    );
  }
  return (
    <ul className="space-y-1.5">
      {items.map((w) => (
        <li
          key={w.itemId}
          className="flex items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-2.5"
        >
          <FolderOpen className="h-4 w-4 shrink-0 text-brand-navy/50" strokeWidth={1.8} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-foreground">{w.name}</p>
            <p className="text-[11px] text-muted-foreground">
              {w.docCount} doc{w.docCount === 1 ? "" : "s"} · {w.pageCount} pages
              {w.folderId && w.folderId !== "ROOT" ? ` · ${w.folderId}` : ""} · {relative(w.createdAt)}
              {w.status === "saving"
                ? " · saving"
                : w.status === "error"
                  ? " · save incomplete"
                  : ""}
            </p>
            {w.status === "error" && w.errorSummary ? (
              <p className="mt-0.5 truncate text-[10.5px] text-destructive">
                {w.errorSummary}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => openWorkspace(w.itemId)}
            disabled={w.status !== "ready"}
            className="shrink-0 rounded bg-brand-navy px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => void remove(w.itemId)}
            disabled={busyId === w.itemId}
            aria-label="Delete workspace"
            className="shrink-0 text-muted-foreground transition hover:text-destructive disabled:opacity-50"
          >
            {busyId === w.itemId ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="px-1 py-8 text-center text-[12.5px] text-muted-foreground">{label}</div>;
}

function Loading() {
  return (
    <div className="flex items-center gap-2 px-1 py-6 text-[12.5px] text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
    </div>
  );
}

function ChatsList() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ConversationSummary[] | null>(null);

  const refresh = useCallback(async () => {
    setItems(await listConversations(100));
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openChat = useCallback(
    (id: string) => {
      try {
        window.sessionStorage.setItem("sw:open-conversation", id);
      } catch {
        /* ignore */
      }
      void navigate({ to: "/research" });
    },
    [navigate],
  );

  if (items === null) return <Loading />;
  if (items.length === 0) return <EmptyState label="No conversations yet." />;

  return (
    <div className="space-y-1">
      {items.map((c) => (
        <div
          key={c.id}
          className="group flex items-center gap-1 rounded-lg px-1 hover:bg-muted/60"
        >
          <button
            type="button"
            onClick={() => openChat(c.id)}
            className="min-w-0 flex-1 px-2 py-2.5 text-left"
          >
            <div className="truncate text-[13.5px] text-foreground">{c.title}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {c.saved ? "Kept · " : ""}
              {relative(c.updatedAt)}
            </div>
          </button>
          <button
            type="button"
            title={c.saved ? "Kept — won't expire" : "Keep (save past the 3-day default)"}
            onClick={async () => {
              if (c.saved) return;
              await keepConversation(c.id);
              setItems((prev) => prev?.map((x) => (x.id === c.id ? { ...x, saved: true } : x)) ?? prev);
            }}
            className={`grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-background hover:text-brand-navy ${
              c.saved ? "text-brand-navy" : "text-muted-foreground/50"
            }`}
          >
            {c.saved ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
          </button>
          <button
            type="button"
            title="Delete"
            onClick={async () => {
              await deleteConversation(c.id);
              setItems((prev) => prev?.filter((x) => x.id !== c.id) ?? prev);
            }}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground/40 transition-colors hover:bg-background hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

function ItemsList({ kind }: { kind: ItemKind }) {
  const isFile = kind === "file";
  const [items, setItems] = useState<LibItem[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [loadingContent, setLoadingContent] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setItems((await listItemsFn({ data: { kind } })) as LibItem[]);
  }, [kind]);
  useEffect(() => {
    setItems(null);
    setOpenId(null);
    void refresh();
  }, [refresh]);

  const view = useCallback(async (id: string) => {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setLoadingContent(true);
    try {
      const full = await getLibraryItemFn({ data: { itemId: id } });
      setContent(full?.content ?? "");
    } finally {
      setLoadingContent(false);
    }
  }, [openId]);

  const download = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      const { url } = await getDownloadUrlFn({ data: { itemId: id } });
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      toast.error("Couldn't get the download link.");
    } finally {
      setBusyId(null);
    }
  }, []);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploading(true);
      try {
        for (const file of Array.from(files)) {
          const { itemId, s3Key, uploadUrl } = await createUploadFn({
            data: { name: file.name, size: file.size },
          });
          const put = await fetch(uploadUrl, { method: "PUT", body: file });
          if (!put.ok) throw new Error(`upload failed (${put.status})`);
          await registerUploadFn({
            data: {
              itemId,
              s3Key,
              name: file.name,
              contentType: file.type || "application/octet-stream",
              size: file.size,
            },
          });
        }
        toast.success(files.length > 1 ? `${files.length} files uploaded` : "File uploaded");
        await refresh();
      } catch (err) {
        toast.error((err as Error).message ?? "Upload failed.");
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [refresh],
  );

  const emptyLabel = isFile
    ? "No uploads yet."
    : kind === "prompt"
      ? "No saved prompts yet."
      : "No saved outputs yet. Use Save on an answer to add one.";

  return (
    <div className="space-y-2">
      {isFile && (
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">Files up to 50 MB.</span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-navy px-2.5 py-1.5 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-brand-navy/90 disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {uploading ? "Uploading…" : "Upload file"}
          </button>
        </div>
      )}

      {items === null ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState label={emptyLabel} />
      ) : (
        <div className="space-y-1">
          {items.map((it) => (
            <div key={it.itemId} className="rounded-lg border border-border/50">
              <div className="group flex items-center gap-1 px-1 hover:bg-muted/40">
                <button
                  type="button"
                  onClick={() => (isFile ? download(it.itemId) : view(it.itemId))}
                  disabled={busyId === it.itemId}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2.5 text-left"
                >
                  {isFile && (
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                      {busyId === it.itemId ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] text-foreground">{it.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {relative(it.createdAt)}
                      {isFile
                        ? [it.size ? prettySize(it.size) : "", it.contentType]
                            .filter(Boolean)
                            .map((s) => ` · ${s}`)
                            .join("")
                        : it.preview
                          ? ` · ${it.preview.slice(0, 80)}`
                          : ""}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  title="Delete"
                  onClick={async () => {
                    await deleteLibraryItemFn({ data: { itemId: it.itemId } });
                    setItems((prev) => prev?.filter((x) => x.itemId !== it.itemId) ?? prev);
                  }}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground/40 transition-colors hover:bg-background hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {!isFile && openId === it.itemId && (
                <div className="border-t border-border/50 px-3 py-2.5">
                  {loadingContent ? (
                    <Loading />
                  ) : (
                    <pre className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-foreground/90">
                      {content}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
