#!/usr/bin/env python3
"""Repair document metadata in the corpus registry.

Computes fixes that can be derived from data already in the registry:
  * attachment_number  - parsed from doc_uid / s3_key (main documents become 0)
  * description        - best sibling description for the same (entry, attachment)
                         slot, else the "# N ..." label inside the parent entry text
  * doc_category       - classified from the description / entry text
  * entry_date_filed   - copied from the linked docket entry
  * duplicate marking  - redundant rows for a slot flagged verification_status='duplicate'

With --s3 it also fills sha256 / byte_count / page_count by reading the stored objects.

Dry run by default; nothing is written without --apply.

    python3 scripts/backfill/repair_metadata.py --docket 2:24-md-03113
    python3 scripts/backfill/repair_metadata.py --docket 2:24-md-03113 --apply
    python3 scripts/backfill/repair_metadata.py --docket 2:24-md-03113 --s3 --apply
"""
from __future__ import annotations

import argparse
import csv
import io
import os
import re
import subprocess
import sys
from collections import defaultdict

DB = os.environ.get("CORPUS_DB_URL")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROMOTE_SQL = os.path.join(ROOT, "supabase", "corpus", "metadata-repair-promote.sql")

ATT_UID_RE = re.compile(r"-p(\d+)-")
ATT_KEY_RE = re.compile(r"\.(\d+)\.(\d+)(?:_\d+)?\.pdf$", re.I)
ATT_BLOCK_RE = re.compile(r"\(Attachments:(.*?)\)\s*\(", re.S | re.I)
ATT_ITEM_RE = re.compile(r"#\s*(\d+)\s+([^#]+?)(?=,\s*#\s*\d+\s|$)", re.S)

GENERIC = {
    "letter", "order", "brief", "exhibit", "notice", "document", "attachment",
    "declaration", "motion", "other", "n/a", "unknown", "main document", "dismiss",
}

CATEGORY_RULES = [
    ("transcript", ("transcript",)),
    ("order", ("order", "judgment", "opinion", "memorandum opinion")),
    ("motion", ("motion", "move to", "petition")),
    ("brief", ("brief", "memorandum of law", "response in opposition", "reply in support")),
    ("complaint", ("complaint", "petition for", "amended complaint")),
    ("declaration", ("declaration", "affidavit", "certification")),
    ("exhibit", ("exhibit", "appendix", "attachment")),
    ("transfer", ("transfer order", "conditional transfer", "mdl transfer")),
    ("appearance", ("notice of appearance", "withdraw as attorney", "pro hac vice")),
    ("stipulation", ("stipulation", "consent", "joint")),
    ("notice", ("notice",)),
    ("letter", ("letter",)),
    ("proposed_order", ("text of proposed",)),
    ("scheduling", ("case management", "scheduling",)),
]


