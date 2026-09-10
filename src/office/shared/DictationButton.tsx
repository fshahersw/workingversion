// Dictation mic for the Sheets and Slides assistant composers. Same pipeline as
// the Writer's mic: the microphone is captured with the Web Audio API, encoded
// as 16 kHz mono 16-bit WAV in the browser and posted to /api/transcribe
// (Bedrock, inside our AWS account). The transcript is appended to the composer
// for the attorney to review; it is never auto-sent.
import { useCallback, useEffect, useRef, useState } from "react";

type MicState = "idle" | "recording" | "transcribing";

const STYLE_ID = "sw-dictate-style";
const CSS = `
.sw-dictate-btn{display:inline-grid;place-items:center;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--text-secondary,#606366);cursor:pointer;padding:0}
.sw-dictate-btn:hover{background:var(--hover,#f5f5f5);color:var(--text,#242424)}
.sw-dictate-btn:disabled{opacity:.5;cursor:default}
.sw-dictate-btn.recording{color:var(--color-ai-action,#e8663f);background:color-mix(in srgb,var(--color-ai-action,#e8663f) 14%,transparent)}
.sw-dictate-btn.busy svg{animation:sw-dictate-spin 1s linear infinite}
@keyframes sw-dictate-spin{to{transform:rotate(360deg)}}
`;

function ensureStyle(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

export function DictationButton({
  onTranscript,
  disabled,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<MicState>("idle");
  const [err, setErr] = useState<string | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  useEffect(ensureStyle, []);

  const supported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  const teardown = useCallback(() => {
    try {
      procRef.current?.disconnect();
      srcRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void ctxRef.current?.close().catch(() => {});
    procRef.current = null;
    srcRef.current = null;
    streamRef.current = null;
    ctxRef.current = null;
  }, []);
  useEffect(() => teardown, [teardown]);

  const start = useCallback(async () => {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error("no AudioContext");
      const ctx = new Ctor({ sampleRate: 16000 });
      ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      srcRef.current = src;
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      procRef.current = proc;
      chunksRef.current = [];
      proc.onaudioprocess = (e) => {
        chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      setState("recording");
    } catch {
      setErr("Mic access denied");
      setState("idle");
      teardown();
    }
  }, [teardown]);

  const stop = useCallback(async () => {
    const sampleRate = ctxRef.current?.sampleRate ?? 16000;
    const chunks = chunksRef.current;
    teardown();
    // Gate on real audio energy: the transcriber confabulates on silence.
    let samples = 0;
    let peak = 0;
    for (const c of chunks) {
      samples += c.length;
      for (let i = 0; i < c.length; i++) {
        const a = Math.abs(c[i]!);
        if (a > peak) peak = a;
      }
    }
    if (samples / sampleRate < 0.25 || peak < 0.02) {
      setErr("No speech detected");
      setState("idle");
      return;
    }
    setState("transcribing");
    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: encodeWavBase64(chunks, sampleRate), format: "wav" }),
      });
      const data = (await res.json()) as { text?: string; error?: string };
      const text = (data.text ?? "").trim();
      if (text) onTranscript(text);
      else setErr(data.error || "No speech detected");
    } catch {
      setErr("Transcription failed");
    } finally {
      setState("idle");
    }
  }, [onTranscript, teardown]);

  if (!supported) return null;
  const recording = state === "recording";
  const transcribing = state === "transcribing";
  return (
    <button
      type="button"
      className={`sw-dictate-btn${recording ? " recording" : ""}${transcribing ? " busy" : ""}`}
      disabled={disabled || transcribing}
      onClick={() => (recording ? void stop() : void start())}
      data-tip={err ?? (recording ? "Stop & transcribe" : transcribing ? "Transcribing…" : "Dictate")}
      aria-label={recording ? "Stop recording" : "Dictate"}
    >
      {transcribing ? (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
          <path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      ) : recording ? (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
          <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
          <path d="M12 15a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 1 0-7 0v5.5A3.5 3.5 0 0 0 12 15Z" fill="currentColor" />
          <path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21M9 21h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

/** Float32 chunks -> 16-bit PCM -> WAV -> base64, header at the actual sample rate. */
function encodeWavBase64(chunks: Float32Array[], sampleRate: number): string {
  let total = 0;
  for (const c of chunks) total += c.length;
  const pcm = new Int16Array(total);
  let o = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]!));
      pcm[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const dv = new DataView(bytes.buffer);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  dv.setUint32(4, 36 + pcm.length * 2, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wstr(36, "data");
  dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(bytes.buffer, 44).set(pcm);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
