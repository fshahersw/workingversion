-- ============================================================================
-- ETL self-test RPCs + observability bridge views.
--
-- The self-test runs the real contract-v1 path end to end, so it needs write
-- access to the corpus. Every write function here is HARD GUARDED to matter
-- slugs beginning with 'selftest-': it is structurally impossible for the
-- admin Pipeline page to touch insulin/apple/roundup data, whatever the
-- caller sends.
--
-- Execute is granted to service_role only (server functions), never anon or
-- authenticated.
-- ============================================================================

create or replace function corpus.assert_selftest_slug(p_slug text)
returns void language plpgsql as $$
begin
  if p_slug is null or p_slug !~ '^selftest-[a-z0-9-]+$' then
    raise exception 'refusing to operate on non-selftest slug %', p_slug;
  end if;
end $$;

-- --------------------------------------------------------------- write ----
-- One transactional call: matter, dockets, entries, documents, parties,
-- counsel, chunks, ordering, counts. Payload mirrors the runner's stages;
-- the caller (server) has already verified hashes and extracted text.
create or replace function corpus.etl_selftest_write(p jsonb)
returns jsonb language plpgsql security definer set search_path = corpus, public, extensions as $$
declare
  v_slug text := p->'matter'->>'slug';
  v_matter uuid;
  r jsonb;
  c jsonb;
  v_entry uuid;
  v_doc uuid;
  v_entries int := 0;
  v_docs int := 0;
  v_parties int := 0;
  v_counsel int := 0;
  v_chunks int := 0;
begin
  perform corpus.assert_selftest_slug(v_slug);

  insert into corpus.matters
    (slug, case_name, short_name, caption, docket_number, court_id, court_name,
     mdl_number, judge, date_filed, courtlistener_docket_id, stage, source, pipeline_stage)
  values
    (v_slug, p->'matter'->>'caption', p->'matter'->>'short_name', p->'matter'->>'caption',
     p->'matter'->>'docket_number', p->'matter'->>'court', p->'matter'->>'court',
     p->'matter'->>'mdl_number', p->'matter'->>'judge',
     nullif(p->'matter'->>'date_filed','')::date,
     nullif(p->'matter'->>'courtlistener_docket_id','')::bigint,
     p->'matter'->>'stage', 'etl-selftest', 'ledger')
  on conflict (slug) do update set
    case_name = excluded.case_name, caption = excluded.caption,
    docket_number = excluded.docket_number, updated_at = now()
  returning matter_id into v_matter;

  -- docket entries (main documents only carry the entry record)
  for r in select * from jsonb_array_elements(p->'entries') loop
    insert into corpus.docket_entries
      (matter_id, docket_source, entry_number, entry_label, date_filed,
       description, entry_type, source, source_docket_number)
    values
      (v_matter, r->>'docket_source', (r->>'entry_number')::int, r->>'entry_label',
       (r->>'filed_date')::date, coalesce(r->>'description',''), r->>'doc_type',
       'etl-selftest', r->>'source_docket_number')
    on conflict (matter_id, docket_source, entry_number) do update set
      entry_label = excluded.entry_label, date_filed = excluded.date_filed,
      description = excluded.description, updated_at = now();
    v_entries := v_entries + 1;
  end loop;

  -- documents
  for r in select * from jsonb_array_elements(p->'documents') loop
    select docket_entry_id into v_entry from corpus.docket_entries
      where matter_id = v_matter and docket_source = r->>'docket_source'
        and entry_number = (r->>'entry_number')::int;
    if v_entry is null then
      raise exception 'orphan attachment: no entry %:%', r->>'docket_source', r->>'entry_number';
    end if;

    insert into corpus.documents
      (matter_id, docket_entry_id, docket_source, entry_number, attachment_number,
       entry_label, title, doc_type, is_sealed, record_id, availability_status,
       expected_sha256, sha256, byte_count, page_count, s3_bucket, s3_key,
       hash_verified, text_status, source, source_docket_number)
    values
      (v_matter, v_entry, r->>'docket_source', (r->>'entry_number')::int,
       (r->>'attachment_number')::int, r->>'entry_label', r->>'title', r->>'doc_type',
       coalesce((r->>'is_sealed')::boolean, false), r->>'record_id', r->>'availability_status',
       r->>'expected_sha256', r->>'sha256', nullif(r->>'byte_count','')::bigint,
       nullif(r->>'page_count','')::int, r->>'s3_bucket', r->>'s3_key',
       coalesce((r->>'hash_verified')::boolean, false), r->>'text_status',
       'etl-selftest', r->>'source_docket_number')
    on conflict (matter_id, docket_source, entry_number, attachment_number) do update set
      docket_entry_id = excluded.docket_entry_id, title = excluded.title,
      sha256 = excluded.sha256, s3_key = excluded.s3_key,
      hash_verified = excluded.hash_verified, text_status = excluded.text_status,
      updated_at = now()
    returning document_id into v_doc;
    v_docs := v_docs + 1;

    delete from corpus.doc_chunks where document_id = v_doc;
    for c in select * from jsonb_array_elements(coalesce(r->'chunks','[]'::jsonb)) loop
      insert into corpus.doc_chunks
        (matter_id, document_id, docket_entry_id, entry_number, attachment_number,
         chunk_index, page_start, page_end, doc_type, is_sealed, content, token_count)
      values
        (v_matter, v_doc, v_entry, (r->>'entry_number')::int, (r->>'attachment_number')::int,
         (c->>'chunk_index')::int, (c->>'page_start')::int, (c->>'page_end')::int,
         r->>'doc_type', coalesce((r->>'is_sealed')::boolean,false),
         c->>'content', (c->>'token_count')::int);
      v_chunks := v_chunks + 1;
    end loop;
  end loop;

  -- parties + counsel
  for r in select * from jsonb_array_elements(coalesce(p->'parties','[]'::jsonb)) loop
    insert into corpus.parties (matter_id, name, party_type)
    values (v_matter, r->>'party_name', nullif(r->>'party_role',''))
    on conflict (matter_id, name, party_type) do nothing;
    v_parties := v_parties + 1;
    if coalesce(r->>'attorney_name','') <> '' then
      insert into corpus.counsel
        (matter_id, party_name, attorney, firm, role, is_lead, phone, fax, address, designations)
      values
        (v_matter, r->>'party_name', r->>'attorney_name', coalesce(r->>'firm_name',''),
         nullif(r->>'party_role',''),
         upper(coalesce(r->>'attorney_designations','')) like '%LEAD%',
         nullif(r->>'attorney_phone',''), nullif(r->>'attorney_fax',''),
         nullif(r->>'firm_address',''), nullif(r->>'attorney_designations',''))
      on conflict (matter_id, attorney, firm, party_name) do nothing;
      v_counsel := v_counsel + 1;
    end if;
  end loop;

  -- finalize: ordering + rollup counts
  perform corpus.refresh_display_order(v_matter);
  update corpus.docket_entries e
     set document_count = c.n, has_pdf = c.pdfs > 0, page_count = c.pages
    from (select docket_entry_id, count(*) n, count(s3_key) pdfs, sum(page_count) pages
            from corpus.documents where matter_id = v_matter group by docket_entry_id) c
   where e.docket_entry_id = c.docket_entry_id;
  update corpus.matters
     set pipeline_stage = 'embedded', last_synced_at = now(), verified_at = now()
   where matter_id = v_matter;

  return jsonb_build_object(
    'matter_id', v_matter, 'entries', v_entries, 'documents', v_docs,
    'parties', v_parties, 'counsel', v_counsel, 'chunks', v_chunks);
