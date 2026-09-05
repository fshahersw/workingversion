// Suggested follow-up questions (JSON, Nemotron on Bedrock).
import { createFileRoute } from "@tanstack/react-router";
import { BEDROCK_AGENT_MODEL, bedrockChat, userText } from "@/lib/agents/bedrock.server";
import { followupsPrompt } from "@/lib/agents/prompts";
import { agentLog, agentError, since, trunc } from "@/lib/agents/log.server";

function parseList(text: string): string[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]) as unknown;
      if (Array.isArray(arr)) {
        return arr.filter((v): v is string => typeof v === "string");
      }
    } catch {
      /* fall through */
    }
  }
  return text
    .split("\n")
    .map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
    .filter((l) => l.length > 8);
}

export const Route = createFileRoute("/api/followups")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { query?: string; answer?: string } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty body */
        }
        const query = (body.query ?? "").trim();
        const answer = (body.answer ?? "").slice(0, 12000);
        if (!query) return Response.json({ followups: [] });

        const started = Date.now();
        try {
          const { text } = await bedrockChat({
            model: BEDROCK_AGENT_MODEL,
            system: followupsPrompt(),
            messages: [
              userText(
                `ORIGINAL QUESTION\n${query}\n\nANSWER\n${answer}\n\nReturn a JSON array of 3 follow-up questions.`,
              ),
            ],
            maxTokens: 500,
            ...(request.signal ? { signal: request.signal } : {}),
          });
          const followups = parseList(text).slice(0, 3);
          agentLog("followups", {
            model: BEDROCK_AGENT_MODEL,
            ms: since(started),
            count: followups.length,
          });
          return Response.json({ followups });
        } catch (err) {
          agentError("followups_failed", {
            model: BEDROCK_AGENT_MODEL,
            ms: since(started),
            error: trunc(err instanceof Error ? err.message : String(err), 200),
          });
          return Response.json({ followups: [] });
        }
      },
    },
  },
});
