import type { Editor } from '@tiptap/core';
import type { AgentToolDef, AgentToolCall } from '../../shared/ipc';
import type { AiDocumentAccess, AiCommentsAccess, FrozenSelection, ToolExecution } from './tools';
import type { AiTrack, NumIds } from './protocol';
import { executeOps, opNames, opSignatures } from './ops';
import { DEFINE_STYLE_TOOL, LIST_STYLES_TOOL, resolveStyleDefinition, describeStyles } from './style-ops';
import { INSERT_PICTURE_TOOL, INSERT_TEXT_BOX_TOOL, textBoxNode, insertPosition } from './floating-ops';
import { buildNotesContext, editNoteText, noteInsertPos, removeNoteRefs } from './note-ops';
import { resolveCommentAnchor, repliesOf } from './comment-ops';
import { applyRevisionSelection, validateSelector, listRevisionEntries } from './revision-ops';
import { parseHtmlFragment, getSelectionScope, replaceBlockRange, insertBlocksAfter } from './protocol';
import { TextSelection } from '@tiptap/pm/state';
import { TRACK_IGNORE } from '../editor/revisions';

export const BROWSER_WRITER_TOOLS: AgentToolDef[] = [
{
    name: 'replace_selection',
    description:
      "Replace exactly the user's selected text (the <sel>…</sel> span in the context) with new inline content, leaving the rest of the block untouched. For rewording/translating/correcting a selected phrase or sentence inside a paragraph. The new text inherits the selection's formatting unless the fragment styles it. Requires a range selection inside one paragraph/heading/list item; for whole blocks or several blocks use replace_blocks.",
    inputSchema: {
      type: 'object',
      properties: {
        html: {
          type: 'string',
          description:
            'replacement inline content: plain text or restricted inline HTML (strong em u s a br formula)',
        },
      },
      required: ['html'],
    },
  },
{
    name: 'apply_ops',
    description:
      `Run a list of formatting/structure ops as one atomic transaction (see the apply_ops guide in the system prompt): ${opNames().join(', ')}. ` +
      'Each op is a flat { op, target?, ...fields } object; fields are patches (present = set, null = clear, absent = untouched). Any invalid op rejects the whole batch with its usage line.',
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          description:
            'ops executed in order, e.g. [{"op":"setFont","target":{"nodeType":"docHeading"},"color":"#FF0000"}]',
          items: { type: 'object' },
        },
        dryRun: {
          type: 'boolean',
          description: 'validate and return the plan without changing the document',
        },
      },
      required: ['ops'],
    },
  },
{
    name: 'accept_changes',
    description:
      'Accept pending tracked changes: insertions become plain text, deleted text disappears, new formatting stays. Select with all: true, ids from read_revisions, or any combination of author / type / blockIndex / blockRange / before. Only when the user asks to accept changes.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'true = every pending change' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'revision ids from read_revisions (r1, r2, …); positional, so re-read after any edit',
        },
        author: { type: 'string', description: 'only changes by this author (case-insensitive)' },
        type: {
          type: 'string',
          enum: ['insertion', 'deletion', 'formatting', 'move'],
          description: 'only changes of this type',
        },
        blockIndex: { type: 'integer', description: 'only changes inside this block' },
        blockRange: {
          type: 'array',
          items: { type: 'integer' },
          minItems: 2,
          maxItems: 2,
          description: '[from, to] block indexes, inclusive',
        },
        before: { type: 'string', description: 'ISO date; only changes recorded before it' },
      },
      required: [],
    },
  },
{
    name: 'reject_changes',
    description:
      'Reject pending tracked changes: inserted text disappears, deleted text is restored, formatting goes back to what it was. Same selector as accept_changes. Only when the user asks to reject changes.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'true = every pending change' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'revision ids from read_revisions (r1, r2, …); positional, so re-read after any edit',
        },
        author: { type: 'string', description: 'only changes by this author (case-insensitive)' },
        type: {
          type: 'string',
          enum: ['insertion', 'deletion', 'formatting', 'move'],
          description: 'only changes of this type',
        },
        blockIndex: { type: 'integer', description: 'only changes inside this block' },
        blockRange: {
          type: 'array',
          items: { type: 'integer' },
          minItems: 2,
          maxItems: 2,
          description: '[from, to] block indexes, inclusive',
        },
        before: { type: 'string', description: 'ISO date; only changes recorded before it' },
      },
      required: [],
    },
  },
{
    name: 'insert_endnote',
    description:
      'Add an endnote (same as insert_footnote, but the text collects at the end of the document). Use when the document already uses endnotes or the user asks for them.',
    inputSchema: {
      type: 'object',
      properties: {
        blockIndex: { type: 'integer', description: 'block that gets the reference mark' },
        afterText: {
          type: 'string',
          description: 'exact text in that block the mark follows; omitted = end of the block',
        },
        text: { type: 'string', description: 'the note text (\\n separates paragraphs)' },
      },
      required: ['blockIndex', 'text'],
    },
  },
{
    name: 'delete_note',
    description:
      'Remove a footnote or endnote together with its reference mark; ids from read_notes.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['footnote', 'endnote'] },
        id: { type: 'string', description: 'note id from read_notes' },
      },
      required: ['kind', 'id'],
    },
  },
{
    name: 'edit_note',
    description:
      'Change the text of an existing footnote or endnote in place (findReplace inside the note): the note keeps its id, reference mark and formatting. Use for a typo or a citation fix instead of delete_note + insert_footnote.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['footnote', 'endnote'],
          description: 'omit when the id is unambiguous across footnotes and endnotes',
        },
        id: { type: 'string', description: 'note id from read_notes' },
        find: { type: 'string', description: 'exact text inside the note to replace' },
        replace: { type: 'string', description: 'replacement text ("" deletes the match)' },
        matchCase: { type: 'boolean', description: 'defaults to true' },
      },
      required: ['id', 'find', 'replace'],
    },
  },
{
    name: 'read_notes',
    description:
      'List every footnote and endnote with its id, number, the block holding its reference mark and its text.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
{
    name: 'add_comment',
    description:
      'Start a new comment thread on a block or on an exact text span inside it, without changing the document: review notes, questions, suggestions the user should decide on.',
    inputSchema: {
      type: 'object',
      properties: {
        blockIndex: { type: 'integer', description: 'block to annotate' },
        text: {
          type: 'string',
          description:
            'exact text inside the block to anchor the comment to; omitted = the whole block',
        },
        occurrence: {
          type: 'integer',
          description: 'which match to anchor when text occurs more than once (1 = first)',
        },
        comment: { type: 'string', description: 'comment body; \\n starts a new paragraph' },
      },
      required: ['blockIndex', 'comment'],
    },
  },
{
    name: 'delete_comment',
    description:
      'Delete a comment. A thread root with replies is refused unless withReplies is true; a reply id deletes just that reply.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id of the comment to delete' },
        withReplies: {
          type: 'boolean',
          description: 'also delete the replies of a thread root (default false)',
        },
      },
      required: ['id'],
    },
  }, DEFINE_STYLE_TOOL, {...LIST_STYLES_TOOL, readOnly:true}, INSERT_PICTURE_TOOL, INSERT_TEXT_BOX_TOOL,
{ name:'write_document',description:'Write supplied restricted HTML into the current document. Append by default; replace:true explicitly replaces the entire BODY, including tables/images. Use only when the user asked to replace or clear the whole document. html:"" with replace:true clears the body. Preserve headers/footer/page settings. Do not use for selected text or a section. This is a native deterministic write, not a second model request.',inputSchema:{type:'object',properties:{html:{type:'string',maxLength:500000},replace:{type:'boolean'},afterBlockIndex:{type:'integer'}},required:['html']} },
{ name:'insert_section_break',description:'Insert a real Word section break after a current top-level block. Following content starts in the requested nextPage/continuous/evenPage/oddPage section. Read context again after this structural change.',inputSchema:{type:'object',properties:{afterBlockIndex:{type:'integer'},type:{type:'string',enum:['nextPage','continuous','evenPage','oddPage']}},required:['afterBlockIndex']} },
{ name:'set_watermark',description:'Set or remove a native text watermark in the Word header. text:null removes it. This browser tool supports text watermarks with the existing Word renderer defaults; picture or custom-style watermarks are not supported.',inputSchema:{type:'object',additionalProperties:false,properties:{text:{type:['string','null'],maxLength:200}},required:['text']} },
].map(tool=>tool.name==='read_notes'?{...tool,readOnly:true,description:'List native footnote/endnote IDs, full text and reference locations with pagination. To read a long note, pass id and kind with offset to continue. Never treat a truncated preview as full text.',inputSchema:{type:'object',properties:{id:{type:'string'},kind:{type:'string',enum:['footnote','endnote']},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:50}}}}:tool.name==='replace_selection'?{...tool,description:'Replace exactly the captured highlighted text. html:"" deletes just the selection, including a multi-block selection; nonempty replacement must fit one paragraph. Never removes the whole block for a partial selection. Refuses stale selections after content changes. Use write_document only for an explicitly requested whole-document replacement.'}:tool);

