#!/usr/bin/env python3
"""Fetch a CourtListener docket via the REST API and emit a canonical
FULL_DOCKET.csv row per document slot (one per RECAP document + one main-doc
row for entries that have no RECAP document).

Uses the authenticated v4 docket-entries endpoint with polite pagination.
Output is consumed directly by scripts/pipeline/ingest_matter.py.

Example:
  python3 scripts/pipeline/fetch_cl_canonical.py 67665081 \
      --slug insulin-pricing-md-3080 \
      --docket-slug insulin-pricing-litigation \
      --court njd \
      --out scripts/pipeline/inputs/insulin-pricing-md-3080/INSULIN_NJD_DOCKET.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CANON_COLS = [
    "record_id", "docket_entry", "attachment_number", "filed_date_iso",
    "docket_description", "document_label", "document_type",
    "public_access_status", "file_name", "page_count_exact", "size_bytes",
    "sha256", "sha1", "md5", "recap_pdf_url", "internet_archive_url",
    "courtlistener_document_url", "pacer_pdf_url", "pacer_price_usd",
]

TOKEN = os.environ.get("COURTLISTENER_API_TOKEN")
BASE = "https://www.courtlistener.com/api/rest/v4/docket-entries/"
UA = {"User-Agent": "Mozilla/5.0 (compatible; SeegerWeiss-Corpus/1.0; +https://seegerweiss.com)"}


def get(url: str, attempt: int = 0) -> dict:
    headers = dict(UA)
    if TOKEN:
        headers["Authorization"] = f"Token {TOKEN}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if attempt >= 12:
            raise
        wait = int(e.headers.get("Retry-After") or 0) + 5 if e.code == 429 else min(60, 2 ** attempt * 2)
        print(f"  retry {attempt + 1} after {wait}s (HTTP {e.code})", flush=True, file=sys.stderr)
        time.sleep(wait)
        return get(url, attempt + 1)
    except Exception as e:
        if attempt >= 8:
            raise
        wait = min(60, 2 ** attempt * 2)
        print(f"  retry {attempt + 1} after {wait}s ({e})", flush=True, file=sys.stderr)
        time.sleep(wait)
        return get(url, attempt + 1)


def to_canonical(
    entries: list[dict],
    *,
    docket_id: str,
    docket_slug: str,
    court: str,
    entry_prefix: str,
    blank_base: int,
    record_prefix: str,
) -> tuple[list[dict], dict]:
    rows: list[dict] = []
    used: set[tuple[str, int]] = set()
    blank_seq = blank_base
    stats = {
        "entries": len(entries),
        "emitted": 0,
        "free_pdf": 0,
        "pacer_link": 0,
        "no_link": 0,
        "sealed": 0,
        "rekeyed": 0,
        "blank_entries": 0,
    }

    for i, e in enumerate(entries, 1):
        entry = str(e.get("entry_number") or "").strip()
        desc = str(e.get("description") or "").strip()
        docs = e.get("recap_documents", []) or []

        if not entry:
            if not desc and not docs:
                continue
            entry = str(blank_seq)
            blank_seq += 1
            stats["blank_entries"] += 1
            if entry_prefix:
                entry = f"{entry_prefix}-{entry}"
        elif entry_prefix:
            entry = f"{entry_prefix}-{entry}"

        # If an entry has no recap documents, emit one text-only main-doc row
        if not docs:
            docs = [{}]

        for d in docs:
            recap_desc = str(d.get("description") or "").strip()
            pdf_path = str(d.get("filepath_local") or "").strip()
            pacer_doc_id = str(d.get("pacer_doc_id") or "").strip()
            sealed = bool(d.get("is_sealed"))
            att_raw = str(d.get("attachment_number") or "").strip()
            att = int(att_raw) if att_raw.isdigit() else 0

            while (entry, att) in used:
                att += 1
                stats["rekeyed"] += 1
            used.add((entry, att))

            recap_url = pdf_path if pdf_path.startswith("http") else (
                f"https://storage.courtlistener.com/{pdf_path}" if pdf_path else "")
            ia_path = str(d.get("filepath_ia") or "").strip()
            ia_url = ia_path if ia_path.startswith("http") else (
                f"https://archive.org/download/{ia_path}" if ia_path else "")

            if recap_url:
                status = "FREE_RECAP_PDF_AVAILABLE"
                stats["free_pdf"] += 1
            elif sealed:
                status = "NO_PUBLIC_PDF_LINK"
                stats["sealed"] += 1
                stats["no_link"] += 1
            elif pacer_doc_id:
                status = "PACER_LINK_AVAILABLE"
                stats["pacer_link"] += 1
            else:
                status = "NO_PUBLIC_PDF_LINK"
                stats["no_link"] += 1

            if recap_url:
                if entry_prefix and entry.startswith(f"{entry_prefix}-"):
                    num = entry.split("-", 1)[1]
                    file_name = f"{entry_prefix}-{int(num):04d}-{att:03d}.pdf"
                else:
                    file_name = f"{int(entry):04d}-{att:03d}.pdf" if entry.isdigit() else ""
            else:
                file_name = ""

            numeric_entry = entry.isdigit()
            cl_entry_url = (
                f"https://www.courtlistener.com/docket/{docket_id}/{entry}/{docket_slug}/"
                if numeric_entry else
                f"https://www.courtlistener.com/docket/{docket_id}/{docket_slug}/")

            rows.append({
                "record_id": f"{record_prefix}-{i:04d}-{att:03d}",
                "docket_entry": entry,
                "attachment_number": att,
                "filed_date_iso": str(e.get("date_filed") or "").strip(),
                "docket_description": desc,
                "document_label": "Main Document" if att == 0 else f"Attachment {att}",
                "document_type": recap_desc or str(d.get("document_type") or "").strip(),
                "public_access_status": status,
                "file_name": file_name,
                "page_count_exact": str(d.get("page_count") or "").strip(),
                "size_bytes": str(d.get("file_size") or "").strip(),
                "sha256": "",
                "sha1": str(d.get("sha1") or "").strip(),
                "md5": "",
                "recap_pdf_url": recap_url,
                "internet_archive_url": ia_url,
                "courtlistener_document_url": cl_entry_url,
                "pacer_pdf_url": (f"https://ecf.{court}.uscourts.gov/doc1/{pacer_doc_id}"
                                  if pacer_doc_id else ""),
                "pacer_price_usd": "",
            })
            stats["emitted"] += 1
    return rows, stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("docket_id", help="CourtListener docket id, e.g. 67665081")
    ap.add_argument("--slug", default="", help="Matter slug / output subdir name")
    ap.add_argument("--docket-slug", required=True, help="URL slug, e.g. insulin-pricing-litigation")
    ap.add_argument("--court", required=True, help="PACER host prefix, e.g. njd, jpml")
    ap.add_argument("--out", required=True, help="Output CSV path")
    ap.add_argument("--entry-prefix", default="", help="e.g. JPML")
    ap.add_argument("--blank-base", type=int, default=800001)
    ap.add_argument("--record-prefix", default="REC")
    ap.add_argument("--page-size", type=int, default=100)
    a = ap.parse_args()

    if not TOKEN:
        print("warning: COURTLISTENER_API_TOKEN not set; requests are unauthenticated", file=sys.stderr)

    url = BASE + "?" + urllib.parse.urlencode({
        "docket": a.docket_id,
        "page_size": a.page_size,
        "order_by": "id",
    })

    entries: list[dict] = []
    pages = 0
    while url:
        data = get(url)
        pages += 1
        batch = data.get("results", [])
        entries.extend(batch)
        url = data.get("next")
        if pages % 10 == 0:
            print(f"  {a.docket_id}: {pages} pages, {len(entries)} entries", flush=True, file=sys.stderr)
        time.sleep(0.4 if TOKEN else 1.2)

    print(f"[{a.docket_id}] fetched {len(entries)} entries in {pages} pages", file=sys.stderr)

    rows, stats = to_canonical(
        entries,
        docket_id=a.docket_id,
        docket_slug=a.docket_slug,
        court=a.court,
        entry_prefix=a.entry_prefix,
        blank_base=a.blank_base,
        record_prefix=a.record_prefix,
    )

    out_dir = os.path.dirname(a.out)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    with open(a.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CANON_COLS)
        w.writeheader()
        for r in rows:
            w.writerow(r)

    print(stats, file=sys.stderr)


if __name__ == "__main__":
    main()
