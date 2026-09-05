-- ============================================================================
-- v2.4  Docket-source normalization
--
-- Retires the 900000 offset that namespaced JPML panel-docket entries inside
-- corpus.docket_entries.entry_number. After this migration:
--
--   * (docket_source, entry_number) is the slot namespace — 'main' | 'jpml' |
--     any future source. JPML entry 12 is stored as entry_number = 12 with
--     docket_source = 'jpml', not 900012.
--   * Entries that genuinely have no docket number (the 800000/1600000 ranges)
--     keep their synthetic number; display_number stays NULL and the UI keeps
--     rendering them as "Unnumbered (date)".
--   * source_docket_number records which physical docket a row came from.
--   * Uniqueness moves from (matter_id, entry_number) to
--     (matter_id, docket_source, entry_number) — required, because after
--     renumbering JPML 1 and main 1 coexist.
--
-- Safety: fully transactional, backs every touched table up first, and aborts
-- on any duplicate. s3_key values are NOT rewritten; existing storage keys
-- stay valid.
-- ============================================================================

begin;

-- ------------------------------------------------------------- 0. backups --
create table if not exists corpus.bak_v24_docket_entries as
  select docket_entry_id, matter_id, entry_number, entry_label, docket_source,
         display_number, display_label_pretty, sort_seq, now() as backed_up_at
  from corpus.docket_entries;

create table if not exists corpus.bak_v24_documents as
  select document_id, matter_id, docket_entry_id, entry_number, attachment_number,
         entry_label, docket_source, display_number, display_label_pretty,
         sort_seq, s3_bucket, s3_key, now() as backed_up_at
  from corpus.documents;

create table if not exists corpus.bak_v24_doc_chunks as
  select chunk_id, document_id, docket_entry_id, entry_number, now() as backed_up_at
  from corpus.doc_chunks;

-- --------------------------------------------------------- 1. new columns --
alter table corpus.docket_entries
  add column if not exists source_docket_number text;
alter table corpus.documents
  add column if not exists source_docket_number text;

-- docket_source must be complete before it becomes part of the key.
update corpus.docket_entries set docket_source = 'main' where docket_source is null;
update corpus.documents d
   set docket_source = e.docket_source
  from corpus.docket_entries e
 where e.docket_entry_id = d.docket_entry_id and d.docket_source is null;
update corpus.documents set docket_source = 'main' where docket_source is null;

-- ------------------------------------------------------- 2. abort on dups --
do $$
declare n bigint;
begin
  select count(*) into n from (
    select matter_id, docket_source,
           case when docket_source = 'jpml' and display_number is not null
                then display_number else entry_number end as nn
    from corpus.docket_entries
    group by 1, 2, 3 having count(*) > 1
  ) x;
  if n > 0 then raise exception 'v2.4 abort: % duplicate entry slots after renumber', n; end if;

  select count(*) into n from (
    select d.matter_id, d.docket_source,
           coalesce(case when e.docket_source = 'jpml' and e.display_number is not null
                         then e.display_number else e.entry_number end,
                    d.entry_number) as nn,
           d.attachment_number
    from corpus.documents d
    left join corpus.docket_entries e on e.docket_entry_id = d.docket_entry_id
    group by 1, 2, 3, 4 having count(*) > 1
  ) x;
  if n > 0 then raise exception 'v2.4 abort: % duplicate document slots after renumber', n; end if;
end $$;

-- ------------------------------------------------------ 3. drop old unique --
alter table corpus.docket_entries
  drop constraint if exists docket_entries_matter_id_entry_number_key;
alter table corpus.documents
  drop constraint if exists documents_matter_id_entry_number_attachment_number_key;

-- --------------------------------------------------------- 4. renumbering --
-- Only rows that carry a real docket number are renumbered; synthetic
-- placeholders (display_number is null) keep their number so nothing collides.
with renum as (
  select docket_entry_id, display_number as nn
  from corpus.docket_entries
  where docket_source = 'jpml' and display_number is not null
        and entry_number <> display_number
)
update corpus.docket_entries e
   set entry_number = r.nn
  from renum r
 where r.docket_entry_id = e.docket_entry_id;

update corpus.documents d
   set entry_number = e.entry_number
  from corpus.docket_entries e
 where e.docket_entry_id = d.docket_entry_id
   and d.entry_number is distinct from e.entry_number;

update corpus.doc_chunks c
   set entry_number = e.entry_number
  from corpus.docket_entries e
 where e.docket_entry_id = c.docket_entry_id
   and c.entry_number is distinct from e.entry_number;

-- ------------------------------------------------- 5. source docket labels --
update corpus.docket_entries e
   set source_docket_number = case
         when e.docket_source = 'jpml'
           then coalesce('MDL ' || nullif(m.mdl_number, ''), 'JPML')
         else m.docket_number
       end
  from corpus.matters m
 where m.matter_id = e.matter_id
   and e.source_docket_number is null;

update corpus.documents d
   set source_docket_number = e.source_docket_number
  from corpus.docket_entries e
 where e.docket_entry_id = d.docket_entry_id
   and d.source_docket_number is null;

-- ------------------------------------------------------ 6. new uniqueness --
alter table corpus.docket_entries
  add constraint docket_entries_slot_key
  unique (matter_id, docket_source, entry_number);

create unique index if not exists documents_slot_key
  on corpus.documents (matter_id, docket_source, entry_number, attachment_number);

create index if not exists v2_entries_source_num_idx
  on corpus.docket_entries (matter_id, docket_source, entry_number desc);

commit;

-- ------------------------------------------- 7. recompute display ordering --
-- refresh_display_order keys JPML off entry_label ('JPML-<n>'), so it stays
-- correct after renumbering.
select corpus.refresh_display_order(matter_id) from corpus.matters;
