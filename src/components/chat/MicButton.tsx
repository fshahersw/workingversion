// Dictation mic for the composer. Captures the microphone via the Web Audio API,
// encodes 16 kHz mono 16-bit WAV in-browser (no deps), and POSTs it to
// /api/transcribe (Bedrock Voxtral). The transcript is handed back to the composer
// for the attorney to review and edit — never auto-sent. No third-party STT: audio
// stays in our AWS account.
import { useCallback, useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";

type MicState = "idle" | "recording" | "transcribing";

export function MicButton({
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

  const start = useCallback(async () => {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
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
      // Route through a muted gain so onaudioprocess fires without echoing to speakers.
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

    // Guard against sending empty / too-short / near-silent captures. Voxtral
    // ignores "output nothing" and CONFABULATES on silence (and the legal priming
    // makes that confabulation long and plausible), so gate on real audio energy
    // here rather than trusting the model. Peak amplitude separates speech
    // (>=~0.1 with AGC) from suppressed room tone (~0) without rejecting a
    // soft-spoken attorney; the duration floor drops accidental taps.
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
      const wavB64 = encodeWavBase64(chunks, sampleRate);
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: wavB64, format: "wav" }),
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

  const recording = state === "recording";
  const transcribing = state === "transcribing";

  return (
    <button
      type="button"
      onClick={recording ? () => void stop() : () => void start()}
      disabled={disabled || transcribing}
      title={err ?? (recording ? "Stop & transcribe" : "Dictate")}
      aria-label={recording ? "Stop recording" : "Dictate"}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-50 ${
        recording
          ? "bg-brand-orange/15 text-brand-orange"
          : "text-muted-foreground hover:bg-muted hover:text-brand-navy"
      }`}
    >
      {transcribing ? (
        <Loader2 className="h-[15px] w-[15px] animate-spin" />
      ) : recording ? (
        <Square className="h-[13px] w-[13px] fill-current" />
      ) : (
        <Mic className="h-[15px] w-[15px]" strokeWidth={1.85} />
      )}
    </button>
  );
}

/** Flatten captured Float32 chunks -> 16-bit PCM -> WAV container -> base64. The
 *  header uses the ACTUAL context sample rate (browsers may ignore the 16 kHz
 *  request), so the audio is always described correctly. No external deps. */
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
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits
  wstr(36, "data");
  dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(bytes.buffer, 44).set(pcm);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
