import type { Attachment, ChoiceAnswer } from "@/lib/chat-types";

export type Emit = (event: string, data: unknown) => void;

export type HistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

export type OrchestrateInput = {
  query: string;
  history?: HistoryTurn[];
  memory?: unknown;
  /** Verified Cognito principal (from request auth, never the client body).
   *  Enables the cross-chat user memory; absent in scripts and tests. */
  principal?: string;
  /** Saved conversation id when the client already has one (second turn on).
   *  Used to count a chat once in the user memory and to drop it from the
   *  recent-chats list. Client-supplied, so only ever used as an opaque key. */
  conversationId?: string;
  signal?: AbortSignal;
  matter?: {
    matter_id: string;
    label: string;
  };
  forceMode?: "fast" | "think";
  attachments?: Attachment[];
  /** Present when this request resumes after a clarification panel. */
  choice?: ChoiceAnswer;
};
