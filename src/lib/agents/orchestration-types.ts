import type { Attachment } from "@/lib/chat-types";

export type Emit = (event: string, data: unknown) => void;

export type HistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

export type OrchestrateInput = {
  query: string;
  history?: HistoryTurn[];
  memory?: unknown;
  signal?: AbortSignal;
  matter?: {
    matter_id: string;
    label: string;
  };
  forceMode?: "fast" | "think";
  attachments?: Attachment[];
};
