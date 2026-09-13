import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, Mic, MicOff, X, Square } from "lucide-react";
import type { AgentLoop } from "@genoffice/agent-core";
import { VoiceTaskRouter } from "./voice-task-router";
import type { OfficeVoiceClient, VoiceLine, VoiceState } from "./voice-client";
import "./office-task-controls.css";

type TaskLoop = Pick<
  AgentLoop,
  | "conversationVersion"
  | "steer"
  | "getDirections"
  | "subscribeDirections"
  | "clearDirections"
  | "taskStatus"
>;
const EMPTY: readonly string[] = [];
const empty = () => EMPTY;
const noopSubscribe = () => () => undefined;

export function OfficeTaskControls(props: {
  app: "writer" | "sheets" | "slides";
  document: string;
  mode: string;
  loop: TaskLoop | null;
  busy: boolean;
  onSend(instruction: string): void;
  onStop(): void;
}) {
  const latest = useRef(props);
  latest.current = props;
  const voice = useRef<OfficeVoiceClient | null>(null);
  const connecting = useRef(false);
  const attemptRef = useRef(0);
  const scope = `${props.app}:${props.document}:${props.mode}:${props.loop?.conversationVersion ?? 0}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [direction, setDirection] = useState("");
  const [notice, setNotice] = useState("");
  const [state, setState] = useState<VoiceState>("off");
  const [lines, setLines] = useState<VoiceLine[]>([]);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const directions = useSyncExternalStore(
    props.loop?.subscribeDirections ?? noopSubscribe,
    props.loop?.getDirections ?? empty,
    empty,
  );

  useEffect(() => {
    let cancelled = false;
    void import("@/lib/office/voice.functions")
      .then((api) => api.officeVoiceStatusFn())
      .then((status) => {
        if (!cancelled) setVoiceAvailable(status.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setVoiceAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Capture the counter object; cleanup invalidates the newest connection attempt.
    const attempts = attemptRef;
    setDirection("");
    setLines([]);
    setNotice("");
    setState("off");
    return () => {
      attempts.current++;
      connecting.current = false;
      voice.current?.close();
      voice.current = null;
    };
  }, [scope]);

  const queue = () => {
    const result = props.loop?.steer(direction);
    if (result?.accepted) {
      setDirection("");
      setNotice("Direction queued. It will apply after the current operation.");
    } else setNotice(result?.reason || "The task is not ready for a direction yet.");
  };
  const startVoice = async () => {
    if (!voiceAvailable || connecting.current || state !== "off") return;
    connecting.current = true;
    const attempt = ++attemptRef.current;
    setState("connecting");
    setNotice("");
    const binding = scope;
    const version = props.loop?.conversationVersion;
    try {
      const { OfficeVoiceClient } = await import("./voice-client");
      if (scopeRef.current !== binding || attemptRef.current !== attempt || !connecting.current)
        return;
      const router = new VoiceTaskRouter({
        available: () =>
          scopeRef.current === binding &&
          attemptRef.current === attempt &&
          latest.current.mode !== "research" &&
          latest.current.loop?.conversationVersion === version,
        status: () => {
          const status = latest.current.loop?.taskStatus() ?? {
            busy: false,
            stopping: false,
            turn: 0,
            pending: 0,
            response: "No task has run in this document.",
          };
          return { ...status, busy: status.busy || latest.current.busy };
        },
        start: (text) => latest.current.onSend(text),
        steer: (text) =>
          latest.current.loop?.steer(text) ?? {
            accepted: false,
            reason: "Office task is not ready.",
          },
        stop: () => latest.current.onStop(),
      });
      const client = new OfficeVoiceClient({
        app: props.app,
        document: props.document,
        mode: props.mode,
        router,
        onState: (next) => {
          if (scopeRef.current === binding && attemptRef.current === attempt) {
            setState(next);
            if (next === "off") connecting.current = false;
          }
        },
        onError: (message) => {
          if (scopeRef.current === binding && attemptRef.current === attempt) setNotice(message);
        },
        onTranscript: (value) => {
          if (scopeRef.current === binding && attemptRef.current === attempt) setLines(value);
        },
      });
      voice.current = client;
      await client.start();
    } catch (error) {
      if (scopeRef.current !== binding || attemptRef.current !== attempt) return;
      setNotice(error instanceof Error ? error.message : "Voice could not start.");
      setState("off");
      connecting.current = false;
    }
  };
  const stopVoice = () => {
    attemptRef.current++;
    connecting.current = false;
    voice.current?.close();
    voice.current = null;
    setState("off");
  };
  const active = state !== "off";

  return (
    <section className="office-task-controls" aria-label="Office task and voice controls">
      <div className="office-task-controls__bar">
        <span className="office-task-controls__state">
          <i data-active={props.busy || active} />
          {props.busy ? "Task in progress" : "Office assistant"}
        </span>
        <div className="office-task-controls__buttons">
          {props.busy && (
            <button
              type="button"
              onClick={props.onStop}
              title="Stop the task; earlier edits remain"
            >
              <Square size={12} />
              Stop task
            </button>
          )}
          {!active ? (
            // Persistent-voice entry point is hidden until the voice gateway is
            // provisioned and OFFICE_VOICE_ENABLED is set (voiceAvailable). This
            // keeps a non-functional Voice button off the toolbar for now.
            voiceAvailable ? (
              <button
                type="button"
                onClick={() => void startVoice()}
                disabled={props.mode === "research"}
                title={
                  props.mode === "research"
                    ? "Switch to Write, Ask, or Review to use voice"
                    : "Start a live voice conversation with the Office assistant"
                }
              >
                <Mic size={14} />
                Voice
              </button>
            ) : null
          ) : (
            <>
              {state === "listening" || state === "muted" ? (
                <button
                  type="button"
                  onClick={() => voice.current?.mute()}
                  aria-pressed={state === "muted"}
                >
                  {state === "muted" ? <MicOff size={14} /> : <Mic size={14} />}
                  {state === "muted" ? "Unmute" : "Mute"}
                </button>
              ) : (
                <span>{state === "reconnecting" ? "Reconnecting…" : "Connecting…"}</span>
              )}
              <button
                type="button"
                onClick={stopVoice}
                title="End voice; keep the Office task running"
              >
                <X size={14} />
                End voice
              </button>
            </>
          )}
        </div>
      </div>
      {props.busy && (
        <>
          <form
            className="office-task-controls__direction"
            onSubmit={(event) => {
              event.preventDefault();
              queue();
            }}
          >
            <input
              aria-label="Update the running task"
              placeholder="Add a direction while it works…"
              maxLength={2000}
              value={direction}
              onChange={(event) => setDirection(event.target.value)}
            />
            <button
              type="submit"
              disabled={!direction.trim() || directions.length >= 4}
              aria-label="Queue direction"
            >
              <ArrowUp size={16} />
            </button>
          </form>
          {directions.length > 0 && (
            <div className="office-task-controls__queue">
              <strong>{directions.length} queued</strong>
              <button
                type="button"
                onClick={() => {
                  props.loop?.clearDirections();
                  setNotice("Queued directions removed. The current task continues.");
                }}
              >
                Clear
              </button>
              <ol>
                {directions.map((text, i) => (
                  <li key={i}>{text}</li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
      {active && (
        <div className="office-task-controls__voice" role="status">
          {state === "muted"
            ? "Microphone muted"
            : state === "listening"
              ? "Listening · speak naturally"
              : "Opening a secure voice connection"}
          <span>Task work continues while this editor stays open.</span>
        </div>
      )}
      {lines.length > 0 && (
        <details className="office-task-controls__transcript">
          <summary>Voice transcript · {lines.length} turns</summary>
          <div>
            {lines.map((line, i) => (
              <p key={i}>
                <b>{line.role === "user" ? "You" : "Assistant"}</b>
                {line.text}
              </p>
            ))}
          </div>
        </details>
      )}
      {notice && (
        <p className="office-task-controls__notice" role="status">
          {notice}
          <button type="button" aria-label="Dismiss task notice" onClick={() => setNotice("")}>
            <X size={12} />
          </button>
        </p>
      )}
    </section>
  );
}
