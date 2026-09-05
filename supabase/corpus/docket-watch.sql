-- ============================================================================
-- v2.5  Docket auto-update: watch registry + inbound webhook event queue
--
-- Providers push (CourtListener docket alerts, DocketBird webhooks) into
-- corpus.docket_events. The refresh worker drains that queue, builds ETL v1
-- batches, and drives the existing ingest endpoints. Nothing here changes the
-- ingest contract or the composite identity rules.
-- ============================================================================

begin;

-- ---------------------------------------------------------- watch registry --
create table if not exists corpus.docket_watches (
  watch_id          uuid primary key default gen_random_uuid(),
  matter_id         uuid not null references corpus.matters(matter_id) on delete cascade,
  matter_slug       text not null,
  docket_source     text not null default 'main',      -- main | jpml | state | appellate
  court_id          text not null,
  docket_number     text not null,

  cl_docket_id      bigint,
  cl_alert_id       bigint,
  db_docket_id      text,

  status            text not null default 'pending',
  -- pending | active | unresolved | paused | error
  last_event_at     timestamptz,
  last_sync_at      timestamptz,
  last_error        text,
  failure_count     int not null default 0,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists docket_watches_identity
  on corpus.docket_watches (matter_id, docket_source);
create index if not exists docket_watches_status_idx
  on corpus.docket_watches (status, last_sync_at nulls first);
create index if not exists docket_watches_cl_docket_idx
  on corpus.docket_watches (cl_docket_id) where cl_docket_id is not null;
create index if not exists docket_watches_db_docket_idx
  on corpus.docket_watches (db_docket_id) where db_docket_id is not null;

-- ---------------------------------------------------------- event inbox ----
create table if not exists corpus.docket_events (
  event_id          uuid primary key default gen_random_uuid(),
  provider          text not null,                     -- courtlistener | docketbird | reconcile
  provider_event_id text not null,                     -- dedupe key from the provider
  watch_id          uuid references corpus.docket_watches(watch_id) on delete set null,
  matter_slug       text,
  cl_docket_id      bigint,
  db_docket_id      text,
  payload           jsonb not null,
  status            text not null default 'pending',
  -- pending | claimed | ingested | skipped | failed
  attempts          int not null default 0,
  batch_id          uuid,
  error             text,
  claimed_by        text,
  claimed_at        timestamptz,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz
);

create unique index if not exists docket_events_provider_key
  on corpus.docket_events (provider, provider_event_id);
create index if not exists docket_events_pending_idx
  on corpus.docket_events (status, received_at);

-- --------------------------------------------------- deferred-PDF backlog ---
-- Entries ingested as metadata-only because no free PDF was obtainable yet.
create table if not exists corpus.pdf_pending (
  pending_id        bigserial primary key,
  matter_slug       text not null,
  docket_source     text not null,
  entry_number      int not null,
  attachment_number int not null default 0,
  cl_document_id    bigint,
  db_document_id    text,
  reason            text,
  attempts          int not null default 0,
  last_attempt_at   timestamptz,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now()
);

create unique index if not exists pdf_pending_identity
  on corpus.pdf_pending (matter_slug, docket_source, entry_number, attachment_number);
create index if not exists pdf_pending_open_idx
  on corpus.pdf_pending (resolved_at, attempts) where resolved_at is null;

-- ------------------------------------------------------- job state (lock) --
-- Single-flight lease + circuit breaker for the refresh/reconcile jobs.
create table if not exists corpus.job_state (
  job_name       text primary key,
  status         text not null default 'idle',        -- idle | running | paused
  lease_until    timestamptz,
  lease_owner    text,
  paused_reason  text,
  paused_at      timestamptz,
  last_run_at    timestamptz,
  last_result    jsonb,
  updated_at     timestamptz not null default now()
);

insert into corpus.job_state (job_name) values ('docket_refresh'), ('docket_reconcile'), ('pdf_backfill')
  on conflict (job_name) do nothing;

-- ------------------------------------------------------------- triggers ----
drop trigger if exists v25_watches_updated_at on corpus.docket_watches;
create trigger v25_watches_updated_at before update on corpus.docket_watches
  for each row execute function corpus.set_updated_at();

-- -------------------------------------------------------------- bridges ----
create or replace view public.corpus_docket_watches as
  select watch_id, matter_id, matter_slug, docket_source, court_id, docket_number,
         cl_docket_id, cl_alert_id, db_docket_id, status, last_event_at, last_sync_at,
         last_error, failure_count, notes, created_at, updated_at
  from corpus.docket_watches;

create or replace view public.corpus_docket_events as
  select event_id, provider, provider_event_id, watch_id, matter_slug, cl_docket_id,
         db_docket_id, status, attempts, batch_id, error, claimed_by, claimed_at,
         received_at, processed_at, payload
  from corpus.docket_events;

create or replace view public.corpus_pdf_pending as
  select pending_id, matter_slug, docket_source, entry_number, attachment_number,
         cl_document_id, db_document_id, reason, attempts, last_attempt_at,
         resolved_at, created_at
  from corpus.pdf_pending;

create or replace view public.corpus_job_state as
  select job_name, status, lease_until, lease_owner, paused_reason, paused_at,
         last_run_at, last_result, updated_at
  from corpus.job_state;

revoke all on public.corpus_docket_watches from anon, authenticated;
revoke all on public.corpus_docket_events from anon, authenticated;
revoke all on public.corpus_pdf_pending from anon, authenticated;
revoke all on public.corpus_job_state from anon, authenticated;
grant select, insert, update, delete on public.corpus_docket_watches to service_role;
grant select, insert, update, delete on public.corpus_docket_events to service_role;
grant select, insert, update, delete on public.corpus_pdf_pending to service_role;
grant select, insert, update, delete on public.corpus_job_state to service_role;

commit;
