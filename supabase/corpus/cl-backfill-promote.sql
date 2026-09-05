-- Promote CourtListener staging metadata into canonical registry tables.
-- Scope: matters present in registry.cl_staging_entries.
-- Idempotent: safe to re-run after re-fetching staging data.

\set ON_ERROR_STOP on
begin;

-- 0. Release row for provenance of newly inserted records ---------------------
insert into registry.releases (
  release_id, schema_version, manifest_status, validation_status,
  manifest_sha256, manifest, predecessor_release_id, built_at, loaded_at, promoted_at
)
select 'cl-backfill-v1', 'batch1-release-manifest.v1', 'successor', 'pass',
       encode(sha256('cl-backfill-v1'::bytea), 'hex'),
       jsonb_build_object('source', 'courtlistener-recap-api', 'scope', 'metadata-backfill'),
       'catalog-backfill-v1', now(), now(), now()
where not exists (select 1 from registry.releases where release_id = 'cl-backfill-v1');

-- 0b. Deduplicate staging rows (CourtListener can list an entry more than once)
create temp table cl_e on commit drop as
select distinct on (matter_id, entry_number) *
from registry.cl_staging_entries where entry_number is not null
order by matter_id, entry_number, length(coalesce(description, '')) desc, cl_entry_id;
create temp table cl_d on commit drop as
select distinct on (matter_id, entry_number, coalesce(attachment_number, -1)) *
from registry.cl_staging_documents where entry_number is not null
order by matter_id, entry_number, coalesce(attachment_number, -1),
         length(coalesce(description, '')) desc, cl_doc_id;

-- 1. Update existing docket entries ------------------------------------------
update registry.docket_entries de
set description = nullif(btrim(s.description), ''),
    date_filed  = coalesce(s.date_filed, de.date_filed),
    text_source = 'courtlistener'
from cl_e s
where de.matter_id = s.matter_id
  and de.entry_number = s.entry_number::text
  and nullif(btrim(s.description), '') is not null;

-- 2. Insert docket entries present in CourtListener but missing from registry --
with missing as (
  select s.*, gen_random_uuid() as new_entry_id, gen_random_uuid() as new_record_id
  from cl_e s
  where s.entry_number is not null
    and not exists (
      select 1 from registry.docket_entries de
      where de.matter_id = s.matter_id and de.entry_number = s.entry_number::text
    )
), ins_rec as (
  insert into registry.records (
    record_id, dataset_name, schema_version, record_status, identity_sha256,
    effective_at, observed_at, first_seen_release_id, last_seen_release_id, is_current, loaded_at
  )
  select new_record_id, 'docket_entries', 'batch1-release-manifest.v1', 'active',
         encode(sha256(('cl-entry-' || cl_entry_id)::bytea), 'hex'),
         date_filed, now(), 'cl-backfill-v1', 'cl-backfill-v1', true, now()
  from missing
  returning record_id
)
insert into registry.docket_entries (
  docket_entry_id, record_id, matter_id, entry_number, description, date_filed, text_source
)
select new_entry_id, new_record_id, matter_id, entry_number::text,
       nullif(btrim(description), ''), date_filed, 'courtlistener'
from missing;

-- 3. Update existing documents from CourtListener document metadata -----------
update registry.documents d
set description       = coalesce(nullif(btrim(s.description), ''), d.description),
    pacer_doc_id      = coalesce(s.pacer_doc_id, d.pacer_doc_id),
    courtlistener_url = coalesce(s.courtlistener_url, d.courtlistener_url),
    download_url      = coalesce(s.download_url, d.download_url),
    is_available      = coalesce(s.is_available, d.is_available),
    is_sealed         = coalesce(s.is_sealed, d.is_sealed),
    page_count        = coalesce(d.page_count, s.page_count),
    sha1              = coalesce(d.sha1, nullif(s.sha1, '')),
    text_source       = 'courtlistener'
from cl_d s
where d.matter_id = s.matter_id
  and d.entry_number = s.entry_number
  and coalesce(d.attachment_number, -1) = coalesce(s.attachment_number, -1);

-- 4. Insert documents known to CourtListener but absent from the registry -----
with missing as (
  select s.*, gen_random_uuid() as new_document_id, gen_random_uuid() as new_record_id,
         de.docket_entry_id
  from cl_d s
  left join registry.docket_entries de
    on de.matter_id = s.matter_id and de.entry_number = s.entry_number::text
  where s.entry_number is not null
    and not exists (
      select 1 from registry.documents d
      where d.matter_id = s.matter_id
        and d.entry_number = s.entry_number
        and coalesce(d.attachment_number, -1) = coalesce(s.attachment_number, -1)
    )
), ins_rec as (
  insert into registry.records (
    record_id, dataset_name, schema_version, record_status, identity_sha256,
    observed_at, first_seen_release_id, last_seen_release_id, is_current, loaded_at
  )
  select new_record_id, 'documents', 'batch1-release-manifest.v1', 'active',
         encode(sha256(('cl-doc-' || cl_doc_id)::bytea), 'hex'),
         now(), 'cl-backfill-v1', 'cl-backfill-v1', true, now()
  from missing
  returning record_id
)
insert into registry.documents (
  document_id, record_id, matter_id, docket_entry_id, doc_uid, description,
  verification_status, doc_source, sha1, page_count, byte_count,
  entry_number, document_number, attachment_number,
  is_available, is_sealed, pacer_doc_id, courtlistener_url, download_url, text_source
)
select new_document_id, new_record_id, matter_id, docket_entry_id,
       'cl-' || cl_doc_id, nullif(btrim(description), ''),
       'unverified', 'courtlistener', nullif(sha1, ''), page_count,
       case when file_size >= 0 then file_size end,
       entry_number, document_number, attachment_number,
       is_available, is_sealed, pacer_doc_id, courtlistener_url, download_url, 'courtlistener'
from missing;

-- 5. Roll entry-level rollups forward ----------------------------------------
update registry.docket_entries de
set document_count = agg.n,
    has_pdf = agg.n > 0,
    page_count = coalesce(agg.pages, de.page_count)
from (
  select docket_entry_id, count(*) n, nullif(sum(coalesce(page_count, 0)), 0) pages
  from registry.documents
  where docket_entry_id is not null
    and matter_id in (select distinct matter_id from registry.cl_staging_entries)
  group by 1
) agg
where de.docket_entry_id = agg.docket_entry_id;

commit;

-- 6. Verification -------------------------------------------------------------
select m.case_name,
       count(distinct de.docket_entry_id) entries,
       count(distinct de.docket_entry_id) filter (where de.description is not null) entries_with_text,
       count(distinct d.document_id) docs,
       count(distinct d.document_id) filter (where d.description is not null) docs_with_text
from registry.matters m
left join registry.docket_entries de on de.matter_id = m.matter_id
left join registry.documents d on d.matter_id = m.matter_id
where m.matter_id in (select distinct matter_id from registry.cl_staging_entries)
group by 1 order by 1;
