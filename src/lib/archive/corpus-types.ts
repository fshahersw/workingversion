// ============================================================================
// Client-safe types shared by the Legal Archive corpus pages (Search, States &
// Counties, Federal Law & Agencies, Courts & Litigation) and their server
// functions. No server-only imports here so both sides can use them.
// ============================================================================
import type { JsonValue } from "./policy";

/** What every corpus server fn returns: the archive's JSON verbatim, plus its closed-layer signal. */
export type CorpusResult<T = JsonValue> = { data: T; closed: boolean };

// --- Server-fn inputs (kept small and explicit; the archive owns the shapes) ---
export type SearchInput = { q: string; limit?: number };
export type QueryInput = { q?: string };
export type IdInput = { id: string };
export type RegPartsInput = { title: string };
export type RegSectionsInput = { title: string; part: string };
export type JurisdictionInput = { state: string; stateName?: string };
export type ForJudgeInput = { judge: string };
