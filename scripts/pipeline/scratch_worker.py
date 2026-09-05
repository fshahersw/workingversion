#!/usr/bin/env python3
"""
scratch_worker.py — Docling ingestion worker for the ephemeral document
workspace (`scratch` schema).

One job = one page span of one document. The worker:

  1. claims a span with FOR UPDATE SKIP LOCKED (safe to run N copies)
  2. slices those pages out of the document's bytea into a sub-PDF
  3. converts the sub-PDF to markdown with Docling
       queue 'text' -> layout only, OCR off      (~20 pp/s/proc)
       queue 'ocr'  -> layout + OCR              (~2.5 pp/s/proc on GPU)
  4. chunks the markdown on heading boundaries
  5. embeds chunks with voyage-law-2, 128 texts per request
  6. COPYs pages + chunks into Postgres

Nothing is written to object storage. Raw bytes are dropped as soon as a
document's spans are all done; scratch.sweep() enforces the hard ceilings.

Run one pool per queue:
    python3 scripts/pipeline/scratch_worker.py --queue text --poll 5 --worker-id t1
    python3 scripts/pipeline/scratch_worker.py --queue ocr  --poll 5 --worker-id o1

Env:
    CORPUS_DB_URL       required
    VOYAGE_API_KEY      required for embeddings (chunks land unembedded without it)
    DOCLING_DEVICE      cpu | cuda | mps      (default: auto)
    SECOND_OPINION      1 to re-read low-confidence pages with Bedrock VL
    AWS_BEARER_TOKEN_BEDROCK / BEDROCK_REGION   for the second-opinion pass
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import psycopg2
import psycopg2.extras
import requests

# --------------------------------------------------------------------------- cfg

DB_URL = os.environ.get("CORPUS_DB_URL", "")
VOYAGE_KEY = os.environ.get("VOYAGE_API_KEY", "")
VOYAGE_MODEL = "voyage-law-2"
VOYAGE_BATCH = 128          # texts per request — the whole reason this is minutes
EMBED_CONCURRENCY = 16
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")
VL_MODEL = "nvidia.nemotron-nano-12b-v2"
SECOND_OPINION = os.environ.get("SECOND_OPINION", "") == "1"

CHUNK_TARGET_CHARS = 4800   # ~1200 tokens
CHUNK_OVERLAP_CHARS = 720   # ~15%
MAX_ATTEMPTS = 4
LOW_CONFIDENCE_CHARS = 40   # a page under this after conversion is suspect

WORKER_ID = "scratch"


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {WORKER_ID}: {msg}", flush=True)


def connect():
    if not DB_URL:
        raise SystemExit("CORPUS_DB_URL is not set")
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = False
    return conn


# ----------------------------------------------------------------- docling

_CONVERTERS: dict[bool, Any] = {}


def converter(ocr: bool):
    """Docling converter, one per mode, built lazily and reused for the process."""
    if ocr in _CONVERTERS:
        return _CONVERTERS[ocr]
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    opts = PdfPipelineOptions()
    opts.do_ocr = ocr
    opts.do_table_structure = True
    opts.table_structure_options.do_cell_matching = True
    opts.generate_page_images = False
    device = os.environ.get("DOCLING_DEVICE")
    if device:
        try:
            from docling.datamodel.pipeline_options import AcceleratorOptions

            opts.accelerator_options = AcceleratorOptions(device=device)
        except Exception:  # noqa: BLE001 - older docling, default device is fine
            pass

    conv = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
    )
    _CONVERTERS[ocr] = conv
    return conv


def slice_pdf(data: bytes, page_start: int, page_end: int) -> bytes:
    """Extract a 1-indexed inclusive page span into a standalone PDF."""
    import pypdfium2 as pdfium

    src = pdfium.PdfDocument(data)
    out = pdfium.PdfDocument.new()
    out.import_pages(src, list(range(page_start - 1, min(page_end, len(src)))))
    buf = io.BytesIO()
    out.save(buf)
    return buf.getvalue()


def pdf_page_count(data: bytes) -> int:
    import pypdfium2 as pdfium

    return len(pdfium.PdfDocument(data))


def convert_span(pdf_bytes: bytes, ocr: bool, offset: int) -> list[dict]:
    """Convert a sub-PDF to per-page markdown records with absolute page numbers."""
    from docling.datamodel.base_models import DocumentStream

    stream = DocumentStream(name="span.pdf", stream=io.BytesIO(pdf_bytes))
    result = converter(ocr).convert(stream)
    doc = result.document
    n = pdf_page_count(pdf_bytes)

    pages: list[dict] = []
    for local in range(1, n + 1):
        md = ""
        try:
            md = doc.export_to_markdown(page_no=local) or ""
        except TypeError:
            # older docling: no per-page export, fall back to a whole-span dump once
            md = ""
        except Exception:  # noqa: BLE001
            md = ""
        pages.append(
            {
                "page_no": offset + local - 1,
                "source": "ocr" if ocr else "text",
                "markdown": md.strip(),
                "elements": page_elements(doc, local),
            }
        )

    if not any(p["markdown"] for p in pages):
        whole = ""
        try:
            whole = doc.export_to_markdown() or ""
        except Exception:  # noqa: BLE001
            whole = ""
        if whole.strip() and pages:
            pages[0]["markdown"] = whole.strip()
    return pages


def page_elements(doc: Any, page_no: int) -> list[dict]:
    """Lightweight structural inventory per page: headings, tables, figures."""
    out: list[dict] = []
    try:
        for item, _level in doc.iterate_items():
            provs = getattr(item, "prov", None) or []
            if not any(getattr(p, "page_no", None) == page_no for p in provs):
                continue
            label = str(getattr(item, "label", "") or "")
            if label in {"section_header", "title", "table", "picture", "caption"}:
                text = (getattr(item, "text", "") or "").strip()
                entry: dict[str, Any] = {"kind": label}
                if text:
                    entry["text"] = text[:300]
                out.append(entry)
    except Exception:  # noqa: BLE001 - structure is a nicety, never fatal
        return out
    return out[:60]


# ------------------------------------------------------------------ chunking

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")


def chunk_pages(pages: list[dict]) -> list[dict]:
    """
    Split markdown on heading boundaries, packing to ~1200 tokens with overlap.
    Every chunk keeps the page range it came from and its heading path.
    """
    blocks: list[dict] = []
    path: list[str] = []
    for page in pages:
        md = page["markdown"]
        if not md:
            continue
        buf: list[str] = []
        for line in md.splitlines():
            m = HEADING_RE.match(line.strip())
            if m:
                if buf:
                    blocks.append(
                        {"page": page["page_no"], "heading": " > ".join(path), "text": "\n".join(buf)}
                    )
                    buf = []
                level = len(m.group(1))
                path = path[: level - 1] + [m.group(2).strip()]
                continue
            buf.append(line)
        if buf:
            blocks.append(
                {"page": page["page_no"], "heading": " > ".join(path), "text": "\n".join(buf)}
            )

    chunks: list[dict] = []
    cur: list[dict] = []
    size = 0
    for block in blocks:
        btext = block["text"].strip()
        if not btext:
            continue
        if size and (size + len(btext) > CHUNK_TARGET_CHARS or block["heading"] != cur[0]["heading"]):
            chunks.append(pack(cur))
            tail, tail_len = [], 0
            for b in reversed(cur):
                if tail_len >= CHUNK_OVERLAP_CHARS:
                    break
                tail.insert(0, b)
                tail_len += len(b["text"])
            cur, size = list(tail), tail_len
        cur.append(block)
        size += len(btext)
    if cur:
        chunks.append(pack(cur))
    return [c for c in chunks if c["content"].strip()]


def pack(blocks: list[dict]) -> dict:
    pageset = [b["page"] for b in blocks]
    heading = blocks[0]["heading"]
    body = "\n".join(b["text"].strip() for b in blocks if b["text"].strip())
    content = f"{heading}\n\n{body}" if heading else body
    return {
        "page_start": min(pageset),
        "page_end": max(pageset),
        "heading_path": heading or None,
        "content": content.strip()[:24000],
    }


# ---------------------------------------------------------------- embeddings


def embed_batches(texts: list[str]) -> list[list[float] | None]:
    """voyage-law-2, 128 texts per request, EMBED_CONCURRENCY requests in flight."""
    if not texts:
        return []
    if not VOYAGE_KEY:
        log("VOYAGE_API_KEY unset — chunks stored without vectors (keyword arm only)")
        return [None] * len(texts)

    batches = [texts[i : i + VOYAGE_BATCH] for i in range(0, len(texts), VOYAGE_BATCH)]
    out: list[list[list[float] | None]] = [[] for _ in batches]

    def run(idx: int) -> None:
        batch = batches[idx]
        for attempt in range(4):
            try:
                res = requests.post(
                    "https://api.voyageai.com/v1/embeddings",
                    headers={"Authorization": f"Bearer {VOYAGE_KEY}"},
                    json={
                        "model": VOYAGE_MODEL,
                        "input": [t[:20000] for t in batch],
                        "input_type": "document",
                    },
                    timeout=180,
                )
                if res.status_code in (429,) or res.status_code >= 500:
                    time.sleep(min(30, 2**attempt))
                    continue
                res.raise_for_status()
                data = res.json().get("data", [])
                vecs: list[list[float] | None] = [None] * len(batch)
                for row in data:
                    vecs[int(row.get("index", 0))] = row.get("embedding")
                out[idx] = vecs
                return
            except Exception as e:  # noqa: BLE001
                if attempt == 3:
                    log(f"embed batch {idx} failed: {e}")
                    out[idx] = [None] * len(batch)
                    return
                time.sleep(min(30, 2**attempt))

    with ThreadPoolExecutor(max_workers=EMBED_CONCURRENCY) as pool:
        list(pool.map(run, range(len(batches))))

    flat: list[list[float] | None] = []
    for vecs in out:
        flat.extend(vecs)
    return flat


# ----------------------------------------------------------- second opinion


def vl_reread(pdf_bytes: bytes, local_page: int) -> str:
    """Re-read one page with the Bedrock VL model. Best effort."""
    key = os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
    if not key:
        return ""
    try:
        import pypdfium2 as pdfium

        doc = pdfium.PdfDocument(pdf_bytes)
        bitmap = doc[local_page - 1].render(scale=300 / 72)
        buf = io.BytesIO()
        bitmap.to_pil().convert("RGB").save(buf, format="JPEG", quality=85)
        b64 = base64.b64encode(buf.getvalue()).decode()
        res = requests.post(
            f"https://bedrock-runtime.{BEDROCK_REGION}.amazonaws.com/model/{VL_MODEL}/converse",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={
                "system": [
                    {
                        "text": "You are a document OCR engine for U.S. litigation PDFs. "
                        "Return ONLY the page text in reading order, preserving headings, "
                        "Bates numbers, stamps and table structure (use | between cells). "
                        "If the page is blank, reply EMPTY."
                    }
                ],
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"image": {"format": "jpeg", "source": {"bytes": b64}}},
                            {"text": "Transcribe every readable word on this page."},
                        ],
                    }
                ],
                "inferenceConfig": {"maxTokens": 8192, "temperature": 0},
            },
            timeout=180,
        )
        res.raise_for_status()
        parts = res.json().get("output", {}).get("message", {}).get("content", [])
        text = "\n".join(p.get("text", "") for p in parts).strip()
        return "" if text.upper() == "EMPTY" else text
    except Exception as e:  # noqa: BLE001
        log(f"vl reread p{local_page} failed: {e}")
        return ""


# ----------------------------------------------------------------- job loop


def claim(conn, queue: str) -> dict | None:
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        """
        UPDATE scratch.jobs SET state='running', attempts=attempts+1,
               claimed_by=%s, claimed_at=now(), heartbeat_at=now()
        WHERE job_id = (
          SELECT job_id FROM scratch.jobs
           WHERE queue=%s AND state='queued' AND attempts < %s
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *
        """,
        (WORKER_ID, queue, MAX_ATTEMPTS),
    )
    row = cur.fetchone()
    conn.commit()
    return dict(row) if row else None


class Heartbeat:
    def __init__(self, conn_url: str, job_id: int):
        self.url, self.job_id, self._stop = conn_url, job_id, threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._stop.wait(30):
            try:
                with psycopg2.connect(self.url) as c, c.cursor() as cur:
                    cur.execute(
                        "UPDATE scratch.jobs SET heartbeat_at=now() WHERE job_id=%s", (self.job_id,)
                    )
            except Exception as e:  # noqa: BLE001 - never kill the run
                log(f"heartbeat failed: {e}")

    def __enter__(self):
        self._t.start()
        return self

    def __exit__(self, *_):
        self._stop.set()


def document_bytes(conn, document_id: str) -> bytes:
    cur = conn.cursor()
    cur.execute("SELECT bytes FROM scratch.documents WHERE document_id=%s", (document_id,))
    row = cur.fetchone()
    conn.commit()
    if not row or row[0] is None:
        raise RuntimeError("document bytes already released")
    return bytes(row[0])


def write_span(conn, job: dict, pages: list[dict], chunks: list[dict], vectors) -> None:
    cur = conn.cursor()
    psycopg2.extras.execute_values(
        cur,
        """
        INSERT INTO scratch.pages
          (document_id, session_id, page_no, source, confidence, markdown, elements)
        VALUES %s
        ON CONFLICT (document_id, page_no) DO UPDATE
          SET source=excluded.source, confidence=excluded.confidence,
              markdown=excluded.markdown, elements=excluded.elements
        """,
        [
            (
                job["document_id"],
                job["session_id"],
                p["page_no"],
                p["source"],
                p.get("confidence"),
                p["markdown"],
                json.dumps(p["elements"]),
            )
            for p in pages
        ],
    )
    if chunks:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO scratch.chunks
              (session_id, document_id, page_start, page_end, heading_path, content, embedding)
            VALUES %s
            """,
            [
                (
                    job["session_id"],
                    job["document_id"],
                    c["page_start"],
                    c["page_end"],
                    c["heading_path"],
                    c["content"],
                    ("[" + ",".join(f"{v:.6f}" for v in vec) + "]") if vec else None,
                )
                for c, vec in zip(chunks, vectors or [None] * len(chunks))
            ],
        )
    cur.execute(
        "UPDATE scratch.documents SET pages_done = pages_done + %s, status='running' "
        "WHERE document_id=%s",
        (len(pages), job["document_id"]),
    )
    cur.execute("UPDATE scratch.jobs SET state='done', error=NULL WHERE job_id=%s", (job["job_id"],))
    conn.commit()
    finalize(conn, job)


