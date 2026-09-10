// ============================================================================
// Research state (§28/§43) — the explicit application-level ledger the research
// loop reads and writes. Pure and model-agnostic: no model private state drives
// correctness (§36). Holds accumulated evidence, the coverage matrix, and known
// limitations, and derives requirement status deterministically from the
// supports/contradicts links tool wrappers stamp on each EvidenceItem.
//
// Compaction (§37) is satisfied by construction: this state stores EvidenceItem
// metadata + a short excerpt + a textRef pointer, never raw source bytes, so
// the model context never carries 120 KB of HTML.
// ============================================================================
import type {
  EvidenceBundle,
  EvidenceItem,
  RequestContext,
  ResearchRequirement,
  RoutePlan,
  ToolRunResult,
} from "./frontier-contracts.ts";
import { dedupeEvidence, isPrimarySource, rankEvidence } from "./frontier-authority.ts";

/** A compact record of one executed tool call, fed back to the orchestrator so
 *  it can see what already ran (and what failed) and adapt — narrow, switch
 *  provider, or race — instead of repeating a call that timed out. */
export interface ActivityEntry {
  round: number;
  tool: string;
  ok: boolean;
  detail: string;
  count: number;
}

export class ResearchState {
  readonly ctx: RequestContext;
  readonly route: RoutePlan;
  /** 1-based round index the loop is currently executing. */
  round = 0;
  requirements: ResearchRequirement[];
  limitations: string[] = [];
  /** Per-call outcome log across rounds (see ActivityEntry). */
  activity: ActivityEntry[] = [];
  private items: EvidenceItem[] = [];

  constructor(ctx: RequestContext, route: RoutePlan, requirements: ResearchRequirement[] = []) {
    this.ctx = ctx;
    this.route = route;
    this.requirements = requirements.map((r) => ({ ...r }));
  }

  /** Fold a batch of tool results into the ledger. Failed calls become honest
   *  limitations (§57) rather than silent gaps, and every call (success or
   *  failure) is logged to activity so the next orchestrator turn can adapt. */
  add(results: readonly ToolRunResult[]): void {
    for (const r of results) {
      this.activity.push({
        round: this.round,
        tool: r.tool,
        ok: r.ok,
        detail: r.ok ? (r.summary ?? `${r.evidence.length} result(s)`) : (r.error ?? "failed"),
        count: r.evidence.length,
      });
      if (r.ok) {
        this.items.push(...r.evidence);
      } else if (r.error) {
        this.limitations.push(`${r.tool} unavailable: ${r.error}`);
      }
    }
  }

  /** Collapse duplicate sources, then order strongest-authority-first (§12). */
  dedupeAndRank(): void {
    this.items = rankEvidence(dedupeEvidence(this.items));
  }

  /**
   * Recompute each requirement's status from the evidence links (§43). A
   * requirement is:
   *   - conflicted  when it has both supporting and contradicting evidence;
   *   - verified    when >=1 primary (level 1-2) source supports it, or >=2
   *                 sources of any level do;
   *   - partial     when only weaker/secondary support exists;
   *   - missing     when nothing references it.
   */
  updateCoverage(): void {
    for (const req of this.requirements) {
      const supporting = this.items.filter((it) => it.supports.includes(req.id));
      const contradicting = this.items.filter((it) => it.contradicts.includes(req.id));
      req.evidenceIds = supporting.map((it) => it.id);
      if (supporting.length && contradicting.length) {
        req.status = "conflicted";
      } else if (contradicting.length) {
        req.status = "conflicted";
      } else if (supporting.length) {
        const hasPrimary = supporting.some((it) => isPrimarySource(it.authorityLevel));
        req.status = hasPrimary || supporting.length >= 2 ? "verified" : "partial";
      } else {
        req.status = "missing";
      }
    }
  }

  /**
   * Completeness gate (§44, coverage half). True only when there ARE required
   * requirements and every one is verified or conflicted. With no requirements,
   * returns false so the orchestrator's own complete/handoff decision drives
   * stopping instead. Citation-integrity/freshness are checked separately at
   * verification time.
   */
  isComplete(): boolean {
    const required = this.requirements.filter((r) => r.required);
    if (!required.length) return false;
    return required.every((r) => r.status === "verified" || r.status === "conflicted");
  }

  /** Current evidence, strongest-first (a copy — callers cannot mutate state). */
  evidence(): EvidenceItem[] {
    return [...this.items];
  }

  count(): number {
    return this.items.length;
  }

  /** The bundle handed to verification and the writer. */
  bundle(): EvidenceBundle {
    return {
      items: this.evidence(),
      requirements: this.requirements.map((r) => ({ ...r })),
      limitations: [...this.limitations],
    };
  }
}
