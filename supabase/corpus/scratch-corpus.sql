-- ============================================================================
-- scratch: ephemeral document workspace (Docling ingestion)
--
-- Temporary by construction. Nothing here joins the permanent corpus and
-- nothing is written to object storage.
--
--   raw PDF bytes      -> dropped as soon as a document finishes (6h ceiling)
--   markdown / vectors -> 3-day rolling expiry, refreshed on access
--
-- A pg_cron sweep enforces both clocks every 15 minutes.
--
-- Idempotent. Apply with:
--   psql "$CORPUS_DB_URL" -f supabase/corpus/scratch-corpus.sql
-- ============================================================================

create schema if not exists scratch;
create extension if not exists vector;
create extension if not exists pg_trgm;

-- ------------------------------------------------------------- sessions ----
create table if not exists scratch.sessions (
  session_id   uuid primary key default gen_random_uuid(),
  label        text,
  instructions text,
  owner_email  text,
  status       text not null default 'open',
  -- open | ingesting | ready | failed
  error        text,
  created_at   timestamptz not null default now(),
  accessed_at  timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '3 days'
);
create index if not exists scratch_sessions_expiry on scratch.sessions (expires_at);

-- ------------------------------------------------------------ documents ----
create table if not exists scratch.documents (
  document_id       uuid primary key default gen_random_uuid(),
  session_id        uuid not null references scratch.sessions(session_id) on delete cascade,
  name              text not null,
  sha256            text not null,
  byte_size         bigint not null default 0,
  page_count        int not null default 0,
  pages_done        int not null default 0,
  status            text not null default 'pending',
  -- pending | running | complete | failed
  error             text,
  bytes             bytea,
  bytes_expires_at  timestamptz not null default now() + interval '6 hours',
  created_at        timestamptz not null default now()
);
create index if not exists scratch_documents_session on scratch.documents (session_id);
create index if not exists scratch_documents_sha on scratch.documents (sha256);
create index if not exists scratch_documents_bytes_expiry
  on scratch.documents (bytes_expires_at) where bytes is not null;

-- ---------------------------------------------------------------- pages ----
create table if not exists scratch.pages (
  page_id     bigserial primary key,
  document_id uuid not null references scratch.documents(document_id) on delete cascade,
  session_id  uuid not null references scratch.sessions(session_id) on delete cascade,
  page_no     int not null,
  source      text not null default 'text',   -- text | ocr | vl | failed
  confidence  real,
  markdown    text not null default '',
  elements    jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  unique (document_id, page_no)
);
create index if not exists scratch_pages_session on scratch.pages (session_id);

-- --------------------------------------------------------------- chunks ----
-- voyage-law-2 / titan-embed-v2 are both 1024-dim, so the column and every
-- existing query stay interchangeable between them.
create table if not exists scratch.chunks (
  chunk_id     bigserial primary key,
  session_id   uuid not null references scratch.sessions(session_id) on delete cascade,
  document_id  uuid not null references scratch.documents(document_id) on delete cascade,
  page_start   int not null,
  page_end     int not null,
  heading_path text,
  content      text not null,
  embedding    vector(1024),
  tsv          tsvector generated always as (to_tsvector('english', content)) stored,
  created_at   timestamptz not null default now()
);
create index if not exists scratch_chunks_session on scratch.chunks (session_id);
create index if not exists scratch_chunks_tsv on scratch.chunks using gin (tsv);
-- 1024 dims indexes directly; no halfvec cast needed.
create index if not exists scratch_chunks_embedding
  on scratch.chunks using hnsw (embedding vector_cosine_ops);

