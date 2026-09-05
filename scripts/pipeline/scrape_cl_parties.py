#!/usr/bin/env python3
"""Parse a CourtListener "Parties and Attorneys" HTML page into the canonical
PARTIES_AND_ATTORNEYS.csv consumed by ingest_matter.py.

Usage:
  python3 scrape_cl_parties.py page.html --out PARTIES.csv [--source-tag njd]
"""
from __future__ import annotations

import argparse
import csv
import re
import sys

from bs4 import BeautifulSoup

COLS = ["party_role", "party_name", "representation", "attorney_name",
        "attorney_designations", "attorney_phone", "attorney_fax",
        "attorney_email", "attorney_address_and_firm", "attorney_full_details"]


def text_lines(el) -> list[str]:
    return [s.replace("\xa0", " ").strip()
            for s in el.get_text("\n").split("\n") if s.strip()]


def parse(html_path: str, source_tag: str) -> list[dict]:
    soup = BeautifulSoup(open(html_path, encoding="utf-8"), "lxml")
    rows: list[dict] = []
    role = None
    for el in soup.select("h3, div.row.v-offset-above-2"):
        if el.name == "h3":
            role = el.get_text(" ", strip=True)
            continue
        cols = el.select(":scope > div")
        party_col = next((c for c in cols if "col-xs-5" in (c.get("class") or [])), None)
        atty_col = next((c for c in cols if "col-xs-4" in (c.get("class") or [])), None)
        if party_col is None:
            continue
        h4 = party_col.find("h4")
        if not h4:
            continue
        party = h4.get_text(" ", strip=True)
        note = party_col.find("em")
        terminated = note.get_text(" ", strip=True) if note else ""
        representation = f"Terminated — {terminated}" if terminated else "Active"
        if terminated:
            representation = terminated  # e.g. "Terminated (Feb. 14, 2025)"

        atty_blocks = atty_col.select("div.v-offset-below-1") if atty_col else []
        if not atty_blocks:
            rows.append({"party_role": role or "", "party_name": party,
                         "representation": representation, "attorney_name": "",
                         "attorney_designations": "", "attorney_phone": "",
                         "attorney_fax": "", "attorney_email": "",
                         "attorney_address_and_firm": "", "attorney_full_details": ""})
            continue
        for block in atty_blocks:
            name_el = block.find("h4")
            name = name_el.get_text(" ", strip=True) if name_el else ""
            phone = fax = ""
            addr_lines: list[str] = []
            designations: list[str] = []
            for p in block.find_all("p"):
                icon = p.find("i")
                title = icon.get("title", "") if icon else ""
                if title == "Phone":
                    phone = p.get_text(" ", strip=True)
                elif title == "Fax":
                    fax = p.get_text(" ", strip=True)
                elif p.find("em"):
                    designations += [e.get_text(" ", strip=True) for e in p.find_all("em")]
                else:
                    addr_lines += text_lines(p)
            full = "; ".join(filter(None, [name, ", ".join(designations),
                                           phone, " | ".join(addr_lines)]))
            if source_tag:
                full = f"[{source_tag}] {full}"
            rows.append({"party_role": role or "", "party_name": party,
                         "representation": representation,
                         "attorney_name": name,
                         "attorney_designations": ", ".join(dict.fromkeys(designations)),
                         "attorney_phone": phone, "attorney_fax": fax,
                         "attorney_email": "",
                         "attorney_address_and_firm": " | ".join(addr_lines),
                         "attorney_full_details": full})
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("html")
    ap.add_argument("--out", required=True)
    ap.add_argument("--append", action="store_true")
    ap.add_argument("--source-tag", default="")
    a = ap.parse_args()
    rows = parse(a.html, a.source_tag)
    mode = "a" if a.append else "w"
    with open(a.out, mode, newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        if mode == "w":
            w.writeheader()
        w.writerows(rows)
    print(f"[parties] {len(rows)} rows -> {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
