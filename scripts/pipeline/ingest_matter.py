#!/usr/bin/env python3
"""
Corpus v2 per-matter ingest pipeline — fresh files only.

Populates one matter from user-provided export files. Nothing is read from
the old registry database.

    python3 scripts/pipeline/ingest_matter.py apple-smartphone-md-3113
    python3 scripts/pipeline/ingest_matter.py apple-smartphone-md-3113 \
        --stages match,store,write --dry-run

Stages: ledger → parties → match → store → write → extract → embed → verify.

Input files (auto-discovered from scripts/pipeline/inputs/<slug>/, or passed
explicitly via --ledger / --parties / --metadata):

  *FULL_DOCKET*.csv   canonical 33-column docket export. Every row is a
                      document slot (attachment_number 0 = main doc). Carries
                      ISO dates, full docket text, document_label/type,
                      standardized file_name, availability status, exact page
                      counts, sha256/sha1/md5, and RECAP/IA/CL/PACER URLs.
  *PARTIES*.csv       party ↔ attorney relationships with designations
                      (LEAD ATTORNEY / ATTORNEY TO BE NOTICED) and firm
                      embedded in the address block.
  *METADATA*.json     case bibliographic record (judges, cause, NOS, CL and
                      PACER ids, inventory totals).

A legacy ledger format (docket_sheet_number/date/title columns) is still
accepted for --ledger.

PDF sources (priority order): --local-dir folder, then the matter's
`incoming/` prefix in the `matters` bucket (files uploaded through the app).
When the ledger supplies an expected sha256 for a slot, the stored file is
verified against it; mismatches are quarantined and never reach pdf/.

Reads credentials from the project .env: CORPUS_DB_URL, AWS_ACCESS_KEY_ID /
AWS_SECRET_ACCESS_KEY / AWS_REGION / S3_ENDPOINT, and VOYAGE_API_KEY for the
embed stage (voyage-law-2, 1024 dims).
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

import boto3
import psycopg
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[2]
TARGET_BUCKET = "matters"

# ---------------------------------------------------------------------------
# env / clients
# ---------------------------------------------------------------------------

_env = ROOT / ".env"
if _env.exists():
    for _line in _env.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            k, v = _line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def need(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        sys.exit(f"missing env: {name}")
    return v


DB_URL = need("CORPUS_DB_URL")
S3 = boto3.client(
    "s3",
    endpoint_url=need("S3_ENDPOINT"),
    aws_access_key_id=need("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=need("AWS_SECRET_ACCESS_KEY"),
    region_name=os.environ.get("AWS_REGION", "us-east-1"),
    config=BotoConfig(s3={"addressing_style": "path"}),
)


def db():
    return psycopg.connect(DB_URL, row_factory=dict_row, autocommit=False)


def load_cfg(slug: str) -> dict:
    cfgs = json.loads((ROOT / "scripts/pipeline/matters.json").read_text())
    if slug not in cfgs:
        sys.exit(f"unknown slug {slug!r}; known: {', '.join(cfgs)}")
    cfg = dict(cfgs[slug])
    cfg["slug"] = slug
    return cfg


def matter_pk(conn, cfg) -> str:
    if cfg.get("matter_id"):
        return cfg["matter_id"]
    row = conn.cursor().execute(
        "SELECT matter_id FROM corpus.matters WHERE slug=%s", (cfg["slug"],)
    ).fetchone()
    if not row:
        sys.exit(f"matter shell {cfg['slug']!r} not found in corpus.matters")
    cfg["matter_id"] = str(row["matter_id"])
    return cfg["matter_id"]


def default_inputs(slug: str) -> dict:
    """Auto-discover the export files under scripts/pipeline/inputs/<slug>/."""
    d = ROOT / "scripts/pipeline/inputs" / slug
    out: dict[str, str] = {}
    if d.exists():
        for p in sorted(d.iterdir()):
            u = p.name.upper()
            if "FULL_DOCKET" in u and p.suffix == ".csv":
                out["ledger"] = str(p)
            elif "PARTIES" in u and p.suffix == ".csv":
                out["parties"] = str(p)
            elif "METADATA" in u and p.suffix == ".json":
                out["metadata"] = str(p)
    return out


# ---------------------------------------------------------------------------
# shared helpers
# ---------------------------------------------------------------------------

ENTRY_RULES: list[tuple[str, str]] = [
    (r"\bmdl\b|transfer order|conditional transfer", "mdl"),
    (r"case management order|\bcmo\b|pretrial order|\bpto\b", "case_management"),
    (r"summary judgment", "summary_judgment"),
    (r"class certification|certif", "class_cert"),
    (r"daubert|expert (report|disclosure|deposition)|\bsargon\b", "expert"),
    (r"\bappeal\b|appellate|mandamus", "appeal"),
    (r"\bopinion\b|memorandum (and|&) order|memorandum opinion", "opinion"),
    (r"\border\b|\bordered\b", "order"),
    (r"\bmotion\b|\bmtn\b|\bmot\.\b", "motion"),
    (r"\bbrief\b|memorandum of law|opposition|reply in (support|further)", "brief"),
    (r"complaint|amended complaint", "pleading"),
    (r"deposition|transcript|30\(b\)\(6\)", "transcript"),
    (r"\bexhibit\b|\bex\.\b|declaration|affidavit|appendix", "exhibit"),
    (r"\bnotice\b|notification", "notice"),
    (r"stipulation|joint (status|letter)|proposed order", "stipulation"),
    (r"minute entry|clerk.s? (minute|note)|docket entry", "minute"),
    (r"letter|correspondence", "correspondence"),
    (r"sealing|sealed", "sealing"),
    (r"settlement|master settlement|allocation", "settlement"),
    (r"discovery|interrogator|request for production|subpoena", "discovery"),
    (r"bellwether", "bellwether"),
]


def classify(text: str, hint: str = "") -> str:
    t = f"{text or ''} {hint or ''}".lower()
    for pat, label in ENTRY_RULES:
        if re.search(pat, t):
            return label
    return "other"


def parse_entry_label(raw: str, taken: set[int]) -> tuple[int, str]:
    """Docket labels can be non-numeric ('T5'). Returns (sortable int, label)."""
    label = (raw or "").strip()
    if re.fullmatch(r"\d+", label):
        return int(label), label
    digits = re.sub(r"\D", "", label)
    n = (900_000 + int(digits)) if digits else 999_999
    while n in taken:
        n += 1
    return n, label or "—"


def pdf_key(slug: str, entry: int, att: int, label: str | None = None) -> str:
    if entry >= 900_000 and label:
        safe = re.sub(r"[^A-Za-z0-9-]", "", label)
        # attachments of a labeled entry must not collide on the same key
        return f"{slug}/pdf/{safe}-{att:03d}.pdf" if att else f"{slug}/pdf/{safe}.pdf"
    return f"{slug}/pdf/{entry:04d}-{att:03d}.pdf"


def text_key(slug: str, entry: int, att: int, label: str | None = None) -> str:
    return pdf_key(slug, entry, att, label).replace("/pdf/", "/text/")[:-4] + ".txt"


def obj_exists(bucket: str, key: str, size: int | None = None) -> bool:
    try:
        h = S3.head_object(Bucket=bucket, Key=key)
        return size is None or h["ContentLength"] == size
    except ClientError:
        return False


def inspect_pdf(data: bytes) -> tuple[str, int, int | None]:
    """Hash + page count without uploading. Returns (sha256, bytes, pages|None)."""
    sha = hashlib.sha256(data).hexdigest()
    pages = None
    try:
        from pypdf import PdfReader
        pages = len(PdfReader(io.BytesIO(data)).pages)
    except Exception:
        pass
    return sha, len(data), pages


def upload(data: bytes, dst_key: str, content_type: str = "application/pdf") -> None:
    S3.put_object(Bucket=TARGET_BUCKET, Key=dst_key, Body=data, ContentType=content_type)


def run_stage(conn, cfg: dict, stage: str, fn):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO corpus.ingest_runs (matter_id, slug, stage, status) "
        "VALUES (%s, %s, %s, 'running') RETURNING run_id",
        (cfg.get("matter_id"), cfg["slug"], stage),
    )
    run_id = cur.fetchone()["run_id"]
    conn.commit()
    t0 = time.time()
    try:
        detail = fn(conn) or {}
        cur.execute(
            "UPDATE corpus.ingest_runs SET status='done', detail=%s, finished_at=now() "
            "WHERE run_id=%s",
            (json.dumps(detail, default=str), run_id),
        )
        conn.commit()
        print(f"[{stage}] done in {time.time()-t0:.1f}s :: {json.dumps(detail, default=str)[:400]}")
    except Exception as e:
        conn.rollback()
        cur.execute(
            "UPDATE corpus.ingest_runs SET status='error', detail=%s, finished_at=now() "
            "WHERE run_id=%s",
            (json.dumps({"error": str(e)[:2000]}), run_id),
        )
        conn.commit()
        print(f"[{stage}] ERROR: {e}", file=sys.stderr)
        raise


# ---------------------------------------------------------------------------
# Ledger parsing — canonical 33-column export (+ legacy fallback)
# ---------------------------------------------------------------------------

LEDGER_DATE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")

AVAILABILITY = {
    "FREE_RECAP_PDF_AVAILABLE": "free_recap",
    "PACER_LINK_AVAILABLE": "pacer_link",
    "NO_PUBLIC_PDF_LINK": "text_only",
    # documents supplied by the firm's own copy of the docket (not in RECAP)
    "LOCALLY_SUPPLIED": "local_supplied",
}


def _int(v: str | None) -> int | None:
    v = (v or "").strip()
    return int(v) if v.isdigit() else None


def _float(v: str | None) -> float | None:
    v = (v or "").strip()
    try:
        return float(v)
    except ValueError:
        return None


def _canon_row(r: dict) -> dict:
    desc = (r.get("docket_description") or "").strip()
    dtype = (r.get("document_type") or "").strip()
    if not desc:
        desc = dtype
    return {
        "label": (r.get("docket_entry") or "").strip(),
        "att": _int(r.get("attachment_number")) or 0,
        "date": (r.get("filed_date_iso") or "").strip() or None,
        "title": desc,
        "doc_type_raw": dtype,
        "document_label": (r.get("document_label") or "").strip(),
        "file_name": (r.get("file_name") or "").strip(),
        "availability": AVAILABILITY.get(
            (r.get("public_access_status") or "").strip(), "unknown"),
        "page_count": _int(r.get("page_count_exact")),
        "byte_count": _int(r.get("size_bytes")),
        "sha256": (r.get("sha256") or "").strip().lower() or None,
        "sha1": (r.get("sha1") or "").strip() or None,
        "md5": (r.get("md5") or "").strip() or None,
        "record_id": (r.get("record_id") or "").strip() or None,
        "recap_url": (r.get("recap_pdf_url") or "").strip() or None,
        "archive_url": (r.get("internet_archive_url") or "").strip() or None,
        "cl_url": (r.get("courtlistener_document_url") or "").strip() or None,
        "pacer_url": (r.get("pacer_pdf_url") or "").strip() or None,
        "pacer_price": _float(r.get("pacer_price_usd")),
    }


def read_ledger(path: str) -> tuple[list[dict], list[dict]]:
    """Returns (entry_rows, slot_rows).

    Canonical format: slot_rows = one per document slot (att 0 rows double as
    entries) with full metadata. Legacy format: slot_rows = attachment rows
    only, matching the historical stage_match behavior.
    """
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return [], []
    if "docket_entry" in rows[0]:
        slots = [_canon_row(r) for r in rows if (r.get("docket_entry") or "").strip()]
        entries = [s for s in slots if s["att"] == 0]
        return entries, slots
    # legacy format
    entries, atts = [], []
    for row in rows:
        num = (row.get("docket_sheet_number") or "").strip()
        if not num:
            continue
        att = (row.get("attachment_number") or "").strip()
        date_raw = (row.get("date") or "").strip()
        m = LEDGER_DATE.match(date_raw)
        date = f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else None
        rec = {"label": num, "date": date, "title": (row.get("title") or "").strip(),
               "att": int(att) if att else 0, "doc_type_raw": "",
               "availability": None, "page_count": None, "byte_count": None,
               "sha256": None, "sha1": None, "md5": None, "record_id": None,
               "recap_url": None, "archive_url": None, "cl_url": None,
               "pacer_url": None, "pacer_price": None,
               "document_label": "", "file_name": ""}
        if att:
            atts.append(rec)
        else:
            entries.append(rec)
    return entries, atts


def is_canonical(path: str) -> bool:
    with open(path, newline="", encoding="utf-8-sig") as f:
        return "docket_entry" in (csv.DictReader(f).fieldnames or [])


# ---------------------------------------------------------------------------
# Stage: ledger — docket entries (+ matters bibliographic record)
# ---------------------------------------------------------------------------

def _parse_display_date(s: str | None) -> str | None:
    if not s:
        return None
    for fmt in ("%B %d, %Y", "%b. %d, %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(s.strip(), fmt).date().isoformat()
        except ValueError:
            continue
    return None


def apply_metadata(cur, matter_id: str, meta_path: str) -> None:
    m = json.loads(Path(meta_path).read_text())
    cur.execute(
        """
        UPDATE corpus.matters SET
          caption                = coalesce(%s, caption),
          judge                  = coalesce(%s, judge),
          magistrate_judge       = coalesce(%s, magistrate_judge),
          cause                  = coalesce(%s, cause),
          nature_of_suit         = coalesce(%s, nature_of_suit),
          jury_demand            = coalesce(%s, jury_demand),
          jurisdiction_type      = coalesce(%s, jurisdiction_type),
          courtlistener_docket_id= coalesce(%s, courtlistener_docket_id),
          courtlistener_url      = coalesce(%s, courtlistener_url),
          pacer_case_id          = coalesce(%s, pacer_case_id),
          pacer_url              = coalesce(%s, pacer_url),
          date_filed             = coalesce(%s, date_filed),
          source                 = 'export',
          source_url             = coalesce(%s, source_url)
        WHERE matter_id = %s
        """,
        (
            m.get("courtlistener_caption"), m.get("assigned_judge"),
            m.get("referred_magistrate_judge"), m.get("cause"),
            m.get("nature_of_suit"), m.get("jury_demand"),
            m.get("jurisdiction_type"), m.get("courtlistener_docket_id"),
            m.get("courtlistener_url"), m.get("pacer_case_id"),
            m.get("pacer_stable_docket_url"),
            _parse_display_date(m.get("date_filed")),
            m.get("courtlistener_url"), matter_id,
        ),
    )


def stage_ledger(conn, cfg, ledger: str | None = None, metadata: str | None = None,
                 dry_run=False, **_):
    if not ledger:
        print("[ledger] no ledger CSV found, skipping")
        return {"skipped": True}
    matter_id = matter_pk(conn, cfg)
    canonical = is_canonical(ledger)
    entries, _slots = read_ledger(ledger)
    cur = conn.cursor()
    taken: set[int] = set()
    n_up = 0
    for e in entries:
        n, label = parse_entry_label(e["label"], taken)
        taken.add(n)
        if dry_run:
            continue
        cur.execute(
            """
            INSERT INTO corpus.docket_entries
              (matter_id, entry_number, entry_label, date_filed, description,
               entry_type, page_count, source, source_url)
            VALUES (%s,%s,%s,%s,%s,%s,%s,'export',%s)
            ON CONFLICT (matter_id, entry_number) DO UPDATE SET
              entry_label=EXCLUDED.entry_label,
              date_filed=coalesce(EXCLUDED.date_filed, corpus.docket_entries.date_filed),
              description=CASE WHEN length(EXCLUDED.description) > length(corpus.docket_entries.description)
                               THEN EXCLUDED.description ELSE corpus.docket_entries.description END,
              entry_type=EXCLUDED.entry_type,
              page_count=coalesce(EXCLUDED.page_count, corpus.docket_entries.page_count),
              source_url=coalesce(EXCLUDED.source_url, corpus.docket_entries.source_url)
            """,
            (matter_id, n, label, e["date"], e["title"],
             classify(e["title"], e.get("doc_type_raw", "")),
             e.get("page_count"), e.get("cl_url")),
        )
        n_up += 1
    if metadata and not dry_run:
        apply_metadata(cur, matter_id, metadata)
    if not dry_run:
        cur.execute("UPDATE corpus.matters SET pipeline_stage='ledger', "
                    "last_synced_at=now() WHERE matter_id=%s AND pipeline_stage='new'",
                    (matter_id,))
        conn.commit()
    detail = {"entries": n_up, "format": "canonical" if canonical else "legacy",
              "metadata_applied": bool(metadata) and not dry_run, "dry_run": dry_run}
    if dry_run:
        print(f"[ledger] DRY RUN :: {len(entries)} entries ({detail['format']})")
        for e in entries[:5]:
            print(f"   {e['label']:>6}  {e['date']}  {e['title'][:70]}")
    return detail


# ---------------------------------------------------------------------------
# Stage: parties — parties & counsel relationship CSV
# ---------------------------------------------------------------------------

_NOT_ADMITTED = re.compile(r"counsel not admitted to\s+[^,|]*?\bbar\b[,\s]*", re.I)
_ADDR_TAIL = re.compile(r"^(?P<firm>.*?)\s+(?P<addr>\d[\s\S]*,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)$")
_PHONE_ONLY = re.compile(r"^[\d()\s.xX+-]+(fax:?\s*[\d()\s.xX+-]+)?$", re.I)


def parse_firm(raw: str | None) -> tuple[str, str | None]:
    """'(212) 909-3344 | Counsel Not Admitted..., Kirkland & Ellis LLP 601
    Lexington Ave. New York, NY 10022' -> ('Kirkland & Ellis LLP', addr).
    Phone-only fields -> ('', None); bare addresses -> ('', addr)."""
    s = (raw or "").strip()
    if " | " in s:
        s = s.split(" | ")[-1].strip()
    s = _NOT_ADMITTED.sub("", s).strip()
    if not s or _PHONE_ONLY.match(s):
        return "", None
    if s[0].isdigit():
        return "", s
    m = _ADDR_TAIL.match(s)
    if m:
        return m.group("firm").strip(" ,"), m.group("addr").strip()
    return s, None


def stage_parties(conn, cfg, parties_csv: str | None = None, dry_run=False, **_):
    if not parties_csv:
        print("[parties] no parties CSV found, skipping")
        return {"skipped": True}
    matter_id = matter_pk(conn, cfg)
    with open(parties_csv, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    cur = conn.cursor()
    parties: set[tuple[str, str]] = set()
    n_counsel = leads = fallbacks = 0
    for r in rows:
        pname = (r.get("party_name") or "").strip()
        if not pname:
            continue
        role = (r.get("party_role") or "").strip() or None
        parties.add((pname, role or ""))
        if dry_run:
            continue
        cur.execute(
            "INSERT INTO corpus.parties (matter_id, name, party_type) "
            "VALUES (%s,%s,%s) ON CONFLICT (matter_id, name, party_type) DO NOTHING",
            (matter_id, pname, role),
        )
        atty = (r.get("attorney_name") or "").strip()
        if not atty:
            continue
        design = (r.get("attorney_designations") or "").strip()
        is_lead = "LEAD ATTORNEY" in design.upper()
        firm, address = parse_firm(r.get("attorney_address_and_firm"))
        if firm and not address:
            fallbacks += 1
        c_role = ("Lead Attorney" if is_lead
                  else "Attorney to be Noticed" if "TO BE NOTICED" in design.upper()
                  else (r.get("representation") or "").strip() or None)
        cur.execute(
            """
            INSERT INTO corpus.counsel
              (matter_id, party_name, attorney, firm, role,
               is_lead, phone, fax, address, designations)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (matter_id, attorney, firm, party_name) DO UPDATE SET
              role=EXCLUDED.role, is_lead=EXCLUDED.is_lead,
              phone=EXCLUDED.phone, fax=EXCLUDED.fax,
              address=EXCLUDED.address, designations=EXCLUDED.designations
            """,
            (matter_id, pname, atty, firm or "", c_role, is_lead,
             (r.get("attorney_phone") or "").strip() or None,
             (r.get("attorney_fax") or "").strip() or None,
             address, design or None),
        )
        n_counsel += 1
        leads += 1 if is_lead else 0
    if not dry_run:
        conn.commit()
    detail = {"parties": len(parties), "counsel_rows": n_counsel,
              "lead_attorneys": leads, "firm_parse_fallbacks": fallbacks,
              "dry_run": dry_run}
    if dry_run:
        print(f"[parties] DRY RUN :: {json.dumps(detail)}")
    return detail


# ---------------------------------------------------------------------------
# Stage: match — build the slot plan from ledger + local dir + incoming/
# ---------------------------------------------------------------------------

RECAP_NAME = re.compile(
    r"gov\.uscourts\.[a-z0-9]+\.[a-z0-9-]+\.(\d+)(?:\.(\d+))?[^/]*\.pdf$", re.I)
LOCAL_NAME = re.compile(
    r"^(\d{1,5})(?:-(\d{1,3}))?[.\s_]*(?:\((\d{2}-\d{2}-\d{4})\))?\s*(.*?)\.pdf$", re.I)
# Cross-docket namespacing: "JPML-0001-005.pdf" -> entry 900001, attachment 5.
# Must stay consistent with parse_entry_label("JPML-<n>") -> 900_000 + n.
JPML_NAME = re.compile(r"^JPML-(\d+)(?:-(\d+))?[^/]*\.pdf$", re.I)


def parse_filename(name: str) -> tuple[int, int, str] | None:
    """Returns (entry, attachment, title-from-name) or None.

    Files uploaded/placed under a `jpml/` folder belong to the JPML panel
    docket and are namespaced to 900_000 + entry so they cannot collide with
    the transferee docket's entry numbers.
    """
    jpml_ns = "/jpml/" in name.replace("\\", "/").lower()
    base = Path(name).name
    # dropzone prefixes keys with a millisecond tag ("1787672725699-0001. ...pdf")
    base = re.sub(r"^\d{10,}-", "", base)
    m = RECAP_NAME.search(base)
    if m:
        n = int(m.group(1))
        return (n + 900_000 if jpml_ns and n < 900_000 else n), int(m.group(2) or 0), ""
    m = JPML_NAME.match(base)
    if m:
        return 900_000 + int(m.group(1)), int(m.group(2) or 0), ""
    m = LOCAL_NAME.match(base)
    if m:
        n = int(m.group(1))
        if jpml_ns and n < 900_000:
            n += 900_000
        return n, int(m.group(2) or 0), (m.group(4) or "").strip()
    return None


def stage_match(conn, cfg, dry_run=False, local_dir: str | None = None,
                ledger: str | None = None, **_):
    matter_pk(conn, cfg)
    plan: dict[tuple[int, int], dict] = {}

    def slot(n: int, att: int) -> dict:
        return plan.setdefault((n, att), {
            "entry": n, "att": att, "label": str(n), "title": "",
            "doc_type_raw": "", "availability": None,
            "sha256": None, "expected_sha256": None, "sha1": None, "md5": None,
            "byte_count": None, "byte_count_expected": None, "page_count": None,
            "record_id": None, "recap_url": None, "archive_url": None,
            "cl_url": None, "pacer_url": None, "pacer_price": None,
            "is_sealed": False, "hash_verified": False, "src": None,
        })

    # ledger slots give us expected slots + full metadata
    ledger_slots = 0
    if ledger:
        entries, slots = read_ledger(ledger)
        taken: set[int] = set()
        label_map: dict[str, tuple[int, str]] = {}
        for e in entries:
            n, label = parse_entry_label(e["label"], taken)
            taken.add(n)
            label_map[e["label"]] = (n, label)
        for s in slots:
            ref = label_map.get(s["label"])
            n = ref[0] if ref else (int(s["label"]) if s["label"].isdigit() else 0)
            if not n:
                continue
            label = ref[1] if ref else s["label"]
            s0 = slot(n, s["att"])
            s0["label"] = label
            if s["title"] and (not s0["title"] or len(s["title"]) > len(s0["title"])):
                s0["title"] = s["title"]
            s0["date"] = s["date"]
            s0["doc_type_raw"] = s.get("doc_type_raw") or ""
            s0["availability"] = s.get("availability")
            s0["expected_sha256"] = s.get("sha256")
            s0["sha1"] = s.get("sha1")
            s0["md5"] = s.get("md5")
            s0["byte_count_expected"] = s.get("byte_count")
            s0["page_count"] = s.get("page_count")
            s0["record_id"] = s.get("record_id")
            s0["recap_url"] = s.get("recap_url")
            s0["archive_url"] = s.get("archive_url")
            s0["cl_url"] = s.get("cl_url")
            s0["pacer_url"] = s.get("pacer_url")
            s0["pacer_price"] = s.get("pacer_price")
            ledger_slots += 1

    # local dir files
    local_found = 0
    if local_dir:
        for f in sorted(Path(local_dir).glob("**/*.pdf")):
            parsed = parse_filename(f.name)
            if not parsed:
                print(f"  [match] unparsed filename: {f.name}")
                continue
            n, att, title = parsed
            s0 = slot(n, att)
            s0["src"] = {"kind": "local", "path": str(f)}
            s0["byte_count"] = f.stat().st_size
            if title and not s0["title"]:
                s0["title"] = title
            local_found += 1

    # incoming/ prefix in the matters bucket (app uploads)
    incoming_found = 0
    prefix = f"{cfg['slug']}/incoming/"
    paginator = S3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=TARGET_BUCKET, Prefix=prefix):
        for o in page.get("Contents", []):
            parsed = parse_filename(o["Key"])
            if not parsed:
                print(f"  [match] unparsed incoming key: {o['Key']}")
                continue
            n, att, title = parsed
            s0 = slot(n, att)
            if not s0["src"]:  # local dir wins over incoming
                s0["src"] = {"kind": "incoming", "key": o["Key"]}
                s0["byte_count"] = o["Size"]
                if title and not s0["title"]:
                    s0["title"] = title
                incoming_found += 1

    with_src = sum(1 for v in plan.values() if v["src"])
    unexpected_files = sum(1 for v in plan.values()
                           if v["src"] and not v["expected_sha256"]
                           and v["availability"] is None and ledger)
    detail = {
        "slots": len(plan), "with_file": with_src, "metadata_only": len(plan) - with_src,
        "ledger_slots": ledger_slots, "local_files": local_found,
        "incoming_files": incoming_found, "files_without_ledger_slot": unexpected_files,
    }
    if dry_run:
        missing = sorted(k for k, v in plan.items()
                         if not v["src"] and v["availability"] != "text_only")
        print(f"[match] DRY RUN :: {json.dumps(detail)}")
        print(f"[match] slots missing a file: {len(missing)} -> "
              f"{missing[:25]}{' …' if len(missing) > 25 else ''}")
    plan_path = ROOT / f"scripts/pipeline/.plan-{cfg['slug']}.json"
    plan_path.write_text(json.dumps({f"{k[0]}|{k[1]}": v for k, v in plan.items()},
                                    indent=1, default=str))
    return detail


def load_plan(cfg) -> dict[tuple[int, int], dict]:
    plan_path = ROOT / f"scripts/pipeline/.plan-{cfg['slug']}.json"
    if not plan_path.exists():
        sys.exit("no match plan — run the match stage first")
    raw = json.loads(plan_path.read_text())
    return {tuple(int(x) for x in k.split("|")): v for k, v in raw.items()}


# ---------------------------------------------------------------------------
# Stage: store — files -> canonical pdf/ keys (hash-verified when expected)
# ---------------------------------------------------------------------------

def stage_store(conn, cfg, dry_run=False, limit: int | None = None, **_):
    plan = load_plan(cfg)
    todo = [(k, v) for k, v in sorted(plan.items()) if v.get("src")]
    done = skipped = failed = quarantined = 0
    for i, ((n, att), row) in enumerate(todo, 1):
        dst = pdf_key(cfg["slug"], n, att, row.get("label"))
        row["dst_key"] = dst
        if dry_run:
            continue
        try:
            if obj_exists(TARGET_BUCKET, dst, row.get("byte_count")):
                row["hash_verified"] = bool(row.get("expected_sha256"))  # trusted from prior run
                skipped += 1
                continue
            src = row["src"]
            if src["kind"] == "local":
                data = Path(src["path"]).read_bytes()
            else:
                data = S3.get_object(Bucket=TARGET_BUCKET, Key=src["key"])["Body"].read()
            sha, size, pages = inspect_pdf(data)
            expected = row.get("expected_sha256")
            if expected and sha != expected:
                qk = f"{cfg['slug']}/quarantine/{Path(src.get('path') or src.get('key')).name}"
                upload(data, qk)
                row["dst_key"] = None
                row["error"] = f"sha256 mismatch (expected {expected[:12]}…, got {sha[:12]}…) -> {qk}"
                failed += 1
                quarantined += 1
                print(f"  [store] HASH MISMATCH {dst} -> quarantined", file=sys.stderr)
                continue
            upload(data, dst)
            row["sha256"] = sha
            row["byte_count"] = size
            row["page_count"] = row.get("page_count") or pages
            row["hash_verified"] = bool(expected)
            done += 1
        except Exception as e:
            failed += 1
            row["error"] = str(e)[:300]
            print(f"  [store] FAILED {dst}: {e}", file=sys.stderr)
        if limit and done >= limit:
            break
        if i % 25 == 0:
            print(f"  [store] {i}/{len(todo)} (stored {done}, reused {skipped}, failed {failed})")
    if not dry_run:
        plan_path = ROOT / f"scripts/pipeline/.plan-{cfg['slug']}.json"
        plan_path.write_text(json.dumps({f"{k[0]}|{k[1]}": v for k, v in plan.items()},
                                        indent=1, default=str))
    return {"planned": len(todo), "stored": done, "already_present": skipped,
            "failed": failed, "quarantined": quarantined, "dry_run": dry_run}


# ---------------------------------------------------------------------------
# Stage: write — document rows + stub entries + rollups
# ---------------------------------------------------------------------------

def stage_write(conn, cfg, **_):
    plan = load_plan(cfg)
    cur = conn.cursor()
    matter_id = matter_pk(conn, cfg)

    cur.execute("SELECT entry_number, docket_entry_id FROM corpus.docket_entries "
                "WHERE matter_id=%s", (matter_id,))
    entry_ids = {r["entry_number"]: r["docket_entry_id"] for r in cur.fetchall()}

    # auto-create stub entries for files with no ledger entry
    stubs = 0
    for (n, att), row in sorted(plan.items()):
        if n in entry_ids or not row.get("dst_key"):
            continue
        cur.execute(
            """
            INSERT INTO corpus.docket_entries
              (matter_id, entry_number, entry_label, description, entry_type, source)
            VALUES (%s,%s,%s,%s,%s,'file')
            ON CONFLICT (matter_id, entry_number) DO NOTHING
            RETURNING docket_entry_id
            """,
            (matter_id, n, row.get("label") or str(n), row.get("title") or "",
             classify(row.get("title") or "", row.get("doc_type_raw") or "")),
        )
        r = cur.fetchone()
        if r:
            entry_ids[n] = r["docket_entry_id"]
            stubs += 1
        else:
            entry_ids[n] = cur.execute(
                "SELECT docket_entry_id FROM corpus.docket_entries "
                "WHERE matter_id=%s AND entry_number=%s",
                (matter_id, n)).fetchone()["docket_entry_id"]

    upserted = 0
    for (n, att), row in sorted(plan.items()):
        title = row.get("title") or "(no description)"
        has_pdf = bool(row.get("dst_key"))
        if has_pdf:
            text_status = "pending"
        elif row.get("availability") == "text_only":
            text_status = "text_only"
        else:
            text_status = "no_pdf"
        cur.execute(
            """
            INSERT INTO corpus.documents
              (matter_id, docket_entry_id, entry_number, entry_label, attachment_number,
               title, doc_type, doc_category, sha256, expected_sha256, sha1, md5,
               hash_verified, byte_count, page_count, s3_bucket, s3_key,
               is_sealed, text_status, availability_status, record_id,
               courtlistener_url, recap_url, archive_url, pacer_url, pacer_price_usd,
               source)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'upload')
            ON CONFLICT (matter_id, entry_number, attachment_number) DO UPDATE SET
              docket_entry_id=EXCLUDED.docket_entry_id,
              entry_label=EXCLUDED.entry_label,
              title=CASE WHEN length(EXCLUDED.title) > length(corpus.documents.title)
                         THEN EXCLUDED.title ELSE corpus.documents.title END,
              doc_type=EXCLUDED.doc_type,
              doc_category=coalesce(EXCLUDED.doc_category, corpus.documents.doc_category),
              sha256=coalesce(EXCLUDED.sha256, corpus.documents.sha256),
              expected_sha256=coalesce(EXCLUDED.expected_sha256, corpus.documents.expected_sha256),
              sha1=coalesce(EXCLUDED.sha1, corpus.documents.sha1),
              md5=coalesce(EXCLUDED.md5, corpus.documents.md5),
              hash_verified=corpus.documents.hash_verified OR EXCLUDED.hash_verified,
              byte_count=coalesce(EXCLUDED.byte_count, corpus.documents.byte_count),
              page_count=coalesce(EXCLUDED.page_count, corpus.documents.page_count),
              s3_bucket=coalesce(EXCLUDED.s3_bucket, corpus.documents.s3_bucket),
              s3_key=coalesce(EXCLUDED.s3_key, corpus.documents.s3_key),
              -- re-ingest must not clobber pipeline progress: only reset
              -- text_status when the underlying file actually changed
              text_status=CASE
                WHEN corpus.documents.s3_key IS DISTINCT FROM EXCLUDED.s3_key
                  THEN EXCLUDED.text_status
                WHEN corpus.documents.text_status IN ('extracted','embedded')
                  THEN corpus.documents.text_status
                ELSE EXCLUDED.text_status
              END,
              availability_status=coalesce(EXCLUDED.availability_status, corpus.documents.availability_status),
              record_id=coalesce(EXCLUDED.record_id, corpus.documents.record_id),
              courtlistener_url=coalesce(EXCLUDED.courtlistener_url, corpus.documents.courtlistener_url),
              recap_url=coalesce(EXCLUDED.recap_url, corpus.documents.recap_url),
              archive_url=coalesce(EXCLUDED.archive_url, corpus.documents.archive_url),
              pacer_url=coalesce(EXCLUDED.pacer_url, corpus.documents.pacer_url),
              pacer_price_usd=coalesce(EXCLUDED.pacer_price_usd, corpus.documents.pacer_price_usd)
            """,
            (
                matter_id, entry_ids.get(n), n, row.get("label") or str(n), att,
                title, classify(title, row.get("doc_type_raw") or ""),
                row.get("doc_type_raw") or None,
                row.get("sha256"), row.get("expected_sha256"),
                row.get("sha1"), row.get("md5"), bool(row.get("hash_verified")),
                row.get("byte_count"), row.get("page_count"),
                TARGET_BUCKET if has_pdf else None, row.get("dst_key"),
                bool(row.get("is_sealed")), text_status,
                row.get("availability"), row.get("record_id"),
                row.get("cl_url"), row.get("recap_url"), row.get("archive_url"),
                row.get("pacer_url"), row.get("pacer_price"),
            ),
        )
        upserted += 1

    cur.execute(
        """
        UPDATE corpus.docket_entries e
        SET document_count = x.n, has_pdf = x.any_pdf,
            page_count = coalesce(e.page_count, x.pages)
        FROM (
          SELECT docket_entry_id, count(*) AS n,
                 bool_or(s3_key IS NOT NULL) AS any_pdf,
                 nullif(sum(coalesce(page_count,0)),0) AS pages
          FROM corpus.documents
          WHERE matter_id=%s AND docket_entry_id IS NOT NULL
          GROUP BY 1
        ) x WHERE x.docket_entry_id = e.docket_entry_id
        """,
        (matter_id,),
    )
    # normalize docket_source / display labels / sort order for this matter
    cur.execute("SELECT corpus.refresh_display_order(%s)", (matter_id,))
    cur.execute("UPDATE corpus.matters SET pipeline_stage='stored', "
                "last_synced_at=now() WHERE matter_id=%s", (matter_id,))
    conn.commit()
    return {"documents_upserted": upserted, "stub_entries": stubs}


# ---------------------------------------------------------------------------
# Stage: extract — PDF text layer -> text/ objects + doc_chunks
# ---------------------------------------------------------------------------

def chunk_pages(pages: list[str], max_chars: int = 3600) -> list[tuple[int, int, str]]:
    chunks: list[tuple[int, int, str]] = []
    buf, start = "", 1
    for i, t in enumerate(pages, start=1):
        # strip NUL/control bytes — Postgres text rejects \x00
        t = (t or "").replace("\x00", "").strip()
        if buf and len(buf) + len(t) > max_chars:
            chunks.append((start, i - 1, buf))
            buf, start = "", i
        if t:
            buf += ("\n\n" if buf else "") + t
    if buf.strip():
        chunks.append((start, len(pages), buf))
    return chunks


def _insert_chunk(cur, matter_id, doc, ci, ps, pe, content):
    cur.execute(
        """
        INSERT INTO corpus.doc_chunks
          (matter_id, document_id, docket_entry_id, entry_number,
           attachment_number, chunk_index, page_start, page_end,
           doc_type, is_sealed, content, token_count)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """,
        (matter_id, doc["document_id"], doc["docket_entry_id"],
         doc["entry_number"], doc["attachment_number"], ci, ps, pe,
         doc["doc_type"], doc["is_sealed"], content, len(content) // 4),
    )


def stage_extract(conn, cfg, limit: int | None = None, **_):
    from pypdf import PdfReader

    cur = conn.cursor()
    matter_id = matter_pk(conn, cfg)
    cur.execute(
        """
        SELECT d.document_id, d.docket_entry_id, d.entry_number, d.entry_label,
               d.attachment_number, d.s3_key, d.doc_type, d.is_sealed, d.text_status,
               e.description AS entry_description
        FROM corpus.documents d
        LEFT JOIN corpus.docket_entries e ON e.docket_entry_id = d.docket_entry_id
        WHERE d.matter_id=%s AND (
          (d.s3_key IS NOT NULL AND d.text_status IN ('pending','failed'))
          OR d.text_status = 'text_only'
        )
        ORDER BY d.entry_number, d.attachment_number
        """,
        (matter_id,),
    )
    docs = cur.fetchall()
    done = no_text = failed = chunks_n = 0
    for i, d in enumerate(docs, 1):
        if limit and done >= limit:
            break
        try:
            if d["text_status"] == "text_only":
                # No PDF exists — the docket text IS the document.
                full = (d["entry_description"] or "").strip()
                if not full:
                    cur.execute("UPDATE corpus.documents SET text_status='no_text' "
                                "WHERE document_id=%s", (d["document_id"],))
                    no_text += 1
                    continue
                tk = text_key(cfg["slug"], d["entry_number"], d["attachment_number"],
                              d.get("entry_label"))
                upload(full.encode(), tk, "text/plain; charset=utf-8")
                cur.execute("DELETE FROM corpus.doc_chunks WHERE document_id=%s",
                            (d["document_id"],))
                _insert_chunk(cur, matter_id, d, 0, 1, 1, full)
                chunks_n += 1
                cur.execute("UPDATE corpus.documents SET text_status='extracted' "
                            "WHERE document_id=%s", (d["document_id"],))
                done += 1
                continue

            data = S3.get_object(Bucket=TARGET_BUCKET, Key=d["s3_key"])["Body"].read()
            reader = PdfReader(io.BytesIO(data))
            pages = [(p.extract_text() or "") for p in reader.pages]
            full = "\n\n".join(t for t in pages if t.strip())
            if not full.strip():
                cur.execute("UPDATE corpus.documents SET text_status='no_text' "
                            "WHERE document_id=%s", (d["document_id"],))
                no_text += 1
            else:
                tk = text_key(cfg["slug"], d["entry_number"], d["attachment_number"],
                              d.get("entry_label"))
                upload(full.encode(), tk, "text/plain; charset=utf-8")
                cur.execute("DELETE FROM corpus.doc_chunks WHERE document_id=%s",
                            (d["document_id"],))
                for ci, (ps, pe, content) in enumerate(chunk_pages(pages)):
                    _insert_chunk(cur, matter_id, d, ci, ps, pe, content)
                    chunks_n += 1
                cur.execute("UPDATE corpus.documents SET text_status='extracted', "
                            "page_count=coalesce(page_count,%s) WHERE document_id=%s",
                            (len(reader.pages), d["document_id"]))
                done += 1
        except Exception as e:
            failed += 1
            cur.execute("UPDATE corpus.documents SET text_status='failed' "
                        "WHERE document_id=%s", (d["document_id"],))
            print(f"  [extract] FAILED {d.get('s3_key') or d['entry_label']}: {e}",
                  file=sys.stderr)
        if i % 10 == 0:
            conn.commit()
            print(f"  [extract] {i}/{len(docs)} (ok {done}, no text {no_text}, failed {failed})")
    cur.execute("UPDATE corpus.matters SET pipeline_stage='extracted' "
                "WHERE matter_id=%s AND pipeline_stage IN ('stored','ledger','new')",
                (matter_id,))
    conn.commit()
    return {"documents": len(docs), "extracted": done, "no_text": no_text,
            "failed": failed, "chunks": chunks_n}


# ---------------------------------------------------------------------------
# Stage: embed — voyage-law-2 (1024 dims) -> doc_chunks.embedding
# ---------------------------------------------------------------------------

VOYAGE_MODEL = "voyage-law-2"

# Voyage rejects an over-large request outright (400). Keep every request well
# under the per-request token cap: ~4 chars/token, so 90k chars ~= 23k tokens.
EMBED_MAX_CHARS_PER_CHUNK = 4000
EMBED_MAX_CHARS_PER_REQUEST = 90_000
EMBED_MAX_ROWS_PER_REQUEST = 96


class VoyageHTTPError(RuntimeError):
    """Voyage API error that carries the HTTP status and the response body."""

    def __init__(self, code: int, body: str):
        self.code = code
        self.body = body
        super().__init__(f"voyage HTTP {code}: {body[:500]}")


def voyage_embed(texts: list[str], input_type: str, key: str) -> list[list[float]]:
    body = json.dumps({"model": VOYAGE_MODEL, "input": texts,
                       "input_type": input_type}).encode()
    for attempt in range(4):
        req = urllib.request.Request(
            "https://api.voyageai.com/v1/embeddings",
            data=body,
            headers={"Authorization": f"Bearer {key}",
                     "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                payload = json.loads(r.read())
            return [d["embedding"] for d in payload["data"]]
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                detail = e.reason or ""
            if e.code == 429 and attempt < 3:
                time.sleep(5 * (attempt + 1))
                continue
            raise VoyageHTTPError(e.code, detail) from None
    raise RuntimeError("voyage embed failed")


def embed_batches(rows: list, text_of=lambda r: r["content"]):
    """Yield row slices sized by BOTH row count and total characters, so one
    long chunk can never push a request over Voyage's per-request limit."""
    batch: list = []
    chars = 0
    for r in rows:
        n = min(len(text_of(r)), EMBED_MAX_CHARS_PER_CHUNK)
        if batch and (len(batch) >= EMBED_MAX_ROWS_PER_REQUEST
                      or chars + n > EMBED_MAX_CHARS_PER_REQUEST):
            yield batch
            batch, chars = [], 0
        batch.append(r)
        chars += n
    if batch:
        yield batch


