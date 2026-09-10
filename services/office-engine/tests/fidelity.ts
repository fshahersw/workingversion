// Package-fidelity gate (bundled by build.mjs into .build/fidelity.cjs and run
// by server/fidelity.test.mjs). For every fixture, apply one surgical cell
// edit through the retained change-plan writer and assert that only the
// targeted worksheet part changed: every other ZIP entry survives
// byte-identical and none disappears. This is the property that makes
// "what you did not touch stays exactly as Excel wrote it" true.
import { applyPlanToXlsx } from "../vendor/sheets/src/gateway/xlsx-gateway";
import type { CellState, ChangePlan } from "../vendor/sheets/src/domain/workbook.types";
import {
  buildCompatibilityFixture,
  buildEditFixture,
  buildKitchenSinkFixture,
  buildSheetsFixture,
  buildStructureFixture,
} from "./fixture-builder";

export { PPTX_CORPUS, verifyPptxCase, openPptx, savePptx } from "./fidelity-pptx";

export type FixtureCase = {
  name: string;
  build: () => Promise<Buffer>;
  sheetName: string;
  address: string;
  before: CellState;
  after: CellState;
};

export const CORPUS: readonly FixtureCase[] = [
  { name: "compatibility-basic.xlsx", build: buildCompatibilityFixture, sheetName: "Sheet1", address: "A1", before: { value: "Old" }, after: { value: "Verified" } },
  { name: "compatibility-edit.xlsx", build: buildEditFixture, sheetName: "Data", address: "C1", before: { value: 5 }, after: { value: 6 } },
  { name: "compatibility-structure.xlsx", build: buildStructureFixture, sheetName: "Data", address: "A1", before: { value: 1 }, after: { value: 99 } },
  { name: "compatibility-sheets.xlsx", build: buildSheetsFixture, sheetName: "Data", address: "A1", before: { value: 1 }, after: { value: 99 } },
  { name: "compatibility-kitchen-sink.xlsx", build: buildKitchenSinkFixture, sheetName: "Data", address: "A1", before: { value: 1 }, after: { value: 99 } },
];

export type FixtureReport = {
  fixture: string;
  passed: boolean;
  error?: string;
  touchedEntries: string[];
  changedEntries: string[];
  removedEntries: string[];
  unexpectedChanges: string[];
  preservedEntryCount: number;
};

export async function verifyCase(entry: FixtureCase, source?: Buffer): Promise<FixtureReport> {
  const bytes = source ?? (await entry.build());
  const plan: ChangePlan = {
    transactionId: `fidelity-${entry.name}`,
    baseRevision: 0,
    cellChanges: [{ sheetId: "sheet-under-test", address: entry.address, before: entry.before, after: entry.after }],
    sheetRenames: [],
    structuralChanges: [],
    formatChanges: [],
    warnings: [],
  };
  try {
    const mutation = await applyPlanToXlsx(bytes, plan, { "sheet-under-test": entry.sheetName });
    const beforeByPath = new Map(mutation.beforeEntries.map((e) => [e.path, e.sha256]));
    const afterPaths = new Set(mutation.afterEntries.map((e) => e.path));
    const changedEntries = mutation.afterEntries.filter((e) => beforeByPath.get(e.path) !== e.sha256).map((e) => e.path);
    const removedEntries = mutation.beforeEntries.filter((e) => !afterPaths.has(e.path)).map((e) => e.path);
    const unexpectedChanges = [...changedEntries, ...removedEntries].filter((p) => !mutation.touchedEntries.includes(p));
    return {
      fixture: entry.name,
      passed: unexpectedChanges.length === 0 && changedEntries.length > 0,
      touchedEntries: [...mutation.touchedEntries],
      changedEntries,
      removedEntries,
      unexpectedChanges,
      preservedEntryCount: mutation.afterEntries.length - changedEntries.length,
    };
  } catch (error) {
    return {
      fixture: entry.name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      touchedEntries: [],
      changedEntries: [],
      removedEntries: [],
      unexpectedChanges: [],
      preservedEntryCount: 0,
    };
  }
}
