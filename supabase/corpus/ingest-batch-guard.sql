-- ============================================================================
-- Guard: a batch may only go running -> queued through a known code path.
--
-- run_batch.py's release_claim()/requeue_stale() and the commit endpoint all
-- set stage explicitly. A reset with stage NULL therefore comes from outside
-- the pipeline (a direct DB write or a foreign runner) and strands partially
-- promoted files. We do not block it — we stamp it so the Pipeline page can
-- show that the batch was interrupted mid-run instead of looking freshly
-- queued.
-- ============================================================================

create or replace function corpus.guard_batch_requeue()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'running' and new.status = 'queued' and new.stage is null then
    new.stage := 'queued';
    new.error := coalesce(
      new.error,
      'reset to queued from outside the runner while stage=' ||
      coalesce(old.stage, 'unknown') || '; re-run is safe (idempotent)'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists v2_batches_requeue_guard on corpus.ingest_batches;
create trigger v2_batches_requeue_guard before update on corpus.ingest_batches
  for each row execute function corpus.guard_batch_requeue();
