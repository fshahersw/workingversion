// ============================================================================
// Live Grok writer (§10/§64). Streams one tool-less Converse turn via
// streamOneTurn: text deltas are the answer (onAnswer), reasoning deltas stay on
// a separate channel and are never rendered (§1.4). Model us.xai.grok-4.6 — no
// temperature (rejected), no cache, no adaptive-thinking effort (Grok reasons on
// its own); a generous token floor so reasoning + prose both fit.
// ============================================================================
import { streamOneTurn } from "./bedrock-stream-tools.server.ts";
import { userText } from "./bedrock.server.ts";
import { loadWriterModel } from "./research-models.ts";
import type { EvidenceBundle, RequestContext, RoutePlan } from "./frontier-contracts.ts";
import { WRITER_SYSTEM_PROMPT, buildWriterUser, writerMaxTokens } from "./frontier-writer.ts";

export interface WriterHandlers {
  onAnswer: (delta: string) => void;
  onReasoning?: (delta: string) => void;
}

export interface WriterResult {
  text: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  stopReason: string;
}

export async function streamGrokWriter(
  args: {
    ctx: RequestContext;
    bundle: EvidenceBundle;
    route: RoutePlan;
    model?: string;
    maxTokens?: number;
    instructions?: readonly string[];
    signal?: AbortSignal;
  },
  handlers: WriterHandlers,
): Promise<WriterResult> {
  const model = args.model ?? loadWriterModel();
  const maxTokens = args.maxTokens ?? writerMaxTokens(args.route.answerStyle);
  const turn = await streamOneTurn(
    {
      model,
      system: WRITER_SYSTEM_PROMPT,
      messages: [userText(buildWriterUser(args.ctx, args.bundle, args.route, args.instructions))],
      maxTokens,
      ...(args.signal ? { signal: args.signal } : {}),
    },
    handlers.onAnswer,
    handlers.onReasoning,
  );
  return { text: turn.text, usage: turn.usage, stopReason: turn.stopReason };
}
