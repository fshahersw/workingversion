-- Promote locally backfilled PDFs (registry.local_staging_documents) into the
-- canonical registry tables. Idempotent; only fills gaps, never destroys data.

\set ON_ERROR_STOP on
begin;

-- 0. Provenance release ------------------------------------------------------
insert into registry.releases (
  release_id, schema_version, manifest_status, validation_status,
  manifest_sha256, manifest, predecessor_release_id, built_at, loaded_at, promoted_at
)
select 'local-backfill-v1', 'batch1-release-manifest.v1', 'successor', 'pass',
       encode(sha256('local-backfill-v1'::bytea), 'hex'),
       jsonb_build_object('source', 'local-pdf-library', 'scope', 'pdf+metadata-backfill'),
       'cl-backfill-v1', now(), now(), now()
where not exists (select 1 from registry.releases where release_id = 'local-backfill-v1');

-- 1. Docket entries the local set knows about but the registry does not -------
with missing as (
  select distinct on (s.matter_id, s.entry_number)
         s.matter_id, s.entry_number, s.date_filed,
         gen_random_uuid() as new_entry_id, gen_random_uuid() as new_record_id
  from registry.local_staging_documents s
  where not exists (
    select 1 from registry.docket_entries de
    where de.matter_id = s.matter_id and de.entry_number = s.entry_number::text
  )
  order by s.matter_id, s.entry_number, s.date_filed
), ins_rec as (
  insert into registry.records (
    record_id, dataset_name, schema_version, record_status, identity_sha256,
    effective_at, observed_at, first_seen_release_id, last_seen_release_id, is_current, loaded_at
  )
  select new_record_id, 'docket_entries', 'batch1-release-manifest.v1', 'active',
         encode(sha256(('local-entry-' || matter_id || '-' || entry_number)::bytea), 'hex'),
         date_filed, now(), 'local-backfill-v1', 'local-backfill-v1', true, now()
  from missing
  returning record_id
)
insert into registry.docket_entries (
  docket_entry_id, record_id, matter_id, entry_number, date_filed, text_source
)
select new_entry_id, new_record_id, matter_id, entry_number::text, date_filed, 'local-pdf'
from missing;

-- 2. Fill gaps on existing documents -----------------------------------------
update registry.documents d
set s3_bucket   = coalesce(d.s3_bucket, s.s3_bucket),
    s3_key      = coalesce(nullif(d.s3_key, ''), s.s3_key),
    sha256      = coalesce(d.sha256, s.sha256),
    byte_count  = coalesce(d.byte_count, s.byte_count),
    page_count  = coalesce(d.page_count, s.page_count),
    description = coalesce(nullif(btrim(d.description), ''), nullif(btrim(s.description), '')),
    is_available = true,
    text_source = case
      when nullif(btrim(d.description), '') is null and nullif(btrim(s.description), '') is not null
        then 'local-pdf' else d.text_source end
from registry.local_staging_documents s
where d.matter_id = s.matter_id
  and d.entry_number = s.entry_number
  and coalesce(d.attachment_number, -1) = coalesce(s.attachment_number, -1);

-- 3. Insert documents that exist only in the local library --------------------
with missing as (
  select s.*, de.docket_entry_id,
         gen_random_uuid() as new_document_id, gen_random_uuid() as new_record_id
  from registry.local_staging_documents s
  left join registry.docket_entries de
    on de.matter_id = s.matter_id and de.entry_number = s.entry_number::text
  where not exists (
    select 1 from registry.documents d
    where d.matter_id = s.matter_id
      and d.entry_number = s.entry_number
      and coalesce(d.attachment_number, -1) = coalesce(s.attachment_number, -1)
  )
), ins_rec as (
  insert into registry.records (
    record_id, dataset_name, schema_version, record_status, identity_sha256,
    effective_at, observed_at, first_seen_release_id, last_seen_release_id, is_current, loaded_at
  )
  select new_record_id, 'documents', 'batch1-release-manifest.v1', 'active',
         encode(sha256(('local-doc-' || coalesce(sha256, s3_key))::bytea), 'hex'),
         date_filed, now(), 'local-backfill-v1', 'local-backfill-v1', true, now()
  from missing
  returning record_id
)
insert into registry.documents (
  document_id, record_id, matter_id, docket_entry_id, doc_uid, description,
  verification_status, doc_source, sha256, byte_count, page_count,
  entry_number, attachment_number, entry_date_filed,
  s3_bucket, s3_key, is_available, is_sealed, text_source
)
select new_document_id, new_record_id, matter_id, docket_entry_id,
       'local-' || matter_id || '-' || entry_number || '-' || coalesce(attachment_number, 0),
       nullif(btrim(description), ''), 'verified', 'local-pdf',
       sha256, byte_count, page_count,
       entry_number, attachment_number, date_filed,
       s3_bucket, s3_key, true, false, 'local-pdf'
from missing;

-- 4. Refresh entry-level rollups ---------------------------------------------
update registry.docket_entries de
set document_count = agg.n,
    has_pdf = agg.with_pdf > 0,
    page_count = coalesce(agg.pages, de.page_count)
from (
  select docket_entry_id, count(*) n,
         count(*) filter (where s3_key is not null) with_pdf,
         nullif(sum(coalesce(page_count, 0)), 0) pages
  from registry.documents
  where docket_entry_id is not null
    and matter_id in (select distinct matter_id from registry.local_staging_documents)
  group by 1
) agg
where de.docket_entry_id = agg.docket_entry_id;

commit;

-- 5. Verification -------------------------------------------------------------
select m.case_name,
       count(*) docs,
       count(*) filter (where d.s3_key is not null) with_pdf,
       count(*) filter (where d.sha256 is not null) with_sha256,
       count(*) filter (where d.page_count is not null) with_pages,
       count(*) filter (where d.description is not null) with_desc
from registry.documents d
join registry.matters m using (matter_id)
where d.matter_id in (select distinct matter_id from registry.local_staging_documents)
group by 1 order by 1;
