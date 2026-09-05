-- corpus.refresh_display_order(matter uuid)
-- Recomputes docket_source / display_number / display_label_pretty / sort_seq
-- for one matter. Idempotent; safe to call at the end of every ingest run.
-- Companion to docket-order-cleanup.sql (the one-time v2.3 backfill).

create or replace function corpus.refresh_display_order(p_matter uuid)
returns void
language plpgsql
as $$
begin
  update corpus.docket_entries e
  set docket_source = case
        when e.entry_label ilike 'JPML%' or e.entry_number >= 900000 then 'jpml'
        else 'main'
      end,
      -- Any entry_number at or above 100000 is a synthetic placeholder minted
      -- by an upstream pipeline for an unnumbered minute/text entry. It never
      -- becomes a display number and never drives ordering — such entries are
      -- slotted by filed date below.
      display_number = case
        when e.entry_label ~ '^JPML-[0-9]+$'
             and (regexp_replace(e.entry_label, '^JPML-', ''))::bigint < 100000
          then (regexp_replace(e.entry_label, '^JPML-', ''))::integer
        when e.entry_label ~ '^JPML-[0-9]+$' then null
        when e.entry_number >= 100000 then null
        else e.entry_number
      end
  where e.matter_id = p_matter;

  with anchored as (
    select e.docket_entry_id,
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
             partition by e.docket_source, e.date_filed order by e.entry_number
           ) as tiebreak
    from corpus.docket_entries e
    where e.matter_id = p_matter
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
        -- Unnumbered entries keep the human label the sender supplied
        -- ("TXT 3", "JPML TXT 1"); never the synthetic number.
        when nullif(e.entry_label, '') is not null and e.entry_label !~ '^[0-9]+$'
          then e.entry_label
        when e.docket_source = 'jpml'
          then 'JPML — unnumbered' || coalesce(' (' || to_char(e.date_filed, 'YYYY-MM-DD') || ')', '')
        else 'Unnumbered' || coalesce(' (' || to_char(e.date_filed, 'YYYY-MM-DD') || ')', '')
      end
  where e.matter_id = p_matter;

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
  where e.docket_entry_id = d.docket_entry_id
    and d.matter_id = p_matter;

  update corpus.documents d
  set docket_source = case
        when d.entry_label ilike 'JPML%' or d.entry_number >= 900000 then 'jpml' else 'main' end,
      sort_seq = coalesce(d.sort_seq, d.entry_number::numeric),
      display_label_pretty = coalesce(d.display_label_pretty, nullif(d.entry_label, ''), d.entry_number::text)
  where d.matter_id = p_matter and d.docket_source is null;

  -- Attachments inherit the parent description; prefix so each row is
  -- self-describing. Title references the PARENT label (no "-N" suffix).
  update corpus.documents d
  set title = 'Attachment ' || d.attachment_number || ' to '
              || regexp_replace(d.display_label_pretty, '-[0-9]+$', '')
              || ' — ' || left(d.title, 240)
  where d.matter_id = p_matter
    and d.attachment_number > 0
    and d.display_label_pretty is not null
    and d.title <> ''
    and d.title not like 'Attachment %';
end;
$$;