def is_junk_chunk(text: str) -> bool:
    """PDFs with no text layer extract as CID/glyph token noise
    ('/0/1/2/3/i255/...'). Those chunks are useless in the vector index and
    inflate embed requests, so they are dropped rather than embedded."""
    s = (text or "").strip()
    if not s:
        return True
    letters = sum(ch.isalpha() for ch in s)
    if letters / max(len(s), 1) >= 0.5:
        return False
    slashes = s.count("/")
    return slashes >= 20 and slashes / max(len(s), 1) > 0.03


def stage_embed(conn, cfg, limit: int | None = None, **_):
    key = os.environ.get("VOYAGE_API_KEY")
    if not key:
        print("[embed] VOYAGE_API_KEY not set — skipping (text + chunks are ready)")
        return {"skipped": "no VOYAGE_API_KEY"}
    cur = conn.cursor()
    matter_id = matter_pk(conn, cfg)
    cur.execute(
        "SELECT chunk_id, content FROM corpus.doc_chunks "
        "WHERE matter_id=%s AND embedding IS NULL ORDER BY chunk_id",
        (matter_id,),
    )
    rows = cur.fetchall()
    junk = [r for r in rows if is_junk_chunk(r["content"])]
    if junk:
        cur.execute("DELETE FROM corpus.doc_chunks WHERE chunk_id = ANY(%s)",
                    ([r["chunk_id"] for r in junk],))
        conn.commit()
        print(f"  [embed] dropped {len(junk)} unusable (no text layer) chunks")
        rows = [r for r in rows if not is_junk_chunk(r["content"])]
    total = len(rows)
    embedded = 0
    for batch in embed_batches(rows):
        if limit and embedded >= limit:
            break
        vecs = voyage_embed(
            [r["content"][:EMBED_MAX_CHARS_PER_CHUNK] for r in batch], "document", key)

        for r, v in zip(batch, vecs):
            lit = "[" + ",".join(f"{x:.6f}" for x in v) + "]"
            cur.execute("UPDATE corpus.doc_chunks SET embedding=%s::extensions.vector "
                        "WHERE chunk_id=%s", (lit, r["chunk_id"]))
        embedded += len(batch)
        conn.commit()
        print(f"  [embed] {embedded}/{total}")

    cur.execute("UPDATE corpus.matters SET pipeline_stage='embedded' "
                "WHERE matter_id=%s", (matter_id,))
    conn.commit()
    return {"model": VOYAGE_MODEL, "chunks_embedded": embedded, "total_pending": total}


