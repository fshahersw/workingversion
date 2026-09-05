#!/usr/bin/env python3
"""Deduplicate document holdings for a matter by (title, file size).

Groups registry.documents by (matter_id, lower(trim(description)), byte_count)
and, for every group with more than one row, keeps a single canonical row and
deletes the redundant copies. These copies are RECAP re-download artifacts:
the same docket slot (document_number / attachment_number / entry_number)
fetched repeatedly and stored under suffixed S3 keys
(gov.uscourts.njd.550383.2.2.pdf vs ..._1.pdf, ..._2.pdf, ...).

Canonical pick per group:
  1. unsuffixed base S3 key (....2.2.pdf) preferred over _N suffixed copies
  2. smallest numeric suffix otherwise
  3. sha256 present preferred
  4. is_available preferred
  5. lowest document_id as a stable final tie-break

Safety gates (a group is skipped and reported, never partially deleted, when):
  * rows disagree on (document_number, attachment_number, entry_number)
  * a delete candidate is referenced by registry.opinions or
    registry.meta_repair_staging

Dry run by default; nothing is written without --apply.

    python3 scripts/backfill/dedup_documents.py --matter-id 447c8a03-748a-5de9-8e2d-e7018b0e63d3
    python3 scripts/backfill/dedup_documents.py --matter-id 447c8a03-... --apply --s3
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import subprocess
import sys
from collections import defaultdict

DB = os.environ.get("CORPUS_DB_URL")

KEY_RE = re.compile(r"\.(\d+)\.(\d+)(?:_(\d+))?\.pdf$", re.I)

FIELDS = (
    "document_id", "docket_entry_id", "description", "byte_count", "sha256",
    "s3_bucket", "s3_key", "document_number", "attachment_number",
    "entry_number", "page_count", "entry_date_filed", "is_available",
)


def psql_rows(sql: str) -> list[list[str]]:
    out = subprocess.run(
        ["psql", DB, "-v", "ON_ERROR_STOP=1", "-At", "-F", "\x01", "-c", sql],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit(f"psql failed: {out.stderr.strip()}")
    return [r.split("\x01") for r in out.stdout.splitlines()]


def key_suffix(s3_key: str | None) -> int:
    """0 for the unsuffixed base key, N for a _N suffixed copy; big when unparsed."""
    if not s3_key:
        return 1_000_000
    m = KEY_RE.search(s3_key)
    if not m:
        return 999_999
    return int(m.group(3)) if m.group(3) else 0


def pick_canonical(rows: list[dict]) -> dict:
    return min(
        rows,
        key=lambda r: (
            key_suffix(r["s3_key"]),
            r["sha256"] in ("", None),
            r["is_available"] != "t",
            r["document_id"],
        ),
    )


def referenced_ids(matter_id: str) -> set[str]:
    refs = set()
    for table in ("opinions", "meta_repair_staging"):
        for (rid,) in psql_rows(
            f"SELECT DISTINCT r.document_id::text FROM registry.{table} r "
            f"JOIN registry.documents d ON d.document_id = r.document_id "
            f"WHERE d.matter_id = '{matter_id}'"
        ):
            if rid:
                refs.add(rid)
    return refs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--matter-id", required=True)
    ap.add_argument("--apply", action="store_true", help="delete excess rows")
    ap.add_argument("--s3", action="store_true", help="also delete redundant S3 objects (only with --apply)")
    ap.add_argument("--report", default="/mnt/documents/apple-dedup-report.csv")
    args = ap.parse_args()

    if not DB:
        sys.exit("CORPUS_DB_URL is not set")
    if args.s3 and not args.apply:
        sys.exit("--s3 only makes sense with --apply")

    mid = args.matter_id

    groups = psql_rows(
        "SELECT lower(btrim(description)), byte_count, count(*) "
        f"FROM registry.documents WHERE matter_id = '{mid}' "
        "AND description IS NOT NULL AND byte_count IS NOT NULL "
        "GROUP BY 1, 2 HAVING count(*) > 1 ORDER BY 3 DESC"
    )
    print(f"duplicate groups: {len(groups)}")
    if not groups:
        return

    refs = referenced_ids(mid)

    decisions: list[dict] = []   # report rows
    delete_ids: list[str] = []
    delete_keys: list[tuple[str, str]] = []
    skipped = 0

    for norm_title, byte_count, n in groups:
        escaped = norm_title.replace("'", "''")
        rows = [
            dict(zip(FIELDS, r))
            for r in psql_rows(
                f"SELECT {', '.join(FIELDS)} FROM registry.documents "
                f"WHERE matter_id = '{mid}' AND byte_count = {byte_count} "
                f"AND lower(btrim(description)) = '{escaped}'"
            )
        ]

        slots = {(r["document_number"], r["attachment_number"], r["entry_number"]) for r in rows}
        canon = pick_canonical(rows)
        victims = [r for r in rows if r["document_id"] != canon["document_id"]]
        hit_refs = [r["document_id"] for r in victims if r["document_id"] in refs]

        gate = ""
        if len(slots) > 1:
            gate = f"SKIP: mixed docket slots {sorted(slots)}"
        elif hit_refs:
            gate = f"SKIP: {len(hit_refs)} delete candidate(s) referenced elsewhere"

        label = (rows[0]["description"] or "")[:90]
        print(f"\n[{n}x] {label}  ({int(byte_count):,} bytes)")
        print(f"  KEEP   {canon['document_id']}  {canon['s3_key']}")
        for v in victims:
            mark = "DELETE" if not gate else "skip"
            print(f"  {mark:6} {v['document_id']}  {v['s3_key']}")

        if gate:
            print(f"  {gate}")
            skipped += 1
            for r in rows:
                decisions.append({"group_title": label, "byte_count": byte_count,
                                  "action": "skipped", **{k: r[k] for k in ("document_id", "s3_key", "sha256")}})
            continue

        delete_ids.extend(v["document_id"] for v in victims)
        delete_keys.extend((v["s3_bucket"], v["s3_key"]) for v in victims if v["s3_bucket"] and v["s3_key"])
        decisions.append({"group_title": label, "byte_count": byte_count, "action": "keep",
                          "document_id": canon["document_id"], "s3_key": canon["s3_key"], "sha256": canon["sha256"]})
        for v in victims:
            decisions.append({"group_title": label, "byte_count": byte_count, "action": "delete",
                              "document_id": v["document_id"], "s3_key": v["s3_key"], "sha256": v["sha256"]})

    print(f"\n=== summary: {len(groups)} groups, {skipped} skipped, "
          f"{len(delete_ids)} rows to delete, {len(delete_keys)} s3 objects ===")

    if not args.apply:
        print("dry run — re-run with --apply to delete")
    elif delete_ids:
        id_list = ", ".join(f"'{i}'" for i in delete_ids)
        txn = (
            "BEGIN;\n"
            f"DELETE FROM registry.documents WHERE document_id IN ({id_list});\n"
            "COMMIT;\n"
        )
        out = subprocess.run(["psql", DB, "-v", "ON_ERROR_STOP=1", "-c", txn],
                             capture_output=True, text=True)
        if out.returncode != 0:
            sys.exit(f"delete failed (rolled back): {out.stderr.strip()}")
        print(out.stdout.strip())
        print(f"deleted {len(delete_ids)} rows")

        if args.s3 and delete_keys:
            import boto3
            from botocore.config import Config
            client = boto3.client(
                "s3",
                endpoint_url=os.environ.get("S3_ENDPOINT") or None,
                region_name=os.environ.get("AWS_REGION") or None,
                config=Config(s3={"addressing_style": "path"},
                              signature_version="s3v4"),
            )
            by_bucket: dict[str, list[str]] = defaultdict(list)
            for bucket, key in delete_keys:
                by_bucket[bucket].append(key)
            for bucket, keys in by_bucket.items():
                failed = 0
                for k in keys:  # endpoint does not support bulk DeleteObjects
                    try:
                        client.delete_object(Bucket=bucket, Key=k)
                    except Exception as e:
                        failed += 1
                        print(f"  s3 error: {k}: {type(e).__name__} {str(e)[:120]}")
                print(f"s3: deleted {len(keys) - failed}/{len(keys)} objects in {bucket}")

    os.makedirs(os.path.dirname(args.report), exist_ok=True)
    with open(args.report, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["group_title", "byte_count", "action", "document_id", "s3_key", "sha256"])
        w.writeheader()
        w.writerows(decisions)
    print(f"report: {args.report}")


if __name__ == "__main__":
    main()
