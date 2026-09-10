// ============================================================================
// Live Grok research orchestrator (§8). Implements the Orchestrator port over
// the existing SigV4 Converse path (bedrockChat), model us.xai.grok-4.6.
//
// Grok is a reasoning model: no `temperature` (it rejects it), no prompt cache
// (not Claude), and a generous token budget so hidden reasoning plus the JSON
// decision both fit. Any failure degrades to handoff_to_writer so the loop
// always makes progress and writes from whatever evidence exists (§57).
// ============================================================================
import { bedrockChat, userText } from "./bedrock.server.ts";
import { loadOrchestratorModel } from "./research-models.ts";
import { agentError, agentLog, trunc } from "./log.server";
import type { OrchestratorDecision } from "./frontier-contracts.ts";
import type { Orchestrator } from "./frontier-research-loop.server.ts";
import type { ResearchState } from "./frontier-research-state.ts";
import {
  DEFAULT_TOOL_CATALOG,
  ORCHESTRATOR_MAX_TOKENS,
  ORCHESTRATOR_SYSTEM_PROMPT,
  buildOrchestratorUser,
  parseOrchestratorDecision,
  type ToolSpec,
} from "./frontier-orchestrator.ts";

export class GrokOrchestrator implements Orchestrator {
  private readonly model: string;
  private readonly toolCatalog: readonly ToolSpec[];

  constructor(opts: { model?: string; toolCatalog?: readonly ToolSpec[] } = {}) {
    this.model = opts.model ?? loadOrchestratorModel();
    this.toolCatalog = opts.toolCatalog ?? DEFAULT_TOOL_CATALOG;
  }

  async decide(state: ResearchState, signal?: AbortSignal): Promise<OrchestratorDecision> {
    try {
      const res = await bedrockChat({
        model: this.model,
        system: ORCHESTRATOR_SYSTEM_PROMPT,
        messages: [userText(buildOrchestratorUser(state, this.toolCatalog))],
        maxTokens: ORCHESTRATOR_MAX_TOKENS,
        ...(signal ? { signal } : {}),
      });
      const decision = parseOrchestratorDecision(res.text) ?? { status: "handoff_to_writer" as const };
      agentLog("frontier_decide", {
        round: state.round,
        status: decision.status,
        calls: decision.calls?.length ?? 0,
        stop: res.stopReason,
        out_tokens: res.usage.output,
        raw_len: res.text.length,
        raw: trunc(res.text, 300),
      });
      return decision;
    } catch (err) {
      agentError("frontier_decide_failed", {
        round: state.round,
        error: trunc(err instanceof Error ? err.message : "decide failed", 200),
      });
      return { status: "handoff_to_writer" };
    }
  }
}