export const BROWSER_WRITER_GUIDE = 'Native apply_ops operation signatures (flat records; atomic batch, max 100):\n'+opSignatures().join('\n')+'\nUse replace_selection with html:"" to remove only highlighted text; never widen a partial selection to blocks. For explicit whole-document clear/rewrite use write_document replace:true with the complete requested restricted HTML (empty clears). A page is a rendered region, not a block: inspect the user selection and page context before editing. Use actual revision IDs after read_revisions; accept/reject only when requested. Read notes/styles/comments before editing them.';
const result = (summary: string, output: string, mutated = false): ToolExecution => ({ summary, output, mutated });
const failure = (summary: string, output: string): ToolExecution => ({ ...result(summary, output), isError: true });

export function executeBrowserWriterTool(editor: Editor, call: AgentToolCall, numIds: NumIds, track: AiTrack | undefined, frozen: FrozenSelection | null | undefined, comments: AiCommentsAccess | undefined, app: AiDocumentAccess | undefined): ToolExecution | null {
  const input = call.input;
  const name = call.name;
  const summary = name.replaceAll('_', ' ');
  const notes = app?.notes;
  try {
    switch (name) {
      case 'replace_selection': {
        if (typeof input.html !== 'string') return failure(summary, 'html must be a string; an empty string deletes the selection.');
        const scope = frozen ? (frozen.doc === editor.state.doc ? frozen.scope : null) : getSelectionScope(editor);
        if (!scope?.isRange || scope.from === undefined || scope.to === undefined || scope.from >= scope.to) return failure(summary, 'The captured selection is empty or changed after a content edit. Select the intended text again, or inspect and use explicit current block targets. Nothing changed.');
        const { from, to } = scope;
        const doc = editor.state.doc;
        const $from = doc.resolve(from), $to = doc.resolve(to);
        let protectedContent = false;
        doc.nodesBetween(from, to, n => { if (n.type.name === 'docProtected' || n.attrs.locked) protectedContent = true; });
        if (protectedContent) return failure(summary, 'The selection includes protected content. Use an explicit supported object/block operation after inspecting it.');
        const html = input.html.trim();
        const tr = editor.state.tr;
        if (!html) {
          // Multi-block deletion is character-exact. The TrackChanges recorder
          // retains a reviewable deletion when tracking is enabled.
          tr.deleteRange(from, to);
        } else {
          if (!$from.sameParent($to) || !$from.parent.isTextblock) return failure(summary, 'Nonempty replacement must be inside one paragraph. Use explicit block replacement for multiple paragraphs.');
          const parsed = parseHtmlFragment(html, numIds);
          if (parsed.length !== 1 || !['docParagraph','docHeading','docListItem'].includes(parsed[0]!.type)) return failure(summary, 'Selection replacement must contain inline text in one paragraph.');
          const block = editor.schema.nodeFromJSON(parsed[0]!);
          const anchor = $from.parent.childAfter($from.parentOffset).node;
          const inherited = (anchor?.marks ?? []).filter(m => !['ins','del','rprChange'].includes(m.type.name));
          const nodes: import('@tiptap/pm/model').Node[] = [];
          block.forEach(node => {
            let marks: readonly import("@tiptap/pm/model").Mark[] = inherited;
            for (const mark of node.marks) marks = mark.addToSet(marks);
            nodes.push(node.mark(marks));
          });
          if (track) {
            const date = new Date().toISOString();
            const size = nodes.reduce((n,node)=>n+node.nodeSize,0);
            tr.insert(to,nodes).addMark(from,to,editor.schema.marks.del!.create({author:track.author,date}));
            if(size) tr.addMark(to,to+size,editor.schema.marks.ins!.create({author:track.author,date}));
            tr.setMeta(TRACK_IGNORE,true).setSelection(TextSelection.create(tr.doc,to,to+size));
          } else tr.replaceWith(from,to,nodes).setSelection(TextSelection.create(tr.doc,from,from+nodes.reduce((n,node)=>n+node.nodeSize,0)));
        }
        const storage = editor.storage.trackChanges as { enabled: boolean; author: string } | undefined;
        if (track && storage && !tr.getMeta(TRACK_IGNORE)) {
          const prior = { ...storage }; storage.enabled = true; storage.author = track.author;
          try { editor.view.dispatch(tr); } finally { storage.enabled = prior.enabled; storage.author = prior.author; }
        } else editor.view.dispatch(tr);
        return result(summary, html ? 'Replaced only the captured selected text; surrounding content is unchanged.' : 'Removed only the captured selected text; surrounding content is unchanged.', true);
      }
      case 'write_document': {
        if (typeof input.html !== 'string' || input.html.length > 500000) return failure(summary,'html must be a string of at most 500000 characters.');
        if (input.replace !== undefined && typeof input.replace !== 'boolean') return failure(summary,'replace must be true or false.');
        const nodes = parseHtmlFragment(input.html,numIds);
        if (input.replace === true) {
          // Retain a valid editable empty paragraph when clearing the whole body.
          const body = nodes.length ? nodes : [{type:'docParagraph',attrs:{aiChanged:true}}];
          if (!replaceBlockRange(editor,0,editor.state.doc.childCount-1,body,track,{inheritFormatting:false})) return failure(summary,'The document body was not replaced.');
          return result(summary,`Replaced the entire document body with ${nodes.length} supplied block(s). Headers, footers and page settings are unchanged.`,true);
        }
        if (!nodes.length) return failure(summary,'No content to append. To clear the body explicitly use replace:true.');
        const at = insertPosition(editor,input.afterBlockIndex);
        if ('error' in at) return failure(summary,at.error);
        insertBlocksAfter(editor,at.after,nodes,track);
        return result(summary,`Inserted ${nodes.length} supplied block(s) after block ${at.after}.`,true);
      }
      case 'apply_ops': {
        if (!Array.isArray(input.ops) || input.ops.length > 100) return failure(summary,'ops must contain 1–100 operations.');
        const needsSelection = input.ops.some((op: any) => op?.target?.scope === 'selection');
        if (needsSelection && frozen && frozen.doc !== editor.state.doc) return failure(summary,'The captured selection changed after a content edit. Inspect current targets before editing.');
        const outcome = executeOps(editor,input.ops,{numIds,track,selection:frozen?.scope,dryRun:input.dryRun===true,styles:app?.styles});
        if (!outcome.ok) return failure(summary,outcome.error ?? 'No operations were applied.');
        return result(summary,JSON.stringify({dryRun:input.dryRun===true,results:outcome.results,plan:outcome.plan}),outcome.results.some(r=>r.changed>0));
      }
      case 'read_notes': {
        if(!notes) return failure(summary,'Notes are unavailable.');
        const all = (['footnote','endnote'] as const).flatMap(kind => notes.list(kind).map(note => ({ ...note, kind })));
        const selected = all.filter(note => (!input.id || note.id === input.id) && (!input.kind || note.kind === input.kind));
        const offset = Math.max(0,Math.trunc(Number(input.offset)||0));
        if(input.id) {
          if(selected.length!==1) return failure(summary,'Provide an existing unambiguous id/kind from the inventory.');
          const note=selected[0]!;
          const text=note.text.slice(offset,offset+120000);
          return result(summary,JSON.stringify({id:note.id,kind:note.kind,text,totalCharacters:note.text.length,nextOffset:offset+text.length<note.text.length?offset+text.length:null}));
        }
        const limit=Math.max(1,Math.min(50,Math.trunc(Number(input.limit)||25)));
        const page=selected.slice(offset,offset+limit).map(note=>({id:note.id,kind:note.kind,text:note.text.slice(0,2000),truncated:note.text.length>2000,reference:buildNotesContext(editor.state.doc,note.kind==='footnote'?[note]:[],note.kind==='endnote'?[note]:[],notes.protectedMarkBlock)}));
        return result(summary,JSON.stringify({notes:page,total:selected.length,nextOffset:offset+page.length<selected.length?offset+page.length:null}));
      }
      case 'insert_endnote': {
        if (!notes) return failure(summary,'Notes are unavailable.');
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 100000) return failure(summary,'text must contain 1–100000 characters.');
        const at = noteInsertPos(editor.state.doc,Number(input.blockIndex),input.afterText === undefined ? undefined : String(input.afterText));
        if ('error' in at) return failure(summary,at.error);
        const added = notes.insert('endnote',input.text,at.pos);
        return typeof added === 'string' ? failure(summary,added) : result(summary,`Inserted endnote ${added.num}.`,true);
      }
      case 'edit_note': {
        if (!notes?.replace) return failure(summary,'Note editing is unavailable.');
        const id=String(input.id??'');
        const kinds: Array<'footnote'|'endnote'> = input.kind === undefined ? ['footnote','endnote'] as const : input.kind === 'footnote' || input.kind === 'endnote' ? [input.kind] : [];
        const matches = kinds.flatMap(kind=>notes.list(kind).filter(n=>n.id===id).map(note=>({kind,note})));
        if(matches.length!==1) return failure(summary,'Read notes and provide an existing unambiguous id/kind.');
        if(typeof input.find!=='string' || !input.find || input.find.length>100000 || typeof input.replace!=='string' || input.replace.length>100000) return failure(summary,'find must be nonempty; replace must be a string.');
        const {kind,note}=matches[0]!;
        const edited=editNoteText(note,input.find,input.replace,input.matchCase!==false);
        if(!edited.count) return failure(summary,'The exact text was not found in this note; nothing changed.');
        const error=notes.replace(kind,id,edited.note);
        return error ? failure(summary,error) : result(summary,`Updated ${edited.count} match(es) in ${kind} ${id}; reference and formatting preserved.`,true);
      }
      case 'delete_note': {
        if (!notes?.remove) return failure(summary,'Note deletion is unavailable.');
        if(input.kind!=='footnote' && input.kind!=='endnote') return failure(summary,'kind must be footnote or endnote.');
        const id=String(input.id??'');
        if(!notes.list(input.kind).some(n=>n.id===id)) return failure(summary,'No note with this id; read_notes for current ids.');
        const locked=notes.protectedMarkBlock?.(input.kind,id);
        if(locked!==null && locked!==undefined) return failure(summary,`Reference remains in protected block ${locked}; note was preserved.`);
        const error=notes.remove(input.kind,id);
        return error ? failure(summary,error) : result(summary,`Deleted ${input.kind} ${id} and its reference marks.`,true);
      }
      case 'add_comment': {
        if(!comments?.add) return failure(summary,'Comment creation is unavailable.');
        if(typeof input.comment!=='string'||!input.comment.trim()||input.comment.length>100000) return failure(summary,'comment must contain 1–100000 characters.');
        const anchor=resolveCommentAnchor(editor,input as unknown as {blockIndex:unknown});
        if('error' in anchor) return failure(summary,anchor.error);
        const added=comments.add(anchor.from,anchor.to,input.comment);
        return typeof added==='string' ? failure(summary,added) : result(summary,`Added comment ${added.id} on "${anchor.excerpt.slice(0,120)}".`,true);
      }
      case 'delete_comment': {
        if(!comments?.remove) return failure(summary,'Comment deletion is unavailable.');
        const id=String(input.id??'');
        if(!comments.list().some(c=>c.id===id)) return failure(summary,'No comment with this id.');
        if(repliesOf(comments.list(),id).length && input.withReplies!==true) return failure(summary,'This thread has replies. Set withReplies:true only when the user wants the whole thread deleted.');
        const error=comments.remove(id);
        return error ? failure(summary,error) : result(summary,`Deleted comment ${id}${input.withReplies?' and its replies':''}.`,true);
      }
      case 'accept_changes': case 'reject_changes': {
        const selector=validateSelector(input);
        if('error' in selector) return failure(summary,selector.error);
        const applied=applyRevisionSelection(editor,selector,name==='accept_changes'?'accept':'reject');
        return 'error' in applied ? failure(summary,applied.error) : result(summary,`${name==='accept_changes'?'Accepted':'Rejected'} ${applied.entries.length} change(s). Remaining: ${listRevisionEntries(editor.state.doc).length}. Positional IDs changed; reread before further revision edits.`,true);
      }
      case 'list_styles': return app?.styles ? result(summary,describeStyles(app.styles.list())) : failure(summary,'Style catalog unavailable.');
      case 'define_style': {
        if(!app?.styles) return failure(summary,'Style catalog unavailable.');
        const parsed=resolveStyleDefinition(input,app.styles.list());
        if('error' in parsed) return failure(summary,parsed.error);
        const error=app.styles.upsert(parsed.value.upsert);
        return error ? failure(summary,error) : result(summary,`Defined native style ${parsed.value.upsert.styleId}; use apply_ops applyStyle to apply it.`,true);
      }
      case 'insert_text_box': {
        const at=insertPosition(editor,input.afterBlockIndex);
        if('error' in at) return failure(summary,at.error);
        const built=textBoxNode(input);
        if('error' in built) return failure(summary,built.error);
        const ok=editor.chain().insertContentAt(at.pos,built.node).run();
        return ok ? result(summary,`Inserted native editable text box after block ${at.after}.`,true) : failure(summary,'Text box insertion was rejected.');
      }
      case 'set_watermark': {
        if(!app?.watermark) return failure(summary,'Watermark editing unavailable.');
        if(Object.keys(input).some(k=>k!=='text') || (input.text!==null && (typeof input.text!=='string'||input.text.length>200))) return failure(summary,'Only text (up to 200 characters) or text:null is supported.');
        const error=app.watermark.set(input.text as string|null);
        return error ? failure(summary,error) : result(summary,input.text ? 'Native text watermark set.' : 'Native text watermark removed.',true);
      }
      case 'insert_section_break': {
        if(!app?.pageSetup?.insertBreak) return failure(summary,'Section break insertion unavailable.');
        const type=input.type??'nextPage';
        if(!['nextPage','continuous','evenPage','oddPage'].includes(String(type))) return failure(summary,'Invalid section break type.');
        const at=insertPosition(editor,input.afterBlockIndex);
        if('error' in at) return failure(summary,at.error);
        const error=app.pageSetup.insertBreak(type as 'nextPage'|'continuous'|'evenPage'|'oddPage',at.after);
        return error ? failure(summary,error) : result(summary,`Inserted native ${type} section break after block ${at.after}; re-read document context before further structural edits.`,true);
      }
      default: return null;
    }
  } catch(error) { return failure(summary,error instanceof Error?error.message:String(error)); }
}