def finalize(conn, job: dict) -> None:
    """Close out the document (and session) once no spans remain, dropping bytes."""
    cur = conn.cursor()
    cur.execute(
        "SELECT count(*) FILTER (WHERE state NOT IN ('done','failed')) FROM scratch.jobs "
        "WHERE document_id=%s",
        (job["document_id"],),
    )
    if cur.fetchone()[0] == 0:
        cur.execute(
            "UPDATE scratch.documents SET status='complete', bytes=NULL WHERE document_id=%s",
            (job["document_id"],),
        )
        cur.execute(
            "SELECT count(*) FILTER (WHERE status NOT IN ('complete','failed')) "
            "FROM scratch.documents WHERE session_id=%s",
            (job["session_id"],),
        )
        if cur.fetchone()[0] == 0:
            cur.execute(
                "UPDATE scratch.sessions SET status='ready', accessed_at=now() WHERE session_id=%s",
                (job["session_id"],),
            )
    conn.commit()


def fail(conn, job: dict, err: str) -> None:
    cur = conn.cursor()
    state = "failed" if job["attempts"] >= MAX_ATTEMPTS else "queued"
    cur.execute(
        "UPDATE scratch.jobs SET state=%s, error=%s, claimed_by=NULL WHERE job_id=%s",
        (state, err[:2000], job["job_id"]),
    )
    if state == "failed":
        cur.execute(
            "UPDATE scratch.documents SET status='failed', error=%s WHERE document_id=%s",
            (err[:500], job["document_id"]),
        )
    conn.commit()
    if state == "failed":
        finalize(conn, job)


