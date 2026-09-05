#!/usr/bin/env python3
"""Fetch CourtListener RECAP docket entries + documents into registry staging tables.

Usage: python3 scripts/backfill/fetch_courtlistener.py <docket_id> <matter_id> <label>
Writes TSV to /tmp/backfill/<label>.{entries,docs}.tsv and loads via psql COPY.
"""
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

TOKEN = os.environ["COURTLISTENER_API_TOKEN"]
DB = os.environ["CORPUS_DB_URL"]
BASE = "https://www.courtlistener.com/api/rest/v4/docket-entries/"


def esc(v):
    if v is None or v == "":
        return r"\N"
    s = str(v)
    return s.replace("\\", "\\\\").replace("\t", " ").replace("\n", " ").replace("\r", " ")


def get(url, attempt=0):
    req = urllib.request.Request(url, headers={"Authorization": f"Token {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            import json
            return json.load(r)
    except urllib.error.HTTPError as e:
        if attempt >= 12:
            raise
        wait = int(e.headers.get("Retry-After") or 0) + 5 if e.code == 429 else min(60, 2 ** attempt * 2)
        print(f"  retry {attempt + 1} after {wait}s (HTTP {e.code})", flush=True)
        time.sleep(wait)
        return get(url, attempt + 1)
    except Exception as e:  # noqa: BLE001
        if attempt >= 8:
            raise
        wait = min(60, 2 ** attempt * 2)
        print(f"  retry {attempt + 1} after {wait}s ({e})", flush=True)
        time.sleep(wait)
        return get(url, attempt + 1)


def main():
    docket_id, matter_id, label = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs("/tmp/backfill", exist_ok=True)
    ep = f"/tmp/backfill/{label}.entries.tsv"
    dp = f"/tmp/backfill/{label}.docs.tsv"
    url = BASE + "?" + urllib.parse.urlencode({"docket": docket_id, "page_size": 100, "order_by": "id"})
    n_e = n_d = pages = 0
    with open(ep, "w") as fe, open(dp, "w") as fd:
        while url:
            data = get(url)
            pages += 1
            for e in data["results"]:
                fe.write("\t".join(esc(x) for x in [
                    e["id"], matter_id, e.get("entry_number"), e.get("date_filed"),
                    e.get("description"), e.get("pacer_sequence_number"),
                ]) + "\n")
                n_e += 1
                for d in e.get("recap_documents", []):
                    abs_url = d.get("absolute_url")
                    fd.write("\t".join(esc(x) for x in [
                        d["id"], e["id"], matter_id, e.get("entry_number"),
                        d.get("document_number"), d.get("attachment_number"), d.get("description"),
                        d.get("page_count"), d.get("file_size"), d.get("sha1"), d.get("pacer_doc_id"),
                        d.get("is_available"), d.get("is_sealed"),
                        ("https://www.courtlistener.com" + abs_url) if abs_url else None,
                        ("https://storage.courtlistener.com/" + d["filepath_local"]) if d.get("filepath_local") else None,
                    ]) + "\n")
                    n_d += 1
            url = data.get("next")
            if pages % 10 == 0:
                print(f"  {label}: {pages} pages, {n_e} entries, {n_d} docs", flush=True)
            time.sleep(1.2)
    print(f"{label}: fetched {n_e} entries / {n_d} docs in {pages} pages", flush=True)

    sql = f"""
\\set ON_ERROR_STOP on
create temp table t_e (cl_entry_id bigint, matter_id uuid, entry_number integer, date_filed date, description text, pacer_sequence_number bigint);
create temp table t_d (cl_doc_id bigint, cl_entry_id bigint, matter_id uuid, entry_number integer, document_number text, attachment_number integer, description text, page_count integer, file_size bigint, sha1 text, pacer_doc_id text, is_available boolean, is_sealed boolean, courtlistener_url text, download_url text);
\\copy t_e from '{ep}' with (format text, null '\\N')
\\copy t_d from '{dp}' with (format text, null '\\N')
insert into registry.cl_staging_entries (cl_entry_id, matter_id, entry_number, date_filed, description, pacer_sequence_number)
select distinct on (cl_entry_id) * from t_e
on conflict (cl_entry_id) do update set entry_number=excluded.entry_number, date_filed=excluded.date_filed,
  description=excluded.description, pacer_sequence_number=excluded.pacer_sequence_number, fetched_at=now();
insert into registry.cl_staging_documents (cl_doc_id, cl_entry_id, matter_id, entry_number, document_number, attachment_number, description, page_count, file_size, sha1, pacer_doc_id, is_available, is_sealed, courtlistener_url, download_url)
select distinct on (cl_doc_id) * from t_d
on conflict (cl_doc_id) do update set description=excluded.description, page_count=excluded.page_count,
  file_size=excluded.file_size, sha1=excluded.sha1, pacer_doc_id=excluded.pacer_doc_id,
  is_available=excluded.is_available, is_sealed=excluded.is_sealed,
  courtlistener_url=excluded.courtlistener_url, download_url=excluded.download_url, fetched_at=now();
select '{label}' as label, (select count(*) from registry.cl_staging_entries where matter_id='{matter_id}') as staged_entries,
       (select count(*) from registry.cl_staging_documents where matter_id='{matter_id}') as staged_docs;
COMMIT;
"""
    subprocess.run(["psql", DB, "-q"], input=sql, text=True, check=True)


if __name__ == "__main__":
    main()
