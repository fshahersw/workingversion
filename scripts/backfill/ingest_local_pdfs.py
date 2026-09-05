#!/usr/bin/env python3
"""Ingest locally backfilled docket PDFs into the corpus registry.

Filename convention produced by the local downloader:

    0133. (11-19-2025) NOTICE of Voluntary Dismissal ... .pdf   -> entry 133, main doc
    0140-003. (11-20-2025) (Exhibit).pdf                        -> entry 140, attachment 3

Usage:
    python3 scripts/backfill/ingest_local_pdfs.py --dir /path/to/apple --docket 2:24-md-03113
    python3 scripts/backfill/ingest_local_pdfs.py --dir /path/to/apple --docket 2:24-md-03113 --apply

Without --apply nothing is written or uploaded: you get the match report only.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field

DB = os.environ["CORPUS_DB_URL"]
BUCKET_DEFAULT = "kb-staging"
REPORT_DIR = "/mnt/documents"

NAME_RE = re.compile(
    r"^(?P<entry>\d{1,6})(?:-(?P<att>\d{1,4}))?\s*\.\s*"
    r"(?:\((?P<date>\d{2}-\d{2}-\d{4})\)\s*)?"
    r"(?P<desc>.*?)\s*\.pdf$",
    re.IGNORECASE,
)

# RECAP / PACER convention: gov.uscourts.njd.550383.6.0.pdf / ...17.3_1.pdf
RECAP_RE = re.compile(
    r"^gov\.uscourts\.[a-z0-9]+\.\d+\.(?P<entry>\d{1,6})\.(?P<att>\d{1,4})"
    r"(?:_\d+)?\.pdf$",
    re.IGNORECASE,
)


@dataclass
class LocalFile:
    path: str
    filename: str
    entry: int
    attachment: int | None
    date_filed: str | None
    description: str | None
    sha256: str = ""
    byte_count: int = 0
    page_count: int | None = None
    outcome: str = ""
    document_id: str | None = None
    s3_key: str | None = None


def psql(sql: str, tuples: bool = True) -> list[list[str]]:
    args = ["psql", DB, "-v", "ON_ERROR_STOP=1", "-A", "-F", "\x1f", "-c", sql]
    if tuples:
        args.insert(4, "-t")
    out = subprocess.run(args, capture_output=True, text=True, check=True).stdout
    return [ln.split("\x1f") for ln in out.splitlines() if ln.strip()]


def psql_script(sql: str) -> None:
    subprocess.run(["psql", DB, "-q", "-v", "ON_ERROR_STOP=1"], input=sql, text=True, check=True)


def parse_dir(directory: str) -> tuple[list[LocalFile], list[str]]:
    parsed: list[LocalFile] = []
    skipped: list[str] = []
    for root, _dirs, files in os.walk(directory):
        for fn in sorted(files):
            if not fn.lower().endswith(".pdf"):
                continue
            m = NAME_RE.match(fn.strip())
            if m:
                entry = m.group("entry")
                att = m.group("att")
                raw_date = m.group("date")
                desc = (m.group("desc") or "").strip().strip("-").strip()
            else:
                rm = RECAP_RE.match(fn.strip())
                if not rm:
                    skipped.append(os.path.join(root, fn))
                    continue
                entry = rm.group("entry")
                att = rm.group("att")
                raw_date = None
                desc = ""
            date_filed = None
            if raw_date:
                mm, dd, yyyy = raw_date.split("-")
                date_filed = f"{yyyy}-{mm}-{dd}"
            parsed.append(
                LocalFile(
                    path=os.path.join(root, fn),
                    filename=fn,
                    entry=int(entry),
                    # "-000" and absent both mean the main document
                    attachment=(int(att) if att and int(att) != 0 else None),
                    date_filed=date_filed,
                    description=desc or None,
                )
            )
    return parsed, skipped


def hash_and_pages(lf: LocalFile) -> None:
    h = hashlib.sha256()
    size = 0
    with open(lf.path, "rb") as fh:
        while chunk := fh.read(1 << 20):
            h.update(chunk)
            size += len(chunk)
    lf.sha256 = h.hexdigest()
    lf.byte_count = size
    try:
        from pypdf import PdfReader

        lf.page_count = len(PdfReader(lf.path, strict=False).pages)
    except Exception as exc:  # noqa: BLE001
        print(f"  ! page count failed for {lf.filename}: {exc}", flush=True)
        lf.page_count = None


def resolve_matter(docket_number: str) -> tuple[str, str, str | None, str]:
    rows = psql(
        "select m.matter_id::text, m.case_name, "
        "(select d.s3_key from registry.documents d where d.matter_id = m.matter_id "
        " and d.s3_key is not null limit 1), "
        "coalesce((select d.s3_bucket from registry.documents d where d.matter_id = m.matter_id "
        " and d.s3_bucket is not null limit 1), '" + BUCKET_DEFAULT + "') "
        f"from registry.matters m where m.docket_number = '{docket_number}' limit 1"
    )
    if not rows:
        sys.exit(f"No matter with docket_number {docket_number}")
    matter_id, case_name, sample_key, bucket = rows[0]
    return matter_id, case_name, (sample_key or None), bucket


def key_template(sample_key: str | None, docket_id: str | None) -> tuple[str, str]:
    """Return (prefix, gov_stub) derived from an existing stored key."""
    if sample_key:
        prefix = sample_key.rsplit("/", 1)[0]
        base = sample_key.rsplit("/", 1)[1]
        m = re.match(r"^(gov\.uscourts\.[a-z]+\.\d+)\.", base)
        if m:
            return prefix, m.group(1)
        return prefix, ""
    return f"recap-pdfs/{docket_id or 'local'}", ""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True,
                    help="local folder of PDFs, or a staging prefix when --from-s3 is set")
    ap.add_argument("--from-s3", default=None,
                    help="bucket holding the uploaded PDFs; --dir is then the key prefix")
    ap.add_argument("--docket", required=True, help="docket_number, e.g. 2:24-md-03113")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--label", default=None)
    args = ap.parse_args()

    label = args.label or args.docket.replace(":", "").replace("/", "-")
    matter_id, case_name, sample_key, bucket = resolve_matter(args.docket)
    print(f"Matter: {case_name}  ({matter_id})")

    source_dir = args.dir
    if args.from_s3:
        source_dir = pull_from_s3(args.from_s3, args.dir, label)

    files, skipped = parse_dir(source_dir)
    print(f"Parsed {len(files)} PDFs, {len(skipped)} unparseable filenames")
    if not files:
        sys.exit("Nothing to ingest")

    # Existing registry rows for this matter, keyed on (entry, attachment)
    rows = psql(
        "select document_id::text, entry_number, coalesce(attachment_number, -1), "
        "coalesce(s3_key, ''), coalesce(sha256, ''), coalesce(description, '') "
        f"from registry.documents where matter_id = '{matter_id}'"
    )
    existing: dict[tuple[int, int], dict] = {}
    for did, ent, att, key, sha, desc in rows:
        if not ent:
            continue
        existing[(int(ent), int(att))] = {
            "document_id": did, "s3_key": key, "sha256": sha, "description": desc,
        }
    print(f"Registry rows for matter: {len(rows)} ({len(existing)} with an entry number)")

    docket_id = None
    if sample_key:
        m = re.search(r"recap-pdfs/(\d+)/", sample_key)
        docket_id = m.group(1) if m else None
    prefix, gov_stub = key_template(sample_key, docket_id)

    print("Hashing and reading page counts ...")
    for i, lf in enumerate(files, 1):
        hash_and_pages(lf)
        k = (lf.entry, lf.attachment if lf.attachment is not None else -1)
        hit = existing.get(k)
        if hit is None:
            lf.outcome = "new_document"
        elif hit["s3_key"]:
            lf.outcome = "already_stored"
        else:
            lf.outcome = "fills_missing_pdf"
        if hit:
            lf.document_id = hit["document_id"]
        att_part = lf.attachment if lf.attachment is not None else 0
        base = (
            f"{gov_stub}.{lf.entry}.{att_part}.pdf"
            if gov_stub
            else f"local.{lf.entry:04d}.{att_part}.pdf"
        )
        lf.s3_key = hit["s3_key"] if hit and hit["s3_key"] else f"{prefix}/{base}"
        if i % 50 == 0:
            print(f"  {i}/{len(files)}", flush=True)

    counts: dict[str, int] = {}
    for lf in files:
        counts[lf.outcome] = counts.get(lf.outcome, 0) + 1
    print("\nMatch report:")
    for k in ("fills_missing_pdf", "already_stored", "new_document"):
        print(f"  {k:>20}: {counts.get(k, 0)}")
    print(f"  {'unparseable':>20}: {len(skipped)}")

    os.makedirs(REPORT_DIR, exist_ok=True)
    report = f"{REPORT_DIR}/local-backfill-report-{label}.csv"
    with open(report, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["filename", "entry", "attachment", "date_filed", "description",
                    "sha256", "byte_count", "page_count", "outcome", "document_id", "s3_key"])
        for lf in files:
            w.writerow([lf.filename, lf.entry, lf.attachment or "", lf.date_filed or "",
                        lf.description or "", lf.sha256, lf.byte_count, lf.page_count or "",
                        lf.outcome, lf.document_id or "", lf.s3_key])
        for p in skipped:
            w.writerow([os.path.basename(p), "", "", "", "", "", "", "", "unparseable", "", ""])
    print(f"\nReport: {report}")

    if not args.apply:
        print("\nDry run — nothing uploaded or written. Re-run with --apply to commit.")
        return

    upload(files, bucket)
    stage_and_promote(files, matter_id, bucket, label)


def pull_from_s3(bucket: str, prefix: str, label: str) -> str:
    """Download an uploaded staging prefix to a local scratch folder."""
    cli = s3_client()
    dest = f"/tmp/backfill/src-{label}"
    os.makedirs(dest, exist_ok=True)
    token, n = None, 0
    while True:
        kw = {"Bucket": bucket, "Prefix": prefix.lstrip("/")}
        if token:
            kw["ContinuationToken"] = token
        resp = cli.list_objects_v2(**kw)
        for obj in resp.get("Contents", []):
            key = obj["Key"]
            if not key.lower().endswith(".pdf"):
                continue
            out = os.path.join(dest, os.path.basename(key))
            if os.path.exists(out) and os.path.getsize(out) == obj["Size"]:
                continue
            cli.download_file(bucket, key, out)
            n += 1
            if n % 25 == 0:
                print(f"  downloaded {n}", flush=True)
        if not resp.get("IsTruncated"):
            break
        token = resp.get("NextContinuationToken")
    print(f"Pulled {n} PDFs from s3://{bucket}/{prefix} -> {dest}")
    return dest


def s3_client():
    import boto3
    from botocore.config import Config

    endpoint = os.environ.get("S3_ENDPOINT") or None
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=os.environ.get("AWS_REGION", "us-east-1"),
        # Supabase storage S3 endpoint: path-style addressing is required
        config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"),
    )


def upload(files: list[LocalFile], bucket: str) -> None:
    cli = s3_client()
    up = skip = 0
    for i, lf in enumerate(files, 1):
        try:
            head = cli.head_object(Bucket=bucket, Key=lf.s3_key)
            if head.get("ContentLength") == lf.byte_count:
                skip += 1
                continue
        except Exception:  # noqa: BLE001  (404 => not stored yet)
            pass
        with open(lf.path, "rb") as fh:
            cli.put_object(Bucket=bucket, Key=lf.s3_key, Body=fh,
                           ContentType="application/pdf")
        up += 1
        if i % 25 == 0:
            print(f"  uploaded {up}, skipped {skip} ({i}/{len(files)})", flush=True)
    print(f"Upload done: {up} new objects, {skip} already present")


def stage_and_promote(files: list[LocalFile], matter_id: str, bucket: str, label: str) -> None:
    tsv = f"/tmp/backfill/local-{label}.tsv"
    os.makedirs("/tmp/backfill", exist_ok=True)

    def esc(v):
        if v is None or v == "":
            return r"\N"
        return (str(v).replace("\\", "\\\\").replace("\t", " ")
                .replace("\n", " ").replace("\r", " "))

    with open(tsv, "w") as fh:
        for lf in files:
            fh.write("\t".join(esc(x) for x in [
                matter_id, lf.entry, lf.attachment, lf.date_filed, lf.description,
                lf.sha256, lf.byte_count, lf.page_count, bucket, lf.s3_key, lf.filename,
            ]) + "\n")

    sql = f"""
