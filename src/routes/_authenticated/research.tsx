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
import { GuidedSetup } from "@/components/chat/GuidedSetup";
import { ResearchToolkit } from "@/components/chat/ResearchToolkit";
import { ComposerScope, MatterChip } from "@/components/chat/ComposerScope";
import { SlashPalette, SkillForm } from "@/components/chat/SkillMenu";
import type { Attachment, ChoiceAnswer, MatterScope } from "@/lib/chat-types";
import { useChat } from "@/lib/use-chat";
import {
  appendSourceScope,
  filterSkills,
  slashDraft,
  type ResearchSkill,
  type SelectedDoc,
} from "@/lib/research-skills";

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
  const [pane, setPane] = useState<"chat" | "guided">("chat");
  /** Depth chosen in Guided setup, seeded into the composer on Fill chat. */
  const [seedMode, setSeedMode] = useState<ComposerMode | null>(null);
  /** Focus documents chosen in the composer's Sources popover (fold into the
   *  first request; matter scoping itself is real and applies every turn). */
  const [selectedDocs, setSelectedDocs] = useState<SelectedDoc[]>([]);
  const [focusOnly, setFocusOnly] = useState(false);

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
    ) => {
      // Focus documents fold into the request only at construction (the first
      // message of a conversation). Matter scoping (matter_id) is sent on every
      // turn regardless, so follow-ups stay scoped without re-listing titles.
      const scoped = inChat ? text : appendSourceScope(text, matter, selectedDocs, focusOnly);
      send(scoped, matter, opts);
    },
    [send, matter, selectedDocs, focusOnly, inChat],
  );

  // Guided setup fills the composer (it never sends): drop any active skill,
  // carry the chosen depth into the composer, prefill the request, and return to
  // the chat view so the editable draft is front and center.
  const handleGuidedFill = useCallback((text: string, mode: ComposerMode) => {
    setSkill(null);
    setSeedMode(mode);
    setPrefill(text);
    setPane("chat");
  }, []);

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
            className="flex h-full w-full justify-center overflow-y-auto px-4 py-6 sm:px-6"
          >
            <div className="mx-auto flex w-full max-w-[880px] flex-col pt-[min(7vh,4rem)]">
              <div className="mb-4 flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-foreground">
                    Research workspace
                  </h1>
                  <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                    Ask a question or start with a guided task.
                  </p>
                </div>
                <div className="inline-flex shrink-0 rounded-md border border-border bg-card p-0.5">
                  {(["chat", "guided"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPane(p)}
                      className={`rounded px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card ${
                        pane === p
                          ? "bg-brand-navy text-white"
                          : "text-muted-foreground hover:text-brand-navy"
                      }`}
                    >
                      {p === "chat" ? "Chat" : "Guided setup"}
                    </button>
                  ))}
                </div>
              </div>
              <HeroComposer
                onSubmit={sendScoped}
                disabled={busy}
                initialValue={prefill}
                onPickSkill={(s) => {
                  setSkill(s);
                  setPrefill("");
                }}
                matter={matter}
                onMatterChange={setMatter}
                selectedDocs={selectedDocs}
                onDocsChange={setSelectedDocs}
                focusOnly={focusOnly}
                onFocusOnlyChange={setFocusOnly}
                seedMode={seedMode}
              />
              {pane === "guided" ? (
                <GuidedSetup matter={matter} onMatterChange={setMatter} onFill={handleGuidedFill} />
              ) : (
                <>
                  {skill && (
                    <div className="mt-3">
                      <SkillForm
                        skill={skill}
                        onCancel={() => setSkill(null)}
                        onRun={(text) => {
                          setSkill(null);
                          sendScoped(text);
                        }}
                      />
                    </div>
                  )}
                  <ResearchToolkit
                    onPrefill={(text) => {
                      setSkill(null);
                      setPrefill(text);
                    }}
                    onSend={(text) => {
                      setSkill(null);
                      sendScoped(text);
                    }}
                    onOpenConversation={openConversation}
                  />
                </>
              )}
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
              onMatterChange={setMatter}
              selectedDocs={selectedDocs}
              onDocsChange={setSelectedDocs}
              focusOnly={focusOnly}
              onFocusOnlyChange={setFocusOnly}
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
  matter = null,
  onMatterChange,
  selectedDocs = [],
  onDocsChange,
  focusOnly = false,
  onFocusOnlyChange,
  seedMode = null,
}: {
  onSubmit: (
    t: string,
    opts?: { mode?: ComposerMode; attachments?: Attachment[] },
  ) => void;
  disabled: boolean;
  initialValue?: string;
  onPickSkill: (skill: ResearchSkill) => void;
  matter?: MatterScope | null;
  onMatterChange?: (m: MatterScope | null) => void;
  selectedDocs?: SelectedDoc[];
  onDocsChange?: (docs: SelectedDoc[]) => void;
  focusOnly?: boolean;
  onFocusOnlyChange?: (v: boolean) => void;
  seedMode?: ComposerMode | null;
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

  // Guided setup seeds the depth when it fills the composer.
  useEffect(() => {
    if (seedMode) setMode(seedMode);
  }, [seedMode, setMode]);

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
        {matter && (
          <div className="flex justify-end px-3 pt-2.5">
            <MatterChip
              matter={matter}
              onClear={() => {
                onMatterChange?.(null);
                onDocsChange?.([]);
                onFocusOnlyChange?.(false);
              }}
            />
          </div>
        )}
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
          <div className="flex items-center gap-1">
            <ComposerScope
              matter={matter}
              onMatterChange={onMatterChange ?? (() => {})}
              selectedDocs={selectedDocs}
              onDocsChange={onDocsChange ?? (() => {})}
              focusOnly={focusOnly}
              onFocusOnlyChange={onFocusOnlyChange ?? (() => {})}
              uploads={files}
              disabled={disabled}
            />
            <ModeDropdown mode={mode} onChange={setMode} disabled={disabled} />
          </div>
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
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-brand-navy text-white shadow-sm transition-all hover:bg-brand-navy/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-40"
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