# ---------------------------------------------------------------------------
# Stage: verify — quality gate
# ---------------------------------------------------------------------------

def stage_verify(conn, cfg, **_):
    cur = conn.cursor()
    matter_id = matter_pk(conn, cfg)

    def one(q, a=(matter_id,)):
        cur.execute(q, a)
        return cur.fetchone()["c"]

    entries = one("SELECT count(*) AS c FROM corpus.docket_entries WHERE matter_id=%s")
    e_dated = one("SELECT count(*) AS c FROM corpus.docket_entries WHERE matter_id=%s "
                  "AND date_filed IS NOT NULL")
    e_described = one("SELECT count(*) AS c FROM corpus.docket_entries WHERE matter_id=%s "
                      "AND btrim(description) <> ''")
    docs = one("SELECT count(*) AS c FROM corpus.documents WHERE matter_id=%s")
    with_pdf = one("SELECT count(*) AS c FROM corpus.documents WHERE matter_id=%s "
                   "AND s3_key IS NOT NULL")
    text_only = one("SELECT count(*) AS c FROM corpus.documents WHERE matter_id=%s "
                    "AND availability_status='text_only'")
    declared_pacer = one("SELECT count(*) AS c FROM corpus.documents WHERE matter_id=%s "
                         "AND availability_status='pacer_link' AND s3_key IS NULL")
    unexpected_missing = one(
        "SELECT count(*) AS c FROM corpus.documents WHERE matter_id=%s "
        "AND s3_key IS NULL AND coalesce(availability_status,'') NOT IN ('pacer_link','text_only')")
    no_sha = one("SELECT count(*) AS c FROM corpus.documents WHERE matter_id=%s "
                 "AND s3_key IS NOT NULL AND sha256 IS NULL")
    unverified_hash = one(
        "SELECT count(*) AS c FROM corpus.documents WHERE matter_id=%s "
        "AND s3_key IS NOT NULL AND expected_sha256 IS NOT NULL AND NOT hash_verified")
    pages_missing = one("SELECT count(*) AS c FROM corpus.documents WHERE matter_id=%s "
                        "AND s3_key IS NOT NULL AND page_count IS NULL")
    extracted = one("SELECT count(*) AS c FROM corpus.documents WHERE matter_id=%s "
                    "AND text_status='extracted'")
    chunks = one("SELECT count(*) AS c FROM corpus.doc_chunks WHERE matter_id=%s")
    embedded = one("SELECT count(*) AS c FROM corpus.doc_chunks WHERE matter_id=%s "
                   "AND embedding IS NOT NULL")
    parties = one("SELECT count(*) AS c FROM corpus.parties WHERE matter_id=%s")
    counsel = one("SELECT count(*) AS c FROM corpus.counsel WHERE matter_id=%s")

    report = {
        "entries": entries, "entries_dated": e_dated, "entries_described": e_described,
        "documents": docs, "with_pdf": with_pdf, "text_only": text_only,
        "declared_pacer_only": declared_pacer, "unexpected_missing_pdf": unexpected_missing,
        "hash_missing": no_sha, "hash_unverified": unverified_hash,
        "pages_missing": pages_missing, "text_extracted": extracted,
        "chunks": chunks, "chunks_embedded": embedded,
        "parties": parties, "counsel": counsel,
    }
    print(json.dumps(report, indent=2))

    cur.execute(
        """
        SELECT entry_label, attachment_number, title, pacer_url, pacer_price_usd
        FROM corpus.documents
        WHERE matter_id=%s AND s3_key IS NULL AND availability_status='pacer_link'
        ORDER BY entry_number, attachment_number
        """,
        (matter_id,),
    )
    missing = cur.fetchall()
    csv_path = Path(f"/mnt/documents/{cfg['slug']}-v2-coverage.csv")
    try:
        with csv_path.open("w") as f:
            f.write("entry,attachment,title,pacer_url,pacer_price_usd\n")
            for r in missing:
                t = (r["title"] or "").replace('"', "'")
                price = r["pacer_price_usd"] if r["pacer_price_usd"] is not None else ""
                f.write(f"{r['entry_label']},{r['attachment_number']},\"{t}\","
                        f"{r['pacer_url'] or ''},{price}\n")
        print(f"[verify] PACER-only gap CSV -> {csv_path} ({len(missing)} rows)")
    except Exception as e:
        print(f"[verify] CSV write failed: {e}")

    gates = {
        "all entries dated": e_dated == entries,
        "all entries described": e_described == entries,
        "no unexpected missing pdfs": unexpected_missing == 0,
        "hashes complete": no_sha == 0,
        "ledger hashes verified": unverified_hash == 0,
        "pages complete": pages_missing == 0,
    }
    passed = all(gates.values()) and docs > 0
    if passed:
        cur.execute("UPDATE corpus.matters SET verified_at=now(), "
                    "pipeline_stage='verified' WHERE matter_id=%s", (matter_id,))
        conn.commit()
    print(f"[verify] gates: {json.dumps(gates)} -> {'LIVE' if passed else 'not live yet'}")
    return {**report, **{f"gate_{k}": v for k, v in gates.items()}}