\\set ON_ERROR_STOP on
create table if not exists registry.local_staging_documents (
  matter_id uuid not null,
  entry_number integer not null,
  attachment_number integer,
  date_filed date,
  description text,
  sha256 text,
  byte_count bigint,
  page_count integer,
  s3_bucket text,
  s3_key text,
  source_filename text,
  fetched_at timestamptz not null default now()
);
create unique index if not exists local_staging_documents_uidx
  on registry.local_staging_documents (matter_id, entry_number, coalesce(attachment_number, -1));
delete from registry.local_staging_documents where matter_id = '{matter_id}';
create temp table t_l (matter_id uuid, entry_number integer, attachment_number integer,
  date_filed date, description text, sha256 text, byte_count bigint, page_count integer,
  s3_bucket text, s3_key text, source_filename text);
\\copy t_l from '{tsv}' with (format text, null '\\N')
insert into registry.local_staging_documents (matter_id, entry_number, attachment_number,
  date_filed, description, sha256, byte_count, page_count, s3_bucket, s3_key, source_filename)
select distinct on (matter_id, entry_number, coalesce(attachment_number, -1)) *
from t_l order by matter_id, entry_number, coalesce(attachment_number, -1), byte_count desc;
select count(*) as staged from registry.local_staging_documents where matter_id = '{matter_id}';
"""
    psql_script(sql)
    psql_script(open("supabase/corpus/local-backfill-promote.sql").read())
    print("Promoted into registry.documents / registry.docket_entries")


if __name__ == "__main__":
    main()
