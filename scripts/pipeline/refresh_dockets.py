#!/usr/bin/env python3
"""Drain corpus.docket_events into ETL contract v1 batches.

    python3 scripts/pipeline/refresh_dockets.py --once
    python3 scripts/pipeline/refresh_dockets.py --poll 30          # daemon
    python3 scripts/pipeline/refresh_dockets.py --reconcile        # hourly sweep

Flow per event: claim (FOR UPDATE SKIP LOCKED) -> normalize provider payload
into docket rows -> fetch PDFs (DocketBird first, RECAP fallback, else
metadata-only) -> POST /api/public/ingest/batches -> upload -> validate ->
commit. run_batch.py then does store/extract/embed exactly as for any other
bundle: this script never writes docket_entries, documents or chunks itself.

Rules that must not drift:
  * never invent an entry number — unnumbered filings are skipped and logged,
  * composite identity is (matter, docket_source, entry_number, attachment_number),
  * an entry with no obtainable PDF is ingested as text_only/pacer_link and
    recorded in corpus.pdf_pending for later retry.
"""
from __future__ import annotations

import argparse
import csv
import io
import hashlib
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ingest_matter import db  # noqa: E402

WORKER = f"{socket.gethostname()}:{os.getpid()}"
CL_API = "https://www.courtlistener.com/api/rest/v4"
DB_API = "https://api.docketbird.com/v1"
CL_STORAGE = "https://storage.courtlistener.com/"
MAX_ATTEMPTS = 5

DOCKET_COLUMNS = [
    "record_id", "docket_source", "entry_number", "entry_label", "attachment_number",
    "filed_date", "description", "document_title", "document_type", "availability",
    "file_name", "page_count", "size_bytes", "sha256", "is_sealed",
    "recap_pdf_url", "courtlistener_document_url", "pacer_pdf_url",
]


def log(msg: str) -> None:
    print(f"[{WORKER}] {msg}", flush=True)


def ingest_base() -> str:
    return os.environ.get("INGEST_BASE_URL", "https://litdev.lovable.app").rstrip("/")


def ingest_key() -> str:
    k = os.environ.get("INGEST_API_KEY")
    if not k:
        raise SystemExit("INGEST_API_KEY is not set")
    return k


def http(url: str, method="GET", body: bytes | dict | None = None,
         headers: dict[str, str] | None = None, timeout=120):
    data = body
    hdrs = dict(headers or {})
    if isinstance(body, dict):
        data = json.dumps(body).encode()
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode()


def api(path: str, method="GET", body: dict | None = None):
    status, raw = http(f"{ingest_base()}{path}", method, body, {"X-Ingest-Key": ingest_key()})
    try:
        return status, json.loads(raw.decode() or "{}")
    except Exception:
        return status, {"raw": raw[:400].decode(errors="replace")}


# ------------------------------------------------------------- normalize ---
def iso_date(v) -> str | None:
    if not v:
        return None
    s = str(v)[:10]
    try:
        datetime.strptime(s, "%Y-%m-%d")
        return s
    except ValueError:
        return None


def norm_courtlistener(payload: dict) -> list[dict]:
    """CourtListener docket-alert payload -> normalized rows."""
    results = (payload.get("payload") or payload).get("results") or payload.get("results") or []
    out: list[dict] = []
    for entry in results:
        entry_number = entry.get("entry_number")
        filed = iso_date(entry.get("date_filed") or entry.get("date_created"))
        desc = (entry.get("description") or "").strip()
        if entry_number is None or filed is None:
            continue  # never invent a docket number
        docs = entry.get("recap_documents") or [{}]
        for d in docs:
            att = d.get("attachment_number") or 0
            out.append({
                "entry_number": int(entry_number),
                "attachment_number": int(att),
                "filed_date": filed,
                "description": desc or (d.get("description") or "").strip(),
                "document_title": (d.get("description") or "").strip() or None,
                "page_count": d.get("page_count"),
                "is_sealed": bool(d.get("is_sealed")),
                "pdf_url": (CL_STORAGE + d["filepath_local"]) if d.get("filepath_local") else None,
                "cl_document_id": d.get("id"),
                "courtlistener_document_url": (
                    f"https://www.courtlistener.com{d['absolute_url']}" if d.get("absolute_url") else None
                ),
                "db_document_id": None,
            })
    return out


