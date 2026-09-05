#!/usr/bin/env python3
"""Audit and import an authoritative docket-ledger CSV into registry tables.

Dry-run is the default. Use --apply only after reviewing the generated report.

  python3 scripts/backfill/import_docket_ledger.py \
    --csv /path/to/docket.csv --docket 2:24-md-03113
  python3 scripts/backfill/import_docket_ledger.py \
    --csv /path/to/docket.csv --docket 2:24-md-03113 --apply
"""
from __future__ import annotations

import argparse
import csv
import html
import os
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime

DB = os.environ.get("CORPUS_DB_URL")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROMOTE_SQL = os.path.join(ROOT, "supabase", "corpus", "docket-ledger-promote.sql")
REPORT_DIR = "/mnt/documents"
REQUIRED = {"document_id", "docket_sheet_number", "attachment_number", "date", "title"}
TEXT_EVENT_RE = re.compile(r"-(\d{5})-t(\d{3})$", re.I)
TAG_RE = re.compile(r"<[^>]+>")


@dataclass(frozen=True)
class LedgerRow:
    source_document_id: str
    entry_number: int | None
    entry_key: str
    attachment_number: int | None
    date_filed: str
    title: str
    is_unnumbered: bool


def clean_title(raw: str) -> str:
    text = re.sub(r"<hr\s*/?>", " — ", raw, flags=re.I)
    text = TAG_RE.sub(" ", text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def parse_csv(path: str) -> list[LedgerRow]:
    with open(path, encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        missing = REQUIRED - set(reader.fieldnames or [])
        if missing:
            sys.exit(f"Missing required columns: {', '.join(sorted(missing))}")
        raw_rows = list(reader)

    ids = [r["document_id"].strip() for r in raw_rows]
    dup_ids = [v for v, n in Counter(ids).items() if n > 1]
    if dup_ids:
        sys.exit(f"Duplicate document_id values: {', '.join(dup_ids[:10])}")

    rows: list[LedgerRow] = []
    slots: Counter[tuple[int, int]] = Counter()
    for line, raw in enumerate(raw_rows, 2):
        source_id = raw["document_id"].strip()
        title = clean_title(raw["title"])
        if not source_id or not title:
            sys.exit(f"Row {line}: document_id and title are required")
        try:
            date_filed = datetime.strptime(raw["date"].strip(), "%m/%d/%Y").date().isoformat()
        except ValueError as exc:
            sys.exit(f"Row {line}: invalid MM/DD/YYYY date {raw['date']!r}: {exc}")

        entry_raw = raw["docket_sheet_number"].strip()
        att_raw = raw["attachment_number"].strip()
        if entry_raw:
            if not entry_raw.isdigit() or (att_raw and not att_raw.isdigit()):
                sys.exit(f"Row {line}: invalid entry or attachment number")
            entry = int(entry_raw)
            attachment = int(att_raw) if att_raw else None
            slots[(entry, attachment or 0)] += 1
            entry_key = str(entry)
            unnumbered = False
        else:
            if att_raw:
                sys.exit(f"Row {line}: unnumbered event cannot have an attachment number")
            match = TEXT_EVENT_RE.search(source_id)
            if not match:
                sys.exit(f"Row {line}: cannot derive stable key for unnumbered event {source_id}")
            entry = None
            attachment = None
            entry_key = f"T{int(match.group(1))}.{int(match.group(2)):03d}"
            unnumbered = True
        rows.append(LedgerRow(source_id, entry, entry_key, attachment, date_filed, title, unnumbered))

    duplicate_slots = [slot for slot, count in slots.items() if count > 1]
    if duplicate_slots:
        sys.exit(f"Duplicate numbered entry/attachment slots: {duplicate_slots[:10]}")
    return rows


def psql_rows(sql: str) -> list[list[str]]:
    run = subprocess.run(
        ["psql", DB, "-v", "ON_ERROR_STOP=1", "-At", "-F", "\x01", "-c", sql],
        capture_output=True,
        text=True,
    )
    if run.returncode:
        sys.exit(run.stderr.strip())
    return [line.split("\x01") for line in run.stdout.splitlines() if line]


def sql_quote(value: str) -> str:
    return value.replace("'", "''")


def resolve_matter(docket: str) -> tuple[str, str]:
    safe = sql_quote(docket)
    rows = psql_rows(
        f"SELECT matter_id::text, case_name FROM registry.matters "
        f"WHERE docket_number = '{safe}' ORDER BY matter_id LIMIT 2"
    )
    if len(rows) != 1:
        sys.exit(f"Expected exactly one matter for docket {docket}; found {len(rows)}")
    return rows[0][0], rows[0][1]


def audit(rows: list[LedgerRow], matter_id: str) -> dict[str, int]:
    existing_docs = psql_rows(
        "SELECT entry_number::text, coalesce(attachment_number, 0)::text, "
        "coalesce(entry_date_filed::text, ''), coalesce(description, ''), "
        "CASE WHEN nullif(s3_key, '') IS NOT NULL THEN '1' ELSE '0' END "
        f"FROM registry.documents WHERE matter_id = '{matter_id}'"
    )
    existing_entries = psql_rows(
        "SELECT entry_number, coalesce(date_filed::text, ''), coalesce(description, '') "
        f"FROM registry.docket_entries WHERE matter_id = '{matter_id}'"
    )
    doc_slots: dict[tuple[int, int], list[list[str]]] = {}
    for row in existing_docs:
        if row[0].isdigit():
            doc_slots.setdefault((int(row[0]), int(row[1])), []).append(row)
    entry_keys = {row[0]: row for row in existing_entries}

    counts = Counter()
    for row in rows:
        if row.is_unnumbered:
            counts["unnumbered_insert"] += row.entry_key not in entry_keys
            continue
        slot = (row.entry_number or 0, row.attachment_number or 0)
        docs = doc_slots.get(slot, [])
        if not docs:
            counts["document_insert"] += 1
        else:
            if any(d[2] != row.date_filed for d in docs):
                counts["document_date_update"] += 1
            if any(d[3].strip() != row.title for d in docs):
                counts["document_title_update"] += 1
            if len(docs) > 1:
                counts["duplicate_document_rows"] += len(docs) - 1
        key = str(row.entry_number)
        entry = entry_keys.get(key)
        if entry is None:
            counts["docket_entry_insert"] += 1
        elif row.attachment_number is None:
            if entry[1] != row.date_filed:
                counts["docket_date_update"] += 1
            if entry[2].strip() != row.title:
                counts["docket_title_update"] += 1
    return dict(counts)


def write_report(rows: list[LedgerRow], docket: str) -> str:
    os.makedirs(REPORT_DIR, exist_ok=True)
    label = re.sub(r"[^a-zA-Z0-9]+", "-", docket).strip("-").lower()
    path = os.path.join(REPORT_DIR, f"docket-ledger-{label}-normalized.csv")
    with open(path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["source_document_id", "entry_number", "entry_key", "attachment_number", "date_filed", "title", "is_unnumbered"])
        for row in rows:
            writer.writerow([row.source_document_id, row.entry_number or "", row.entry_key,
                             row.attachment_number if row.attachment_number is not None else "",
                             row.date_filed, row.title, str(row.is_unnumbered).lower()])
    return path


def apply(rows: list[LedgerRow], matter_id: str) -> None:
    values = []
    for row in rows:
        vals = [
            matter_id,
            row.source_document_id,
            str(row.entry_number) if row.entry_number is not None else None,
            row.entry_key,
            str(row.attachment_number) if row.attachment_number is not None else None,
            row.date_filed,
            row.title,
            "true" if row.is_unnumbered else "false",
        ]
        values.append("(" + ",".join("NULL" if v is None else f"'{sql_quote(v)}'" for v in vals) + ")")
    setup = f"""
CREATE TABLE IF NOT EXISTS registry.docket_ledger_staging (
  matter_id uuid NOT NULL,
  source_document_id text NOT NULL,
  entry_number integer,
  entry_key text NOT NULL,
  attachment_number integer,
  date_filed date NOT NULL,
  title text NOT NULL,
  is_unnumbered boolean NOT NULL DEFAULT false,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (matter_id, source_document_id)
);
DELETE FROM registry.docket_ledger_staging WHERE matter_id = '{matter_id}';
INSERT INTO registry.docket_ledger_staging
  (matter_id,source_document_id,entry_number,entry_key,attachment_number,date_filed,title,is_unnumbered)
VALUES {','.join(values)};
"""
    subprocess.run(["psql", DB, "-v", "ON_ERROR_STOP=1"], input=setup, text=True, check=True)
    subprocess.run(["psql", DB, "-v", "ON_ERROR_STOP=1", "-f", PROMOTE_SQL], check=True)


def main() -> None:
    if not DB:
        sys.exit("CORPUS_DB_URL is not set")
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True)
    parser.add_argument("--docket", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    rows = parse_csv(args.csv)
    matter_id, case_name = resolve_matter(args.docket)
    counts = audit(rows, matter_id)
    report = write_report(rows, args.docket)
    print(f"Matter: {case_name} ({matter_id})")
    print(f"Ledger rows: {len(rows)} ({sum(not r.is_unnumbered for r in rows)} numbered, {sum(r.is_unnumbered for r in rows)} unnumbered)")
    for key in sorted(counts):
        print(f"  {key:<28} {counts[key]}")
    print(f"Normalized report: {report}")
    if not args.apply:
        print("Dry run — no database changes. Re-run with --apply to promote.")
        return
    apply(rows, matter_id)
    print("Ledger promoted into registry.docket_entries and registry.documents")


if __name__ == "__main__":
    main()