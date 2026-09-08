import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildFolderTree,
  canReparent,
  cleanFolderName,
  flattenFolders,
  folderDepth,
  folderPath,
  ROOT_FOLDER,
  type LibraryFolder,
} from "./folder-tree.ts";

function folder(id: string, name: string, parentId = ROOT_FOLDER): LibraryFolder {
  return {
    folderId: id,
    category: "workingset",
    name,
    parentId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const folders = [
  folder("a", "Acme MDL"),
  folder("a1", "Depositions", "a"),
  folder("a1x", "Experts", "a1"),
  folder("b", "Zeta v. Omega"),
  folder("orphan", "Lost", "missing-parent"),
];

test("tree nests by parent, sorts by name, and attaches orphans to the root", () => {
  const tree = buildFolderTree(folders);
  assert.deepEqual(
    tree.map((n) => n.name),
    ["Acme MDL", "Lost", "Zeta v. Omega"],
  );
  const acme = tree[0]!;
  assert.equal(acme.children[0]!.name, "Depositions");
  assert.equal(acme.children[0]!.children[0]!.name, "Experts");
  assert.equal(acme.children[0]!.children[0]!.depth, 2);
});

test("path and depth follow the parent chain", () => {
  assert.deepEqual(
    folderPath(folders, "a1x").map((f) => f.name),
    ["Acme MDL", "Depositions", "Experts"],
  );
  assert.equal(folderDepth(folders, ROOT_FOLDER), 0);
  assert.equal(folderDepth(folders, "a"), 1);
  assert.equal(folderDepth(folders, "a1x"), 3);
  assert.deepEqual(folderPath(folders, "nope"), []);
});

test("reparenting refuses cycles, self, unknown parents and over-deep trees", () => {
  assert.equal(canReparent(folders, "a", "a1x"), false, "cannot move under own descendant");
  assert.equal(canReparent(folders, "a", "a"), false);
  assert.equal(canReparent(folders, "b", "ghost"), false);
  assert.equal(canReparent(folders, "b", "a1x"), true, "b has no children; depth 4 is allowed");
  assert.equal(
    canReparent(folders, "a", "b"),
    true,
    "a's subtree reaches depth 4 under b: allowed",
  );
  const deeper = [...folders, folder("a1xy", "Rebuttal", "a1x")];
  assert.equal(canReparent(deeper, "a", "b"), false, "a's subtree would reach depth 5 under b");
  assert.equal(canReparent(folders, "a1x", ROOT_FOLDER), true);
});

test("flatten keeps tree order with depths for a picker", () => {
  const flat = flattenFolders(folders).map((entry) => `${entry.depth}:${entry.folder.name}`);
  assert.deepEqual(flat, ["0:Acme MDL", "1:Depositions", "2:Experts", "0:Lost", "0:Zeta v. Omega"]);
});

test("folder names are cleaned and capped", () => {
  assert.equal(cleanFolderName("  Privilege\u0007   review  "), "Privilege review");
  assert.equal(cleanFolderName("x".repeat(100)).length, 60);
  assert.equal(cleanFolderName(null), "");
});