def norm_docketbird(payload: dict) -> list[dict]:
    """DocketBird webhook payload -> normalized rows (defensive about shape)."""
    items = (payload.get("documents") or payload.get("filings")
             or payload.get("data") or payload.get("entries") or [])
    if isinstance(items, dict):
        items = [items]
    out: list[dict] = []
    for d in items:
        num = d.get("entry_number") or d.get("document_number") or d.get("docket_number")
        filed = iso_date(d.get("filed_date") or d.get("date_filed") or d.get("filed_on"))
        if num is None or filed is None:
            continue
        try:
            entry_number = int(str(num).split(".")[0])
        except ValueError:
            continue
        out.append({
            "entry_number": entry_number,
            "attachment_number": int(d.get("attachment_number") or 0),
            "filed_date": filed,
            "description": (d.get("description") or d.get("docket_text") or "").strip(),
            "document_title": (d.get("title") or "").strip() or None,
            "page_count": d.get("page_count"),
            "is_sealed": bool(d.get("is_sealed")),
            "pdf_url": d.get("pdf_url") or d.get("download_url"),
            "cl_document_id": None,
            "db_document_id": d.get("id") or d.get("document_id"),
            "courtlistener_document_url": None,
        })
    return out


# ------------------------------------------------------------- pdf fetch ---
def fetch_pdf(row: dict) -> bytes | None:
    dbkey = os.environ.get("DOCKETBIRD_API_KEY")
    if dbkey and row.get("db_document_id"):
        status, raw = http(
            f"{DB_API}/documents/{row['db_document_id']}/download",
            headers={"X-API-Key": dbkey, "Authorization": f"Bearer {dbkey}"},
        )
        if status == 200 and raw[:4] == b"%PDF":
            return raw
    if row.get("pdf_url"):
        status, raw = http(row["pdf_url"])
        if status == 200 and raw[:4] == b"%PDF":
            return raw
    return None


def page_count(pdf: bytes) -> int | None:
    try:
        from pypdf import PdfReader
        return len(PdfReader(io.BytesIO(pdf)).pages)
    except Exception:
        return None