def run_job(conn, job: dict) -> None:
    t0 = time.time()
    span = f"{job['page_start']}-{job['page_end']}"
    ocr = job["queue"] == "ocr"
    data = document_bytes(conn, str(job["document_id"]))
    sub = slice_pdf(data, job["page_start"], job["page_end"])
    pages = convert_span(sub, ocr, job["page_start"])

    if SECOND_OPINION:
        for i, p in enumerate(pages, start=1):
            if len(p["markdown"]) < LOW_CONFIDENCE_CHARS:
                alt = vl_reread(sub, i)
                if len(alt) > len(p["markdown"]):
                    p["markdown"], p["source"] = alt, "vl"
    for p in pages:
        p["confidence"] = 0.2 if len(p["markdown"]) < LOW_CONFIDENCE_CHARS else 0.95
        if not p["markdown"]:
            p["source"] = "failed"

    chunks = chunk_pages(pages)
    vectors = embed_batches([c["content"] for c in chunks])
    write_span(conn, job, pages, chunks, vectors)

    n = len(pages)
    dt = max(time.time() - t0, 0.001)
    log(f"{job['queue']} span {span} · {n}pp · {len(chunks)} chunks · {n / dt:.1f} pp/s")


def main() -> int:
    global WORKER_ID
    ap = argparse.ArgumentParser()
    ap.add_argument("--queue", choices=["text", "ocr"], required=True)
    ap.add_argument("--poll", type=int, default=0, help="poll interval seconds (daemon)")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--worker-id", default=None)
    args = ap.parse_args()
    WORKER_ID = args.worker_id or f"{args.queue}-{os.getpid()}"

    conn = connect()
    log(f"worker up on queue '{args.queue}'")
    idle = 0
    last_sweep = 0.0
    while True:
        # pg_cron is not available on every corpus project, so the pool also
        # drives retention: bytes released, expired sessions dropped, dead
        # spans requeued. Cheap and idempotent — safe from every worker.
        if time.time() - last_sweep > 900:
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT scratch.sweep()")
                conn.commit()
            except Exception as e:  # noqa: BLE001
                conn.rollback()
                log(f"sweep failed: {e}")
            last_sweep = time.time()

        job = claim(conn, args.queue)
        if not job:
            if args.once or not args.poll:
                log("no work" if idle == 0 else "drained")
                return 0
            idle += 1
            time.sleep(args.poll)
            continue
        idle = 0
        with Heartbeat(DB_URL, job["job_id"]):
            try:
                run_job(conn, job)
            except Exception as e:  # noqa: BLE001
                conn.rollback()
                log(f"job {job['job_id']} failed: {e}")
                traceback.print_exc()
                fail(conn, job, str(e))
        if args.once:
            return 0


if __name__ == "__main__":
    sys.exit(main())
