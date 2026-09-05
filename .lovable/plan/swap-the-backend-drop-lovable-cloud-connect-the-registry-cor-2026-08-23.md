# Swap the backend: drop Lovable Cloud, connect the `registry` corpus project

## What I verified just now (after you enabled the API)

Against `odwhzepghulspdzmzhhz` with the publishable key:

- The `registry` schema is now exposed — good, that part is done.
- Real tables confirmed to exist: `matters`, `docket_entries`, `documents`, `courts`, `parties` (each returns a permissions error, not "not found"). Names like `cases`, `dockets`, `chunks`, `sources` do **not** exist.
- Every existing table returns `permission denied for schema registry` — so one grant step is still missing before the app can read anything.

## Plan

### 1. Grant read access on the corpus project (one step, on that project)
Run there:

```sql
GRANT USAGE ON SCHEMA registry TO anon, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA registry TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA registry
  GRANT SELECT ON TABLES TO anon, authenticated;
```

If any registry tables have RLS enabled, they also need a read policy (or RLS stays off for read-only reference data). If you'd rather not open all 40 tables, grant `SELECT` on just `matters`, `docket_entries`, `documents`, `courts`, `parties` and I'll build against those.

Storage: `FORAWS` also needs a read policy for the app role, or we serve files via signed URLs from a server function.

Once reads work I'll enumerate the actual columns and lock the field mapping — no guessing at shapes.

### 2. Remove the Lovable Cloud dependency
- Drop `src/integrations/supabase/*` usage from app code: `use-auth.ts`, `HomeDashboard.tsx`, and the `attachSupabaseAuth` middleware in `src/start.ts`.
- Remove the `news_headlines` query; Home renders a static curated headline list (`src/lib/news-static.ts`) so the panel keeps its look with no DB calls.
- Remove the `fetch-immigration-news` function and its config entry.
- Keep `useAuth`'s shape (`session/user/loading/signIn/signOut`) and no sign-in gate, so your new auth workflow drops in later without touching components.

### 3. Add the corpus client
- New `src/lib/corpus.ts`: one Supabase client for `https://odwhzepghulspdzmzhhz.supabase.co` configured with `db: { schema: 'registry' }`, plus a helper for `FORAWS` file URLs.
- `src/lib/supabase.ts` (the `tbasvydiknulgtnsqvfp` orchestrate/chat backend) stays untouched — that remains the agent backend.

### 4. Replace mock matters with corpus-backed data
- `src/lib/matters-corpus.ts`: queries against `registry.matters` (plus `courts`/`parties` joins where they exist) and a mapper into the existing `Matter` type, which stays the UI contract.
- `MattersTable` and `MatterDetail` move from synchronous `MATTERS`/`getMatter()` to TanStack Query reads with skeleton, empty, and error states.
- Matter detail lists related `docket_entries` and links `documents` to `FORAWS` objects.
- The current mock array stays behind an explicit fallback flag during the swap so the page never renders blank.

### 5. Follow-on (separate pass)
Docket auto-refresh, RAG retrieval over the corpus, and grounding the research agent's citations in registry documents — scoped once the real columns are visible.

## Technical notes

- Changed: `src/start.ts`, `src/lib/use-auth.ts`, `src/components/home/HomeDashboard.tsx`, `src/lib/matters-data.ts`, `src/components/matters/MattersTable.tsx`, `src/components/matters/MatterDetail.tsx`, `supabase/config.toml`; `src/integrations/supabase/*` becomes unused.
- New: `src/lib/corpus.ts`, `src/lib/news-static.ts`, `src/lib/matters-corpus.ts`.
- The publishable key is safe in client code; it only sees what grants and RLS allow.