# ---------------------------------------------------------------------------

STAGES = {
    "ledger": stage_ledger,
    "parties": stage_parties,
    "match": stage_match,
    "store": stage_store,
    "write": stage_write,
    "extract": stage_extract,
    "embed": stage_embed,
    "verify": stage_verify,
}

DEFAULT_STAGES = "ledger,parties,match,store,write,extract,embed,verify"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--stages", default=DEFAULT_STAGES)
    ap.add_argument("--ledger", help="docket ledger CSV path")
    ap.add_argument("--parties", dest="parties_csv", help="parties/attorneys CSV path")
    ap.add_argument("--metadata", help="case metadata JSON path")
    ap.add_argument("--local-dir", help="folder of PDFs")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()

    cfg = load_cfg(args.slug)
    defaults = default_inputs(args.slug)
    ledger = args.ledger or defaults.get("ledger")
    parties_csv = args.parties_csv or defaults.get("parties")
    metadata = args.metadata or defaults.get("metadata")

    conn = db()
    for stage in [s.strip() for s in args.stages.split(",") if s.strip()]:
        run_stage(conn, cfg, stage,
                  lambda c, s=stage: STAGES[s](c, cfg, dry_run=args.dry_run,
                                               local_dir=args.local_dir,
                                               ledger=ledger, parties_csv=parties_csv,
                                               metadata=metadata, limit=args.limit))
    conn.close()


if __name__ == "__main__":
    main()
