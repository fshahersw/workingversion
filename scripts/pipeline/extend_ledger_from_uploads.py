#!/usr/bin/env python3
"""Append canonical ledger rows for uploaded PDFs that no docket export listed.

Court exports (CourtListener in particular) frequently omit attachment rows that
exist on the real docket. When the firm uploads its own copy of the docket we
end up with files whose (entry, attachment) slot has no ledger row, so the
pipeline would treat them as "files without a ledger slot".

This script scans an S3 incoming prefix, matches each file to an existing entry
in the canonical ledger, and appends a row for every slot that is missing —
inheriting the parent entry's label, filed date and docket description, and
taking the document title from the filename.

    python3 scripts/pipeline/extend_ledger_from_uploads.py \
        --ledger scripts/pipeline/inputs/insulin-pricing-md-3080/INSULIN_FULL_DOCKET.csv \
        --prefix insulin-pricing-md-3080/incoming/jpml/ --entry-prefix JPML [--apply]
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import shutil
import sys

import boto3
from botocore.config import Config

CANON_COLS = [
    "record_id", "docket_entry", "attachment_number", "filed_date_iso",
    "docket_description", "document_label", "document_type",
    "public_access_status", "file_name", "page_count_exact", "size_bytes",
    "sha256", "sha1", "md5", "recap_pdf_url", "internet_archive_url",
    "courtlistener_document_url", "pacer_pdf_url", "pacer_price_usd",
]

# "0446-003. (01-23-2026) (Exhibit A - ILN1-26-cv-00390).pdf"
NAME = re.compile(
    r"^(\d{1,5})(?:-(\d{1,3}))?\.\s*(?:\((\d{2})-(\d{2})-(\d{4})\))?\s*(.*)\.pdf$", re.I)


def s3():
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("S3_ENDPOINT") or None,
        region_name=os.environ.get("AWS_REGION") or None,
        config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"),
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ledger", required=True)
    ap.add_argument("--bucket", default=os.environ.get("MATTERS_BUCKET", "matters"))
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--entry-prefix", default="", help="e.g. JPML")
    ap.add_argument("--record-prefix", default="LOCAL")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    rows = list(csv.DictReader(open(a.ledger, newline="", encoding="utf-8-sig")))
    ep = a.entry_prefix.upper()

    def entry_num(label: str) -> int | None:
        label = label.strip().upper()
        if ep and not label.startswith(f"{ep}-"):
            return None
        if not ep and not label.isdigit():
            return None
        m = re.search(r"(\d+)", label)
        return int(m.group(1)) if m else None

    known: set[tuple[int, int]] = set()
    parent: dict[int, dict] = {}
    for r in rows:
        n = entry_num(r["docket_entry"])
        if n is None:
            continue
        known.add((n, int(r["attachment_number"] or 0)))
        if int(r["attachment_number"] or 0) == 0 or n not in parent:
            parent.setdefault(n, r)

    client = s3()
    paginator = client.get_paginator("list_objects_v2")
    files: dict[tuple[int, int], tuple[str, str, str]] = {}
    unparsed: list[str] = []
    for page in paginator.paginate(Bucket=a.bucket, Prefix=a.prefix):
        for o in page.get("Contents", []):
            base = re.sub(r"^\d{10,}-", "", o["Key"].rsplit("/", 1)[-1])
            m = NAME.match(base)
            if not m:
                unparsed.append(base)
                continue
            slot = (int(m.group(1)), int(m.group(2) or 0))
            date = f"{m.group(5)}-{m.group(3)}-{m.group(4)}" if m.group(3) else ""
            files[slot] = (date, (m.group(6) or "").strip(" .()"), base)

    new = sorted(k for k in files if k not in known)
    orphan = [k for k in new if k[0] not in parent]
    print(f"files: {len(files)}  unparsed: {len(unparsed)}  "
          f"already in ledger: {len(files) - len(new)}  new slots: {len(new)}  "
          f"orphan (no parent entry): {len(orphan)}")
    if unparsed:
        print("  unparsed sample:", unparsed[:5])
    if orphan:
        print("  orphan sample:", orphan[:10])
    if not new:
        return

    out_rows = []
    for i, (n, att) in enumerate(new, 1):
        if n not in parent:
            continue
        p = parent[n]
        date, title, base = files[(n, att)]
        out_rows.append({
            "record_id": f"{a.record_prefix}-{n:04d}-{att:03d}",
            "docket_entry": p["docket_entry"],
            "attachment_number": att,
            "filed_date_iso": date or p["filed_date_iso"],
            "docket_description": p["docket_description"],
            "document_label": "Main Document" if att == 0 else f"Attachment {att}",
            "document_type": title,
            "public_access_status": "LOCALLY_SUPPLIED",
            "file_name": base,
            "page_count_exact": "", "size_bytes": "",
            "sha256": "", "sha1": "", "md5": "",
            "recap_pdf_url": "", "internet_archive_url": "",
            "courtlistener_document_url": p["courtlistener_document_url"],
            "pacer_pdf_url": "", "pacer_price_usd": "",
        })
    print(f"rows to append: {len(out_rows)}  (sample: "
          f"{[r['record_id'] for r in out_rows[:3]]})")
    if not a.apply:
        print("dry run — re-run with --apply")
        return

    shutil.copyfile(a.ledger, a.ledger + ".bak")
    with open(a.ledger, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CANON_COLS)
        w.writerows(out_rows)
    total = sum(1 for _ in open(a.ledger)) - 1
    print(f"appended {len(out_rows)} rows -> {a.ledger} ({total} rows total, "
          f"backup at {a.ledger}.bak)")


if __name__ == "__main__":
    main()
