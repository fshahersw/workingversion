// Loop vs writer model selection for the research agent.
//
// FAST mode runs the tool loop on Sonnet 5 (fastRouterPrompt — gather only, never
// writes) and hands the FINAL written answer to Sonnet 5 (fastWriterPrompt). Same
// model, two DISTINCT prompts: a lean gather-only router and a writer. THINK mode
// stays Sonnet 5 end to end on the single combined prompt. Fast is still tighter
// than think (leaner prompts, smaller budget, no coverage gate / faithfulness
// judge), just no longer on a weaker loop model (Nemotron/Haiku both underperformed
// on query discipline).
//
// Safety: nothing silently changes deployed traffic. Every runtime — dev and
// hosted — resolves FAST to the research model (Sonnet 5) unless BEDROCK_FAST_MODEL
// is set. Override or A/B at any time via BEDROCK_FAST_MODEL (e.g. set it to
// us.anthropic.claude-haiku-4-5-20251001-v1:0 or nvidia.nemotron-super-3-120b).
export type EnvSource = Readonly<Record<string, string | undefined>>;
export type LoopMode = "fast" | "think";

export const DEFAULT_RESEARCH_MODEL = "us.anthropic.claude-sonnet-5";
// Fast loop tool-caller = Sonnet 5 (same as the writer, but a separate gather-only
// prompt). Override/rollback via BEDROCK_FAST_MODEL.
export const DEFAULT_FAST_MODEL = "us.anthropic.claude-sonnet-5";
// Frontier redesign (referenceforagentarchitecture.md §2.1): the pure routing
// controller. Small structured RoutePlan output only, no prose, no tools.
export const DEFAULT_ROUTER_MODEL = "nvidia.nemotron-super-3-120b";
// §2.2: Grok 4.6 is the orchestrator + writer. Confirmed live in-account as
// us.xai.grok-4.6 over the SAME SigV4 Converse path as every other model here
// (no Mantle needed — the design is app-controlled, so JSON is prompt-coerced).
export const DEFAULT_GROK_MODEL = "us.xai.grok-4.6";

function runtimeEnv(): EnvSource {
  return typeof process === "undefined" ? {} : process.env;
}

/** True on a deployed runtime, where FAST must not silently change model. */
function hostedRuntime(env: EnvSource): boolean {
  const app = env["APP_ENVIRONMENT"]?.trim();
  if (app === "testing" || app === "staging" || app === "prod") return true;
  return env["NODE_ENV"] === "production";
}

export function loadResearchModel(env: EnvSource = runtimeEnv()): string {
  return env["BEDROCK_RESEARCH_MODEL"]?.trim() || DEFAULT_RESEARCH_MODEL;
}

/** FAST tool-loop model. Explicit env wins; hosted stays on the research model
 *  unless set; local dev defaults to Nemotron. */
export function loadFastModel(env: EnvSource = runtimeEnv()): string {
  const explicit = env["BEDROCK_FAST_MODEL"]?.trim();
  if (explicit) return explicit;
  if (hostedRuntime(env)) return loadResearchModel(env);
  return DEFAULT_FAST_MODEL;
}

/** FAST writer (final synthesis) model. Defaults to the research model (Sonnet). */
export function loadFastWriterModel(env: EnvSource = runtimeEnv()): string {
  return env["BEDROCK_FAST_WRITER_MODEL"]?.trim() || loadResearchModel(env);
}

/** Frontier RoutePlan router model (Nemotron). Override via NEMOTRON_MODEL_ID.
 *  The frontier path is flag-gated and separate from the live loop, so this has
 *  no deploy-safety gating — it is only reached when the new path is enabled. */
export function loadRouterModel(env: EnvSource = runtimeEnv()): string {
  return env["NEMOTRON_MODEL_ID"]?.trim() || DEFAULT_ROUTER_MODEL;
}

/** Grok orchestrator model. GROK_ORCHESTRATOR_MODEL wins, else GROK_MODEL_ID,
 *  else the in-account default. */
export function loadOrchestratorModel(env: EnvSource = runtimeEnv()): string {
  return (
    env["GROK_ORCHESTRATOR_MODEL"]?.trim() || env["GROK_MODEL_ID"]?.trim() || DEFAULT_GROK_MODEL
  );
}

/** Grok writer model. GROK_WRITER_MODEL wins, else GROK_MODEL_ID, else default. */
export function loadWriterModel(env: EnvSource = runtimeEnv()): string {
  return env["GROK_WRITER_MODEL"]?.trim() || env["GROK_MODEL_ID"]?.trim() || DEFAULT_GROK_MODEL;
}

/** Master switch for the flag-gated frontier pipeline. OFF unless FRONTIER_AGENT
 *  is truthy, so the new path stays dark in every runtime until explicitly on. */
export function frontierEnabled(env: EnvSource = runtimeEnv()): boolean {
  return /^(1|on|true|yes)$/i.test(env["FRONTIER_AGENT"]?.trim() ?? "");
}

/** Grok is a reasoning model on Bedrock Converse and, like Sonnet 5, rejects the
 *  `temperature` field; gate temperature off for these. (Prompt-cache and
 *  adaptive-thinking are already gated by isClaudeModel.) */
export function isGrokModel(model: string): boolean {
  return /xai\.grok/.test(model);
}

export function loopModel(mode: LoopMode, env: EnvSource = runtimeEnv()): string {
  return mode === "fast" ? loadFastModel(env) : loadResearchModel(env);
}

export function writerModel(mode: LoopMode, env: EnvSource = runtimeEnv()): string {
  return mode === "fast" ? loadFastWriterModel(env) : loadResearchModel(env);
}

/** Prompt-cache (cachePoint) and adaptive-thinking (thinking.adaptive +
 *  output_config.effort) are Claude-only on Bedrock Converse; sending either to
 *  Nemotron returns a 400. Gate those per-turn on this. */
export function isClaudeModel(model: string): boolean {
  return /anthropic\.claude/.test(model);
}
