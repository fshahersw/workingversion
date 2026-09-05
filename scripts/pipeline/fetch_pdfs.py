#!/usr/bin/env python3
"""Download PDFs for a canonical FULL_DOCKET.csv (from convert_cl_export.py),
verify them, and fill in sha256/md5/page counts.

For every row with public_access_status=FREE_RECAP_PDF_AVAILABLE:
  1. GET recap_pdf_url (storage.courtlistener.com); on failure or hash
     mismatch, fall back to internet_archive_url.
  2. Verify sha1 + size_bytes against the CSV (CourtListener's own metadata).
  3. Compute sha256, md5, page_count (pypdf) and write them back into the CSV.
  4. Save as <out_dir>/<file_name>  (file_name must already be set by the
     converter; names are unique per matter, e.g. 0001-000.pdf / JPML-0001-000.pdf).

Rows whose download fails are left with an empty file_name so the pipeline
treats them as PACER-link / text-only records. Idempotent: existing files with
matching sha1 are kept and only re-hashed if sha256 is missing.

Usage:
  python3 fetch_pdfs.py DOCKET.csv --out-dir downloads/<slug>/ [--workers 6]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

UA = {"User-Agent": "Mozilla/5.0 (compatible; SeegerWeiss-Corpus/1.0; +https://seegerweiss.com)"}
CHUNK = 1 << 20


CL_TOKEN = __import__("os").environ.get("COURTLISTENER_API_TOKEN")


def fetch(url: str, retries: int = 4) -> bytes:
    last = None
    for attempt in range(retries):
        try:
            headers = dict(UA)
            if CL_TOKEN and "courtlistener.com" in url:
                headers["Authorization"] = f"Token {CL_TOKEN}"
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - report and retry
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET failed {url}: {last}")


def hashes(data: bytes) -> tuple[str, str, str]:
    return (hashlib.sha1(data).hexdigest(),
            hashlib.sha256(data).hexdigest(),
            hashlib.md5(data).hexdigest())


def page_count(data: bytes) -> int | None:
    try:
        from pypdf import PdfReader
        return len(PdfReader(io.BytesIO(data)).pages)
    except Exception:
        return None


def process_row(row: dict, out_dir: Path) -> dict:
    """Download + verify one row. Mutates and returns the row."""
    name = row["file_name"].strip()
    if not name:
        return row
    dest = out_dir / name
    want_sha1 = row["sha1"].strip().lower()
    want_size = int(row["size_bytes"]) if row["size_bytes"].strip().isdigit() else None

    if dest.exists() and row["sha256"].strip():
        return row  # already done in a previous run

    data = None
    if dest.exists():
        data = dest.read_bytes()
        sha1 = hashlib.sha1(data).hexdigest()
        if want_sha1 and sha1 != want_sha1:
            data = None  # corrupt local file, re-download
    if data is None:
        errors = []
        for url in (row["recap_pdf_url"].strip(), row["internet_archive_url"].strip()):
            if not url:
                continue
            try:
                data = fetch(url)
            except Exception as e:  # noqa: BLE001
                errors.append(str(e))
                data = None
                continue
            sha1 = hashlib.sha1(data).hexdigest()
            if want_sha1:
                # sha1 is the authoritative check; CL's size_bytes can be stale
                if sha1 != want_sha1:
                    errors.append(f"sha1 mismatch via {url}")
                    data = None
                    continue
            elif want_size is not None and len(data) != want_size:
                errors.append(f"size mismatch via {url}")
                data = None
                continue
            break
        if data is None:
            row["_error"] = "; ".join(errors) or "no url"
            row["file_name"] = ""  # pipeline falls back to pacer/text-only
            return row
        dest.write_bytes(data)

    sha1, sha256, md5 = hashes(data)
    row["sha1"] = sha1
    row["sha256"] = sha256
    row["md5"] = md5
    row["size_bytes"] = str(len(data))
    pc = page_count(data)
    if pc is not None:
        row["page_count_exact"] = str(pc)
    return row


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("csv_path")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()

    csv_path = Path(a.csv_path)
    out_dir = Path(a.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = list(csv.DictReader(open(csv_path, newline="")))
    fields = list(rows[0].keys()) if rows else []
    todo = [r for r in rows
            if r.get("public_access_status") == "FREE_RECAP_PDF_AVAILABLE"
            and r.get("file_name", "").strip()]
    print(f"[fetch] {len(todo)} PDFs to fetch -> {out_dir}", file=sys.stderr)

    ok = fail = 0
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(process_row, r, out_dir): r for r in todo}
        for i, fut in enumerate(as_completed(futs), 1):
            r = fut.result()
            if r.get("_error"):
                fail += 1
                print(f"  [fetch] FAILED {r['docket_entry']}/{r['attachment_number']}: "
                      f"{r['_error']}", file=sys.stderr)
            else:
                ok += 1
            if i % 25 == 0:
                print(f"  [fetch] {i}/{len(todo)} (ok {ok}, failed {fail})",
                      file=sys.stderr)

    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in rows:
            r.pop("_error", None)
            w.writerow(r)
    print(f"[fetch] done: {ok} ok, {fail} failed; CSV updated", file=sys.stderr)


if __name__ == "__main__":
    main()
