# Seeger Weiss top-50 matters: registry coverage report

A one-off research report. No app code changes.

## What I already verified in the registry

- 4,159 matters total: 16 supporting masters, 57 target matters, 4,086 public dockets.
- Counsel data names 12 firms; **Seeger Weiss appears on 38 matters** — the only firm-level link between the corpus and the firm's actual caseload.
- Coverage on those 38 is very uneven: Testosterone Replacement Therapy has 2,184 entries / 2,553 docs, VW Clean Diesel has 661 entries but only 3 with text, and most `target_matter` rows have 0–1 entries.

## The work

**1. Build the "top 50" list (research)**
Sources, in priority order:
- Seeger Weiss firm site (current cases / practice pages) for what the firm publicly claims.
- JPML active MDL statistics for MDLs where Seeger Weiss holds leadership (lead/co-lead counsel, PSC, liaison).
- CourtListener/RECAP and news for recent filings and leadership appointments (2024–2026).

Rank by relevance to the firm: leadership role, MDL size (pending actions), and recency/activity. Output 50 rows with case name, court, MDL/docket number, status (active/recent), and the firm's role.

**2. Match each to the registry**
Match on docket number + court first, then normalized case name, then MDL number via `matter_relationships`. Each row lands in one of: `present`, `present under a different node role` (e.g. only member cases, no master), or `absent`.

**3. Docket completeness % per matter**
For every matched matter, compare registry entry count against the true docket length from CourtListener's docket for that case (highest entry number / reported entry count):

```text
completeness = registry entries with a real entry_number / source docket entry count
```
Rows also carry entry-text coverage and document counts as secondary columns, since a docket can be "complete" in row count while 99% of its text is missing (VW Clean Diesel: 661 entries, 3 with text).

**4. Deliverables**
- A ranked table in chat: rank, matter, court/MDL, status, in registry?, registry entries, source entries, completeness %, text %, docs.
- `/mnt/documents/seeger-weiss-top50-coverage.csv` and a short markdown summary with the headline numbers (how many of the 50 we hold, how many are >90% complete, the biggest gaps).

## Technical notes

- Registry reads go through the existing corpus Postgres connection, read-only; no migrations, no schema changes.
- Source-of-truth docket lengths come from the CourtListener API; where a case isn't in RECAP, the row is marked `unknown source total` rather than guessed.
- Research runs through parallel sub-agents so the 50 lookups don't serialize.
