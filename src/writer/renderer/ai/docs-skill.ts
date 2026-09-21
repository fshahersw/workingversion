import type { Editor } from "@tiptap/core";
import type { AgentSkill } from "@genoffice/agent-core";
import {
  AGENT_SYSTEM_PROMPT,
  buildDocContext,
  getSelectionScope,
  type AiTrack,
  type NumIds,
} from "./protocol";
import {
  AGENT_TOOLS,
  PLATFORM_SYSTEM_PROMPT,
  executeTool,
  markDocSeen,
  beginOfficeTask,
  type AiCommentsAccess,
  type AiDocumentAccess,
  type AiHeaderFooterAccess,
  type FrozenSelection,
} from "./tools";
import { auditLiveDocument, extractAuditModel, formatDocAudit } from "./document-audit";
import type { AuditModel } from "@/lib/writer/document-audit";

/**
 * The docx capability as an AgentSkill: document skeleton context, the five
 * document tools, and the local executor. Future apps register their own
 * skills (Excel / PPT) against the same agent loop.
 */
export function createDocsSkill(
  getEditor: () => Editor,
  getNumIds: () => NumIds,
  getTrack?: () => AiTrack | undefined,
  getComments?: () => AiCommentsAccess | undefined,
  getHf?: () => AiHeaderFooterAccess | undefined,
  getApp?: () => AiDocumentAccess | undefined,
  getInstruction?: () => string,
): AgentSkill {
  // Selection frozen per run: tools act on the range the prompt described,
  // not on wherever the user's live selection has wandered mid-run. The doc
  // snapshot bounds the freeze's validity (see FrozenSelection).
  let frozen: FrozenSelection | null = null;
  let auditBaseline: AuditModel | null = null;
  let requestedScope = "";
  return {
    id: "docx",
    // Platform build: the shared platform tools (Python, diagrams, citation
    // checks, guides, clarification card) ride along with the docx tools; their
    // definitions are appended to AGENT_TOOLS in tools.ts.
    systemPrompt: AGENT_SYSTEM_PROMPT + "\n\n" + PLATFORM_SYSTEM_PROMPT,
    tools: AGENT_TOOLS,
    buildContext: () => {
      const editor = getEditor();
      beginOfficeTask(editor);
      markDocSeen(editor); // the context the model receives is the freshness baseline for index-addressed writes
      frozen = { scope: getSelectionScope(editor), doc: editor.state.doc };
      requestedScope = getInstruction?.() ?? "";
      try { auditBaseline = structuredClone(extractAuditModel(editor, getApp?.())); }
      catch { auditBaseline = null; }
      return buildDocContext(editor, frozen.scope, getComments?.()?.list(), getHf?.()?.read());
    },
    executeTool: (call, signal) =>
      executeTool(
        getEditor(),
        call,
        getNumIds(),
        getTrack?.(),
        signal,
        frozen,
        getComments?.(),
        getHf?.(),
        getApp?.(),
      ),
    // Correct only new structural damage from this run. Requested or existing
    // style, bare headings, widths and blank paragraphs never force a rewrite.
    // The explicit audit_document tool still reports those advisory findings.
    verifyResponse: (_finalText, executed) => {
      const wrote = executed.some((c) => !READ_ONLY_TOOLS.has(c.name) && c.ok);
      if (!wrote || !auditBaseline) return null;
      let issues: string[];
      try {
        issues = auditLiveDocument(getEditor(), getApp?.(), { structuralOnly: true, baseline: auditBaseline });
      } catch {
        return null; // the audit must never block a run
      }
      if (!issues.length) return null;
      return `The original user request remains the goal: ${JSON.stringify(requestedScope || "Preserve the scope of the user's most recent instruction.")}. Repair only new structural damage caused by this run; do not restyle, expand, add descriptors, remove requested headings, or fix unrelated pre-existing issues. The final receipt must address the original request, not the audit.${formatDocAudit(issues, { structuralOnly: true })}`;
    },
  };
}

const READ_ONLY_TOOLS = new Set(AGENT_TOOLS.filter((t) => t.readOnly).map((t) => t.name));