def psql_rows(sql: str) -> list[list[str]]:
    out = subprocess.run(["psql", DB, "-v", "ON_ERROR_STOP=1", "-At", "-F", "\x01", "-c", sql],
                         capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(out.stderr.strip())
    return [ln.split("\x01") for ln in out.stdout.splitlines() if ln]


def classify(text: str | None) -> str | None:
    if not text:
        return None
    t = text.lower()
    if t.startswith("text of proposed"):
        return "proposed_order"
    for cat, needles in CATEGORY_RULES:
        if any(n in t for n in needles):
            return cat
    return "other"


def is_weak(desc: str | None) -> bool:
    if not desc or not desc.strip():
        return True
    d = desc.strip().lower()
    return len(d) < 6 or d in GENERIC


def parse_attachment_labels(entry_text: str | None) -> dict[int, str]:
    if not entry_text:
        return {}
    block = ATT_BLOCK_RE.search(entry_text)
    raw = block.group(1) if block else None
    if raw is None:
        i = entry_text.lower().find("(attachments:")
        if i == -1:
            return {}
        raw = entry_text[i + len("(attachments:"):]
    labels: dict[int, str] = {}
    for num, label in ATT_ITEM_RE.findall(raw):
        clean = re.sub(r"\s+", " ", label).strip(" ,)\u00a0")
        clean = re.sub(r"\)\(.*$", "", clean).strip()
        if clean:
            labels[int(num)] = clean[:400]
    return labels


def derive_attachment(doc_uid: str | None, s3_key: str | None) -> int | None:
    if doc_uid:
        m = ATT_UID_RE.search(doc_uid)
        if m:
            return int(m.group(1))
    if s3_key:
        m = ATT_KEY_RE.search(s3_key)
        if m:
            return int(m.group(2))
    return None


def main() -> None:
    if not DB:
        sys.exit("CORPUS_DB_URL is not set")
    ap = argparse.ArgumentParser()
    ap.add_argument("--docket", required=True)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--s3", action="store_true", help="also compute sha256/byte_count/page_count from S3")
    ap.add_argument("--s3-limit", type=int, default=0, help="max objects to read (0 = all)")
    args = ap.parse_args()

    safe = args.docket.replace("'", "''")
    rows = psql_rows(f"""
        SELECT d.document_id, coalesce(d.entry_number::text, ''), coalesce(d.attachment_number::text, ''),
               coalesce(d.doc_uid, ''), coalesce(d.s3_bucket, ''), coalesce(d.s3_key, ''),
               replace(coalesce(d.description, ''), chr(10), ' '),
               coalesce(d.doc_category, ''), coalesce(d.entry_date_filed::text, ''),
               coalesce(e.date_filed::text, ''), replace(coalesce(e.description, ''), chr(10), ' '),
               coalesce(d.page_count::text, ''), coalesce(d.byte_count::text, ''), coalesce(d.sha256, ''),
               coalesce(d.doc_source, '')
        FROM registry.documents d
        JOIN registry.matters m USING (matter_id)
        LEFT JOIN registry.docket_entries e ON e.docket_entry_id = d.docket_entry_id
        WHERE m.docket_number ILIKE '%{safe}%';
    """)
    if not rows:
        sys.exit("no documents matched that docket")

    docs = []
    for r in rows:
        (did, entry, att, uid, bucket, key, desc, cat, edate, entry_date, entry_desc,
         pages, byts, sha, src) = r
        docs.append(dict(document_id=did, entry=entry, att=att, uid=uid, bucket=bucket,
                         key=key, desc=desc, cat=cat, edate=edate, entry_date=entry_date,
                         entry_desc=entry_desc, pages=pages, bytes=byts, sha=sha, src=src))

    # pass 1: attachment numbers
    for d in docs:
        d["new_att"] = int(d["att"]) if d["att"] else derive_attachment(d["uid"], d["key"])
        if d["new_att"] is None and d["key"]:
            d["new_att"] = 0
        if d["new_att"] is None and d["uid"].startswith("cl-"):
            d["new_att"] = None  # unknown; leave alone
        d["slot"] = (d["entry"], d["new_att"] if d["new_att"] is not None else -1)

    # pass 2: descriptions from slot siblings + parent entry attachment labels
    by_slot: dict[tuple, list[dict]] = defaultdict(list)
    for d in docs:
        by_slot[d["slot"]].append(d)

    entry_labels: dict[str, dict[int, str]] = {}
    for d in docs:
        if d["entry"] and d["entry"] not in entry_labels:
            entry_labels[d["entry"]] = parse_attachment_labels(d["entry_desc"])

    stats = defaultdict(int)
    out_rows = []
    for slot, group in by_slot.items():
        best = max((g["desc"] for g in group), key=lambda s: len(s or ""), default="")
        for d in group:
            new_desc = None
            if is_weak(d["desc"]):
                cand = best if not is_weak(best) else None
                if not cand:
                    labels = entry_labels.get(d["entry"], {})
                    att = d["new_att"]
                    if att and att in labels:
                        cand = labels[att]
                    elif att == 0 and d["entry_desc"]:
                        head = re.split(r"\s*\(Attachments:", d["entry_desc"])[0]
                        head = re.sub(r"\s*\(Entered:.*$", "", head).strip()
                        cand = head[:400] if len(head) >= 6 else None
                if cand and len(cand) > len(d["desc"] or ""):
                    new_desc = cand
                    stats["description"] += 1

            eff_desc = new_desc or d["desc"] or d["entry_desc"]
            new_cat = None if d["cat"] else classify(eff_desc)
            if new_cat:
                stats["doc_category"] += 1
            new_date = None if d["edate"] else (d["entry_date"] or None)
            if new_date:
                stats["entry_date_filed"] += 1
            new_att = d["new_att"] if not d["att"] and d["new_att"] is not None else None
            if new_att is not None:
                stats["attachment_number"] += 1

            dupe = False
            if len(group) > 1:
                # keep the row with a PDF and the richest description; flag the rest
                ranked = sorted(group, key=lambda g: (bool(g["key"]), len(g["desc"] or "")), reverse=True)
                dupe = d is not ranked[0]
                if dupe:
                    stats["duplicate"] += 1

            if any(v is not None for v in (new_att, new_desc, new_cat, new_date)) or dupe:
                out_rows.append({
                    "document_id": d["document_id"],
                    "attachment_number": new_att if new_att is not None else "",
                    "description": new_desc or "",
                    "doc_category": new_cat or "",
                    "entry_date_filed": new_date or "",
                    "page_count": "", "byte_count": "", "sha256": "",
                    "is_duplicate": "true" if dupe else "false",
                    "source_note": "derived",
                })

    if args.s3:
        s3_fill(docs, out_rows, stats, args.s3_limit)

    print(f"documents scanned : {len(docs)}")
    for k in ("attachment_number", "description", "doc_category", "entry_date_filed",
              "duplicate", "sha256", "page_count"):
        print(f"  {k:<18}: {stats[k]}")
    print(f"staged rows       : {len(out_rows)}")

    for sample in out_rows[:8]:
        print("   ", {k: v for k, v in sample.items() if v not in ("", "false")})

    if not args.apply:
        print("\ndry run - re-run with --apply to write")
        return

    if not out_rows:
        print("nothing to write")
        return

    buf = io.StringIO()
    w = csv.writer(buf)
    cols = ["document_id", "attachment_number", "description", "doc_category",
            "entry_date_filed", "page_count", "byte_count", "sha256", "is_duplicate", "source_note"]
    for r in out_rows:
        w.writerow([r[c] if r[c] != "" else "\\N" for c in cols])

    subprocess.run(["psql", DB, "-v", "ON_ERROR_STOP=1", "-f", PROMOTE_SQL],
                   check=True, capture_output=True, text=True)
    load = subprocess.run(
        ["psql", DB, "-v", "ON_ERROR_STOP=1",
         "-c", "TRUNCATE registry.meta_repair_staging;",
         "-c", f"COPY registry.meta_repair_staging ({','.join(cols)}) FROM STDIN WITH CSV NULL '\\N';"],
        input=buf.getvalue(), capture_output=True, text=True)
    if load.returncode != 0:
        sys.exit(load.stderr.strip())
    promote = subprocess.run(["psql", DB, "-v", "ON_ERROR_STOP=1", "-f", PROMOTE_SQL],
                             capture_output=True, text=True)
    if promote.returncode != 0:
        sys.exit(promote.stderr.strip())
    print(promote.stdout.strip())
    print("promoted")


def s3_fill(docs, out_rows, stats, limit: int) -> None:
    import hashlib
    import boto3
    from pypdf import PdfReader

    session = boto3.session.Session()
    s3 = session.client("s3", endpoint_url=os.environ.get("S3_ENDPOINT") or None,
                        region_name=os.environ.get("AWS_REGION"))
    index = {r["document_id"]: r for r in out_rows}
    todo = [d for d in docs if d["key"] and (not d["sha"] or not d["pages"] or not d["bytes"])]
    if limit:
        todo = todo[:limit]
    for i, d in enumerate(todo, 1):
        try:
            obj = s3.get_object(Bucket=d["bucket"] or "kb-staging", Key=d["key"])
            body = obj["Body"].read()
        except Exception as exc:  # noqa: BLE001
            stats["s3_error"] += 1
            if stats["s3_error"] < 4:
                print(f"  s3 error {d['key']}: {exc}")
            continue
        sha = hashlib.sha256(body).hexdigest()
        try:
            pages = len(PdfReader(io.BytesIO(body)).pages)
        except Exception:  # noqa: BLE001
            pages = None
        row = index.get(d["document_id"])
        if row is None:
            row = {"document_id": d["document_id"], "attachment_number": "", "description": "",
                   "doc_category": "", "entry_date_filed": "", "page_count": "", "byte_count": "",
                   "sha256": "", "is_duplicate": "false", "source_note": "s3"}
            out_rows.append(row)
            index[d["document_id"]] = row
        row["sha256"] = sha
        row["byte_count"] = str(len(body))
        if pages:
            row["page_count"] = str(pages)
            stats["page_count"] += 1
        stats["sha256"] += 1
        if i % 50 == 0:
            print(f"  s3 {i}/{len(todo)}")


if __name__ == "__main__":
    main()
