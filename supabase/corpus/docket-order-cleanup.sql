-- Docket ordering / labeling cleanup (v2.3)
-- Adds explicit docket_source, a real display_number, a human display_label_pretty,
-- and a stable sort_seq so synthetic collision-avoidance entry numbers
-- (800k / 900k / 1.6M ranges) no longer dominate ordering or leak into the UI.
-- Additive only: no rows are deleted and no chunks are touched.

alter table corpus.docket_entries
  add column if not exists docket_source text,
  add column if not exists display_number integer,
  add column if not exists display_label_pretty text,
  add column if not exists sort_seq numeric(18,6);

alter table corpus.documents
  add column if not exists docket_source text,
  add column if not exists display_number integer,
  add column if not exists display_label_pretty text,
  add column if not exists sort_seq numeric(18,6);

-- ---------------------------------------------------------------- entries --
update corpus.docket_entries e
set docket_source = case
      when e.entry_label ilike 'JPML%' or e.entry_number >= 900000 then 'jpml'
      else 'main'
    end,
    display_number = case
      when e.entry_label ~ '^JPML-[0-9]+$'
           and (regexp_replace(e.entry_label, '^JPML-', ''))::bigint < 700000
        then (regexp_replace(e.entry_label, '^JPML-', ''))::integer
      when e.entry_label ~ '^JPML-[0-9]+$' then null
      when e.entry_number >= 800000 then null
      else e.entry_number
    end;

-- sort_seq: numbered entries sort by their real number; unnumbered entries slot
-- in by filed date just after the last numbered entry filed on/before that date.
with anchored as (
  select e.docket_entry_id,
         e.matter_id,
         e.docket_source,
         e.display_number,
         coalesce((
           select max(n.display_number)
           from corpus.docket_entries n
           where n.matter_id = e.matter_id
             and n.docket_source = e.docket_source
             and n.display_number is not null
             and n.date_filed is not null
             and e.date_filed is not null
             and n.date_filed <= e.date_filed
         ), 0) as anchor,
         row_number() over (
           partition by e.matter_id, e.docket_source, e.date_filed
           order by e.entry_number
         ) as tiebreak
  from corpus.docket_entries e
)
update corpus.docket_entries e
set sort_seq = case
      when a.display_number is not null then a.display_number::numeric
      else a.anchor::numeric + (a.tiebreak::numeric / 10000)
    end
from anchored a
where a.docket_entry_id = e.docket_entry_id;

update corpus.docket_entries e
set display_label_pretty = case
      when e.display_number is not null and e.docket_source = 'jpml'
        then 'JPML ' || e.display_number
      when e.display_number is not null then e.display_number::text
      when e.docket_source = 'jpml'
        then 'JPML — unnumbered' || coalesce(' (' || to_char(e.date_filed, 'YYYY-MM-DD') || ')', '')
      else 'Unnumbered' || coalesce(' (' || to_char(e.date_filed, 'YYYY-MM-DD') || ')', '')
    end;

-- -------------------------------------------------------------- documents --
update corpus.documents d
set docket_source = e.docket_source,
    display_number = e.display_number,
    sort_seq = e.sort_seq,
    display_label_pretty = case
      when d.attachment_number > 0
        then e.display_label_pretty || '-' || d.attachment_number
      else e.display_label_pretty
    end
from corpus.docket_entries e
where e.docket_entry_id = d.docket_entry_id;

-- documents with no linked entry (defensive)
update corpus.documents d
set docket_source = case
      when d.entry_label ilike 'JPML%' or d.entry_number >= 900000 then 'jpml'
      else 'main' end,
    sort_seq = coalesce(d.sort_seq, d.entry_number::numeric),
    display_label_pretty = coalesce(d.display_label_pretty, nullif(d.entry_label, ''), d.entry_number::text)
where d.docket_source is null;

-- Attachments inherit the parent entry description as their title, which makes
-- multi-attachment entries render as identical rows. Prefix them so each row is
-- self-describing.
update corpus.documents d
set title = 'Attachment ' || d.attachment_number || ' to ' || d.display_label_pretty
            || ' — ' || left(d.title, 240)
where d.attachment_number > 0
  and d.display_label_pretty is not null
  and d.title <> ''
  and d.title not like 'Attachment %';

-- ---------------------------------------------------------------- indexes --
create index if not exists v2_entries_sort_idx
  on corpus.docket_entries (matter_id, docket_source, sort_seq desc);
create index if not exists v2_documents_sort_idx
  on corpus.documents (matter_id, docket_source, sort_seq desc, attachment_number);

-- ------------------------------------------------------------------ views --
-- The public.corpus_* bridge views (including the display/sort columns added
-- above) are defined in supabase/corpus/bridge-views.sql — the single
-- authoritative source. Apply that file after this one.

