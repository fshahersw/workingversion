// ============================================================================
// Dictation speech-to-text via Bedrock Voxtral (Mistral) — Converse API.
//
// In-account (HIPAA-eligible, NO data egress, no third-party STT); reuses the
// app's SigV4 Bedrock transport (bedrock-sign.server). Voxtral takes an audio
// content block (wav 16kHz mono from the browser recorder) plus a text
// instruction and returns the transcript at output.message.content[].text.
//
// PRIVACY: never log the audio or the transcript — dictation may contain PHI.
// ============================================================================
import {
  signedBedrockFetch,
  BEDROCK_MAX_RETRIES,
  isRetryableBedrockStatus,
  bedrockRetryDelayMs,
  retryAfterMsFrom,
} from "./bedrock-sign.server";
import { loadBedrockRegion } from "../config.server";

// Voxtral mini (on-demand, speech->text). Override via VOXTRAL_MODEL_ID
// (e.g. mistral.voxtral-small-24b-2507 for higher accuracy).
const VOXTRAL_MODEL = process.env["VOXTRAL_MODEL_ID"] || "mistral.voxtral-mini-3b-2507";
// ~a few minutes of 16kHz mono wav; keeps the inline InvokeModel payload sane.
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

export type AudioFormat = "wav" | "mp3" | "ogg" | "flac" | "m4a" | "webm";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Transcribe base64-encoded audio to text. Throws on failure (caller maps to a
 *  502); returns "" only when the model heard nothing. */
export async function transcribeAudio(
  audioBase64: string,
  opts?: { format?: AudioFormat; signal?: AbortSignal },
): Promise<string> {
  const audio = (audioBase64 || "").trim();
  if (!audio) return "";
  if (audio.length * 0.75 > MAX_AUDIO_BYTES) {
    throw new Error("Audio too long — keep dictation under about 3 minutes.");
  }

  const region = loadBedrockRegion();
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(VOXTRAL_MODEL)}/converse`;
  const body = JSON.stringify({
    messages: [
      {
        role: "user",
        content: [
          { audio: { format: opts?.format ?? "wav", source: { bytes: audio } } },
          {
            text: "You are transcribing dictation by a U.S. litigation attorney. Transcribe the audio verbatim, in English. Expect party and law-firm names, pharmaceutical and medical terms, Latin legal phrases (voir dire, res judicata, certiorari, in limine, stare decisis), MDL and docket numbers (e.g. 2:23-cv-01234), court names, judge surnames, and case or statute citations; preserve names, numbers, and citations exactly. Output ONLY the transcript text with ordinary punctuation and capitalization: no preamble, no timestamps, no commentary, no translation, no summary. If there is no discernible speech, output nothing.",
          },
        ],
      },
    ],
    inferenceConfig: { maxTokens: 1024, temperature: 0 },
  });

  let lastErr = "transcription failed";
  for (let attempt = 0; attempt <= BEDROCK_MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await signedBedrockFetch(url, {
        body,
        headers: { accept: "application/json" },
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      lastErr = err instanceof Error ? err.message : "network error";
      if (attempt < BEDROCK_MAX_RETRIES) {
        await sleep(bedrockRetryDelayMs(attempt));
        continue;
      }
      throw new Error(lastErr);
    }

    if (res.ok) {
      const data = (await res.json()) as {
        output?: { message?: { content?: { text?: string }[] } };
      };
      return (data.output?.message?.content ?? [])
        .map((c) => c.text ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    }

    const detail = await res.text().catch(() => "");
    lastErr = `HTTP ${res.status}: ${detail.slice(0, 200)}`;
    if (isRetryableBedrockStatus(res.status) && attempt < BEDROCK_MAX_RETRIES) {
      await sleep(bedrockRetryDelayMs(attempt, retryAfterMsFrom(res)));
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error(lastErr);
}
