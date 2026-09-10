// Dictation speech-to-text endpoint. Accepts { audio: base64, format? } and
// returns { text }. Same edge-auth posture as /api/orchestrate. The handler never
// logs the audio or the transcript (possible PHI).
import { createFileRoute } from "@tanstack/react-router";
import { transcribeAudio, type AudioFormat } from "@/lib/agents/transcribe.server";

const FORMATS = new Set<AudioFormat>(["wav", "mp3", "ogg", "flac", "m4a", "webm"]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { audio?: string; format?: string } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty body */
        }
        const audio = (body.audio ?? "").trim();
        if (!audio) return json({ error: "audio is required" }, 400);
        const format: AudioFormat = FORMATS.has(body.format as AudioFormat)
          ? (body.format as AudioFormat)
          : "wav";
        try {
          const text = await transcribeAudio(audio, { format, signal: request.signal });
          return json({ text });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : "transcription failed" }, 502);
        }
      },
    },
  },
});
