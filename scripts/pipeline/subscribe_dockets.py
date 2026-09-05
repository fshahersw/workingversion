#!/usr/bin/env python3
"""Register every corpus matter for provider push notifications.

Idempotent. Run it after adding matters, or on a schedule.

    python3 scripts/pipeline/subscribe_dockets.py --dry-run
    python3 scripts/pipeline/subscribe_dockets.py                # all matters
    python3 scripts/pipeline/subscribe_dockets.py --slug insulin

What it does per matter:
  1. resolve the CourtListener docket id (matters.courtlistener_docket_id, else
     a court + docket_number lookup),
  2. create a CourtListener docket alert if one does not exist,
  3. resolve the DocketBird docket id when DOCKETBIRD_API_KEY is configured,
  4. upsert corpus.docket_watches.

It never invents docket numbers and never writes to docket_entries. Matters it
cannot resolve are stored with status='unresolved' so /pipeline can show them.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ingest_matter import db  # noqa: E402

CL_API = "https://www.courtlistener.com/api/rest/v4"
DB_API = "https://api.docketbird.com/v1"


def _req(url: str, token_header: dict[str, str], method: str = "GET", body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in token_header.items():
        req.add_header(k, v)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:500]}
    except Exception as e:  # network/DNS
        return 0, {"error": str(e)}


def cl_headers() -> dict[str, str] | None:
    tok = os.environ.get("COURTLISTENER_API_TOKEN")
    return {"Authorization": f"Token {tok}"} if tok else None


def db_headers() -> dict[str, str] | None:
    key = os.environ.get("DOCKETBIRD_API_KEY")
    return {"X-API-Key": key, "Authorization": f"Bearer {key}"} if key else None


def resolve_cl_docket(court_id: str, docket_number: str, hdr: dict[str, str]) -> int | None:
    q = urllib.parse.urlencode({"court": court_id, "docket_number": docket_number})
    status, body = _req(f"{CL_API}/dockets/?{q}", hdr)
    if status != 200:
        return None
    for row in body.get("results", []) or []:
        if str(row.get("docket_number", "")).strip() == docket_number.strip():
            return int(row["id"])
    results = body.get("results") or []
    return int(results[0]["id"]) if results else None


def existing_alert(cl_docket_id: int, hdr: dict[str, str]) -> int | None:
    status, body = _req(f"{CL_API}/docket-alerts/?docket={cl_docket_id}", hdr)
    if status != 200:
        return None
    results = body.get("results") or []
    return int(results[0]["id"]) if results else None


def create_alert(cl_docket_id: int, hdr: dict[str, str]) -> tuple[int | None, str | None]:
    found = existing_alert(cl_docket_id, hdr)
    if found:
        return found, None
    status, body = _req(f"{CL_API}/docket-alerts/", hdr, "POST", {"docket": cl_docket_id})
    if status in (200, 201):
        return int(body.get("id")) if body.get("id") else None, None
    if status == 400 and "already" in json.dumps(body).lower():
        return existing_alert(cl_docket_id, hdr), None
    return None, f"cl_alert_failed {status}: {json.dumps(body)[:200]}"


def resolve_docketbird(court_id: str, docket_number: str, hdr: dict[str, str]) -> tuple[str | None, str | None]:
    q = urllib.parse.urlencode({"court_id": court_id, "case_number": docket_number})
    status, body = _req(f"{DB_API}/cases?{q}", hdr)
    if status != 200:
        return None, f"docketbird_lookup_{status}"
    rows = body.get("data") or body.get("cases") or body.get("results") or []
    if isinstance(rows, dict):
        rows = [rows]
    if not rows:
        return None, "docketbird_no_match"
    row = rows[0]
    ident = row.get("id") or row.get("case_id") or row.get("docket_id")
    return (str(ident) if ident else None), None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    clh = cl_headers()
    dbh = db_headers()
    if not clh:
        print("COURTLISTENER_API_TOKEN not set — alerts cannot be created", file=sys.stderr)

    with db() as conn, conn.cursor() as cur:
        sql = ("select matter_id, slug, docket_number, court_id, courtlistener_docket_id "
               "from corpus.matters")
        params: tuple = ()
        if args.slug:
            sql += " where slug = %s"
            params = (args.slug,)
        cur.execute(sql + " order by slug", params)
        matters = cur.fetchall()

        for m in matters:
            slug = m["slug"]
            errors: list[str] = []
            cl_id = m["courtlistener_docket_id"]
            alert_id = None
            dbird_id = None

            if clh:
                if not cl_id:
                    cl_id = resolve_cl_docket(m["court_id"], m["docket_number"], clh)
                    time.sleep(0.3)
                if cl_id:
                    alert_id, err = create_alert(int(cl_id), clh)
                    if err:
                        errors.append(err)
                else:
                    errors.append("courtlistener_no_match")

            if dbh:
                dbird_id, err = resolve_docketbird(m["court_id"], m["docket_number"], dbh)
                if err:
                    errors.append(err)

            status = "active" if (alert_id or dbird_id) else "unresolved"
            print(f"{slug:28s} cl={cl_id} alert={alert_id} db={dbird_id} -> {status}"
                  + (f"  [{'; '.join(errors)}]" if errors else ""))

            if args.dry_run:
                continue

            cur.execute(
                """
                insert into corpus.docket_watches
                  (matter_id, matter_slug, docket_source, court_id, docket_number,
                   cl_docket_id, cl_alert_id, db_docket_id, status, last_sync_at, last_error)
                values (%s,%s,'main',%s,%s,%s,%s,%s,%s, now(), %s)
                on conflict (matter_id, docket_source) do update set
                  court_id      = excluded.court_id,
                  docket_number = excluded.docket_number,
                  cl_docket_id  = coalesce(excluded.cl_docket_id, corpus.docket_watches.cl_docket_id),
                  cl_alert_id   = coalesce(excluded.cl_alert_id, corpus.docket_watches.cl_alert_id),
                  db_docket_id  = coalesce(excluded.db_docket_id, corpus.docket_watches.db_docket_id),
                  status        = excluded.status,
                  last_sync_at  = now(),
                  last_error    = excluded.last_error
                """,
                (m["matter_id"], slug, m["court_id"], m["docket_number"],
                 cl_id, alert_id, dbird_id, status, "; ".join(errors) or None),
            )
            if cl_id and not m["courtlistener_docket_id"]:
                cur.execute(
                    "update corpus.matters set courtlistener_docket_id = %s where matter_id = %s",
                    (cl_id, m["matter_id"]),
                )
        conn.commit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
