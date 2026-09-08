import {
  ChevronRight,
  Folder,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  flattenFolders,
  folderPath,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_NAME,
  ROOT_FOLDER,
  type LibraryFolder,
} from "@/lib/library/folder-tree";

/**
 * Folder navigation for one Library section: breadcrumb, the folders at the
 * current level, and create / rename / delete. Contents are rendered by the
 * caller, filtered to `current`.
 */
export function FolderBar({
  folders,
  current,
  counts,
  busy,
  onNavigate,
  onCreate,
  onRename,
  onDelete,
}: {
  folders: LibraryFolder[];
  current: string;
  /** Items directly inside each folder id, for the chip badge. */
  counts?: Map<string, number>;
  busy?: boolean;
  onNavigate: (folderId: string) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (folderId: string, name: string) => Promise<void>;
  onDelete: (folderId: string) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const path = folderPath(folders, current);
  const children = folders
    .filter((f) => f.parentId === current)
    .sort((a, b) => a.name.localeCompare(b.name));
  const depth = current === ROOT_FOLDER ? 0 : path.length;
  const canNest = depth < MAX_FOLDER_DEPTH;

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const submitCreate = async () => {
    const name = draft.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    await onCreate(name);
    setDraft("");
    setCreating(false);
  };

  return (
    <div className="space-y-2">
      <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-[12px]">
        <button
          type="button"
          onClick={() => onNavigate(ROOT_FOLDER)}
          className={`rounded px-1.5 py-0.5 ${
            current === ROOT_FOLDER
              ? "font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          All
        </button>
        {path.map((folder, index) => (
          <span key={folder.folderId} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
            <button
              type="button"
              onClick={() => onNavigate(folder.folderId)}
              className={`max-w-[14rem] truncate rounded px-1.5 py-0.5 ${
                index === path.length - 1
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {folder.name}
            </button>
          </span>
        ))}
        <span className="ml-auto flex items-center gap-1">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
          {canNest ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.8} />
              New folder
            </button>
          ) : null}
        </span>
      </nav>

      {creating || children.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {children.map((folder) =>
            renaming === folder.folderId ? (
              <form
                key={folder.folderId}
                className="flex items-center"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const name = renameDraft.trim();
                  if (name && name !== folder.name) await onRename(folder.folderId, name);
                  setRenaming(null);
                }}
              >
                <input
                  autoFocus
                  value={renameDraft}
                  maxLength={MAX_FOLDER_NAME}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={() => setRenaming(null)}
                  onKeyDown={(event) => event.key === "Escape" && setRenaming(null)}
                  className="h-7 w-44 rounded-md border border-border bg-card px-2 text-[12px] outline-none focus:border-brand-navy/40"
                  aria-label="Folder name"
                />
              </form>
            ) : (
              <span
                key={folder.folderId}
                className="group inline-flex items-center rounded-md border border-border/70 bg-card pl-2 text-[12px] hover:border-brand-navy/30"
              >
                <button
                  type="button"
                  onClick={() => onNavigate(folder.folderId)}
                  className="inline-flex items-center gap-1.5 py-1 pr-1 text-foreground"
                >
                  <Folder className="h-3.5 w-3.5 text-brand-navy/60" strokeWidth={1.8} />
                  <span className="max-w-[12rem] truncate">{folder.name}</span>
                  {counts?.get(folder.folderId) ? (
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                      {counts.get(folder.folderId)}
                    </span>
                  ) : null}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Folder options for ${folder.name}`}
                      className="grid h-7 w-6 place-items-center rounded-r-md text-muted-foreground/50 hover:bg-muted hover:text-foreground"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="text-[12.5px]">
                    <DropdownMenuItem
                      onClick={() => {
                        setRenameDraft(folder.name);
                        setRenaming(folder.folderId);
                      }}
                    >
                      <Pencil className="mr-2 h-3.5 w-3.5" /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => void onDelete(folder.folderId)}
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete folder
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            ),
          )}
          {creating ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCreate();
              }}
            >
              <input
                ref={inputRef}
                value={draft}
                maxLength={MAX_FOLDER_NAME}
                placeholder="Folder name"
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => void submitCreate()}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setDraft("");
                    setCreating(false);
                  }
                }}
                className="h-7 w-44 rounded-md border border-border bg-card px-2 text-[12px] outline-none focus:border-brand-navy/40"
                aria-label="New folder name"
              />
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** "Move to…" picker over the whole folder tree of a section. */
export function MoveToMenu({
  folders,
  current,
  onMove,
  children,
}: {
  folders: LibraryFolder[];
  current: string;
  onMove: (folderId: string) => void;
  children: React.ReactNode;
}) {
  const flat = flattenFolders(folders);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto text-[12.5px]">
        <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
          Move to
        </DropdownMenuLabel>
        <DropdownMenuItem disabled={current === ROOT_FOLDER} onClick={() => onMove(ROOT_FOLDER)}>
          All (top level)
        </DropdownMenuItem>
        {flat.length ? <DropdownMenuSeparator /> : null}
        {flat.map(({ folder, depth }) => (
          <DropdownMenuItem
            key={folder.folderId}
            disabled={folder.folderId === current}
            onClick={() => onMove(folder.folderId)}
            style={{ paddingLeft: 8 + depth * 12 }}
          >
            <Folder className="mr-2 h-3.5 w-3.5 text-brand-navy/60" strokeWidth={1.8} />
            <span className="truncate">{folder.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
