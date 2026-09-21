// ============================================================================
// Server functions for the Legal Archive corpus pages. Each is Cognito-gated
// (requireAuth) and calls the allow-listed archive/workbench client from
// client.server.ts, so the gateway app key never leaves the server. Responses
// are returned verbatim (the pages render them, tailored where the shape is
// known, generic otherwise) along with the archive's closed-layer signal.
//
// Endpoint paths here must all be present in ARCHIVE_ALLOWED_PATHS /
// WORKBENCH_ALLOWED_PATHS (policy.ts); the client rejects anything else.
// ============================================================================
import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";

import type { JsonValue } from "./policy";
import type {
  CorpusResult,
  ForJudgeInput,
  IdInput,
  JurisdictionInput,
  QueryInput,
  RegPartsInput,
  RegSectionsInput,
  SearchInput,
} from "./corpus-types";

type Query = Record<string, string | number | undefined>;

async function archive(path: string, query?: Query): Promise<CorpusResult> {
  const { archiveGet } = await import("./client.server");
  const r = await archiveGet<JsonValue>(path, query);
  return { data: r.data as JsonValue, closed: r.closed };
}

async function workbench(path: string, query?: Query): Promise<CorpusResult> {
  const { workbenchGet } = await import("./client.server");
  const r = await workbenchGet<JsonValue>(path, query);
  return { data: r.data as JsonValue, closed: r.closed };
}

// --- Search & explore (workbench + archive) -------------------------------------
export const corpusSearch = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: SearchInput) => d)
  .handler(
    async ({ data }): Promise<CorpusResult> =>
      workbench("/api/search", { q: data.q, limit: data.limit ?? 25 }),
  );

export const corpusExplore = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async (): Promise<CorpusResult> => archive("/api/explore"));

// --- States & counties -----------------------------------------------------------
export const stateCoverage = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async (): Promise<CorpusResult> => archive("/api/coverage/state"));

export const listCounties = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: JurisdictionInput) => d)
  .handler(
    async ({ data }): Promise<CorpusResult> => archive("/api/counties", { state: data.state }),
  );

export const countyFilingCoverage = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async (): Promise<CorpusResult> => archive("/api/county-filing/coverage"));

export const countyLitigation = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: JurisdictionInput) => d)
  .handler(
    async ({ data }): Promise<CorpusResult> =>
      archive("/api/county-litigation", { state: data.state }),
  );

// --- Federal law & agencies ------------------------------------------------------
export const regTitles = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async (): Promise<CorpusResult> => archive("/api/regulations/titles"));

export const regParts = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: RegPartsInput) => d)
  .handler(
    async ({ data }): Promise<CorpusResult> =>
      archive("/api/regulations/parts", { title: data.title }),
  );

export const regSections = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: RegSectionsInput) => d)
  .handler(
    async ({ data }): Promise<CorpusResult> =>
      archive("/api/regulations/sections", { title: data.title, part: data.part }),
  );

export const regSearch = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: SearchInput) => d)
  .handler(
    async ({ data }): Promise<CorpusResult> => archive("/api/regulations/search", { q: data.q }),
  );

export const lawOutline = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async (): Promise<CorpusResult> => archive("/api/law-outline"));

export const agencyHub = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async (): Promise<CorpusResult> => archive("/api/agency-hub"));

export const agencySearch = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: SearchInput) => d)
  .handler(async ({ data }): Promise<CorpusResult> => archive("/api/agency/search", { q: data.q }));

// --- Courts & litigation ---------------------------------------------------------
export const resolveCourt = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: QueryInput) => d)
  .handler(async ({ data }): Promise<CorpusResult> => archive("/api/court-resolve", { q: data.q }));

export const listJudges = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: QueryInput) => d)
  .handler(async ({ data }): Promise<CorpusResult> => archive("/api/judges", { q: data.q }));

export const getJudge = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: IdInput) => d)
  .handler(async ({ data }): Promise<CorpusResult> => archive("/api/judge", { id: data.id }));

export const mdlsForJudge = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: ForJudgeInput) => d)
  .handler(
    async ({ data }): Promise<CorpusResult> =>
      archive("/api/mdls/for-judge", { judge: data.judge }),
  );

export const listMdls = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: QueryInput) => d)
  .handler(async ({ data }): Promise<CorpusResult> => archive("/api/mdls", { q: data.q }));

export const getMdl = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: IdInput) => d)
  .handler(async ({ data }): Promise<CorpusResult> => archive("/api/mdl", { id: data.id }));

export const mdlsSummary = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async (): Promise<CorpusResult> => archive("/api/mdls/summary"));

export const listDocuments = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: QueryInput) => d)
  .handler(async ({ data }): Promise<CorpusResult> => archive("/api/documents", { q: data.q }));

export const getRecord = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: IdInput) => d)
  .handler(async ({ data }): Promise<CorpusResult> => archive("/api/record", { id: data.id }));
