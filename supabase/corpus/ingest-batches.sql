-- ============================================================================
-- v2.4  Ingest batch bookkeeping (contract v1)
--
-- One row per submitted bundle. The HTTP endpoint creates the batch, records
-- validation results, and flips it to 'queued'; the pipeline runner
-- (scripts/pipeline/run_batch.py) executes the stages and reports back.
-- ============================================================================

create table if not exists corpus.ingest_batches (
  batch_id          uuid primary key default gen_random_uuid(),
  matter_slug       text not null,
  matter_id         uuid references corpus.matters(matter_id) on delete set null,
  contract_version  text not null,
  mode              text not null default 'incremental',   -- full | incremental
  idempotency_key   text,
  status            text not null default 'open',
  -- open | uploading | validated | queued | running | completed | failed
  stage             text,
  manifest          jsonb not null,
  counts            jsonb not null default '{}'::jsonb,
  error             text,
  submitted_by      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz
);

create unique index if not exists ingest_batches_idem_key
  on corpus.ingest_batches (matter_slug, idempotency_key)
  where idempotency_key is not null;
create index if not exists ingest_batches_status_idx
  on corpus.ingest_batches (status, created_at);

create table if not exists corpus.ingest_rejects (
  reject_id   bigserial primary key,
  batch_id    uuid not null references corpus.ingest_batches(batch_id) on delete cascade,
  record_id   text,
  slot        text,
  code        text not null,
  message     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists ingest_rejects_batch_idx on corpus.ingest_rejects (batch_id);

drop trigger if exists v2_batches_updated_at on corpus.ingest_batches;
create trigger v2_batches_updated_at before update on corpus.ingest_batches
  for each row execute function corpus.set_updated_at();

-- ------------------------------------------------------------- bridges ----
create or replace view public.corpus_ingest_batches as
select batch_id, matter_slug, matter_id, contract_version, mode,
       idempotency_key, status, stage, counts, error, submitted_by,
       created_at, updated_at, completed_at, manifest
from corpus.ingest_batches;

create or replace view public.corpus_ingest_rejects as
select reject_id, batch_id, record_id, slot, code, message, created_at
from corpus.ingest_rejects;

revoke all on public.corpus_ingest_batches from anon, authenticated;
revoke all on public.corpus_ingest_rejects from anon, authenticated;
grant select on public.corpus_ingest_batches to service_role;
grant select on public.corpus_ingest_rejects to service_role;
