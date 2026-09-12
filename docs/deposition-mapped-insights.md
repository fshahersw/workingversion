# Deposition mapped insights

Local implementation in the Discovery deposition connection graph. The feature
computes review leads from the current analysis and active graph filters. It uses
the real extracted graph, including when a saved deposition is reopened. There is
no sample-data fallback, new model call, backend write, or schema migration.

## User flow

- Open **Connections → Mapped insights** after reading a deposition.
- **Patterns** identifies shared references across transcripts, connection hubs,
  entities connecting otherwise separate groups, and separate evidence groups.
- **Review** surfaces paired potential conflicts and relationships that lack
  matched source evidence. Isolated entities are also identified.
- Select an insight to highlight and frame its entities and relationships. The
  expanded card explains why it surfaced, suggests a next review step, and lists
  the specific relationships behind it. Each relationship opens the existing
  quotation panel and transcript citation controls.
- **Groups** maps every entity in a selected layout cluster, rather than selecting
  its first entity. A selected entity's dossier also offers up to six short
  source-matched paths, each with a **Map path** action.
- **Recenter** restores the current map after manual panning or zooming.
  **Show full graph** clears the map. Closing an insight inspector retains the
  highlighted map while making more room for the canvas.

## Evidence and algorithm contract

`src/lib/pile/graph-insights.ts` exposes a pure, deterministic analysis function.
Its input must come from the existing transcript verification pipeline; it does
not independently re-read or re-verify transcripts.

A structural relationship requires `evidenceStatus: source_matched`, a named
source, and a quotation. Unnumbered source-matched text can still participate;
the citation panel does not invent page/line navigation. A paired comparison
requires two individually matched, named passages. Comparisons do not become
structural relationships connecting the two witnesses.

- Shared references count distinct filenames, never distinct citation strings.
  They do not imply independent witnesses, agreement, or corroboration.
- Hubs count distinct direct neighbors. Duplicate links do not inflate degree.
- Bridge detection removes each entity and counts resulting branches of at least
  two entities within its original connected component. Leaf-only stars are hubs,
  not bridges. Alternate paths prevent a bridge finding.
- Separate groups are connected components of source-linked relationships, not
  inferred legal topics. Missing paths can reflect extraction or filter coverage.
- Potential conflicts originate in the existing paired analysis, not a keyword
  match on a relationship label. The interface explicitly asks readers to compare
  subject, question, time, and scope. Matching quotations does not establish that
  the interpretations or claimed inconsistency are correct.
- Self-links and dangling endpoints are discarded. Duplicate relationship
  identities include both comparison passages. Ordering is deterministic.

Analysis is bounded to 400 entities and 4,000 relationships, ordered by stable
identity. Partial graph coverage is disclosed with analyzed/total counts. The
panel shows up to 24 prioritized leads, with up to six per kind, and reports when
more candidates exist. Narrowing filters recomputes insights. Heuristic ordering
is a navigation aid, not a confidence score or legal importance ranking.

`graph-paths.ts` now uses bounded breadth-first traversal (12,000 neighbor visits,
256 candidate routes, at most four hops; current product default is three).
Paths preserve relationship direction when traversed backward. Missing source
filenames are no longer replaced with citation strings for transcript counts.

## Camera and responsive behavior

`src/components/summarize/useGraphCamera.ts` owns one camera for entity
neighborhoods, evidence links, groups, paths, and insights. It fits actual card
bounds, including negative coordinates, and does not impose a minimum fit scale
that would clip large selections. It observes the real viewport dimensions,
including inspector opening/closing and window resizing.

Automatic movement uses a 360 ms eased animation. Reduced-motion preference skips
the animation; manual pan or zoom interrupts it. Repeated selection can recenter
the same map. Filter or analysis replacement clears stale mapped selections.
The inspector stays beside the canvas from 800 px of component width; smaller
components dock it below with bounded height. This avoids wasting graph height on
ordinary laptop-sized windows.

## Maintenance and verification

- Pure analysis and camera geometry regressions: `src/lib/pile/graph-insights.test.ts`.
- Direction and dense-graph path bounds: `src/lib/pile/graph-paths.test.ts`.
- Real component browser interactions: `tests/discovery/mapped-insights.spec.ts`.
  These check transformed card bounds, responsive reframing, group/path membership,
  reduced motion, manual pan/recenter, source navigation, paired quotations,
  filter changes, and replacement with a different analysis.
- Synthetic testimony is confined to `tests/discovery/graph-insights.fixture.ts`.
  It is never imported by product routes or stored in application databases.

See `discovery-reliability-graph.md` for the earlier save-recovery changes, local
development setup, backend/auth limitations, and combined validation commands.
