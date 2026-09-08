// ============================================================================
// Library folders on DynamoDB (server-only). Owner-scoped like every other
// library row: PK = USER#<principal>, SK = FOLDER#<category>#<ulid>. A folder
// lives under one Library tab (category) and may nest up to MAX_FOLDER_DEPTH.
// Contents keep pointing at folders by `folderId`; moving content rewrites
// that field (and the GSI1 folder key where the row has one).
// ============================================================================
import { ulid } from "ulid";

import { deleteItem, getItem, putItem, queryPrefix, updateItem } from "@/lib/data/dynamo.server";
import {
  canReparent,
  cleanFolderName,
  folderDepth,
  MAX_FOLDER_DEPTH,
  ROOT_FOLDER,
  type FolderCategory,
  type LibraryFolder,
} from "./folder-tree";

const userPK = (p: string) => `USER#${p}`;
const folderSK = (category: FolderCategory, folderId: string) => `FOLDER#${category}#${folderId}`;
const itemSK = (id: string) => `ITEM#${id}`;
const convSK = (id: string) => `CONV#${id}`;

type Item = Record<string, unknown>;
const s = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

function mapFolder(i: Item): LibraryFolder {
  return {
    folderId: s(i.folderId),
    category: s(i.category) as FolderCategory,
    name: s(i.name, "Untitled folder"),
    parentId: s(i.parentId, ROOT_FOLDER) || ROOT_FOLDER,
    createdAt: s(i.createdAt),
    updatedAt: s(i.updatedAt),
  };
}

export async function listFolders(
  principal: string,
  category: FolderCategory,
): Promise<LibraryFolder[]> {
  const rows = await queryPrefix(userPK(principal), `FOLDER#${category}#`);
  return rows.map(mapFolder).filter((f) => f.folderId);
}

export async function createFolder(
  principal: string,
  input: { category: FolderCategory; name: string; parentId?: string },
): Promise<LibraryFolder> {
  const name = cleanFolderName(input.name);
  if (!name) throw new Error("Folder name required");
  const parentId = input.parentId && input.parentId !== ROOT_FOLDER ? input.parentId : ROOT_FOLDER;
  const existing = await listFolders(principal, input.category);
  if (parentId !== ROOT_FOLDER) {
    if (!existing.some((f) => f.folderId === parentId)) throw new Error("Parent folder not found");
    if (folderDepth(existing, parentId) + 1 > MAX_FOLDER_DEPTH) {
      throw new Error(`Folders can nest ${MAX_FOLDER_DEPTH} levels deep`);
    }
  }
  if (
    existing.some((f) => f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase())
  ) {
    throw new Error("A folder with that name already exists here");
  }
  const now = new Date().toISOString();
  const folder: LibraryFolder = {
    folderId: ulid(),
    category: input.category,
    name,
    parentId,
    createdAt: now,
    updatedAt: now,
  };
  await putItem({
    PK: userPK(principal),
    SK: folderSK(input.category, folder.folderId),
    entity: "folder",
    owner: principal,
    ...folder,
  });
  return folder;
}

export async function renameFolder(
  principal: string,
  input: { category: FolderCategory; folderId: string; name: string },
): Promise<LibraryFolder> {
  const name = cleanFolderName(input.name);
  if (!name) throw new Error("Folder name required");
  const row = await getItem(userPK(principal), folderSK(input.category, input.folderId));
  if (!row) throw new Error("Folder not found");
  const next = { ...row, name, updatedAt: new Date().toISOString() };
  await putItem(next);
  return mapFolder(next);
}

export async function moveFolder(
  principal: string,
  input: { category: FolderCategory; folderId: string; parentId: string },
): Promise<LibraryFolder> {
  const folders = await listFolders(principal, input.category);
  const target = folders.find((f) => f.folderId === input.folderId);
  if (!target) throw new Error("Folder not found");
  const parentId = input.parentId === ROOT_FOLDER ? ROOT_FOLDER : input.parentId;
  if (!canReparent(folders, input.folderId, parentId)) {
    throw new Error("That folder cannot be moved there");
  }
  const row = await getItem(userPK(principal), folderSK(input.category, input.folderId));
  if (!row) throw new Error("Folder not found");
  const next = { ...row, parentId, updatedAt: new Date().toISOString() };
  await putItem(next);
  return mapFolder(next);
}

