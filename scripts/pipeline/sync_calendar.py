#!/usr/bin/env python3
"""Cache DocketBird AutoCalendar into corpus.calendar_entries.

    python scripts/pipeline/sync_calendar.py
    python scripts/pipeline/sync_calendar.py --days 180
"""
from __future__ import annotations

import argparse
import json
import os
import re
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
from psycopg.types.json import Json

ROOT = Path(__file__).resolve().parents[2]
DB_API = "https://api.docketbird.com"
CORE_RE = re.compile(r"(\d{2,4})-([a-z]+)-(\d+)", re.I)


def load_env() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        val = v.strip().strip('"').strip("'")
        if val:
            os.environ[k.strip()] = val


def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}", flush=True)


def docket_core(value: str | None) -> str | None:
    if not value:
        return None
    m = CORE_RE.search(value)
    if not m:
        return None
    year = f"20{m.group(1)}" if len(m.group(1)) == 2 else m.group(1)
    return f"{year}-{m.group(2).lower()}-{int(m.group(3))}"


def fingerprint(case_id: str, date: str, time: str | None, title: str) -> str:
    return f"{case_id}|{date}|{time or ''}|{title}"


def fetch_rollup(days: int) -> tuple[list[dict], str | None, str | None, str | None]:
    key = os.environ.get("DOCKETBIRD_API_KEY") or ""
    if not key:
        raise SystemExit("DOCKETBIRD_API_KEY is not set")
    req = urllib.request.Request(
        f"{DB_API}/calendar_entries?days={days}",
        headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        obj = json.loads(r.read().decode("utf-8"))
    data = obj.get("data") or obj
    rows = data.get("calendar_entries") or []
    return (
        rows if isinstance(rows, list) else [],
        data.get("window_start"),
        data.get("window_end"),
        data.get("calendar_last_updated"),
    )


def main() -> None:
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=180)
    args = ap.parse_args()
    days = max(1, min(args.days, 180))

    dsn = os.environ.get("CORPUS_DB_URL")
    if not dsn:
        raise SystemExit("CORPUS_DB_URL is not set")

    log("applying schema")
    with psycopg.connect(dsn, autocommit=True) as raw:
        # The SQL file is multiple statements; psycopg 3 needs them split
        # around function bodies. Use a simple runner via the connection's
        # pipeline-less execute of the whole script through libpq isn't
        # supported — fall back to psql-compatible statement split on
        # semicolons that are not inside $...$ dollar quotes.
        text = (ROOT / "supabase" / "corpus" / "calendar-entries.sql").read_text(encoding="utf-8")
        run_sql_script(raw, text)

    log(f"fetching DocketBird AutoCalendar days={days}")
    raw_rows, window_start, window_end, source_updated = fetch_rollup(days)
    log(f"  firm rows {len(raw_rows)}")

    today = datetime.now(timezone.utc).date()
    ws = window_start or today.isoformat()
    we = window_end or (today + timedelta(days=days)).isoformat()

    with psycopg.connect(dsn) as conn:
        matters = conn.execute(
            "SELECT matter_id, slug, short_name, case_name, docket_number FROM corpus.matters"
        ).fetchall()
        by_core: dict[str, tuple] = {}
        for matter_id, slug, short_name, case_name, docket_number in matters:
            core = docket_core(docket_number)
            if core:
                by_core[core] = (str(matter_id), slug, short_name or case_name or slug)

        entries: dict[str, dict] = {}
        skipped = 0
        linked = 0
        for row in raw_rows:
            if not isinstance(row, dict):
                continue
            case_id = str(row.get("case_id") or "").strip()
            date = str(row.get("date") or "")[:10]
            title = str(row.get("title") or "").strip() or "Calendar entry"
            if not case_id or not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
                skipped += 1
                continue
            matter = by_core.get(docket_core(case_id) or "")
            case_name = str(row.get("case_name") or case_id)
            time = str(row.get("time") or "").strip() or None
            src = row.get("source_document_id")
            fp = fingerprint(case_id, date, time, title)
            if matter:
                linked += 1
            entries[fp] = {
                "fingerprint": fp,
                "matter_id": matter[0] if matter else None,
                "matter_slug": matter[1] if matter else case_id,
                "matter_name": matter[2] if matter else case_name,
                "case_id": case_id,
                "case_name": case_name,
                "event_date": date,
                "event_time": time,
                "title": title,
                "source_document_id": str(src) if src is not None else None,
                "in_corpus": bool(matter),
            }

        payload = {
            "window_start": str(ws)[:10],
            "window_end": str(we)[:10],
            "source_updated": source_updated,
            "skipped": skipped,
            "entries": list(entries.values()),
        }
        result = conn.execute(
            "SELECT public.corpus_calendar_sync(%s::jsonb)",
            [Json(payload)],
        ).fetchone()
        conn.commit()
        log(
            f"  stored {len(entries)}  workspace-linked {linked}  "
            f"bad-rows {skipped}  result {result[0] if result else result}"
        )


def run_sql_script(conn: psycopg.Connection, text: str) -> None:
    """Execute a SQL file that may contain dollar-quoted function bodies."""
    parts: list[str] = []
    buf: list[str] = []
    in_dollar: str | None = None
    i = 0
    while i < len(text):
        if in_dollar:
            end = text.find(in_dollar, i)
            if end < 0:
                buf.append(text[i:])
                break
            buf.append(text[i : end + len(in_dollar)])
            i = end + len(in_dollar)
            in_dollar = None
            continue
        if text.startswith("--", i):
            nl = text.find("\n", i)
            i = len(text) if nl < 0 else nl + 1
            buf.append("\n")
            continue
        if text[i] == "$":
            m = re.match(r"\$[A-Za-z0-9_]*\$", text[i:])
            if m:
                in_dollar = m.group(0)
                buf.append(in_dollar)
                i += len(in_dollar)
                continue
        if text[i] == ";":
            stmt = "".join(buf).strip()
            if stmt:
                parts.append(stmt)
            buf = []
            i += 1
            continue
        buf.append(text[i])
        i += 1
    tail = "".join(buf).strip()
    if tail:
        parts.append(tail)
    for stmt in parts:
        if stmt:
            conn.execute(stmt)  # type: ignore[arg-type]


if __name__ == "__main__":
    main()
