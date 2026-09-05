# Matters — new tab under Home

A litigation-professional workspace where each active matter (MDL, mass tort program, class action) gets a structured, AI-aware home. Frontend-only for now, backed by realistic Seeger Weiss demo data; the chat agent stays the intelligence layer.

## Navigation

Sidebar order: Home → **Matters** → Conversations. Icon: `Scale` (or `Briefcase`) from lucide.

Routes:
- `/matters` — matter list
- `/matters/$matterId` — matter detail

## Matters list page

Dense, shadcn-style table matching the Home dashboard's editorial tone:

- Header: "Matters" + count, small "New matter" button (non-functional shell), search field, status filter chips (Active / Discovery / Trial-set / Settled / Closed).
- Columns: Matter name, Type (MDL / Class Action / Single-event), Court & MDL no., Lead attorney, Plaintiffs, Next deadline, Status pill, Last activity.
- Zebra rows, 36px height, hover highlight, sortable headers, row click → detail.
- Seed with ~10 credible mass-tort matters (e.g. Talc MDL, AFFF/PFAS, Roundup, Camp Lejeune, Hair Relaxer, Zantac, Social Media Adolescent Addiction, Bard Hernia Mesh) with plausible courts, judges, and dates.

## Matter detail page

Two-column layout, scrollable, dense cards:

Left (primary):
- Matter header: caption, MDL number, court, judge, status pill, key dates.
- Case summary paragraph + posture ("bellwether discovery, first trial set…").
- Key deadlines timeline (compact vertical list, overdue/soon color coding).
- Recent activity feed (filings, orders, expert reports) with dates.
- Documents table stub (name, type, date, source) — display only.

Right (rail):
- Team card (lead, associates, paralegal) with initials avatars.
- Metrics: plaintiff count, tolled claims, PFS completion %, upcoming depositions — small stat tiles.
- **Ask about this matter** card: prompt input + 3 matter-specific suggested prompts that deep-link to `/conversations` with the question prefilled, so the existing agent answers with matter context prepended.

## Agent integration

- Matter context (caption, court, posture, key issues) is appended to the system prompt when a question is launched from a matter, reusing the existing hardcoded-persona approach in `orchestrate.ts`.
- Deep link: `/conversations?q=...&matter=...`; `conversations.tsx` reads the search params and auto-fills (not auto-sends) the composer.

## Technical notes

- New files: `src/routes/matters.tsx` (layout/list), `src/routes/matters.$matterId.tsx`, `src/lib/matters-data.ts` (typed demo dataset), `src/components/matters/*` (MattersTable, MatterHeader, DeadlineList, ActivityFeed, StatTiles, AskAboutMatter).
- Reuse existing tokens (`brand-navy`, `brand-blue-soft`), white background, 0.5rem radii, no new color system.
- Each route gets its own `head()` metadata.
- No backend, no database, no auth work — pure frontend with local demo data.

## Open choice

Data is hardcoded demo data now; wiring to real records can come later if you want persistence.