# ------------------------------------------------------------ bundle push --
def submit_bundle(matter: dict, source: str, rows: list[dict], event_id: str) -> tuple[str | None, str | None]:
    """Build and commit one ETL v1 batch. Returns (batch_id, error)."""
    prepared: list[dict] = []
    files: list[tuple[str, bytes]] = []
    pending: list[dict] = []
    pages = total_bytes = 0

    for r in rows:
        entry, att = r["entry_number"], r["attachment_number"]
        base = {
            "record_id": f"{source}-{entry}-{att}",
            "docket_source": source,
            "entry_number": entry,
            "entry_label": str(entry),
            "attachment_number": att,
            "filed_date": r["filed_date"],
            "description": r["description"] or f"Docket entry {entry}",
            "document_title": r.get("document_title") or "",
            "document_type": "",
            "is_sealed": "true" if r.get("is_sealed") else "false",
            "recap_pdf_url": r.get("pdf_url") if (r.get("pdf_url") or "").startswith("https://storage.courtlistener") else "",
            "courtlistener_document_url": r.get("courtlistener_document_url") or "",
            "pacer_pdf_url": "",
        }
        pdf = None if r.get("is_sealed") else fetch_pdf(r)
        if pdf:
            name = f"{source}-{entry:05d}-{att:03d}.pdf"
            pc = page_count(pdf) or r.get("page_count") or 1
            prepared.append({**base, "availability": "free_pdf", "file_name": name,
                             "page_count": pc, "size_bytes": len(pdf),
                             "sha256": hashlib.sha256(pdf).hexdigest()})
            files.append((name, pdf))
            pages += int(pc)
            total_bytes += len(pdf)
        else:
            availability = "sealed" if r.get("is_sealed") else ("pacer_link" if r.get("pdf_url") else "text_only")
            prepared.append({**base, "availability": availability, "file_name": "",
                             "page_count": "", "size_bytes": "", "sha256": ""})
            if availability == "pacer_link":
                pending.append({"entry_number": entry, "attachment_number": att,
                                "cl_document_id": r.get("cl_document_id"),
                                "db_document_id": r.get("db_document_id"),
                                "reason": "pdf_not_free_at_ingest"})

    if not prepared:
        return None, "no_usable_rows"

    manifest = {
        "contract_version": "1.0",
        "idempotency_key": f"watch-{event_id}",
        "matter": {
            "slug": matter["slug"],
            "short_name": matter["short_name"] or matter["case_name"][:80],
            "caption": matter["caption"] or matter["case_name"],
            "docket_number": matter["docket_number"],
            "court": matter["court_id"],
        },
        "dockets": [{"source": source, "docket_number": matter["docket_number"]}],
        "batch": {"mode": "incremental", "filename_inference": False,
                  "submitted_by": f"docket-watch/{WORKER}"},
        "files": [{"file_name": n, "size_bytes": len(b)} for n, b in files],
        "totals": {"document_slots": len(prepared), "pdf_files": len(files),
                   "total_pages": pages, "total_bytes": total_bytes},
    }

    status, body = api("/api/public/ingest/batches", "POST", manifest)
    if status not in (200, 201):
        return None, f"create_failed {status}: {json.dumps(body)[:300]}"
    batch_id = body["batch_id"]
    uploads = body["uploads"]

    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=DOCKET_COLUMNS, extrasaction="ignore",
                       lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    w.writeheader()
    for row in prepared:
        w.writerow(row)
    st, _ = http(uploads["docket_csv"], "PUT", buf.getvalue().encode(),
                 {"Content-Type": "text/csv"})
    if st not in (200, 204):
        return batch_id, f"docket_csv_upload_{st}"

    by_name = dict(files)
    for f in uploads["files"]:
        st, _ = http(f["url"], "PUT", by_name[f["file_name"]], {"Content-Type": "application/pdf"})
        if st not in (200, 204):
            return batch_id, f"pdf_upload_{st}"

    status, body = api(f"/api/public/ingest/batches/{batch_id}/validate", "POST")
    if status != 200:
        return batch_id, f"validate_failed {status}: {json.dumps(body)[:400]}"

    status, body = api(f"/api/public/ingest/batches/{batch_id}/commit", "POST")
    if status not in (200, 201):
        return batch_id, f"commit_failed {status}: {json.dumps(body)[:300]}"

    if pending:
        with db() as conn, conn.cursor() as cur:
            for p in pending:
                cur.execute(
                    """insert into corpus.pdf_pending
                         (matter_slug, docket_source, entry_number, attachment_number,
                          cl_document_id, db_document_id, reason)
                       values (%s,%s,%s,%s,%s,%s,%s)
                       on conflict (matter_slug, docket_source, entry_number, attachment_number)
                       do nothing""",
                    (matter["slug"], source, p["entry_number"], p["attachment_number"],
                     p["cl_document_id"], p["db_document_id"], p["reason"]),
                )
            conn.commit()
    return batch_id, None


