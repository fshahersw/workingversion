import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Bookmark,
  BookmarkCheck,
  Download,
  FileText,
  FolderInput,
  FolderOpen,
  Layers,
  Loader2,
  MessageSquare,
  Mic,
  PenLine,
  Search,
  Table2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import { FolderBar, MoveToMenu } from "@/components/library/FolderBar";
import {
  deleteConversation,
  keepConversation,
  listConversations,
  type ConversationSummary,
} from "@/lib/chat/history";
import { ROOT_FOLDER, type FolderCategory, type LibraryFolder } from "@/lib/library/folder-tree";
import {
  createFolderFn,
  deleteFolderFn,
  listFoldersFn,
  moveContentFn,
  renameFolderFn,
} from "@/lib/library/folders.functions";
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
import { deleteOfficeDocFn, listOfficeDocsFn } from "@/lib/office/office.functions";
import { OFFICE_LABEL, type OfficeDocSummary } from "@/lib/office/types";

export const Route = createFileRoute("/_authenticated/library")({
  ssr: false,
  component: LibraryPage,
});

type ItemKind = "output" | "prompt" | "file";
type LibItem = {
  itemId: string;
  kind: string;
  name: string;
  folderId?: string;
  createdAt: string;
  preview?: string;
  contentType?: string;
  size?: number;
};

const folderOf = (value: string | undefined | null): string => value || ROOT_FOLDER;

/**
 * Folder state for one Library section: the tree, the folder being viewed,
 * and the create / rename / delete / move actions. Every action re-reads the
 * server's tree so two tabs never disagree.
 */