end $$;

-- --------------------------------------------------------------- embed ----
create or replace function corpus.etl_selftest_embed(p_slug text, p_vectors jsonb)
returns int language plpgsql security definer set search_path = corpus, public, extensions as $$
declare
  v_matter uuid;
  r jsonb;
  n int := 0;
begin
  perform corpus.assert_selftest_slug(p_slug);
  select matter_id into v_matter from corpus.matters where slug = p_slug;
  for r in select * from jsonb_array_elements(p_vectors) loop
    update corpus.doc_chunks
       set embedding = (r->>'embedding')::extensions.vector
     where chunk_id = (r->>'chunk_id')::uuid and matter_id = v_matter;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function corpus.etl_selftest_chunks(p_slug text)
returns jsonb language sql security definer set search_path = corpus, public as $$
  select coalesce(jsonb_agg(jsonb_build_object('chunk_id', c.chunk_id, 'content', c.content)
                            order by c.chunk_id), '[]'::jsonb)
    from corpus.doc_chunks c
    join corpus.matters m on m.matter_id = c.matter_id
   where m.slug = p_slug and c.embedding is null;
$$;

-- ---------------------------------------------------------------- stats ---
create or replace function corpus.etl_selftest_stats(p_slug text)
returns jsonb language sql security definer set search_path = corpus, public as $$
  with m as (select matter_id from corpus.matters where slug = p_slug)
  select jsonb_build_object(
    'matter_exists', (select count(*) from m) = 1,
    'entries', (select count(*) from corpus.docket_entries where matter_id = (select matter_id from m)),
    'entries_by_source', (select coalesce(jsonb_object_agg(docket_source, n), '{}'::jsonb)
                            from (select docket_source, count(*) n from corpus.docket_entries
                                   where matter_id = (select matter_id from m)
                                   group by docket_source) s),
    'max_entry_number', (select coalesce(max(entry_number),0) from corpus.docket_entries
                          where matter_id = (select matter_id from m)),
    'documents', (select count(*) from corpus.documents where matter_id = (select matter_id from m)),
    'documents_with_pdf', (select count(*) from corpus.documents
                            where matter_id = (select matter_id from m) and s3_key is not null),
    'hash_verified', (select count(*) from corpus.documents
                       where matter_id = (select matter_id from m) and hash_verified),
    'text_status', (select coalesce(jsonb_object_agg(text_status, n), '{}'::jsonb)
                      from (select text_status, count(*) n from corpus.documents
                             where matter_id = (select matter_id from m) group by text_status) t),
    'availability', (select coalesce(jsonb_object_agg(availability_status, n), '{}'::jsonb)
                       from (select availability_status, count(*) n from corpus.documents
                              where matter_id = (select matter_id from m) group by availability_status) a),
    'chunks', (select count(*) from corpus.doc_chunks where matter_id = (select matter_id from m)),
    'unembedded_chunks', (select count(*) from corpus.doc_chunks
                           where matter_id = (select matter_id from m) and embedding is null),
    'parties', (select count(*) from corpus.parties where matter_id = (select matter_id from m)),
    'counsel', (select count(*) from corpus.counsel where matter_id = (select matter_id from m)),
    'unordered_entries', (select count(*) from corpus.docket_entries
                           where matter_id = (select matter_id from m) and sort_seq is null),
    'duplicate_slots', (select count(*) from (
        select 1 from corpus.documents where matter_id = (select matter_id from m)
        group by docket_source, entry_number, attachment_number having count(*) > 1) d)
  );
