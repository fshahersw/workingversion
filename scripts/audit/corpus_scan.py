#!/usr/bin/env python3
"""Corpus metadata health scan.

Reports, per matter, how complete and well-labeled the document metadata is.
Read-only: it never writes corpus data (it only (re)creates the health views).

Usage:
    python3 scripts/audit/corpus_scan.py                          # whole corpus, top offenders
    python3 scripts/audit/corpus_scan.py --docket 2:24-md-03113   # one matter + defect detail
    python3 scripts/audit/corpus_scan.py --limit 40 --csv
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import subprocess
import sys

DB = os.environ.get("CORPUS_DB_URL")
REPORT_DIR = "/mnt/documents"

# (rollup column in corpus.v_matter_health, per-document flag f_<name>, label)
FLAGS = [
    ("unfetchable", "no PDF and no fetch URL"),
    ("no_title", "blank title"),
    ("generic_title", "generic/stub title"),
    ("title_equals_entry", "attachment copies parent text"),
    ("orphan_entry", "not linked to a docket entry"),
    ("no_doc_type", "missing doc type"),
    ("no_page_count", "stored PDF, no page count"),
    ("no_byte_count", "stored PDF, no byte count"),
    ("no_sha256", "stored PDF, no sha256"),
    ("hash_mismatch", "sha256 != expected"),
    ("duplicate_s3_key", "duplicate S3 key"),
    ("not_extracted", "stored PDF, text not extracted"),
    ("no_chunks", "extracted but no chunks"),
    ("unembedded_docs", "chunks missing embeddings"),
    ("no_display_order", "missing display ordering"),
]

# per-document flag names differ for the two chunk-level rollups
DOC_FLAGS = [c if c != "unembedded_docs" else "unembedded" for c, _ in FLAGS]


def psql(sql: str, tuples: bool = False) -> str:
    cmd = ["psql", DB, "-v", "ON_ERROR_STOP=1"]
    if tuples:
        cmd += ["-At", "-F", "\t"]
    cmd += ["-c", sql]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(out.stderr.strip() or "psql failed")
    return out.stdout


def ensure_views() -> None:
    here = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ddl = os.path.join(here, "supabase", "corpus", "document-health.sql")
    r = subprocess.run(["psql", DB, "-v", "ON_ERROR_STOP=1", "-f", ddl],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(r.stderr.strip())


def main() -> None:
    if not DB:
        sys.exit("CORPUS_DB_URL is not set")
    ap = argparse.ArgumentParser()
    ap.add_argument("--docket", help="scan a single matter by docket number (substring match)")
    ap.add_argument("--limit", type=int, default=25)
    ap.add_argument("--csv", action="store_true", help="write the full per-matter report to /mnt/documents")
    ap.add_argument("--skip-ddl", action="store_true")
    args = ap.parse_args()

    if not args.skip_ddl:
        ensure_views()

    where = ""
    if args.docket:
        safe = args.docket.replace("'", "''")
        where = f"WHERE docket_number ILIKE '%{safe}%'"

    print(psql(f"""
        SELECT docket_number, left(matter_title, 40) AS matter, entries, documents,
               documents_with_pdf AS with_pdf, pdf_coverage_pct AS pdf_pct,
               extract_coverage_pct AS txt_pct, embed_coverage_pct AS emb_pct,
               pacer_gap, main_entry_gap AS gap, health_score AS score
        FROM corpus.v_matter_health {where}
        ORDER BY documents DESC LIMIT {args.limit};
    """))

    print(psql(f"""
        SELECT docket_number,
               {", ".join(c for c, _ in FLAGS)}
        FROM corpus.v_matter_health {where}
        ORDER BY documents DESC LIMIT {args.limit};
    """))

    if args.docket:
        print("Worst-offender documents:")
        flag_sum = " + ".join(f"(f_{c})::int" for c in DOC_FLAGS)
        print(psql(f"""
            SELECT display_label_pretty AS entry, attachment_number AS att,
                   left(coalesce(title, '(blank)'), 44) AS title,
                   has_pdf AS pdf, availability_status AS avail,
                   {flag_sum} AS defects
            FROM corpus.v_document_health
            WHERE docket_number ILIKE '%{args.docket.replace("'", "''")}%'
            ORDER BY defects DESC, display_number NULLS LAST LIMIT 25;
        """))

    if args.csv:
        os.makedirs(REPORT_DIR, exist_ok=True)
        stamp = dt.date.today().isoformat()
        matter_csv = f"{REPORT_DIR}/corpus-health-{stamp}.csv"
        subprocess.run(["psql", DB, "-c",
                        f"COPY (SELECT * FROM corpus.v_matter_health {where} "
                        f"ORDER BY health_score NULLS FIRST) TO STDOUT WITH CSV HEADER"],
                       stdout=open(matter_csv, "w"), check=True)
        print(f"wrote {matter_csv}")
        if args.docket:
            doc_csv = f"{REPORT_DIR}/corpus-health-documents-{stamp}.csv"
            subprocess.run(["psql", DB, "-c",
                            f"COPY (SELECT * FROM corpus.v_document_health {where}) "
                            f"TO STDOUT WITH CSV HEADER"],
                           stdout=open(doc_csv, "w"), check=True)
            print(f"wrote {doc_csv}")


if __name__ == "__main__":
    main()
