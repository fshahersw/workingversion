#!/usr/bin/env python3
"""Ingest contract v1 batch runner.

Consumes batches the HTTP endpoint has marked 'queued' and executes the whole
pipeline for them: store -> write -> parties -> extract -> embed -> finalize.

Identity is composite and explicit: (matter, docket_source, entry_number,
attachment_number). Filenames are never parsed — the manifest and docket.csv
say what each object is.

    python3 scripts/pipeline/run_batch.py --once           # one queued batch
    python3 scripts/pipeline/run_batch.py --batch <uuid>   # a specific batch
    python3 scripts/pipeline/run_batch.py --poll 20        # daemon mode (pool member)
    python3 scripts/pipeline/run_batch.py --poll 60 --requeue-stale   # sweeper

Safe to run N copies at once: batches are claimed with FOR UPDATE SKIP LOCKED and
each matter is additionally guarded by a session advisory lock, so two workers can
never write the same matter concurrently. See scripts/pipeline/WORKERS.md.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import random
import socket
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ingest_matter import (  # noqa: E402  (shared env/clients/helpers)
    S3,
    TARGET_BUCKET,
    EMBED_MAX_CHARS_PER_CHUNK,
    VoyageHTTPError,
    chunk_pages,
    classify,
    db,
    embed_batches,
    is_junk_chunk,
    voyage_embed,
)


REQUIRES_FILE = {"free_pdf", "locally_supplied"}

# Worker identity (set from --worker-id / hostname) and stall thresholds.
WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"
STALE_RUNNING_MINUTES = 30
HEARTBEAT_SECONDS = 60


def log(msg: str) -> None:
    print(f"[{WORKER_ID}] {msg}", flush=True)



# --------------------------------------------------------------- keys -----
def pdf_key(slug: str, source: str, entry: int, att: int) -> str:
    return f"{slug}/pdf/{source}/{entry:05d}-{att:03d}.pdf"


def text_key(slug: str, source: str, entry: int, att: int) -> str:
    return f"{slug}/text/{source}/{entry:05d}-{att:03d}.txt"


def incoming(slug: str, batch_id: str, name: str) -> str:
    return f"{slug}/incoming/{batch_id}/{name}"


def s3_text(key: str) -> str | None:
    try:
        return S3.get_object(Bucket=TARGET_BUCKET, Key=key)["Body"].read().decode("utf-8-sig")
    except S3.exceptions.NoSuchKey:
        return None
    except Exception:
        return None


def s3_bytes(key: str) -> bytes:
    return S3.get_object(Bucket=TARGET_BUCKET, Key=key)["Body"].read()


# ------------------------------------------------------------ bookkeeping --
def set_status(conn, batch_id: str, **patch) -> None:
    cols = ", ".join(f"{k}=%s" for k in patch)
    vals = [json.dumps(v) if isinstance(v, dict) else v for v in patch.values()]
    conn.cursor().execute(
        f"UPDATE corpus.ingest_batches SET {cols}, updated_at=now() WHERE batch_id=%s",
        (*vals, batch_id),
    )
    conn.commit()


def reject(conn, batch_id: str, code: str, message: str, record_id=None, slot=None) -> None:
    conn.cursor().execute(
        "INSERT INTO corpus.ingest_rejects (batch_id, record_id, slot, code, message) "
        "VALUES (%s,%s,%s,%s,%s)",
        (batch_id, record_id, slot, code, message[:2000]),
    )


def claim(conn, batch_id: str | None) -> dict | None:
    """Atomically take one queued batch (SKIP LOCKED = safe to run N workers)."""
    cur = conn.cursor()
    if batch_id:
        cur.execute(
            "UPDATE corpus.ingest_batches SET status='running', stage='claimed', updated_at=now() "
            "WHERE batch_id=%s AND status IN ('queued','failed') RETURNING *",
            (batch_id,),
        )
    else:
        cur.execute(
            """
            UPDATE corpus.ingest_batches SET status='running', stage='claimed', updated_at=now()
            WHERE batch_id = (
              SELECT batch_id FROM corpus.ingest_batches WHERE status='queued'
              ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
            RETURNING *
            """
        )
    row = cur.fetchone()
    conn.commit()
    return row


# ------------------------------------------------------- matter serialization
def lock_matter(conn, slug: str) -> bool:
    """Session advisory lock keyed on the matter slug.

    Two batches for the SAME matter must never run at once (both upsert entries
    and refresh ordering). Different matters proceed fully in parallel. The lock
    is session-scoped, so a crashed worker releases it automatically.
    """
    cur = conn.cursor()
    cur.execute("SELECT pg_try_advisory_lock(hashtext(%s)) AS ok", (f"ingest:{slug}",))
    ok = bool(cur.fetchone()["ok"])
    conn.commit()
    return ok


def unlock_matter(conn, slug: str) -> None:
    conn.cursor().execute("SELECT pg_advisory_unlock(hashtext(%s))", (f"ingest:{slug}",))
    conn.commit()


def release_claim(conn, batch_id: str, note: str) -> None:
    """Put a claimed batch back on the queue (another matter's turn first)."""
    conn.cursor().execute(
        "UPDATE corpus.ingest_batches SET status='queued', stage='queued', updated_at=now() "
        "WHERE batch_id=%s",
        (batch_id,),
    )
    conn.commit()
    log(f"released {batch_id} back to queued: {note}")


def requeue_stale(conn) -> int:
    """Recover batches whose worker died: running + silent for too long."""
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE corpus.ingest_batches
           SET status='queued', stage='queued', updated_at=now(),
               error = 'requeued after stall (>%s min without progress)'
         WHERE status='running'
           AND updated_at < now() - (%s || ' minutes')::interval
        RETURNING batch_id
        """,
        (STALE_RUNNING_MINUTES, STALE_RUNNING_MINUTES),
    )
    rows = cur.fetchall()
    conn.commit()
    for r in rows:
        log(f"requeued stalled batch {r['batch_id']}")
    return len(rows)


class Heartbeat:
    """Touches updated_at on its own connection while a batch is running,
    so long stages (extract/embed) are never mistaken for a dead worker."""

    def __init__(self, batch_id: str):
        self.batch_id = batch_id
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.wait(HEARTBEAT_SECONDS):
            try:
                with db() as hb:
                    hb.cursor().execute(
                        "UPDATE corpus.ingest_batches SET updated_at=now() "
                        "WHERE batch_id=%s AND status='running'",
                        (self.batch_id,),
                    )
                    hb.commit()
            except Exception as e:  # noqa: BLE001 - heartbeat must never kill the run
                log(f"heartbeat failed: {e}")

    def __enter__(self):
        self._t.start()
        return self

    def __exit__(self, *_exc):
        self._stop.set()
        return False



# ----------------------------------------------------------------- matter --
def upsert_matter(cur, m: dict) -> str:
    mt = m["matter"]
    cur.execute(
        """
        INSERT INTO corpus.matters
          (slug, case_name, short_name, caption, docket_number, court_id, court_name,
           mdl_number, judge, magistrate_judge, cause, nature_of_suit, jury_demand,
           jurisdiction_type, date_filed, courtlistener_docket_id, pacer_case_id,
           courtlistener_url, pacer_url, stage, source, pipeline_stage)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'etl','ledger')
        ON CONFLICT (slug) DO UPDATE SET
          case_name=EXCLUDED.case_name, short_name=EXCLUDED.short_name,
          caption=EXCLUDED.caption, docket_number=EXCLUDED.docket_number,
          court_name=EXCLUDED.court_name, mdl_number=COALESCE(EXCLUDED.mdl_number, corpus.matters.mdl_number),
          judge=COALESCE(EXCLUDED.judge, corpus.matters.judge),
          magistrate_judge=COALESCE(EXCLUDED.magistrate_judge, corpus.matters.magistrate_judge),
          cause=COALESCE(EXCLUDED.cause, corpus.matters.cause),
          nature_of_suit=COALESCE(EXCLUDED.nature_of_suit, corpus.matters.nature_of_suit),
          jury_demand=COALESCE(EXCLUDED.jury_demand, corpus.matters.jury_demand),
          jurisdiction_type=COALESCE(EXCLUDED.jurisdiction_type, corpus.matters.jurisdiction_type),
          date_filed=COALESCE(EXCLUDED.date_filed, corpus.matters.date_filed),
          courtlistener_docket_id=COALESCE(EXCLUDED.courtlistener_docket_id, corpus.matters.courtlistener_docket_id),
          pacer_case_id=COALESCE(EXCLUDED.pacer_case_id, corpus.matters.pacer_case_id),
          courtlistener_url=COALESCE(EXCLUDED.courtlistener_url, corpus.matters.courtlistener_url),
          pacer_url=COALESCE(EXCLUDED.pacer_url, corpus.matters.pacer_url),
          stage=COALESCE(EXCLUDED.stage, corpus.matters.stage),
          last_synced_at=now(), updated_at=now()
        RETURNING matter_id
        """,
        (mt["slug"], mt["caption"], mt["short_name"], mt["caption"], mt["docket_number"],
         mt["court"], mt["court"], mt.get("mdl_number"), mt.get("judge"),
         mt.get("magistrate_judge"), mt.get("cause"), mt.get("nature_of_suit"),
         mt.get("jury_demand"), mt.get("jurisdiction_type"), mt.get("date_filed"),
         mt.get("courtlistener_docket_id"), mt.get("pacer_case_id"),
         mt.get("courtlistener_url"), mt.get("pacer_url"), mt.get("stage")),
    )
    return str(cur.fetchone()["matter_id"])


# ---------------------------------------------------------------- stages --
def stage_write(conn, batch, manifest, rows) -> dict:
    """Entries + documents, keyed by (source, entry, attachment)."""
    cur = conn.cursor()
    matter_id = upsert_matter(cur, manifest)
    slug = manifest["matter"]["slug"]
    dockets = {d["source"]: d for d in manifest["dockets"]}
    entries = documents = 0

    mains = [r for r in rows if int(r["attachment_number"]) == 0]
    for r in mains:
        src = r["docket_source"]
        cur.execute(
            """
            INSERT INTO corpus.docket_entries
              (matter_id, docket_source, entry_number, entry_label, date_filed,
               description, entry_type, source, source_docket_number)
            VALUES (%s,%s,%s,%s,%s,%s,%s,'etl',%s)
            ON CONFLICT (matter_id, docket_source, entry_number) DO UPDATE SET
              entry_label=EXCLUDED.entry_label, date_filed=EXCLUDED.date_filed,
              description=EXCLUDED.description, entry_type=EXCLUDED.entry_type,
              source_docket_number=EXCLUDED.source_docket_number, updated_at=now()
            """,
            (matter_id, src, int(r["entry_number"]), r["entry_label"], r["filed_date"],
             r.get("description", ""), r.get("doc_type") or classify(r.get("description", "")),
             (dockets.get(src) or {}).get("docket_number")),
        )
        entries += 1

    cur.execute(
        "SELECT docket_entry_id, docket_source, entry_number FROM corpus.docket_entries "
        "WHERE matter_id=%s", (matter_id,))
    entry_ids = {(e["docket_source"], e["entry_number"]): str(e["docket_entry_id"])
                 for e in cur.fetchall()}

    for r in rows:
        src, num, att = r["docket_source"], int(r["entry_number"]), int(r["attachment_number"])
        eid = entry_ids.get((src, num))
        if not eid:
            reject(conn, batch["batch_id"], "orphan_attachment",
                   f"entry {src}:{num} does not exist for attachment {att}",
                   r.get("record_id"), f"{src}:{num}:{att}")
            continue
        avail = r["availability"]
        has_file = avail in REQUIRES_FILE
        cur.execute(
            """
            INSERT INTO corpus.documents
              (matter_id, docket_entry_id, docket_source, entry_number, attachment_number,
               entry_label, title, doc_type, is_sealed, record_id, availability_status,
               expected_sha256, sha1, md5, byte_count, page_count, recap_url, archive_url,
               courtlistener_url, pacer_url, pacer_price_usd, source, text_status,
               source_docket_number)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'etl',%s,%s)
            ON CONFLICT (matter_id, docket_source, entry_number, attachment_number) DO UPDATE SET
              docket_entry_id=EXCLUDED.docket_entry_id, entry_label=EXCLUDED.entry_label,
              title=EXCLUDED.title, doc_type=EXCLUDED.doc_type, is_sealed=EXCLUDED.is_sealed,
              record_id=COALESCE(EXCLUDED.record_id, corpus.documents.record_id),
              availability_status=EXCLUDED.availability_status,
              expected_sha256=COALESCE(EXCLUDED.expected_sha256, corpus.documents.expected_sha256),
              sha1=COALESCE(EXCLUDED.sha1, corpus.documents.sha1),
              md5=COALESCE(EXCLUDED.md5, corpus.documents.md5),
              byte_count=COALESCE(EXCLUDED.byte_count, corpus.documents.byte_count),
              page_count=COALESCE(EXCLUDED.page_count, corpus.documents.page_count),
              recap_url=COALESCE(EXCLUDED.recap_url, corpus.documents.recap_url),
              archive_url=COALESCE(EXCLUDED.archive_url, corpus.documents.archive_url),
              courtlistener_url=COALESCE(EXCLUDED.courtlistener_url, corpus.documents.courtlistener_url),
              pacer_url=COALESCE(EXCLUDED.pacer_url, corpus.documents.pacer_url),
              source_docket_number=EXCLUDED.source_docket_number, updated_at=now()
            """,
            (matter_id, eid, src, num, att, r.get("entry_label", ""),
             (r.get("document_title") or r.get("description") or r["entry_label"])[:500],
             r.get("doc_type") or classify(r.get("description", ""), r.get("document_type", "")),
             (r.get("is_sealed", "").lower() == "true") or avail == "sealed",
             r.get("record_id"), avail,
             (r.get("sha256") or None) if has_file else None,
             r.get("sha1") or None, r.get("md5") or None,
             int(r["size_bytes"]) if r.get("size_bytes") else None,
             int(r["page_count"]) if r.get("page_count") else None,
             r.get("recap_pdf_url") or None, r.get("internet_archive_url") or None,
             r.get("courtlistener_document_url") or None, r.get("pacer_pdf_url") or None,
             float(r["pacer_price_usd"]) if r.get("pacer_price_usd") else None,
             "pending" if has_file else ("text_only" if avail == "text_only" else "no_text"),
             (dockets.get(src) or {}).get("docket_number")),
        )
        documents += 1
    conn.commit()
    return {"matter_id": matter_id, "entries": entries, "documents": documents}


def stage_store(conn, batch, manifest, rows, matter_id) -> dict:
    """Promote staged uploads to canonical keys after hash + PDF verification."""
    from pypdf import PdfReader

    cur = conn.cursor()
    slug = manifest["matter"]["slug"]
    stored = unchanged = failed = 0
    for r in rows:
        if r["availability"] not in REQUIRES_FILE or not r.get("file_name"):
            continue
        src, num, att = r["docket_source"], int(r["entry_number"]), int(r["attachment_number"])
        slot = f"{src}:{num}:{att}"
        dst = pdf_key(slug, src, num, att)
        try:
            data = s3_bytes(incoming(slug, batch["batch_id"], r["file_name"]))
        except Exception as e:
            failed += 1
            reject(conn, batch["batch_id"], "file_missing", f"staged object unreadable: {e}",
                   r.get("record_id"), slot)
            continue

        digest = hashlib.sha256(data).hexdigest()
        if digest != (r.get("sha256") or "").lower():
            failed += 1
            reject(conn, batch["batch_id"], "hash_mismatch",
                   f"stored bytes hash {digest}, manifest declares {r.get('sha256')}",
                   r.get("record_id"), slot)
            continue
        if not data.startswith(b"%PDF-"):
            failed += 1
            reject(conn, batch["batch_id"], "bad_pdf", "object is not a PDF",
                   r.get("record_id"), slot)
            continue
        try:
            pages = len(PdfReader(io.BytesIO(data)).pages)
        except Exception as e:
            failed += 1
            reject(conn, batch["batch_id"], "bad_pdf", f"unreadable PDF: {e}",
                   r.get("record_id"), slot)
            continue
        if pages != int(r["page_count"]):
            reject(conn, batch["batch_id"], "page_mismatch",
                   f"PDF has {pages} pages, manifest declares {r['page_count']}",
                   r.get("record_id"), slot)

        cur.execute(
            "SELECT sha256, s3_key FROM corpus.documents WHERE matter_id=%s AND docket_source=%s "
            "AND entry_number=%s AND attachment_number=%s",
            (matter_id, src, num, att))
        cur_row = cur.fetchone()
        if cur_row and cur_row["sha256"] == digest and cur_row["s3_key"]:
            unchanged += 1
            continue
        if cur_row and cur_row["sha256"] and cur_row["sha256"] != digest:
            # never overwrite a different document: keep the old object, version the new
            dst = dst[:-4] + f"-v{digest[:8]}.pdf"

        S3.put_object(Bucket=TARGET_BUCKET, Key=dst, Body=data, ContentType="application/pdf")
        cur.execute(
            "UPDATE corpus.documents SET s3_bucket=%s, s3_key=%s, sha256=%s, byte_count=%s, "
            "page_count=%s, hash_verified=true, text_status='pending', updated_at=now() "
            "WHERE matter_id=%s AND docket_source=%s AND entry_number=%s AND attachment_number=%s",
            (TARGET_BUCKET, dst, digest, len(data), pages, matter_id, src, num, att))
        stored += 1
        if stored % 25 == 0:
            conn.commit()
            print(f"  [store] {stored} stored")
    conn.commit()
    return {"stored": stored, "unchanged": unchanged, "failed": failed}


def stage_parties(conn, manifest, party_rows, matter_id) -> dict:
    cur = conn.cursor()
    parties = counsel = 0
    for p in party_rows:
        name = (p.get("party_name") or "").strip()
        if not name:
            continue
        cur.execute(
            "INSERT INTO corpus.parties (matter_id, name, party_type) VALUES (%s,%s,%s) "
            "ON CONFLICT (matter_id, name, party_type) DO NOTHING",
            (matter_id, name, p.get("party_role") or None))
        parties += 1
        att = (p.get("attorney_name") or "").strip()
        if not att:
            continue
        cur.execute(
            """
            INSERT INTO corpus.counsel
              (matter_id, party_name, attorney, firm, role, is_lead, phone, fax, address, designations)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (matter_id, attorney, firm, party_name) DO UPDATE SET
              role=COALESCE(EXCLUDED.role, corpus.counsel.role),
              phone=COALESCE(EXCLUDED.phone, corpus.counsel.phone),
              fax=COALESCE(EXCLUDED.fax, corpus.counsel.fax),
              address=COALESCE(EXCLUDED.address, corpus.counsel.address),
              designations=COALESCE(EXCLUDED.designations, corpus.counsel.designations)
            """,
            (matter_id, name, att, p.get("firm_name") or "", p.get("party_role") or None,
             "LEAD" in (p.get("attorney_designations") or "").upper(),
             p.get("attorney_phone") or None, p.get("attorney_fax") or None,
             p.get("firm_address") or None, p.get("attorney_designations") or None))
        counsel += 1
    conn.commit()
    return {"parties": parties, "counsel": counsel}


def stage_extract(conn, slug, matter_id) -> dict:
    from pypdf import PdfReader

    cur = conn.cursor()
    cur.execute(
        """
        SELECT d.document_id, d.docket_entry_id, d.docket_source, d.entry_number,
               d.attachment_number, d.s3_key, d.doc_type, d.is_sealed, d.text_status,
               e.description AS entry_description
        FROM corpus.documents d
        LEFT JOIN corpus.docket_entries e ON e.docket_entry_id = d.docket_entry_id
        WHERE d.matter_id=%s AND ((d.s3_key IS NOT NULL AND d.text_status IN ('pending','failed'))
                                  OR d.text_status='text_only')
        ORDER BY d.docket_source, d.entry_number, d.attachment_number
        """,
        (matter_id,))
    docs = cur.fetchall()
    done = no_text = failed = chunks_n = 0
    for i, d in enumerate(docs, 1):
        tk = text_key(slug, d["docket_source"], d["entry_number"], d["attachment_number"])
        try:
            if d["text_status"] == "text_only":
                pages = [(d["entry_description"] or "").strip()]
            else:
                data = s3_bytes(d["s3_key"])
                pages = [(p.extract_text() or "") for p in PdfReader(io.BytesIO(data)).pages]
            full = "\n\n".join(t for t in pages if t.strip())
            if not full.strip():
                cur.execute("UPDATE corpus.documents SET text_status='no_text' WHERE document_id=%s",
                            (d["document_id"],))
                no_text += 1
                continue
            S3.put_object(Bucket=TARGET_BUCKET, Key=tk, Body=full.encode(),
                          ContentType="text/plain; charset=utf-8")
            cur.execute("DELETE FROM corpus.doc_chunks WHERE document_id=%s", (d["document_id"],))
            for ci, (ps, pe, content) in enumerate(chunk_pages(pages)):
                cur.execute(
                    """
                    INSERT INTO corpus.doc_chunks
                      (matter_id, document_id, docket_entry_id, entry_number, attachment_number,
                       chunk_index, page_start, page_end, doc_type, is_sealed, content, token_count)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (matter_id, d["document_id"], d["docket_entry_id"], d["entry_number"],
                     d["attachment_number"], ci, ps, pe, d["doc_type"], d["is_sealed"],
                     content, len(content) // 4))
                chunks_n += 1
            cur.execute("UPDATE corpus.documents SET text_status='extracted', "
                        "page_count=COALESCE(page_count,%s) WHERE document_id=%s",
                        (len(pages), d["document_id"]))
            done += 1
        except Exception as e:
            failed += 1
            cur.execute("UPDATE corpus.documents SET text_status='failed' WHERE document_id=%s",
                        (d["document_id"],))
            print(f"  [extract] FAILED {d.get('s3_key') or d['document_id']}: {e}", file=sys.stderr)
        if i % 20 == 0:
            conn.commit()
            print(f"  [extract] {i}/{len(docs)}")
    conn.commit()
    return {"extracted": done, "no_text": no_text, "failed": failed, "chunks": chunks_n}


def embed_with_backoff(texts: list[str], key: str, attempts: int = 6) -> list[list[float]]:
    """Voyage call with bounded exponential backoff + jitter.

    The whole worker pool shares one rate-limit budget, so every worker must
    slow down rather than hammer on 429/5xx. Client errors (400/401/403 ...)
    are deterministic: re-raise immediately with the API's own message.
    """
    delay = 4.0
    for n in range(attempts):
        try:
            return voyage_embed(texts, "document", key)
        except VoyageHTTPError as e:
            if 400 <= e.code < 500 and e.code != 429:
                raise
            if n == attempts - 1:
                raise
            wait = delay * (2 ** n) * (0.5 + random.random())
            log(f"  [embed] retry {n + 1}/{attempts - 1} in {wait:.1f}s ({e})")
            time.sleep(min(wait, 120))
        except Exception as e:  # noqa: BLE001 - retry transient, re-raise at the cap
            if n == attempts - 1:
                raise
            wait = delay * (2 ** n) * (0.5 + random.random())
            log(f"  [embed] retry {n + 1}/{attempts - 1} in {wait:.1f}s ({e})")
            time.sleep(min(wait, 120))
    raise RuntimeError("unreachable")


def stage_embed(conn, matter_id) -> dict:
    key = os.environ.get("VOYAGE_API_KEY")
    if not key:
        return {"skipped": "VOYAGE_API_KEY not set"}
    cur = conn.cursor()
    cur.execute("SELECT chunk_id, content FROM corpus.doc_chunks "
                "WHERE matter_id=%s AND embedding IS NULL ORDER BY chunk_id", (matter_id,))
    rows = cur.fetchall()

    # Drop chunks from PDFs with no text layer (CID/glyph noise): useless in the
    # index, and they would otherwise stay unembedded forever.
    junk = [r["chunk_id"] for r in rows if is_junk_chunk(r["content"])]
    if junk:
        cur.execute("DELETE FROM corpus.doc_chunks WHERE chunk_id = ANY(%s)", (junk,))
        conn.commit()
        log(f"  [embed] dropped {len(junk)} unusable (no text layer) chunks")
        rows = [r for r in rows if r["chunk_id"] not in set(junk)]

    total = len(rows)
    embedded = 0
    for batch in embed_batches(rows):
        vecs = embed_with_backoff(
            [r["content"][:EMBED_MAX_CHARS_PER_CHUNK] for r in batch], key)
        for r, v in zip(batch, vecs):
            lit = "[" + ",".join(f"{x:.6f}" for x in v) + "]"
            cur.execute("UPDATE corpus.doc_chunks SET embedding=%s::extensions.vector "
                        "WHERE chunk_id=%s", (lit, r["chunk_id"]))
        embedded += len(batch)
        conn.commit()
        log(f"  [embed] {embedded}/{total}")

    return {"chunks_embedded": embedded, "junk_chunks_dropped": len(junk)}



def finalize(conn, matter_id) -> dict:
    cur = conn.cursor()
    cur.execute("SELECT corpus.refresh_display_order(%s)", (matter_id,))
    cur.execute(
        """
        UPDATE corpus.docket_entries e SET
          document_count = c.n, has_pdf = c.pdfs > 0, page_count = c.pages
        FROM (SELECT docket_entry_id, count(*) n, count(s3_key) pdfs, sum(page_count) pages
              FROM corpus.documents WHERE matter_id=%s GROUP BY docket_entry_id) c
        WHERE e.docket_entry_id = c.docket_entry_id
        """, (matter_id,))
    cur.execute("UPDATE corpus.matters SET pipeline_stage='embedded', last_synced_at=now(), "
                "verified_at=now() WHERE matter_id=%s", (matter_id,))
    cur.execute("SELECT (SELECT count(*) FROM corpus.docket_entries WHERE matter_id=%s) entries, "
                "(SELECT count(*) FROM corpus.documents WHERE matter_id=%s) documents, "
                "(SELECT count(*) FROM corpus.doc_chunks WHERE matter_id=%s) chunks, "
                "(SELECT count(*) FROM corpus.doc_chunks WHERE matter_id=%s AND embedding IS NULL) unembedded",
                (matter_id, matter_id, matter_id, matter_id))
    row = cur.fetchone()
    conn.commit()
    return dict(row)


# ------------------------------------------------------------------ main --
def run_one(conn, batch: dict) -> None:
    bid = str(batch["batch_id"])
    manifest = batch["manifest"]
    slug = manifest["matter"]["slug"]
    log(f"\n=== batch {bid}  matter {slug}  mode {manifest['batch']['mode']}")

    docket_raw = s3_text(incoming(slug, bid, "docket.csv"))
    if docket_raw is None:
        set_status(conn, bid, status="failed", stage="load", error="docket.csv missing")
        return
    rows = [
        {k: (v or "").strip() for k, v in r.items()}
        for r in csv.DictReader(io.StringIO(docket_raw))
    ]
    parties_raw = s3_text(incoming(slug, bid, "parties.csv")) or ""
    party_rows = [
        {k: (v or "").strip() for k, v in r.items()}
        for r in csv.DictReader(io.StringIO(parties_raw))
    ] if parties_raw.strip() else []

    counts: dict = dict(batch.get("counts") or {})
    counts["worker_id"] = WORKER_ID
    started = time.time()
    try:
        set_status(conn, bid, stage="write", counts=counts)
        w = stage_write(conn, batch, manifest, rows)
        matter_id = w.pop("matter_id")
        counts |= w

        set_status(conn, bid, stage="store", counts=counts)
        counts |= stage_store(conn, batch, manifest, rows, matter_id)

        set_status(conn, bid, stage="parties", counts=counts)
        counts |= stage_parties(conn, manifest, party_rows, matter_id)

        set_status(conn, bid, stage="extract", counts=counts)
        counts |= stage_extract(conn, slug, matter_id)

        set_status(conn, bid, stage="embed", counts=counts)
        counts |= stage_embed(conn, matter_id)

        set_status(conn, bid, stage="finalize", counts=counts)
        counts |= finalize(conn, matter_id)
        counts["elapsed_seconds"] = round(time.time() - started, 1)

        hard = conn.cursor().execute(
            "SELECT count(*) AS n FROM corpus.ingest_rejects WHERE batch_id=%s", (bid,)).fetchone()["n"]
        set_status(conn, bid, status="completed", stage="done", counts=counts,
                   error=None if not hard else f"{hard} record-level reject(s)")
        conn.cursor().execute(
            "UPDATE corpus.ingest_batches SET completed_at=now() WHERE batch_id=%s", (bid,))
        conn.commit()
        log(f"=== completed {bid}: {json.dumps(counts, default=str)}")
    except Exception as e:
        conn.rollback()
        counts["elapsed_seconds"] = round(time.time() - started, 1)
        set_status(conn, bid, status="failed", error=str(e)[:2000], counts=counts)
        print(f"[{WORKER_ID}] === FAILED {bid}: {e}", file=sys.stderr, flush=True)


def process_next(conn, batch_id: str | None) -> str:
    """Claim + run one batch. Returns 'ran', 'skipped' (matter busy) or 'idle'."""
    batch = claim(conn, batch_id)
    if not batch:
        return "idle"
    slug = (batch["manifest"] or {}).get("matter", {}).get("slug")
    if not slug:
        set_status(conn, str(batch["batch_id"]), status="failed", stage="load",
                   error="manifest has no matter.slug")
        return "ran"
    if not lock_matter(conn, slug):
        release_claim(conn, str(batch["batch_id"]), f"another worker holds {slug}")
        return "skipped"
    try:
        with Heartbeat(str(batch["batch_id"])):
            run_one(conn, batch)
    finally:
        unlock_matter(conn, slug)
    return "ran"


def main() -> int:
    global WORKER_ID
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", help="run one specific batch id")
    ap.add_argument("--once", action="store_true", help="run at most one queued batch")
    ap.add_argument("--poll", type=int, default=0, help="poll interval seconds (daemon)")
    ap.add_argument("--worker-id", help="label for logs and batch counts")
    ap.add_argument("--requeue-stale", action="store_true",
                    help="also recover batches stuck in 'running' with a dead worker")
    args = ap.parse_args()
    if args.worker_id:
        WORKER_ID = args.worker_id

    with db() as conn:
        while True:
            if args.requeue_stale:
                try:
                    requeue_stale(conn)
                except Exception as e:  # noqa: BLE001 - sweeper must not die
                    log(f"stale sweep failed: {e}")
            outcome = process_next(conn, args.batch)
            if outcome == "ran":
                if args.once or args.batch:
                    return 0
                continue
            if outcome == "skipped":
                # Matter busy elsewhere; brief pause so we don't spin on it.
                time.sleep(min(args.poll or 5, 5))
                if args.batch:
                    return 0
                continue
            if not args.poll:
                log("no queued batches")
                return 0
            time.sleep(args.poll + random.uniform(0, 2))



if __name__ == "__main__":
    raise SystemExit(main())