/**
 * Where content for a category lives. Workspaces and library items share the
 * ITEM# key space and a GSI1 folder key; conversations live under CONV#.
 */
function contentKind(category: FolderCategory): "workspace" | "item" | "conversation" {
  if (category === "chats") return "conversation";
  if (category === "workingset" || category === "deposition" || category === "review") {
    return "workspace";
  }
  return "item";
}

async function contentRowsIn(
  principal: string,
  category: FolderCategory,
  folderId: string,
): Promise<Item[]> {
  const kind = contentKind(category);
  if (kind === "conversation") {
    const rows = await queryPrefix(userPK(principal), "CONV#");
    return rows.filter((r) => (s(r.folderId, ROOT_FOLDER) || ROOT_FOLDER) === folderId);
  }
  const rows = await queryPrefix(userPK(principal), "ITEM#");
  return rows.filter((r) => {
    if ((s(r.folderId, ROOT_FOLDER) || ROOT_FOLDER) !== folderId) return false;
    if (kind === "workspace") return s(r.type) === "workspace" && s(r.surface) === category;
    return s(r.type) === category;
  });
}

async function setRowFolder(principal: string, row: Item, folderId: string): Promise<void> {
  const sk = s(row.SK);
  if (!sk) return;
  const set: Record<string, unknown> = { folderId };
  if (sk.startsWith("ITEM#")) {
    set["GSI1PK"] = `FLD#${principal}#${folderId}`;
  }
  await updateItem(userPK(principal), sk, { set });
}

/**
 * Delete a folder. Its sub-folders and contents move up to its parent, so
 * nothing the user saved disappears with the folder.
 */
export async function deleteFolder(
  principal: string,
  input: { category: FolderCategory; folderId: string },
): Promise<{ movedFolders: number; movedItems: number }> {
  const folders = await listFolders(principal, input.category);
  const target = folders.find((f) => f.folderId === input.folderId);
  if (!target) return { movedFolders: 0, movedItems: 0 };
  const parentId = target.parentId || ROOT_FOLDER;
  let movedFolders = 0;
  for (const child of folders.filter((f) => f.parentId === input.folderId)) {
    const row = await getItem(userPK(principal), folderSK(input.category, child.folderId));
    if (!row) continue;
    await putItem({ ...row, parentId, updatedAt: new Date().toISOString() });
    movedFolders += 1;
  }
  const contents = await contentRowsIn(principal, input.category, input.folderId);
  for (const row of contents) await setRowFolder(principal, row, parentId);
  await deleteItem(userPK(principal), folderSK(input.category, input.folderId));
  return { movedFolders, movedItems: contents.length };
}

/**
 * Move one piece of content (workspace, library item, or conversation) into a
 * folder of its category. The row must belong to the caller and match the
 * category; the folder must exist (or be ROOT).
 */
export async function moveContent(
  principal: string,
  input: { category: FolderCategory; targetId: string; folderId: string },
): Promise<{ ok: true }> {
  const folderId = input.folderId === ROOT_FOLDER ? ROOT_FOLDER : input.folderId;
  if (folderId !== ROOT_FOLDER) {
    const folder = await getItem(userPK(principal), folderSK(input.category, folderId));
    if (!folder) throw new Error("Folder not found");
  }
  const kind = contentKind(input.category);
  const sk = kind === "conversation" ? convSK(input.targetId) : itemSK(input.targetId);
  const row = await getItem(userPK(principal), sk);
  if (!row) throw new Error("Item not found");
  if (kind === "workspace" && (s(row.type) !== "workspace" || s(row.surface) !== input.category)) {
    throw new Error("Item is not in this section");
  }
  if (kind === "item" && s(row.type) !== input.category)
    throw new Error("Item is not in this section");
  await setRowFolder(principal, row, folderId);
  return { ok: true };
}