# ---------------------------------------------------------------- claim ----
def claim_event(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            with next as (
              select event_id from corpus.docket_events
               where status = 'pending' and attempts < %s
               order by received_at
               for update skip locked limit 1
            )
            update corpus.docket_events e
               set status='claimed', attempts = e.attempts + 1,
                   claimed_by=%s, claimed_at=now()
              from next where e.event_id = next.event_id
            returning e.*
            """,
            (MAX_ATTEMPTS, WORKER),
        )
        row = cur.fetchone()
    conn.commit()
    return row


def matter_for(conn, event) -> dict | None:
    with conn.cursor() as cur:
        if event["watch_id"]:
            cur.execute(
                """select m.*, w.docket_source from corpus.matters m
                     join corpus.docket_watches w on w.matter_id = m.matter_id
                    where w.watch_id = %s""",
                (event["watch_id"],),
            )
        elif event["cl_docket_id"]:
            cur.execute("select *, 'main' as docket_source from corpus.matters where courtlistener_docket_id = %s",
                        (event["cl_docket_id"],))
        elif event["matter_slug"]:
            cur.execute("select *, 'main' as docket_source from corpus.matters where slug = %s",
                        (event["matter_slug"],))
        else:
            return None
        return cur.fetchone()


def finish(conn, event_id: str, status: str, batch_id: str | None, error: str | None):
    with conn.cursor() as cur:
        cur.execute(
            """update corpus.docket_events
                  set status=%s, batch_id=%s, error=%s, processed_at=now()
                where event_id=%s""",
            (status, batch_id, error, event_id),
        )
    conn.commit()


def process_one() -> bool:
    with db() as conn:
        event = claim_event(conn)
        if not event:
            return False
        eid = str(event["event_id"])
        try:
            matter = matter_for(conn, event)
            if not matter:
                finish(conn, eid, "skipped", None, "no matching matter/watch")
                log(f"{eid} skipped: unmatched")
                return True

            payload = event["payload"] or {}
            rows = (norm_courtlistener(payload) if event["provider"] in ("courtlistener", "reconcile")
                    else norm_docketbird(payload))
            if not rows:
                finish(conn, eid, "skipped", None, "no numbered entries in payload")
                log(f"{eid} skipped: nothing to ingest")
                return True

            source = matter.get("docket_source") or "main"
            batch_id, err = submit_bundle(matter, source, rows, eid)
            if err:
                status = "pending" if event["attempts"] < MAX_ATTEMPTS else "failed"
                finish(conn, eid, status, batch_id, err)
                log(f"{eid} {status}: {err}")
            else:
                finish(conn, eid, "ingested", batch_id, None)
                with conn.cursor() as cur:
                    cur.execute("update corpus.docket_watches set last_sync_at=now(), "
                                "failure_count=0, last_error=null where watch_id=%s",
                                (event["watch_id"],))
                conn.commit()
                log(f"{eid} ingested -> batch {batch_id} ({len(rows)} rows)")
        except Exception as e:  # never leave an event claimed
            finish(conn, eid, "pending" if event["attempts"] < MAX_ATTEMPTS else "failed",
                   None, f"{type(e).__name__}: {e}"[:500])
            log(f"{eid} error: {e}")
        return True


# ------------------------------------------------------------ reconcile ----
def reconcile(limit: int = 50) -> int:
    """Safety net: pull recent CL entries for active watches and enqueue them
    as synthetic events. Dedupe on the event key keeps this idempotent."""
    tok = os.environ.get("COURTLISTENER_API_TOKEN")
    if not tok:
        log("reconcile skipped: COURTLISTENER_API_TOKEN not set")
        return 0
    hdr = {"Authorization": f"Token {tok}"}
    made = 0
    with db() as conn, conn.cursor() as cur:
        cur.execute(
            """select watch_id, matter_slug, cl_docket_id from corpus.docket_watches
                where status='active' and cl_docket_id is not null
                order by last_sync_at nulls first limit %s""",
            (limit,),
        )
        for w in cur.fetchall():
            q = urllib.parse.urlencode({"docket": w["cl_docket_id"], "order_by": "-date_filed",
                                        "page_size": 20})
            status, raw = http(f"{CL_API}/docket-entries/?{q}", headers=hdr)
            if status != 200:
                continue
            body = json.loads(raw.decode() or "{}")
            results = body.get("results") or []
            if not results:
                continue
            newest = results[0]
            key = f"reconcile:{w['cl_docket_id']}:{newest.get('id')}"
            cur.execute(
                """insert into corpus.docket_events
                     (provider, provider_event_id, watch_id, matter_slug, cl_docket_id, payload)
                   values ('reconcile', %s, %s, %s, %s, %s)
                   on conflict (provider, provider_event_id) do nothing""",
                (key, w["watch_id"], w["matter_slug"], w["cl_docket_id"],
                 json.dumps({"results": results})),
            )
            made += cur.rowcount
            time.sleep(0.3)
        conn.commit()
    log(f"reconcile enqueued {made} event(s)")
    return made


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--poll", type=int, default=0)
    ap.add_argument("--reconcile", action="store_true")
    ap.add_argument("--worker-id")
    args = ap.parse_args()

    global WORKER
    if args.worker_id:
        WORKER = args.worker_id

    if args.reconcile:
        reconcile()

    if args.once or not args.poll:
        while process_one():
            pass
        return 0

    log(f"polling every {args.poll}s")
    while True:
        try:
            worked = process_one()
        except Exception as e:
            log(f"loop error: {e}")
            worked = False
        if not worked:
            time.sleep(args.poll)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
