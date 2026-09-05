Switch research final writer to Sonnet 5 on AWS Bedrock

Goal
Update the final writer model from the current GLM-5 (`zai.glm-5`) back to Anthropic Claude Sonnet 5 on AWS Bedrock, restoring the adaptive-thinking writer path.

Changes
1. Update the `BEDROCK_WRITER_MODEL` secret to `us.anthropic.claude-sonnet-5`.
2. Verify the new value is active in the runtime environment.

Impact
- The writer will route through `streamBedrockClaude` instead of `streamBedrockConverse`.
- Adaptive thinking will be enabled (`thinking: { type: "adaptive" }`).
- `output_config.effort` will be honored (`low` for conversational, `medium` for scoped/deep).
- `max_tokens` floor remains 8,000 on the Anthropic path because thinking and visible answer share the budget.
- No code changes are required; the model is env-driven in `src/lib/agents/bedrock-claude.server.ts`.

Verification
- Read `process.env['BEDROCK_WRITER_MODEL']` after the secret update and confirm it returns `us.anthropic.claude-sonnet-5`.
