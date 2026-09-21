// "Enhance my prompt" tool body (Practice Tools). The user types a rough prompt
// (mic dictation available) plus an optional note on what to improve, submits to
// the Enhance Prompt server function, and reviews the structured rewrite in a
// scrollable modal with Copy / Add to chat / Add to chat & run.
import { useState } from "react";
import { Check, Copy, Loader2, Play, Sparkles, SquarePen } from "lucide-react";
import { toast } from "sonner";

import { MicButton } from "./MicButton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { enhancePromptFn, type EnhanceResult } from "@/lib/enhance-prompt.functions";

export function EnhancePromptPanel({
  onAddToChat,
  onAddToChatAndRun,
}: {
  /** Fill the composer with the enhanced prompt (does not send). */
  onAddToChat: (text: string) => void;
  /** Fill the composer and submit the enhanced prompt. */
  onAddToChatAndRun: (text: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [improve, setImprove] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EnhanceResult | null>(null);
  const [open, setOpen] = useState(false);

  const append = (setter: (fn: (prev: string) => string) => void) => (t: string) =>
    setter((prev) => (prev.trim() ? `${prev.trim()} ${t}` : t));

  async function run() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      const res = await enhancePromptFn({
        data: { prompt: prompt.trim(), improve: improve.trim() || undefined },
      });
      setResult(res);
      setOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not enhance the prompt.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Turn a rough prompt into a structured legal request. Type or dictate it, optionally note what
        to improve, then review the rewrite before it goes to chat.
      </p>

      <Field label="Your prompt">
        <div className="relative">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="e.g. review this NDA"
            className="block w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 pr-9 text-[12.5px] leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:border-brand-navy/40 focus:outline-none"
          />
          <div className="absolute right-1.5 top-1.5">
            <MicButton onTranscript={append(setPrompt)} disabled={busy} />
          </div>
        </div>
      </Field>

      <Field label="What to improve" optional>
        <div className="relative">
          <textarea
            value={improve}
            onChange={(e) => setImprove(e.target.value)}
            rows={2}
            placeholder="e.g. make it a recipient-side review, memo format"
            className="block w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 pr-9 text-[12.5px] leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:border-brand-navy/40 focus:outline-none"
          />
          <div className="absolute right-1.5 top-1.5">
            <MicButton onTranscript={append(setImprove)} disabled={busy} />
          </div>
        </div>
      </Field>

      <div className="flex justify-end">
        <button
          type="button"
          disabled={!prompt.trim() || busy}
          onClick={() => void run()}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-navy px-3 text-[12px] font-medium text-white hover:bg-brand-navy/90 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />}
          {busy ? "Enhancing…" : "Enhance prompt"}
        </button>
      </div>

      <ResultDialog
        open={open}
        onOpenChange={setOpen}
        result={result}
        onAddToChat={(t) => {
          onAddToChat(t);
          setOpen(false);
        }}
        onAddToChatAndRun={(t) => {
          onAddToChatAndRun(t);
          setOpen(false);
        }}
      />
    </div>
  );
}

function Field({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
        {optional ? " · optional" : ""}
      </span>
      {children}
    </label>
  );
}

function ResultDialog({
  open,
  onOpenChange,
  result,
  onAddToChat,
  onAddToChatAndRun,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  result: EnhanceResult | null;
  onAddToChat: (text: string) => void;
  onAddToChatAndRun: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.expandedPrompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error("Couldn't copy to the clipboard.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px] gap-3 p-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px] text-brand-navy">
            <Sparkles className="h-4 w-4 text-brand-orange" strokeWidth={2} />
            {result?.applied ? "Enhanced prompt" : "Prompt review"}
          </DialogTitle>
        </DialogHeader>

        {result && (
          <>
            {!result.applied && result.skipReason && (
              <p className="rounded-md bg-muted/60 px-3 py-2 text-[12px] text-muted-foreground">
                {result.skipReason}
              </p>
            )}

            <div className="wr-app-scroll max-h-[42vh] overflow-y-auto rounded-md border border-border bg-background px-3 py-2.5 text-[13px] leading-relaxed text-foreground/90 whitespace-pre-wrap">
              {result.expandedPrompt}
            </div>

            {result.reasoning.length > 0 && (
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  What changed
                </p>
                <ul className="space-y-1">
                  {result.reasoning.map((r, i) => (
                    <li key={i} className="flex gap-1.5 text-[12px] leading-snug text-muted-foreground">
                      <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-brand-navy/40" />
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-1 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void copy()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12px] font-medium text-brand-navy hover:bg-muted"
              >
                {copied ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : <Copy className="h-3.5 w-3.5" strokeWidth={2} />}
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={() => onAddToChat(result.expandedPrompt)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12px] font-medium text-brand-navy hover:bg-muted"
              >
                <SquarePen className="h-3.5 w-3.5" strokeWidth={2} />
                Add to chat
              </button>
              <button
                type="button"
                onClick={() => onAddToChatAndRun(result.expandedPrompt)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-navy px-3 text-[12px] font-medium text-white hover:bg-brand-navy/90"
              >
                <Play className="h-3.5 w-3.5" strokeWidth={2} />
                Add to chat &amp; run
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
