/** Only these task-level actions cross the voice boundary; native tools keep their existing policy. */
export interface VoiceTaskAdapter {
  status(): { busy: boolean; stopping: boolean; turn: number; pending: number; response: string };
  start(instruction: string): void;
  steer(instruction: string): { accepted: boolean; reason?: string };
  stop(): void;
  available(): boolean;
}

export class VoiceTaskRouter {
  private utterance = 0;
  private actedOn = 0;
  private startingUntil = 0;
  private results = new Map<string, string>();
  private adapter: VoiceTaskAdapter;
  constructor(adapter: VoiceTaskAdapter) {
    this.adapter = adapter;
  }
  heardUser(): void {
    this.utterance++;
  }
  /** Renewal does not authorize another action from historical conversation. */
  renew(): void {
    this.actedOn = this.utterance;
  }
  dispatch(id: string, name: string, input: Record<string, unknown>): string {
    const cached = this.results.get(id);
    if (cached) return cached;
    let result: unknown;
    try {
      result = this.execute(name, input);
    } catch {
      result = {
        error:
          "Office could not acknowledge this action. Check the task status; do not retry a write automatically.",
      };
    }
    // Gateway bounds each connection; a long conversation also has a bounded cache.
    if (this.results.size >= 1000) this.results.delete(this.results.keys().next().value!);
    const text = JSON.stringify(result);
    this.results.set(id, text);
    return text;
  }
  private execute(name: string, input: Record<string, unknown>): unknown {
    if (!this.adapter.available())
      return { error: "Office document or mode changed; close voice and reconnect." };
    if (name === "task_status") return this.adapter.status();
    if (!["start_task", "steer_task", "stop_task"].includes(name))
      return { error: "Unknown voice action" };
    if (this.utterance <= this.actedOn)
      return {
        error: "A new spoken user instruction is required. Do not replay an earlier action.",
      };
    const text = typeof input.instruction === "string" ? input.instruction.trim() : "";
    if (name !== "stop_task" && (!text || text.length > 2000))
      return { error: "Instruction must contain 1–2,000 characters" };
    const state = this.adapter.status();
    if (name === "start_task" && (state.busy || Date.now() < this.startingUntil))
      return { error: "A task is already starting or running. Use steer_task to update it." };
    this.actedOn = this.utterance;
    if (name === "stop_task") {
      this.adapter.stop();
      return { stopping: true, note: "Earlier edits remain; use the editor's Undo to revert." };
    }
    if (name === "steer_task") return this.adapter.steer(text);
    this.startingUntil = Date.now() + 5000;
    this.adapter.start(text);
    return {
      submitted: true,
      note: "Request submitted to the Office assistant. Check task_status for progress. This does not mean work is complete.",
    };
  }
}
