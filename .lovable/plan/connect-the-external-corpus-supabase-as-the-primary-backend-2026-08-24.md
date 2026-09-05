# Connect the external corpus Supabase as the primary backend

## Goal
Replace the managed Lovable Cloud project (`sqzmsvntyallbhthlbev`) with the external corpus project (`odwhzepghulspdzmzhhz.supabase.co`) so this Lovable instance can run migrations, RLS changes, and backfill writes directly against the litigation registry. The agent backend (`tbasvydiknulgtnsqvfp`) remains a secondary client for chat/orchestrate edge functions.

## What will change

### 1. Backend binding in Lovable Cloud
- Bind the corpus project as the primary backend in this project's settings.
- Provide the corpus project's **service role key** and **publishable key** (the same keys used in `src/lib/corpus.ts`).
- Lovable will regenerate the managed Supabase integration files and env vars to point at `odwh...` instead of `sqzms...`.

### 2. Clean up hardcoded corpus credentials
- Remove the hardcoded `CORPUS_URL` and `CORPUS_KEY` from `src/lib/corpus.ts`.
- Replace them with reads from the Lovable-injected env vars (`VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` on the client, `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` on the server).
- Keep the `registry` schema wrapper (`db: { schema: 'registry' }`) because the generated client defaults to the `public` schema.

### 3. Audit old Lovable Cloud dependencies
- Verify nothing in the codebase still queries the old `news_headlines` or `profiles` tables.
- `news_headlines` was already replaced by `src/lib/news-static.ts`.
- `profiles` was already replaced by `src/lib/local-profile.ts`.
- `src/lib/use-auth.ts` stays a no-op placeholder so the new auth workflow can be wired later without touching components.

### 4. Agent backend stays as a secondary client
- `src/lib/supabase.ts` keeps pointing at `tbasvydiknulgtnsqvfp` for chat/orchestrate edge functions.
- Optionally move its URL/key into managed secrets later, but not in this change.

### 5. Regenerate types and verify connection
- Regenerate `src/integrations/supabase/types.ts` from the corpus schema (public + registry).
- Run a test read query against `registry.matters` to confirm the managed connection works and the Data API can see the registry tables.

### 6. Resume the backfill pipeline
- Once the corpus is the primary backend, run the planned `supabase/corpus/registry-enrichment.sql` migration through the Lovable migration tool.
- Then execute `scripts/backfill-enrich.ts` to populate `enrich_documents` and `enrich_entries` from the S3 catalog.

## What I need from you
- Confirm that `odwhzepghulspdzmzhhz.supabase.co` is the correct project to bind as the primary backend.
- Provide the service role key and publishable key for that project, or confirm they are already saved in this Lovable project's secrets.

## Risks and notes
- The managed Supabase integration files (`src/integrations/supabase/client.ts`, `client.server.ts`, `auth-middleware.ts`, `types.ts`, `previewAuthStorage.ts`) will be regenerated. We have not manually edited them, so this is safe.
- After the switch, the Lovable Cloud project (`sqzms...`) is no longer connected to this app. Any data still living there (old `profiles`/`news_headlines`) will not be reachable unless explicitly migrated.
- The `tbas...` agent backend remains separate and is only reachable through the hardcoded client in `src/lib/supabase.ts` until it is also connected.
