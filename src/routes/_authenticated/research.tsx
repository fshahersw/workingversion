import { createFileRoute } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { ChatView } from "@/components/chat/ChatView";
import { MicButton } from "@/components/chat/MicButton";
import {
  ModeDropdown,
  useUploads,
  UploadButton,
  FileChips,
  initialMode,
  persistMode,
  type ComposerMode,
} from "@/components/chat/composer-kit";
import { ResearchLanding } from "@/components/chat/ResearchLanding";
import { SlashPalette } from "@/components/chat/SkillMenu";
import type { Attachment, ChoiceAnswer, MatterScope } from "@/lib/chat-types";
import { useChat } from "@/lib/use-chat";
import { filterSkills, slashDraft, type ResearchSkill } from "@/lib/research-skills";

export const Route = createFileRoute("/_authenticated/research")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Research — Seeger Weiss" },
      {
        name: "description",
        content:
          "Multi-agent litigation research for MDLs, causation science, regulatory actions, and precedent — every answer cited.",
      },
      { property: "og:title", content: "Research — Seeger Weiss" },
      {
        property: "og:description",
        content:
          "Multi-agent litigation research for MDLs, causation science, regulatory actions, and precedent — every answer cited.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ResearchPage,
});

function getSessionId() {
  if (typeof window === "undefined") return "ssr";
  const KEY = "sw.session_id";
  let id = window.sessionStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.sessionStorage.setItem(KEY, id);
  }
  return id;
}

/** True while the composer holds a slash command that matches at least one
 *  skill: the palette owns Enter then, so Send stays off. An unmatched draft
 *  such as "/remand" is ordinary text and can be sent. */
function slashSkillPending(text: string): boolean {
  const draft = slashDraft(text);
  return draft !== null && filterSkills(draft).length > 0;
}

function ResearchPage() {
  const sessionId = useMemo(() => getSessionId(), []);
  const { messages, send, stop, busy, reset, open, conversationId } =
    useChat(sessionId);
  const inChat = messages.length > 0;
  const [prefill, setPrefill] = useState("");
  const [matter, setMatter] = useState<MatterScope | null>(null);
  const [skill, setSkill] = useState<ResearchSkill | null>(null);

  const openConversation = useCallback(
    async (id: string) => {
      const loaded = await open(id);
      if (loaded) setMatter(loaded.matter);
    },
    [open],
  );

  const sendScoped = useCallback(
    (
      text: string,
      opts?: {
        mode?: "auto" | "fast" | "think";
        attachments?: Attachment[];
        choice?: ChoiceAnswer;
        /** With `choice`: the assistant message whose clarifying question is answered. */
        resumeId?: string;
      },
    ) => send(text, matter, opts),
    [send, matter],
  );

  // Open a conversation handed off from the Library page (sessionStorage key set
  // there, then a navigate to /research). Runs once on mount.
  useEffect(() => {
    try {
      const openId = sessionStorage.getItem("sw:open-conversation");
      if (openId) {
        sessionStorage.removeItem("sw:open-conversation");
        void openConversation(openId);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pick up a seeded prompt from the Home dashboard's Quick Start tiles,
  // or a matter-scoped question that should only prefill (not auto-send).
  useEffect(() => {
    if (inChat || busy) return;
    try {
      const fill = sessionStorage.getItem("sw:prefill-prompt");
      if (fill) {
        sessionStorage.removeItem("sw:prefill-prompt");
        setPrefill(fill);
        return;
      }
      const seed = sessionStorage.getItem("sw:initial-prompt");
      if (seed) {
        sessionStorage.removeItem("sw:initial-prompt");
        send(seed);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AppShell showHeaderLogo={inChat}>
      <AnimatePresence mode="wait">
        {!inChat ? (
          <motion.main
            key="hero"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.4 }}
            className="flex h-full w-full items-start justify-center overflow-y-auto px-4 py-6 sm:px-6"
          >
            <div className="mx-auto flex w-full max-w-[720px] flex-col items-center pt-[min(12vh,7rem)]">
              <div className="w-full">
                <HeroComposer
                  onSubmit={sendScoped}
                  disabled={busy}
                  initialValue={prefill}
                  onPickSkill={(s) => {
                    setSkill(s);
                    setPrefill("");
                  }}
                />
              </div>
              <ResearchLanding
                onSend={(text) => {
                  setSkill(null);
                  sendScoped(text);
                }}
                onPrefill={(text) => {
                  setSkill(null);
                  setPrefill(text);
                }}
                skill={skill}
                onSkill={setSkill}
              />
            </div>
          </motion.main>
        ) : (
          <motion.div
            key="chat"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
            className="h-full min-h-0"
          >
            <ChatView
              messages={messages}
              busy={busy}
              onSend={sendScoped}
              onStop={stop}
              onNewChat={reset}
              sessionId={sessionId}
              matter={matter}
              conversationId={conversationId}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </AppShell>
  );
}

function HeroComposer({
  onSubmit,
  disabled,
  initialValue = "",
  onPickSkill,
}: {
  onSubmit: (
    t: string,
    opts?: { mode?: ComposerMode; attachments?: Attachment[] },
  ) => void;
  disabled: boolean;
  initialValue?: string;
  onPickSkill: (skill: ResearchSkill) => void;
}) {
  const [v, setV] = useState(initialValue);
  const [mode, setModeRaw] = useState<ComposerMode>(initialMode);
  const setMode = useCallback((m: ComposerMode) => {
    setModeRaw(m);
    persistMode(m);
  }, []);
  const { files, uploading, uploadError, handleFiles, removeFile } = useUploads();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (initialValue) setV(initialValue);
  }, [initialValue]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [v]);

  function submit() {
    if (!v.trim() || disabled || slashSkillPending(v)) return;
    onSubmit(v.trim(), { mode, attachments: files });
    setV("");
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="w-full"
    >
      <div
        className="relative rounded-lg border border-border bg-card shadow-sm transition-all focus-within:border-primary/40 focus-within:shadow-md"
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (!disabled) void handleFiles(e.dataTransfer?.files ?? null);
        }}
      >
        <SlashPalette
          value={v}
          onPick={(s) => {
            setV("");
            onPickSkill(s);
          }}
        />
        <FileChips files={files} onRemove={removeFile} className="px-3 pt-2.5" />
        <div className="px-3 pt-2.5">
          <textarea
            ref={ref}
            autoFocus
            value={v}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.defaultPrevented) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder="Ask about MDLs, bellwethers, causation experts, recalls, or settlements…"
            className="block max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-1 py-1.5 text-[15px] leading-[1.5] text-foreground placeholder:text-muted-foreground/80 focus:outline-none"
          />
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-1 border-t border-border/60 px-2 py-1.5">
          <ModeDropdown mode={mode} onChange={setMode} disabled={disabled} />
          <div className="flex items-center gap-1">
            <UploadButton onFiles={handleFiles} uploading={uploading} disabled={disabled} />
            <MicButton
              onTranscript={(t) => setV(v.trim() ? `${v.trim()} ${t}` : t)}
              disabled={disabled}
            />
            <button
              type="submit"
              disabled={disabled || !v.trim() || slashSkillPending(v)}
              aria-label="Send"
              title="Send"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-brand-navy text-white shadow-sm transition-all hover:bg-brand-navy/90 disabled:opacity-40"
            >
              <ArrowUp className="h-[16px] w-[16px]" strokeWidth={2.4} />
            </button>
          </div>
        </div>
        {uploadError && (
          <div className="px-3 pb-2 text-center text-[11px] text-destructive">
            {uploadError}
          </div>
        )}
      </div>
    </form>
  );
}