function useFolders(category: FolderCategory) {
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [current, setCurrent] = useState<string>(ROOT_FOLDER);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setFolders(await listFoldersFn({ data: { category } }));
    } catch {
      setFolders([]);
    }
  }, [category]);
  useEffect(() => {
    setCurrent(ROOT_FOLDER);
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (work: () => Promise<unknown>, ok?: string) => {
      setBusy(true);
      try {
        await work();
        await refresh();
        if (ok) toast.success(ok);
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Folder action failed");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return {
    folders,
    current,
    busy,
    navigate: setCurrent,
    /** Items at this level: in the current folder, or unfiled when viewing All. */
    inView: (folderId: string | undefined | null) => folderOf(folderId) === current,
    create: (name: string) =>
      run(
        () => createFolderFn({ data: { category, name, parentId: current } }),
        "Folder created",
      ).then(() => undefined),
    rename: (folderId: string, name: string) =>
      run(() => renameFolderFn({ data: { category, folderId, name } })).then(() => undefined),
    remove: async (folderId: string) => {
      const ok = await run(
        () => deleteFolderFn({ data: { category, folderId } }),
        "Folder deleted; its contents moved up one level",
      );
      if (ok && current === folderId) {
        const parent = folders.find((f) => f.folderId === folderId)?.parentId ?? ROOT_FOLDER;
        setCurrent(parent);
      }
    },
    move: (targetId: string, folderId: string) =>
      run(() => moveContentFn({ data: { category, targetId, folderId } }), "Moved"),
  };
}

const TABS = [
  { key: "workingset", label: "Working Sets", icon: Layers },
  { key: "deposition", label: "Depositions", icon: Mic },
  { key: "review", label: "Tabular Review", icon: Table2 },
  { key: "draft", label: "Drafts", icon: PenLine },
  { key: "chats", label: "Chat history", icon: MessageSquare },
  { key: "output", label: "Saved outputs", icon: Bookmark },
  { key: "prompt", label: "Prompts", icon: FileText },
  { key: "file", label: "Uploads", icon: Upload },
] as const;
type TabKey = (typeof TABS)[number]["key"];
const SURFACE_TABS = new Set<TabKey>(["workingset", "deposition", "review"]);

/**
 * Sections grouped for the left rail. "Case work" opens in the Discovery
 * workspace; "My library" is the current user's private, owner-scoped store.
 * (Everything here is `PK=USER#<principal>` — there is no team/shared scope, so
 * the rail does not pretend to offer one.)
 */
const SECTION_GROUPS: { title: string; keys: TabKey[] }[] = [
  { title: "Case work", keys: ["workingset", "deposition", "review"] },
  { title: "My library", keys: ["draft", "chats", "output", "prompt", "file"] },
];

/** Case-insensitive substring match; an empty query matches everything. */
function hit(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || text.toLowerCase().includes(q);
}

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
  const [query, setQuery] = useState("");
  const active = TABS.find((t) => t.key === tab) ?? TABS[0];
  const select = (key: TabKey) => {
    setTab(key);
    setQuery("");
  };
  return (
    <AppShell>
      <div className="flex h-full min-h-0 w-full">
        {/* Section rail: navigation on the left */}
        <aside className="hidden w-[190px] shrink-0 flex-col border-r border-border/60 bg-muted/30 md:flex">
          <div className="flex h-[46px] shrink-0 items-center px-4">
            <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Library</h1>
          </div>
          <nav className="wr-app-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {SECTION_GROUPS.map((g) => (
              <div key={g.title} className="mb-3">
                <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {g.title}
                </p>
                <div className="space-y-0.5">
                  {g.keys.map((key) => {
                    const t = TABS.find((x) => x.key === key);
                    if (!t) return null;
                    const isActive = tab === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => select(key)}
                        aria-current={isActive ? "page" : undefined}
                        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] font-medium transition-colors ${
                          isActive
                            ? "bg-brand-blue-soft text-brand-navy"
                            : "text-muted-foreground hover:bg-brand-blue-soft/50 hover:text-brand-navy"
                        }`}
                      >
                        <t.icon className="h-4 w-4 shrink-0" strokeWidth={1.9} />
                        <span className="truncate">{t.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        {/* Work column: breadcrumb-style header, search toolbar, then the list */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Mobile section switcher (the rail is hidden below md) */}
          <div className="flex gap-1 overflow-x-auto border-b border-border/60 px-3 py-2 md:hidden">
            {TABS.map((t) => {
              const isActive = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => select(t.key)}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium ${
                    isActive
                      ? "border-brand-navy bg-brand-navy text-white"
                      : "border-border bg-card text-muted-foreground"
                  }`}
                >
                  <t.icon className="h-3.5 w-3.5" strokeWidth={1.9} />
                  {t.label}
                </button>
              );
            })}
          </div>

          <div className="flex h-[46px] shrink-0 items-center gap-3 border-b border-border/60 px-4">
            <div className="flex min-w-0 items-center gap-2">
              <active.icon className="h-4 w-4 shrink-0 text-brand-navy/60" strokeWidth={1.9} />
              <h2 className="truncate text-[14px] font-semibold text-foreground">{active.label}</h2>
            </div>
            <div className="relative ml-auto w-full max-w-[280px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${active.label.toLowerCase()}`}
                aria-label={`Search ${active.label.toLowerCase()}`}
                className="h-8 w-full rounded-md border border-border bg-card pl-8 pr-7 text-[12.5px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-brand-navy/40"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="wr-app-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {tab === "chats" ? (
              <ChatsList query={query} />
            ) : tab === "draft" ? (
              <DraftsList query={query} />
            ) : SURFACE_TABS.has(tab) ? (
              <WorkspacesList surface={tab as WorkspaceSurface} query={query} />
            ) : (
              <ItemsList kind={tab as ItemKind} query={query} />
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function WorkspacesList({ surface, query = "" }: { surface: WorkspaceSurface; query?: string }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<WorkspaceSummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const folders = useFolders(surface);

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
      const result = await deleteWorkspaceFn({ data: { itemId: id } });
      await load();
      toast.success(
        result.alreadyDeleted
          ? "Already deleted"
          : surface === "review"
            ? "Saved documents deleted; the table that used them now shows those rows as needing re-upload."
            : "Workspace deleted",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete workspace");
    } finally {
      setBusyId(null);
    }
  };

  if (!items) return <Loading />;
  const counts = new Map<string, number>();
  for (const w of items)
    counts.set(folderOf(w.folderId), (counts.get(folderOf(w.folderId)) ?? 0) + 1);
  const shown = items.filter((w) => folders.inView(w.folderId) && hit(w.name, query));
  const emptyLabel =
    surface === "deposition"
      ? "No saved depositions yet. Drop transcripts in Discovery › Depositions; they save automatically."
      : surface === "review"
        ? "No saved review documents yet. Add documents to a Tabular Review table; they save automatically."
        : "No saved working sets yet. Save a working set from Discovery to see it here.";
  return (
    <div className="space-y-3">
      <FolderBar
        folders={folders.folders}
        current={folders.current}
        counts={counts}
        busy={folders.busy}
        onNavigate={folders.navigate}
        onCreate={folders.create}
        onRename={folders.rename}
        onDelete={folders.remove}
      />
      {!items.length ? (
        <EmptyState label={emptyLabel} />
      ) : !shown.length ? (
        <EmptyState
          label={
            query.trim()
              ? `No saved items match "${query.trim()}".`
              : "Nothing in this folder yet. Use Move on an item to file it here."
          }
        />
      ) : null}
      <ul className="space-y-1.5">
        {shown.map((w) => (
          <li
            key={w.itemId}
            className="flex items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-2.5"
          >
            <FolderOpen className="h-4 w-4 shrink-0 text-brand-navy/50" strokeWidth={1.8} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-foreground">{w.name}</p>
              <p className="text-[11px] text-muted-foreground">
                {w.docCount} doc{w.docCount === 1 ? "" : "s"} · {w.pageCount} pages ·{" "}
                {relative(w.createdAt)}
                {w.status === "saving"
                  ? " · saving"
                  : w.status === "error"
                    ? " · save incomplete"
                    : ""}
              </p>
              {w.status === "error" && w.errorSummary ? (
                <p className="mt-0.5 truncate text-[10.5px] text-destructive">{w.errorSummary}</p>
              ) : null}
            </div>
            <MoveToMenu
              folders={folders.folders}
              current={folderOf(w.folderId)}
              onMove={(folderId) => void folders.move(w.itemId, folderId).then(load)}
            >
              <button
                type="button"
                aria-label="Move to folder"
                title="Move to folder"
                className="shrink-0 text-muted-foreground/60 transition hover:text-foreground"
              >
                <FolderInput className="h-4 w-4" strokeWidth={1.8} />
              </button>
            </MoveToMenu>
            <button
              type="button"
              onClick={() => openWorkspace(w.itemId)}
              disabled={w.status !== "ready" && !(w.surface === "deposition" && w.analysis)}
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
    </div>
  );
}

function DraftsList({ query = "" }: { query?: string }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<OfficeDocSummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const folders = useFolders("draft");

  const load = useCallback(async () => {
    try {
      setItems(await listOfficeDocsFn({ data: {} }));
    } catch {
      setItems([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      const result = await deleteOfficeDocFn({ data: { docId: id } });
      await load();
      toast.success(result.alreadyDeleted ? "Already deleted" : "Document deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete document");
    } finally {
      setBusyId(null);
    }
  };

  if (!items) return <Loading />;
  const counts = new Map<string, number>();
  for (const d of items)
    counts.set(folderOf(d.folderId), (counts.get(folderOf(d.folderId)) ?? 0) + 1);
  const shown = items.filter((d) => folders.inView(d.folderId) && hit(d.title, query));
  return (
    <div className="space-y-3">
      <FolderBar
        folders={folders.folders}
        current={folders.current}
        counts={counts}
        busy={folders.busy}
        onNavigate={folders.navigate}
        onCreate={folders.create}
        onRename={folders.rename}
        onDelete={folders.remove}
      />
      {!items.length ? (
        <EmptyState label="No drafts yet. Start one from Drafts; it saves as you write." />
      ) : !shown.length ? (
        <EmptyState
          label={
            query.trim()
              ? `No drafts match "${query.trim()}".`
              : "Nothing in this folder yet. Use Move on a draft to file it here."
          }
        />
      ) : null}
      <ul className="space-y-1.5">
        {shown.map((d) => (
          <li
            key={d.draftId}
            className="flex items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-2.5"
          >
            <PenLine className="h-4 w-4 shrink-0 text-brand-navy/50" strokeWidth={1.8} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-foreground">{d.title}</p>
              <p className="text-[11px] text-muted-foreground">
                {OFFICE_LABEL[d.kind]}
                {d.version > 0 ? ` · revision ${d.version}` : " · legacy draft"} · edited{" "}
                {relative(d.updatedAt)}
              </p>
            </div>
            <MoveToMenu
              folders={folders.folders}
              current={folderOf(d.folderId)}
              onMove={(folderId) => void folders.move(d.draftId, folderId).then(load)}
            >
              <button
                type="button"
                aria-label="Move to folder"
                title="Move to folder"
                className="shrink-0 text-muted-foreground/60 transition hover:text-foreground"
              >
                <FolderInput className="h-4 w-4" strokeWidth={1.8} />
              </button>
            </MoveToMenu>
            <button
              type="button"
              onClick={() =>
                void (d.kind === "xlsx"
                  ? navigate({ to: "/office/sheets/$docId", params: { docId: d.draftId } })
                  : d.kind === "pptx"
                    ? navigate({ to: "/office/slides/$docId", params: { docId: d.draftId } })
                    : d.kind === "pdf"
                      ? navigate({ to: "/office/pdf/$docId", params: { docId: d.draftId } })
                    : navigate({ to: "/office/drafts/$draftId", params: { draftId: d.draftId } }))
              }
              className="shrink-0 rounded bg-brand-navy px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90"
            >
              Open
            </button>
            <button
              type="button"
              onClick={() => void remove(d.draftId)}
              disabled={busyId === d.draftId}
              aria-label="Delete draft"
              className="shrink-0 text-muted-foreground transition hover:text-destructive disabled:opacity-50"
            >
              {busyId === d.draftId ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
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

function ChatsList({ query = "" }: { query?: string }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const folders = useFolders("chats");

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
  const counts = new Map<string, number>();
  for (const c of items)
    counts.set(folderOf(c.folderId), (counts.get(folderOf(c.folderId)) ?? 0) + 1);
  const shown = items.filter((c) => folders.inView(c.folderId) && hit(c.title, query));

  return (
    <div className="space-y-3">
      <FolderBar
        folders={folders.folders}
        current={folders.current}
        counts={counts}
        busy={folders.busy}
        onNavigate={folders.navigate}
        onCreate={folders.create}
        onRename={folders.rename}
        onDelete={folders.remove}
      />
      {items.length === 0 ? (
        <EmptyState label="No conversations yet." />
      ) : shown.length === 0 ? (
        <EmptyState
          label={
            query.trim()
              ? `No conversations match "${query.trim()}".`
              : "Nothing in this folder yet. Use Move on a conversation to file it here."
          }
        />
      ) : null}
      <div className="space-y-1">
        {shown.map((c) => (
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
            <MoveToMenu
              folders={folders.folders}
              current={folderOf(c.folderId)}
              onMove={(folderId) => void folders.move(c.id, folderId).then(refresh)}
            >
              <button
                type="button"
                aria-label="Move to folder"
                title="Move to folder"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground/50 transition-colors hover:bg-background hover:text-foreground"
              >
                <FolderInput className="h-4 w-4" strokeWidth={1.8} />
              </button>
            </MoveToMenu>
            <button
              type="button"
              title={c.saved ? "Kept — won't expire" : "Keep (save past the 3-day default)"}
              onClick={async () => {
                if (c.saved) return;
                await keepConversation(c.id);
                setItems(
                  (prev) => prev?.map((x) => (x.id === c.id ? { ...x, saved: true } : x)) ?? prev,
                );
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
              disabled={busyId === c.id}
              onClick={async () => {
                setBusyId(c.id);
                const ok = await deleteConversation(c.id);
                setBusyId(null);
                if (ok) {
                  setItems((prev) => prev?.filter((x) => x.id !== c.id) ?? prev);
                  toast.success("Conversation deleted");
                } else {
                  toast.error("Could not delete this conversation");
                }
              }}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground/40 transition-colors hover:bg-background hover:text-destructive disabled:opacity-50"
            >
              {busyId === c.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ItemsList({ kind, query = "" }: { kind: ItemKind; query?: string }) {
  const isFile = kind === "file";
  const [items, setItems] = useState<LibItem[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [loadingContent, setLoadingContent] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folders = useFolders(kind);

  const refresh = useCallback(async () => {
    setItems((await listItemsFn({ data: { kind } })) as LibItem[]);
  }, [kind]);
  useEffect(() => {
    setItems(null);
    setOpenId(null);
    void refresh();
  }, [refresh]);

  const view = useCallback(
    async (id: string) => {
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
    },
    [openId],
  );

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
  const counts = new Map<string, number>();
  for (const it of items ?? []) {
    counts.set(folderOf(it.folderId), (counts.get(folderOf(it.folderId)) ?? 0) + 1);
  }
  const shown = (items ?? []).filter(
    (it) => folders.inView(it.folderId) && (hit(it.name, query) || hit(it.preview ?? "", query)),
  );

  return (
    <div className="space-y-2">
      <FolderBar
        folders={folders.folders}
        current={folders.current}
        counts={counts}
        busy={folders.busy}
        onNavigate={folders.navigate}
        onCreate={folders.create}
        onRename={folders.rename}
        onDelete={folders.remove}
      />
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
      ) : shown.length === 0 ? (
        <EmptyState
          label={
            query.trim()
              ? `No ${isFile ? "uploads" : kind === "prompt" ? "prompts" : "saved outputs"} match "${query.trim()}".`
              : "Nothing in this folder yet. Use Move on an item to file it here."
          }
        />
      ) : (
        <div className="space-y-1">
          {shown.map((it) => (
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
                <MoveToMenu
                  folders={folders.folders}
                  current={folderOf(it.folderId)}
                  onMove={(folderId) => void folders.move(it.itemId, folderId).then(refresh)}
                >
                  <button
                    type="button"
                    aria-label="Move to folder"
                    title="Move to folder"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground/50 transition-colors hover:bg-background hover:text-foreground"
                  >
                    <FolderInput className="h-4 w-4" strokeWidth={1.8} />
                  </button>
                </MoveToMenu>
                <button
                  type="button"
                  title="Delete"
                  disabled={busyId === it.itemId}
                  onClick={async () => {
                    setBusyId(it.itemId);
                    try {
                      await deleteLibraryItemFn({ data: { itemId: it.itemId } });
                      setItems((prev) => prev?.filter((x) => x.itemId !== it.itemId) ?? prev);
                      if (openId === it.itemId) setOpenId(null);
                      toast.success(isFile ? "File deleted" : "Deleted");
                    } catch (err) {
                      toast.error(
                        err instanceof Error ? err.message : "Could not delete this item",
                      );
                    } finally {
                      setBusyId(null);
                    }
                  }}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground/40 transition-colors hover:bg-background hover:text-destructive disabled:opacity-50"
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
