import { officeVoiceGrantFn } from "@/lib/office/voice.functions";
import type { VoiceTaskRouter } from "./voice-task-router";

export type VoiceState = "connecting" | "listening" | "muted" | "reconnecting" | "off";
export interface VoiceLine {
  role: "user" | "assistant";
  text: string;
}

export class OfficeVoiceClient {
  private closed = false;
  private ready = false;
  private muted = false;
  private socket?: WebSocket;
  private stream?: MediaStream;
  private audio?: AudioContext;
  private capture?: AudioWorkletNode;
  private sources = new Set<AudioBufferSourceNode>();
  private cursor = 0;
  private transcript: VoiceLine[] = [];
  private content = new Map<string, { role: string; final: boolean; text: string }>();
  private renewInFlight = false;
  private connectionTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private options: {
      app: string;
      document: string;
      mode: string;
      router: VoiceTaskRouter;
      onState(state: VoiceState): void;
      onError(message: string): void;
      onTranscript(lines: VoiceLine[]): void;
      /** Dependency injection for transport verification; production uses the authenticated grant RPC. */
      grant?: () => Promise<{ url: string; token: string }>;
    },
  ) {}

  private getGrant() {
    return this.options.grant
      ? this.options.grant()
      : officeVoiceGrantFn({
          data: {
            app: this.options.app,
            document: this.options.document,
            mode: this.options.mode,
          },
        });
  }

  async start() {
    try {
      if (
        !window.isSecureContext ||
        !navigator.mediaDevices?.getUserMedia ||
        !window.AudioWorkletNode
      )
        throw new Error("Live voice needs a secure browser with microphone support.");
      this.options.onState("connecting");
      // Resume inside the user gesture so browser playback is unlocked.
      this.audio = new AudioContext();
      await this.audio.resume();
      let grant = await this.getGrant();
      const grantedAt = Date.now();
      if (this.closed) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (this.closed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      stream.getTracks().forEach((t) => {
        t.onended = () => this.fail("Microphone disconnected. Reconnect to continue voice.");
      });
      await this.audio.audioWorklet.addModule("/office-voice-capture.js");
      if (this.closed) return;
      this.capture = new AudioWorkletNode(this.audio, "office-voice-capture");
      const silent = this.audio.createGain();
      silent.gain.value = 0;
      this.audio
        .createMediaStreamSource(stream)
        .connect(this.capture)
        .connect(silent)
        .connect(this.audio.destination);
      this.capture.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
        if (!this.ready || this.closed) return;
        if ((this.socket?.bufferedAmount || 0) > 128000) {
          this.fail("Voice upload is too slow. Reconnect when your connection improves.");
          return;
        }
        // Muted tracks are disabled; send silence to keep the stream alive.
        const bytes = this.muted ? new Uint8Array(data.byteLength) : new Uint8Array(data);
        this.send({ type: "audio", data: btoa(String.fromCharCode(...bytes)) });
      };
      if (Date.now() - grantedAt > 45000) grant = await this.getGrant();
      if (!this.closed) this.connect(grant);
    } catch (error) {
      if (!this.closed)
        this.fail(error instanceof Error ? error.message : "Voice could not connect.");
    }
  }

  private connect(grant: { url: string; token: string }) {
    const ws = new WebSocket(grant.url);
    this.socket = ws;
    this.ready = false;
    this.content.clear();
    clearTimeout(this.connectionTimer);
    this.connectionTimer = setTimeout(
      () => this.fail("Voice gateway did not respond. Check the gateway connection."),
      20000,
    );
    ws.onopen = () => {
      if (this.closed || ws !== this.socket) {
        ws.close();
        return;
      }
      ws.send(
        JSON.stringify({
          type: "auth",
          token: grant.token,
          resume: this.transcript
            .map((l) => `${l.role}: ${l.text}`)
            .join("\n")
            .slice(-12000),
        }),
      );
    };
    ws.onmessage = (event) => {
      if (this.closed || ws !== this.socket) return;
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "ready") {
          clearTimeout(this.connectionTimer);
          this.ready = true;
          this.options.onState(this.muted ? "muted" : "listening");
        } else if (message.type === "error") this.fail(message.message || "Voice gateway failed.");
        else if (message.type === "renew") void this.renew();
        else if (message.type === "tool") {
          if (
            typeof message.id !== "string" ||
            typeof message.name !== "string" ||
            !message.input ||
            typeof message.input !== "object"
          )
            throw new Error("Invalid voice tool event");
          this.send({
            type: "tool_result",
            id: message.id,
            result: this.options.router.dispatch(message.id, message.name, message.input),
          });
        } else if (message.type === "event") this.receive(message.event);
      } catch {
        this.fail("Invalid voice response. Reconnect to continue.");
      }
    };
    ws.onerror = () => {
      if (ws === this.socket && !this.closed)
        this.fail("Voice gateway is unavailable. Your Office task can continue.");
    };
    ws.onclose = () => {
      if (ws === this.socket && !this.closed)
        this.fail(
          "Voice connection closed. Reconnect to continue; your Office task is unaffected.",
        );
    };
  }

  private receive(event: Record<string, Record<string, unknown>>) {
    const start = event.contentStart;
    if (start) {
      const extra =
        typeof start.additionalModelFields === "string"
          ? JSON.parse(start.additionalModelFields)
          : {};
      this.content.set(String(start.contentName), {
        role: String(start.role),
        final: start.role === "USER" || extra.generationStage === "FINAL",
        text: "",
      });
    }
    const text = event.textOutput;
    if (text) {
      const value = String(text.content || "");
      if (/"interrupted"\s*:\s*true/.test(value)) {
        this.flushAudio();
        return;
      }
      const item = this.content.get(String(text.contentName));
      if (item) item.text = (item.text + value).slice(-12000);
    }
    if (event.contentEnd) {
      const end = event.contentEnd;
      if (end.stopReason === "INTERRUPTED") this.flushAudio();
      const item = this.content.get(String(end.contentName));
      this.content.delete(String(end.contentName));
      if (item?.final && item.text.trim() && ["USER", "ASSISTANT"].includes(item.role)) {
        if (item.role === "USER") {
          this.flushAudio();
          this.options.router.heardUser();
        }
        this.transcript = [
          ...this.transcript.slice(-19),
          { role: item.role === "USER" ? "user" : "assistant", text: item.text },
        ];
        this.options.onTranscript(this.transcript);
      }
    }
    if (event.audioOutput && this.audio) {
      const binary = atob(String(event.audioOutput.content));
      if (!binary.length || binary.length % 2) return;
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      const view = new DataView(bytes.buffer);
      const buffer = this.audio.createBuffer(1, bytes.length / 2, 24000);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      const source = this.audio.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audio.destination);
      this.cursor = Math.max(this.cursor, this.audio.currentTime);
      if (this.cursor - this.audio.currentTime > 20) {
        this.fail("Voice playback fell behind. Reconnect to continue.");
        return;
      }
      this.sources.add(source);
      source.onended = () => {
        this.sources.delete(source);
        source.disconnect();
      };
      source.start(this.cursor);
      this.cursor += buffer.duration;
    }
  }

  private async renew() {
    if (this.closed || this.renewInFlight) return;
    this.renewInFlight = true;
    this.ready = false;
    this.options.onState("reconnecting");
    this.options.router.renew();
    this.flushAudio();
    this.socket?.close();
    this.socket = undefined;
    try {
      const grant = await this.getGrant();
      if (!this.closed) this.connect(grant);
    } catch (error) {
      if (!this.closed)
        this.fail(error instanceof Error ? error.message : "Voice reconnection failed.");
    } finally {
      this.renewInFlight = false;
    }
  }
  private send(value: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN && !this.closed)
      this.socket.send(JSON.stringify(value));
  }
  private flushAudio() {
    this.sources.forEach((s) => {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    });
    this.sources.clear();
    this.cursor = 0;
  }
  mute() {
    this.muted = !this.muted;
    this.stream?.getAudioTracks().forEach((t) => {
      t.enabled = !this.muted;
    });
    this.flushAudio();
    this.options.onState(this.muted ? "muted" : "listening");
  }
  private fail(message: string) {
    if (this.closed) return;
    this.options.onError(message);
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    clearTimeout(this.connectionTimer);
    this.flushAudio();
    this.socket?.close();
    this.capture?.disconnect();
    this.capture?.port.close();
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    void this.audio?.close().catch(() => undefined);
    this.options.onState("off");
  }
}