-- ----------------------------------------------------------------- jobs ----
create table if not exists scratch.jobs (
  job_id      bigserial primary key,
  session_id  uuid not null references scratch.sessions(session_id) on delete cascade,
  document_id uuid not null references scratch.documents(document_id) on delete cascade,
  queue       text not null,                   -- text | ocr
  page_start  int not null,
  page_end    int not null,
  state       text not null default 'queued',  -- queued | running | done | failed
  attempts    int not null default 0,
  claimed_by  text,
  claimed_at  timestamptz,
  heartbeat_at timestamptz,
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists scratch_jobs_pick
  on scratch.jobs (queue, state, created_at) where state = 'queued';
create index if not exists scratch_jobs_session on scratch.jobs (session_id);
create index if not exists scratch_jobs_stale
  on scratch.jobs (heartbeat_at) where state = 'running';

-- ---------------------------------------------------------------- sweep ----
create or replace function scratch.sweep()
returns void
language plpgsql
security definer
set search_path to 'scratch', 'public', 'extensions'
as $$
begin
  -- raw bytes go first and hardest
  update scratch.documents
     set bytes = null
   where bytes is not null
     and (bytes_expires_at <= now() or status = 'complete');

  -- whole sessions past their rolling window
  delete from scratch.sessions where expires_at <= now();

  -- running jobs whose worker died
  update scratch.jobs
     set state = 'queued', claimed_by = null, claimed_at = null
   where state = 'running'
     and coalesce(heartbeat_at, claimed_at) < now() - interval '10 minutes'
     and attempts < 4;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('scratch-sweep')
      where exists (select 1 from cron.job where jobname = 'scratch-sweep');
    perform cron.schedule('scratch-sweep', '*/15 * * * *', 'select scratch.sweep()');
  end if;
end;
$$;

-- --------------------------------------------------------------- search ----
-- Hybrid: vector arm + tsvector arm, fused with reciprocal rank fusion.
create or replace function scratch.hybrid_search(
  p_session uuid,
  p_query   text,
  p_embedding vector(1024),
  p_limit   int default 20
)
returns table (
  chunk_id     bigint,
  document_id  uuid,
  document_name text,
  page_start   int,
  page_end     int,
  heading_path text,
  content      text,
  score        double precision
)
language sql
stable
security definer
set search_path to 'scratch', 'public', 'extensions'
as $$
  with vec as (
    select c.chunk_id, row_number() over (order by c.embedding <=> p_embedding) as rk
      from scratch.chunks c
     where c.session_id = p_session and c.embedding is not null
     order by c.embedding <=> p_embedding
     limit greatest(p_limit * 4, 60)
  ),
  kw as (
    select c.chunk_id,
           row_number() over (
             order by ts_rank_cd(c.tsv, websearch_to_tsquery('english', p_query)) desc
           ) as rk
      from scratch.chunks c
     where c.session_id = p_session
       and c.tsv @@ websearch_to_tsquery('english', p_query)
     limit greatest(p_limit * 4, 60)
  ),
  fused as (
    select coalesce(v.chunk_id, k.chunk_id) as chunk_id,
           coalesce(1.0 / (60 + v.rk), 0) + coalesce(1.0 / (60 + k.rk), 0) as score
      from vec v full outer join kw k on k.chunk_id = v.chunk_id
  )
  select c.chunk_id, c.document_id, d.name, c.page_start, c.page_end,
         c.heading_path, c.content, f.score
    from fused f
    join scratch.chunks c on c.chunk_id = f.chunk_id
    join scratch.documents d on d.document_id = c.document_id
   order by f.score desc
   limit p_limit;
$$;

-- --------------------------------------------------------------- bridge ----
-- App reads through PostgREST's default public profile, service_role only.
create or replace view public.scratch_sessions as
select s.session_id, s.label, s.instructions, s.owner_email, s.status, s.error,
       s.created_at, s.accessed_at, s.expires_at
from scratch.sessions s;

create or replace view public.scratch_documents as
select document_id, session_id, name, sha256, byte_size, page_count,
       pages_done, status, error, created_at
from scratch.documents;

create or replace view public.scratch_pages as
select page_id, document_id, session_id, page_no, source, confidence, markdown, elements
from scratch.pages;

create or replace view public.scratch_jobs as
select job_id, session_id, document_id, queue, page_start, page_end, state,
       attempts, claimed_by, error, created_at
from scratch.jobs;

revoke all on public.scratch_sessions, public.scratch_documents,
              public.scratch_pages, public.scratch_jobs
  from anon, authenticated;
grant select, insert, update, delete on public.scratch_sessions to service_role;
grant select, insert, update, delete on public.scratch_documents to service_role;
grant select on public.scratch_pages to service_role;
grant select on public.scratch_jobs to service_role;
grant usage on schema scratch to service_role;
grant execute on function scratch.hybrid_search(uuid, text, vector, int) to service_role;

-- ------------------------------------------------- public RPC wrappers ----
-- PostgREST resolves rpc/* in the public schema, so the app-facing surface
-- lives here and delegates into `scratch`.

create or replace function public.scratch_hybrid_search(
  p_session uuid,
  p_query text,
  p_embedding text default null,
  p_limit int default 20
)
returns table (
  chunk_id bigint, document_id uuid, document_name text,
  page_start int, page_end int, heading_path text, content text,
  score double precision
)
language sql
stable
security definer
set search_path to 'scratch', 'public', 'extensions'
as $$
  select * from scratch.hybrid_search(
    p_session, p_query,
    coalesce(p_embedding::vector(1024), array_fill(0::real, array[1024])::vector(1024)),
    p_limit
  );
$$;

-- Streamed upload: the app appends base64 slices so no single request has to
-- carry a whole PDF. Bytes are dropped again the moment the document finishes.
create or replace function public.scratch_append_bytes(
  p_document uuid,
  p_chunk_b64 text
)
returns bigint
language plpgsql
security definer
set search_path to 'scratch', 'public', 'extensions'
as $$
declare
  total bigint;
begin
  update scratch.documents
     set bytes = coalesce(bytes, ''::bytea) || decode(p_chunk_b64, 'base64')
   where document_id = p_document
  returning octet_length(bytes) into total;
  return coalesce(total, 0);
end;
$$;

-- Fan a document out into span-sized jobs on the right queue.
create or replace function public.scratch_enqueue_document(
  p_document uuid,
  p_page_count int,
  p_ocr_pages int[] default '{}',
  p_span int default 50
)
returns int
language plpgsql
security definer
set search_path to 'scratch', 'public', 'extensions'
as $$
declare
  sess uuid;
  i int := 1;
  hi int;
  made int := 0;
  q text;
begin
  select session_id into sess from scratch.documents where document_id = p_document;
  if sess is null then raise exception 'unknown scratch document %', p_document; end if;

  update scratch.documents
     set page_count = p_page_count, status = 'pending'
   where document_id = p_document;

  while i <= p_page_count loop
    hi := least(i + p_span - 1, p_page_count);
    -- a span goes to the OCR queue when any page in it lacks a text layer
    q := case when exists (
           select 1 from unnest(p_ocr_pages) pg where pg between i and hi
         ) then 'ocr' else 'text' end;
    insert into scratch.jobs (session_id, document_id, queue, page_start, page_end)
    values (sess, p_document, q, i, hi);
    made := made + 1;
    i := hi + 1;
  end loop;

  update scratch.sessions set status = 'ingesting', accessed_at = now()
   where session_id = sess;
  return made;
end;
$$;

-- Progress rollup for the browser poll.
create or replace function public.scratch_progress(p_session uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'scratch', 'public', 'extensions'
as $$
  select jsonb_build_object(
    'session', (select to_jsonb(s) - 'instructions' from scratch.sessions s
                 where s.session_id = p_session),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'documentId', d.document_id, 'name', d.name, 'pages', d.page_count,
        'pagesDone', d.pages_done, 'status', d.status, 'error', d.error)
        order by d.created_at)
      from scratch.documents d where d.session_id = p_session), '[]'::jsonb),
    'jobs', coalesce((
      select jsonb_object_agg(k, n) from (
        select state || ':' || queue as k, count(*) as n
          from scratch.jobs where session_id = p_session group by 1) t), '{}'::jsonb),
    'pages', coalesce((
      select jsonb_object_agg(source, n) from (
        select source, count(*) as n from scratch.pages
         where session_id = p_session group by 1) t), '{}'::jsonb),
    'chunks', (select count(*) from scratch.chunks where session_id = p_session)
  );
$$;

revoke all on function public.scratch_hybrid_search(uuid, text, text, int) from anon, authenticated;
revoke all on function public.scratch_append_bytes(uuid, text) from anon, authenticated;
revoke all on function public.scratch_enqueue_document(uuid, int, int[], int) from anon, authenticated;
revoke all on function public.scratch_progress(uuid) from anon, authenticated;
grant execute on function public.scratch_hybrid_search(uuid, text, text, int) to service_role;
grant execute on function public.scratch_append_bytes(uuid, text) to service_role;
grant execute on function public.scratch_enqueue_document(uuid, int, int[], int) to service_role;
grant execute on function public.scratch_progress(uuid) to service_role;

-- pg_cron is not enabled on every corpus project, so retention has two other
-- drivers: the worker pool sweeps every 15 minutes, and the app sweeps whenever
-- a workspace is created. All three call the same idempotent function.
create or replace function public.scratch_sweep()
returns void
language sql
security definer
set search_path to 'scratch', 'public', 'extensions'
as $$ select scratch.sweep(); $$;
revoke all on function public.scratch_sweep() from anon, authenticated;
grant execute on function public.scratch_sweep() to service_role;
