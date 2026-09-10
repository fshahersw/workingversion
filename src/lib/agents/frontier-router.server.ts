// ============================================================================
// Live Nemotron RoutePlan router (§7). Thin server wrapper over bedrockChat:
// one small, near-greedy, tool-less Converse call, then parse + normalize the
// RoutePlan. Any failure (throttle, malformed output) degrades to a
// deterministic fallback route so routing can never hard-fail the request.
//
// Nemotron is not a Claude model, so no prompt cache and no adaptive-thinking
// fields are sent (both are Claude-only on Bedrock Converse). Temperature is
// accepted by Nemotron.
// ============================================================================
import { bedrockChat, userText } from "./bedrock.server.ts";
import { loadRouterModel } from "./research-models.ts";
import type { RequestContext, RoutePlan } from "./frontier-contracts.ts";
import {
  ROUTER_MAX_TOKENS,
  ROUTER_SYSTEM_PROMPT,
  ROUTER_TEMPERATURE,
  buildRouterUser,
  fallbackRoutePlan,
  parseRoutePlan,
} from "./frontier-router.ts";

export interface RouteOutcome {
  route: RoutePlan;
  /** Raw model text (or the error message when the call threw). */
  raw: string;
  /** True when parsing failed and the deterministic fallback was used. */
  usedFallback: boolean;
  latencyMs: number;
  usage: { input: number; output: number };
}

export async function routeRequest(
  ctx: RequestContext,
  opts: { model?: string; signal?: AbortSignal } = {},
): Promise<RouteOutcome> {
  const model = opts.model ?? loadRouterModel();
  const start = Date.now();
  try {
    const res = await bedrockChat({
      model,
      system: ROUTER_SYSTEM_PROMPT,
      messages: [userText(buildRouterUser(ctx))],
      maxTokens: ROUTER_MAX_TOKENS,
      temperature: ROUTER_TEMPERATURE,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const route = parseRoutePlan(res.text);
    return {
      route: route ?? fallbackRoutePlan(),
      raw: res.text,
      usedFallback: route === null,
      latencyMs: Date.now() - start,
      usage: { input: res.usage.input, output: res.usage.output },
    };
  } catch (err) {
    return {
      route: fallbackRoutePlan(),
      raw: err instanceof Error ? err.message : "router failed",
      usedFallback: true,
      latencyMs: Date.now() - start,
      usage: { input: 0, output: 0 },
    };
  }
}