$$;

-- ---------------------------------------------------------------- purge ---
create or replace function corpus.etl_selftest_purge(p_slug text)
returns jsonb language plpgsql security definer set search_path = corpus, public as $$
declare
  v_matter uuid;
  v jsonb;
begin
  perform corpus.assert_selftest_slug(p_slug);
  select matter_id into v_matter from corpus.matters where slug = p_slug;
  if v_matter is null then
    return jsonb_build_object('deleted_matter', false, 'batches', 0);
  end if;
  delete from corpus.doc_chunks where matter_id = v_matter;
  delete from corpus.documents where matter_id = v_matter;
  delete from corpus.docket_entries where matter_id = v_matter;
  delete from corpus.parties where matter_id = v_matter;
  delete from corpus.counsel where matter_id = v_matter;
  delete from corpus.matters where matter_id = v_matter;
  delete from corpus.ingest_batches where matter_slug = p_slug;
  select jsonb_build_object(
    'deleted_matter', true,
    'residual_documents', (select count(*) from corpus.documents where matter_id = v_matter),
    'residual_chunks', (select count(*) from corpus.doc_chunks where matter_id = v_matter))
    into v;
  return v;
end $$;

-- ------------------------------------------------- public RPC wrappers ----
create or replace function public.etl_selftest_write(p jsonb) returns jsonb
  language sql security definer set search_path = public, corpus as $$ select corpus.etl_selftest_write(p) $$;
create or replace function public.etl_selftest_embed(p_slug text, p_vectors jsonb) returns int
  language sql security definer set search_path = public, corpus as $$ select corpus.etl_selftest_embed(p_slug, p_vectors) $$;
create or replace function public.etl_selftest_chunks(p_slug text) returns jsonb
  language sql security definer set search_path = public, corpus as $$ select corpus.etl_selftest_chunks(p_slug) $$;
create or replace function public.etl_selftest_stats(p_slug text) returns jsonb
  language sql security definer set search_path = public, corpus as $$ select corpus.etl_selftest_stats(p_slug) $$;
create or replace function public.etl_selftest_purge(p_slug text) returns jsonb
  language sql security definer set search_path = public, corpus as $$ select corpus.etl_selftest_purge(p_slug) $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.etl_selftest_write(jsonb)',
    'public.etl_selftest_embed(text, jsonb)',
    'public.etl_selftest_chunks(text)',
    'public.etl_selftest_stats(text)',
    'public.etl_selftest_purge(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ------------------------------------------------ observability bridges ---
create or replace view public.corpus_matter_health as
  select * from corpus.v_matter_health;

revoke all on public.corpus_matter_health from anon, authenticated;
grant select on public.corpus_matter_health to service_role;

notify pgrst, 'reload schema';
