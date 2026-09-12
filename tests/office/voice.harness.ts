import { OfficeVoiceClient } from "../../src/office/shared/voice-client";
import { VoiceTaskRouter } from "../../src/office/shared/voice-task-router";
const tick = () => new Promise((r) => setTimeout(r, 0));

export async function verifyVoice(kind: string) {
  const originals = {
    AudioContext: window.AudioContext,
    AudioWorkletNode: window.AudioWorkletNode,
    WebSocket: window.WebSocket,
    getUserMedia: navigator.mediaDevices.getUserMedia,
  };
  let audioClosed = 0,
    trackStopped = 0,
    sourcesStopped = 0,
    taskStops = 0,
    grants = 0,
    resolveMic = () => {};
  const errors: string[] = [],
    states: string[] = [],
    speech: string[] = [];
  const sockets: FakeSocket[] = [];
  const track = {
    enabled: true,
    onended: null,
    stop: () => {
      trackStopped++;
    },
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    sent: string[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;
    constructor() {
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    send(text: string) {
      this.sent.push(text);
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.());
    }
    event(message: unknown) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }
  const node = () => ({ connect: () => node(), disconnect() {} });
  class FakeAudio {
    currentTime = 0;
    destination = {};
    audioWorklet = { addModule: async () => {} };
    resume() {
      return Promise.resolve();
    }
    close() {
      audioClosed++;
      return Promise.resolve();
    }
    createGain() {
      return { ...node(), gain: { value: 0 } };
    }
    createMediaStreamSource() {
      return node();
    }
    createBuffer(_channels: number, count: number, rate: number) {
      return { duration: count / rate, getChannelData: () => new Float32Array(count) };
    }
    createBufferSource() {
      return {
        ...node(),
        buffer: null,
        onended: null,
        start() {},
        stop() {
          sourcesStopped++;
        },
      };
    }
  }
  class FakeWorklet {
    port = { onmessage: null, close() {} };
    connect() {
      return node();
    }
    disconnect() {}
  }
  Object.assign(window, {
    AudioContext: FakeAudio,
    AudioWorkletNode: FakeWorklet,
    WebSocket: FakeSocket,
  });
  navigator.mediaDevices.getUserMedia = () =>
    kind === "cancel-microphone"
      ? new Promise((resolve) => {
          resolveMic = () => resolve(stream as unknown as MediaStream);
        })
      : Promise.resolve(stream as unknown as MediaStream);
  const router = new VoiceTaskRouter({
    available: () => true,
    status: () => ({ busy: false, stopping: false, turn: 0, pending: 0, response: "" }),
    start: () => {},
    steer: () => ({ accepted: true }),
    stop: () => {
      taskStops++;
    },
  });
  const client = new OfficeVoiceClient({
    app: "writer",
    document: "doc",
    mode: "ask",
    router,
    grant: async () => {
      grants++;
      if (kind === "no-grant") throw new Error("Gateway is not configured");
      return { url: "ws://test/voice", token: "test-only" };
    },
    onState: (s) => states.push(s),
    onError: (e) => errors.push(e),
    onTranscript: (lines) => {
      speech.splice(0, speech.length, ...lines.map((l) => l.text));
    },
  });
  try {
    const starting = client.start();
    await tick();
    if (kind === "cancel-microphone") {
      client.close();
      resolveMic();
      await starting;
    } else {
      await starting;
      const ws = sockets[0];
      if (ws) {
        ws.event({ type: "ready" });
        ws.event({ type: "event", event: { audioOutput: { content: "AAA=" } } });
        ws.event({ type: "event", event: { textOutput: { content: '{"interrupted":true}' } } });
        ws.event({
          type: "event",
          event: { contentStart: { contentName: "user-1", role: "USER" } },
        });
        ws.event({
          type: "event",
          event: { textOutput: { contentName: "user-1", content: "Check the document" } },
        });
        ws.event({ type: "event", event: { contentEnd: { contentName: "user-1" } } });
        if (kind === "renew") {
          ws.event({ type: "renew" });
          await tick();
          sockets[1].event({ type: "ready" });
        }
        client.mute();
        client.mute();
        client.close();
      }
    }
    return {
      audioClosed,
      trackStopped,
      sourcesStopped,
      taskStops,
      states,
      errors,
      speech,
      grants,
      sockets: sockets.map((s) => ({
        state: s.readyState,
        sent: s.sent.map((m) => JSON.parse(m)),
      })),
      replay: JSON.parse(
        router.dispatch("new-action", "start_task", { instruction: "Repeat old action" }),
      ),
    };
  } finally {
    client.close();
    Object.assign(window, {
      AudioContext: originals.AudioContext,
      AudioWorkletNode: originals.AudioWorkletNode,
      WebSocket: originals.WebSocket,
    });
    navigator.mediaDevices.getUserMedia = originals.getUserMedia;
  }
}
Object.assign(window, { verifyOfficeVoice: verifyVoice });
declare global {
  interface Window {
    verifyOfficeVoice: typeof verifyVoice;
  }
}
