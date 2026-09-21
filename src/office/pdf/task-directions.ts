import type { OfficeTaskLoop } from "../shared/OfficeTaskControls";

const EMPTY: readonly string[] = [];
type Message = { role: "user" | "assistant"; text: string };

/** One binding per PDF conversation. Record each accepted direction once;
 * acknowledgments describe whether it reached a tool boundary or was removed. */
export function createPdfTaskDirections(agent: OfficeTaskLoop, options: {
  isCurrent(): boolean;
  append(message: Message): void;
}) {
  let pending: string[] = [];
  const record = (message: Message) => { if (options.isCurrent()) options.append(message); };
  const loop: OfficeTaskLoop = {
    get conversationVersion() { return agent.conversationVersion; },
    getDirections: () => options.isCurrent() ? agent.getDirections() : EMPTY,
    subscribeDirections: listener => agent.subscribeDirections(listener),
    taskStatus: () => agent.taskStatus(),
    steer(instruction) {
      if (!options.isCurrent()) return { accepted: false, reason: "This PDF conversation is no longer active." };
      const result = agent.steer(instruction);
      if (result.accepted) {
        // The core validates limits and redacts secret-like payloads before
        // accepting; persist that same normalized direction, not raw input.
        const text = agent.getDirections().at(-1)!;
        pending.push(text);
        record({ role: "assistant", text: "Updated directions received and queued for the current task; they have not been applied yet." });
        record({ role: "user", text });
      }
      return result;
    },
    clearDirections() {
      if (!options.isCurrent()) return;
      const removed = pending;
      pending = [];
      agent.clearDirections();
      if (removed.length) record({ role: "assistant", text: "The user removed these queued directions before they were applied. Do not act on them unless requested again:\n" + removed.join("\n\n") });
    },
  };
  return {
    loop,
    applied(directions: readonly string[] = []) {
      if (!options.isCurrent()) return;
      const applied: string[] = [];
      for (const direction of directions) {
        const index = pending.indexOf(direction);
        if (index >= 0) { pending.splice(index, 1); applied.push(direction); }
      }
      if (applied.length) record({ role: "assistant", text: "The queued directions were added to the current task at an operation boundary. This acknowledges the instructions, not completed document edits." });
    },
    finish() {
      const remaining = pending;
      pending = [];
      if (remaining.length) record({ role: "assistant", text: "The task ended before these queued directions were applied. Review the current PDF and confirm the remaining work before continuing:\n" + remaining.join("\n\n") });
    },
  };
}
