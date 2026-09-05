import {
  BookmarkPlus,
  Check,
  Copy,
  Download,
  FileText,
  Loader2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import type { MatterScope, Source } from "@/lib/chat-types";
import {
  answerToPlainText,
  downloadDocx,
  downloadMarkdown,
} from "@/lib/memo-export";
import { saveOutputTextFn } from "@/lib/library/library.functions";

/**
 * Actions on a completed answer: copy with authorities, export as
 * Markdown/Word, save to the matter workspace, or watch the question for
 * new authority.
 */
export function AnswerActions({
  question,
  answer,
  sources,
  matter,
  conversationId,
  onWatchAdded,
}: {
  question: string;
  answer: string;
  sources: Source[];
  matter: MatterScope | null;
  conversationId: string | null;
  onWatchAdded?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const payload = {
    question,
    answer,
    sources,
    matterLabel: matter?.label ?? null,
  };

  async function copy() {
    await navigator.clipboard.writeText(answerToPlainText(payload));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
    } catch {
      toast.error("Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-border/40 pt-2">
      <Action onClick={copy} icon={copied ? Check : Copy}>
        {copied ? "Copied" : "Copy"}
      </Action>

      <Action
        onClick={() => downloadMarkdown(payload)}
        icon={FileText}
      >
        Markdown
      </Action>

      <Action
        onClick={() =>
          run("docx", () => downloadDocx(payload), "Word memo downloaded")
        }
        icon={Download}
        busy={busy === "docx"}
      >
        Word
      </Action>

      <Action
        onClick={() =>
          run(
            "save",
            async () => {
              await saveOutputTextFn({
                data: { name: question, content: answerToPlainText(payload) },
              });
            },
            "Saved to library",
          )
        }
        icon={BookmarkPlus}
        busy={busy === "save"}
      >
        Save
      </Action>
    </div>
  );
}

function Action({
  onClick,
  icon: Icon,
  busy,
  children,
}: {
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Icon className="h-3 w-3" />
      )}
      {children}
    </button>
  );
}
