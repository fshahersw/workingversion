#!/usr/bin/env python3
"""Local pre-flight validator for ingest contract v1 bundles.

Mirrors the server rules in src/lib/ingest/schema.ts exactly, plus the
commit-time file checks (sha256, PDF parseability, real page count).

    python3 scripts/pipeline/validate_bundle.py <bundle_dir> [--strict-files]

Exit 0 = clean, 1 = rejects, 2 = bundle unusable.
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path

CONTRACT_VERSION = "1.0"
SOURCES = {"main", "jpml", "state", "appellate"}
AVAILABILITY = {"free_pdf", "locally_supplied", "pacer_link", "text_only", "sealed"}
REQUIRES_FILE = {"free_pdf", "locally_supplied"}
DOC_TYPES = {
    "mdl", "case_management", "summary_judgment", "class_cert", "expert", "appeal",
    "opinion", "order", "motion", "brief", "pleading", "transcript", "exhibit",
    "notice", "stipulation", "minute", "correspondence", "sealing", "settlement",
    "discovery", "bellwether", "other",
}
SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

DOCKET_COLUMNS = {
    "record_id", "docket_source", "entry_number", "entry_label", "attachment_number",
    "filed_date", "description", "document_title", "document_type", "doc_type",
    "availability", "file_name", "page_count", "size_bytes", "sha256", "sha1", "md5",
    "is_sealed", "recap_pdf_url", "internet_archive_url", "courtlistener_document_url",
    "pacer_pdf_url", "pacer_price_usd",
}
PARTY_COLUMNS = {
    "party_role", "party_name", "representation", "attorney_name", "attorney_designations",
    "attorney_phone", "attorney_fax", "attorney_email", "firm_name", "firm_address",
    "attorney_full_details",
}


@dataclass
class Reject:
    code: str
    message: str
    record_id: str = ""
    slot: str = ""


rejects: list[Reject] = []


def rej(code: str, message: str, record_id: str = "", slot: str = "") -> None:
    rejects.append(Reject(code, message, record_id, slot))


def is_int(v: str, lo: int | None = None, hi: int | None = None) -> bool:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return False
    if lo is not None and n < lo:
        return False
    if hi is not None and n > hi:
        return False
    return True


def valid_date(v: str) -> bool:
    if not DATE_RE.match(v or ""):
        return False
    y, m, d = (int(x) for x in v.split("-"))
    try:
        date(y, m, d)
    except ValueError:
        return False
    return True


def load_manifest(path: Path) -> dict:
    m = json.loads(path.read_text())
    if m.get("contract_version") != CONTRACT_VERSION:
        rej("invalid_manifest", f"contract_version must be {CONTRACT_VERSION}")
    matter = m.get("matter") or {}
    if not SLUG_RE.match(matter.get("slug", "")):
        rej("invalid_manifest", "matter.slug must be kebab-case")
    for f in ("short_name", "caption", "docket_number", "court"):
        if not matter.get(f):
            rej("invalid_manifest", f"matter.{f} is required")
    if matter.get("date_filed") and not valid_date(matter["date_filed"]):
        rej("invalid_manifest", "matter.date_filed must be YYYY-MM-DD")
    if not isinstance(m.get("idempotency_key"), str) or len(m.get("idempotency_key", "")) < 8:
        rej("invalid_manifest", "idempotency_key must be a string of >= 8 chars")
    dockets = m.get("dockets") or []
    if not dockets:
        rej("invalid_manifest", "dockets must declare at least one docket")
    seen = set()
    for d in dockets:
        if d.get("source") not in SOURCES:
            rej("invalid_manifest", f"unknown docket source {d.get('source')!r}")
        if d.get("source") in seen:
            rej("invalid_manifest", f"duplicate docket source {d.get('source')}")
        seen.add(d.get("source"))
        if not d.get("docket_number"):
            rej("invalid_manifest", f"docket {d.get('source')} needs docket_number")
    batch = m.get("batch") or {}
    if batch.get("mode") not in {"full", "incremental"}:
        rej("invalid_manifest", "batch.mode must be full or incremental")
    for key in ("document_slots", "pdf_files", "total_pages", "total_bytes"):
        if not isinstance((m.get("totals") or {}).get(key), int):
            rej("invalid_manifest", f"totals.{key} must be an integer")
    return m


def read_csv(path: Path, allowed: set[str], label: str) -> list[dict]:
    with path.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames is None:
            rej(f"{label}_unparseable", f"{path.name} has no header row")
            return []
        unknown = set(reader.fieldnames) - allowed
        if unknown:
            rej(f"{label}_unparseable", f"{path.name} has unknown columns: {sorted(unknown)}")
        if len(set(reader.fieldnames)) != len(reader.fieldnames):
            rej(f"{label}_unparseable", f"{path.name} has duplicate columns")
        rows = []
        for i, raw in enumerate(reader, start=2):
            if None in raw or any(v is None for v in raw.values()):
                rej(f"{label}_unparseable", f"{path.name} row {i} has the wrong field count")
                continue
            rows.append({k: (v or "").strip() for k, v in raw.items()} | {"_line": str(i)})
        return rows


def validate_docket_row(r: dict) -> bool:
    rid = r.get("record_id") or f"row_{r['_line']}"
    ok = True

    def bad(field: str, msg: str) -> None:
        nonlocal ok
        ok = False
        rej("invalid_field", f"{field}: {msg}", rid)

    if r.get("docket_source") not in SOURCES:
        bad("docket_source", f"must be one of {sorted(SOURCES)}")
    if not is_int(r.get("entry_number", ""), 0):
        bad("entry_number", "must be an integer >= 0")
    if not r.get("entry_label"):
        bad("entry_label", "is required")
    if not is_int(r.get("attachment_number", ""), 0, 999):
        bad("attachment_number", "must be an integer 0-999")
    if not valid_date(r.get("filed_date", "")):
        bad("filed_date", "must be a real ISO date (YYYY-MM-DD)")
    av = r.get("availability", "")
    if av not in AVAILABILITY:
        bad("availability", f"must be one of {sorted(AVAILABILITY)}")
    if r.get("doc_type") and r["doc_type"] not in DOC_TYPES:
        bad("doc_type", f"unknown value {r['doc_type']!r}")
    if r.get("is_sealed") and r["is_sealed"].lower() not in {"true", "false"}:
        bad("is_sealed", "must be true or false")
    for u in ("recap_pdf_url", "internet_archive_url", "courtlistener_document_url", "pacer_pdf_url"):
        if r.get(u) and not r[u].startswith("https://"):
            bad(u, "must be an https URL")
    if r.get("sha256") and not SHA_RE.match(r["sha256"]):
        bad("sha256", "must be 64 lowercase hex chars")

    if av in REQUIRES_FILE:
        for f in ("file_name", "sha256", "size_bytes", "page_count"):
            if not r.get(f):
                bad(f, f"is required when availability={av}")
        if r.get("size_bytes") and not is_int(r["size_bytes"], 1):
            bad("size_bytes", "must be an integer >= 1")
        if r.get("page_count") and not is_int(r["page_count"], 1):
            bad("page_count", "must be an integer >= 1")
    elif r.get("file_name"):
        bad("file_name", f"must be empty when availability={av}")

    if r.get("attachment_number") == "0" and not r.get("description"):
        bad("description", "main document (attachment 0) needs the docket text")
    return ok


def pdf_page_count(path: Path) -> int | None:
    data = path.read_bytes()
    if not data.startswith(b"%PDF-"):
        return None
    if b"/Encrypt" in data:
        return -1
    counts = [int(m.group(1)) for m in re.finditer(rb"/Type\s*/Pages[^>]*?/Count\s+(\d+)", data, re.S)]
    if counts:
        return max(counts)
    pages = len(re.findall(rb"/Type\s*/Page[^s]", data))
    return pages or None


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    bundle = Path(sys.argv[1])
    strict_files = "--strict-files" in sys.argv
    if not bundle.is_dir():
        print(f"not a directory: {bundle}")
        return 2

    manifest_path = bundle / "manifest.json"
    docket_path = bundle / "docket.csv"
    if not manifest_path.exists() or not docket_path.exists():
        print("bundle must contain manifest.json and docket.csv")
        return 2

    m = load_manifest(manifest_path)
    rows = read_csv(docket_path, DOCKET_COLUMNS, "docket")
    parties_path = bundle / "parties.csv"
    party_rows = read_csv(parties_path, PARTY_COLUMNS, "parties") if parties_path.exists() else []
    for p in party_rows:
        if not p.get("party_name"):
            rej("invalid_party", "party_name is required", f"parties_row_{p['_line']}")

    valid_rows = [r for r in rows if validate_docket_row(r)]

    sources = {d.get("source") for d in (m.get("dockets") or [])}
    slots: dict[str, str] = {}
    files: dict[str, str] = {}
    entry_meta: dict[str, tuple[str, str]] = {}
    pdfs = pages = size_total = 0

    for r in valid_rows:
        rid = r.get("record_id") or f"row_{r['_line']}"
        slot = f"{r['docket_source']}:{int(r['entry_number'])}:{int(r['attachment_number'])}"
        if r["docket_source"] not in sources:
            rej("unknown_docket_source", f"{r['docket_source']} is not declared in manifest.dockets", rid, slot)
        if slot in slots:
            rej("duplicate_slot", f"slot already declared by {slots[slot]}", rid, slot)
        slots[slot] = rid

        ek = f"{r['docket_source']}:{int(r['entry_number'])}"
        # attachments carry their own printed label, only the date must agree
        if ek not in entry_meta:
            entry_meta[ek] = (r["filed_date"], r["entry_label"])
        elif entry_meta[ek][0] != r["filed_date"]:
            rej("entry_conflict", f"rows disagree on filed_date for entry {ek}", rid, slot)

        if r.get("file_name"):
            name = r["file_name"]
            if name in files:
                rej("duplicate_file_name", f"file_name {name} declared twice", rid, slot)
            files[name] = rid
            pdfs += 1
            pages += int(r["page_count"])
            size_total += int(r["size_bytes"])

            path = bundle / name
            if not path.exists():
                rej("file_missing", f"declared file {name} is not in the bundle", rid, slot)
                continue
            actual_size = path.stat().st_size
            if actual_size != int(r["size_bytes"]):
                rej("size_mismatch", f"{name} is {actual_size} bytes, declared {r['size_bytes']}", rid, slot)
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != r["sha256"]:
                rej("hash_mismatch", f"{name} sha256 is {digest}, declared {r['sha256']}", rid, slot)
            pc = pdf_page_count(path)
            if pc is None:
                rej("bad_pdf", f"{name} is not a readable PDF", rid, slot)
            elif pc == -1:
                rej("bad_pdf", f"{name} is encrypted", rid, slot)
            elif strict_files and pc != int(r["page_count"]):
                rej("page_mismatch", f"{name} has {pc} pages, declared {r['page_count']}", rid, slot)

    for path in bundle.glob("*.pdf"):
        if path.name not in files:
            rej("file_undeclared", f"{path.name} is in the bundle but not declared in docket.csv")

    if (m.get("batch") or {}).get("mode") == "full":
        for r in valid_rows:
            if int(r["attachment_number"]) > 0:
                main_slot = f"{r['docket_source']}:{int(r['entry_number'])}:0"
                if main_slot not in slots:
                    rej("orphan_attachment", f"no main document for entry {r['docket_source']}:{r['entry_number']}",
                        r.get("record_id", ""), f"{main_slot}")

    declared_files = {f.get("file_name") for f in (m.get("files") or [])}
    for name in files:
        if name not in declared_files:
            rej("file_undeclared", f"{name} is used in docket.csv but missing from manifest.files")

    t = m.get("totals") or {}
    if t.get("document_slots") != len(rows):
        rej("totals_mismatch", f"manifest declares {t.get('document_slots')} slots, docket.csv has {len(rows)}")
    if t.get("pdf_files") != pdfs:
        rej("totals_mismatch", f"manifest declares {t.get('pdf_files')} PDFs, rows declare {pdfs}")
    if t.get("total_pages") != pages:
        rej("totals_mismatch", f"manifest declares {t.get('total_pages')} pages, rows sum to {pages}")
    if t.get("total_bytes") != size_total:
        rej("totals_mismatch", f"manifest declares {t.get('total_bytes')} bytes, rows sum to {size_total}")

    print(f"bundle:        {bundle}")
    print(f"docket rows:   {len(rows)}  (valid {len(valid_rows)})")
    print(f"party rows:    {len(party_rows)}")
    print(f"declared PDFs: {pdfs}   pages {pages}   bytes {size_total}")
    if not rejects:
        print("\nRESULT: clean — ready to submit")
        return 0
    print(f"\nRESULT: {len(rejects)} reject(s)\n")
    for r in rejects[:200]:
        loc = " ".join(x for x in (r.record_id, r.slot) if x)
        print(f"  [{r.code}] {loc}{': ' if loc else ''}{r.message}")
    if len(rejects) > 200:
        print(f"  … {len(rejects) - 200} more")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
