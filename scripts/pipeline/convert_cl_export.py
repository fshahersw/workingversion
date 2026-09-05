#!/usr/bin/env python3
"""Convert a raw CourtListener docket CSV export into the canonical
FULL_DOCKET.csv format consumed by ingest_matter.py.

Raw CL exports carry fields like `docketentry_entry_number`,
`recapdocument_filepath_local`, `recapdocument_sha1`, ... and lack sha256/md5
(those are computed by fetch_pdfs.py after download).

Cross-docket namespacing (one matter, several source dockets):
  --entry-prefix JPML   labels numbered entries "JPML-<n>" so the pipeline maps
                        them to entry 900_000+n (see parse_entry_label).
  --blank-base 800001   rows with no entry number get sequential numeric labels
                        starting here (use a distinct range per source docket).

Slot collisions: when two rows share (entry, attachment) the later row is
re-keyed to the next free attachment number for that entry, so no document
is silently dropped.
"""
from __future__ import annotations

import argparse
import csv
import sys

CANON_COLS = [
    "record_id", "docket_entry", "attachment_number", "filed_date_iso",
    "docket_description", "document_label", "document_type",
    "public_access_status", "file_name", "page_count_exact", "size_bytes",
    "sha256", "sha1", "md5", "recap_pdf_url", "internet_archive_url",
    "courtlistener_document_url", "pacer_pdf_url", "pacer_price_usd",
]


def convert(src: str, out, *, docket_id: str, docket_slug: str, court: str,
            entry_prefix: str, blank_base: int, record_prefix: str) -> dict:
    rows = list(csv.DictReader(open(src, newline="", encoding="utf-8-sig")))
    w = csv.DictWriter(out, fieldnames=CANON_COLS)
    w.writeheader()

    used: set[tuple[str, int]] = set()
    stats = {"rows": len(rows), "emitted": 0, "skipped_empty": 0,
             "free_pdf": 0, "pacer_link": 0, "no_link": 0,
             "sealed": 0, "rekeyed": 0, "blank_entries": 0}
    blank_seq = blank_base

    for i, r in enumerate(rows, 1):
        entry = (r.get("docketentry_entry_number") or "").strip()
        desc = (r.get("docketentry_description") or "").strip()
        recap_desc = (r.get("recapdocument_description") or "").strip()
        pdf_path = (r.get("recapdocument_filepath_local") or "").strip()
        pacer_doc_id = (r.get("recapdocument_pacer_doc_id") or "").strip()
        sealed = (r.get("recapdocument_is_sealed") or "").strip() == "True"

        if not entry:
            if not desc and not recap_desc:
                stats["skipped_empty"] += 1
                continue  # junk row: no number, no text, no document
            entry = str(blank_seq)
            blank_seq += 1
            stats["blank_entries"] += 1
            if entry_prefix:
                entry = f"{entry_prefix}-{entry}"
        elif entry_prefix:
            entry = f"{entry_prefix}-{entry}"

        att_raw = (r.get("recapdocument_attachment_number") or "").strip()
        att = int(att_raw) if att_raw.isdigit() else 0
        while (entry, att) in used:  # CL sometimes files 2 main docs on one entry
            att += 1
            stats["rekeyed"] += 1
        used.add((entry, att))

        # CL exports carry full URLs in these fields; prefix only bare paths
        recap_url = pdf_path if pdf_path.startswith("http") else (
            f"https://storage.courtlistener.com/{pdf_path}" if pdf_path else "")
        ia_path = (r.get("recapdocument_filepath_ia") or "").strip()
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
        cl_doc_url = (
            f"https://www.courtlistener.com/docket/{docket_id}/{entry}/{docket_slug}/"
            if numeric_entry else
            f"https://www.courtlistener.com/docket/{docket_id}/{docket_slug}/")

        w.writerow({
            "record_id": f"{record_prefix}-{i:04d}",
            "docket_entry": entry,
            "attachment_number": att,
            "filed_date_iso": (r.get("docketentry_date_filed") or "").strip(),
            "docket_description": desc,
            "document_label": "Main Document" if att == 0 else f"Attachment {att}",
            "document_type": recap_desc or (r.get("recapdocument_document_type") or "").strip(),
            "public_access_status": status,
            "file_name": file_name,
            "page_count_exact": (r.get("recapdocument_page_count") or "").strip(),
            "size_bytes": (r.get("recapdocument_file_size") or "").strip(),
            "sha256": "",
            "sha1": (r.get("recapdocument_sha1") or "").strip(),
            "md5": "",
            "recap_pdf_url": recap_url,
            "internet_archive_url": ia_url,
            "courtlistener_document_url": cl_doc_url,
            "pacer_pdf_url": (f"https://ecf.{court}.uscourts.gov/doc1/{pacer_doc_id}"
                              if pacer_doc_id else ""),
            "pacer_price_usd": "",
        })
        stats["emitted"] += 1
    return stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--docket-id", required=True)
    ap.add_argument("--docket-slug", required=True)
    ap.add_argument("--court", required=True, help="PACER host prefix, e.g. njd, jpml")
    ap.add_argument("--entry-prefix", default="", help="e.g. JPML")
    ap.add_argument("--blank-base", type=int, default=800001)
    ap.add_argument("--record-prefix", default="REC")
    a = ap.parse_args()
    with open(a.out, "w", newline="") as f:
        stats = convert(a.src, f, docket_id=a.docket_id, docket_slug=a.docket_slug,
                        court=a.court, entry_prefix=a.entry_prefix,
                        blank_base=a.blank_base, record_prefix=a.record_prefix)
    print(stats, file=sys.stderr)


if __name__ == "__main__":
    main()
