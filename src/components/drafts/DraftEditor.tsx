import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Eraser,
  Highlighter,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Table as TableIcon,
  Underline,
  Undo2,
} from "lucide-react";
import { useEffect, useMemo, type ReactNode } from "react";

import { draftExtensions } from "@/lib/drafts/editor-extensions";
import type { DraftStyle, JsonValue } from "@/lib/drafts/types";

export type DraftEditorProps = {
  /** Initial document (TipTap JSON) or null for an empty document. */
  initialDoc: JsonValue | null;
  style: DraftStyle;
  readOnly?: boolean;
  placeholder?: string;
  /** Fires after every change with the current document and its plain text. */
  onChange: (doc: JsonValue, text: string) => void;
  /** Hands the live editor to the parent (AI panel inserts through it). */
  onReady?: (editor: Editor) => void;
  /** Selection changes: plain text of the selection, or "" when collapsed. */
  onSelection?: (text: string) => void;
  /** Rendered between the toolbar and the page (e.g. save status). */
  toolbarEnd?: ReactNode;
};

export function DraftEditor({
  initialDoc,
  style,
  readOnly = false,
  placeholder = "Start writing, or ask the assistant to draft a section…",
  onChange,
  onReady,
  onSelection,
  toolbarEnd,
}: DraftEditorProps) {
  // Stable extension instances: useEditor compares options by identity on
  // every render and re-applies them when they differ.
  const extensions = useMemo(() => draftExtensions(placeholder), [placeholder]);
  const editor = useEditor({
    extensions,
    // A stored document is always a JSON object; anything else starts empty.
    content:
      initialDoc && typeof initialDoc === "object" && !Array.isArray(initialDoc)
        ? (initialDoc as Record<string, unknown>)
        : undefined,
    editable: !readOnly,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: `sw-doc sw-doc-${style} focus:outline-none`,
        spellcheck: "true",
      },
    },
    onUpdate: ({ editor: e }) => {
      onChange(e.getJSON() as JsonValue, e.getText({ blockSeparator: "\n" }));
    },
    onSelectionUpdate: ({ editor: e }) => {
      if (!onSelection) return;
      const { from, to, empty } = e.state.selection;
      onSelection(empty ? "" : e.state.doc.textBetween(from, to, "\n"));
    },
  });

  useEffect(() => {
    if (editor && onReady) onReady(editor);
  }, [editor, onReady]);

  useEffect(() => {
    if (!editor) return;
    editor.setOptions({
      editorProps: {
        attributes: { class: `sw-doc sw-doc-${style} focus:outline-none`, spellcheck: "true" },
      },
    });
  }, [editor, style]);

  // emitUpdate=false: toggling editability is not a document change and must
  // not trigger onChange (it queued empty autosaves on every mount).
  useEffect(() => {
    editor?.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border/70 bg-card px-2 py-1">
        {editor ? <Toolbar editor={editor} disabled={readOnly} /> : null}
        {toolbarEnd ? <div className="ml-auto flex items-center">{toolbarEnd}</div> : null}
      </div>
      <div className="wr-app-scroll min-h-0 flex-1 overflow-y-auto bg-surface px-4 py-6 sm:px-8">
        <div className="sw-page mx-auto w-full max-w-[860px] rounded-md border border-border/70 bg-card px-10 py-12 shadow-[0_10px_40px_-24px_rgba(31,42,94,0.35)] sm:px-16 sm:py-16">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}

function Toolbar({ editor, disabled }: { editor: Editor; disabled: boolean }) {
  // Re-render on every transaction so active states track the cursor.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      highlight: e.isActive("highlight"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      link: e.isActive("link"),
      table: e.isActive("table"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      left: e.isActive({ textAlign: "left" }),
      center: e.isActive({ textAlign: "center" }),
      right: e.isActive({ textAlign: "right" }),
      justify: e.isActive({ textAlign: "justify" }),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const block = state.h1 ? "h1" : state.h2 ? "h2" : state.h3 ? "h3" : "p";
  const setBlock = (value: string) => {
    const chain = editor.chain().focus();
    if (value === "p") chain.setParagraph().run();
    else chain.toggleHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 }).run();
  };
  const setLink = () => {
    const previous = editor.getAttributes("link")["href"] as string | undefined;
    const url = window.prompt("Link address", previous ?? "https://");
    if (url === null) return;
    if (!url.trim()) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };

  return (
    <>
      <Tb
        title="Undo"
        onClick={() => editor.chain().focus().undo().run()}
        disabled={disabled || !state.canUndo}
      >
        <Undo2 className="h-3.5 w-3.5" />
      </Tb>
      <Tb
        title="Redo"
        onClick={() => editor.chain().focus().redo().run()}
        disabled={disabled || !state.canRedo}
      >
        <Redo2 className="h-3.5 w-3.5" />
      </Tb>
      <Sep />
      <select
        value={block}
        onChange={(e) => setBlock(e.target.value)}
        disabled={disabled}
        aria-label="Paragraph style"
        className="h-7 rounded border border-border/70 bg-background px-1.5 text-[11.5px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="p">Body</option>
        <option value="h1">Title</option>
        <option value="h2">Heading</option>
        <option value="h3">Subheading</option>
      </select>
      <Sep />
      <Tb
        title="Bold (Ctrl+B)"
        active={state.bold}
        onClick={() => editor.chain().focus().toggleBold().run()}
        disabled={disabled}
      >
        <Bold className="h-3.5 w-3.5" />
      </Tb>
      <Tb
        title="Italic (Ctrl+I)"
        active={state.italic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        disabled={disabled}
      >
        <Italic className="h-3.5 w-3.5" />
      </Tb>
      <Tb
        title="Underline (Ctrl+U)"
        active={state.underline}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        disabled={disabled}
      >
        <Underline className="h-3.5 w-3.5" />
      </Tb>
      <Tb
        title="Strikethrough"
        active={state.strike}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        disabled={disabled}
      >
        <Strikethrough className="h-3.5 w-3.5" />
      </Tb>
      <Tb
        title="Highlight"
        active={state.highlight}
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        disabled={disabled}
      >
        <Highlighter className="h-3.5 w-3.5" />
      </Tb>
      <Tb title="Link" active={state.link} onClick={setLink} disabled={disabled}>
        <Link2 className="h-3.5 w-3.5" />
      </Tb>
      <Sep />
      <Tb
        title="Bulleted list"
        active={state.bullet}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        disabled={disabled}
      >
        <List className="h-3.5 w-3.5" />
      </Tb>
      <Tb
        title="Numbered list"
        active={state.ordered}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        disabled={disabled}
      >
        <ListOrdered className="h-3.5 w-3.5" />
      </Tb>
      <Tb
        title="Block quote"
        active={state.quote}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        disabled={disabled}
      >
        <Quote className="h-3.5 w-3.5" />
      </Tb>
      <Sep />
      <Tb
        title="Align left"
        active={state.left}
        onClick={() => editor.chain().focus().setTextAlign("left").run()}
        disabled={disabled}
      >
        <AlignLeft className="h-3.5 w-3.5" />
      </Tb>
      <Tb
        title="Center"
        active={state.center}
        onClick={() => editor.chain().focus().setTextAlign("center").run()}
        disabled={disabled}
      >
        <AlignCenter className="h-3.5 w-3.5" />
      </Tb>
      <Tb
        title="Align right"
        active={state.right}
        onClick={() => editor.chain().focus().setTextAlign("right").run()}
        disabled={disabled}
      >
        <AlignRight className="h-3.5 w-3.5" />
      </Tb>
      <Tb
        title="Justify"
        active={state.justify}
        onClick={() => editor.chain().focus().setTextAlign("justify").run()}
        disabled={disabled}
      >
        <AlignJustify className="h-3.5 w-3.5" />
      </Tb>
      <Sep />
      {state.table ? (
        <>
          <TextTb
            title="Add a row below"
            onClick={() => editor.chain().focus().addRowAfter().run()}
            disabled={disabled}
          >
            + Row
          </TextTb>
          <TextTb
            title="Add a column after"
            onClick={() => editor.chain().focus().addColumnAfter().run()}
            disabled={disabled}
          >
            + Col
          </TextTb>
          <TextTb
            title="Delete this row"
            onClick={() => editor.chain().focus().deleteRow().run()}
            disabled={disabled}
          >
            − Row
          </TextTb>
          <TextTb
            title="Delete this column"
            onClick={() => editor.chain().focus().deleteColumn().run()}
            disabled={disabled}
          >
            − Col
          </TextTb>
          <TextTb
            title="Toggle header row"
            onClick={() => editor.chain().focus().toggleHeaderRow().run()}
            disabled={disabled}
          >
            Header
          </TextTb>
          <TextTb
            title="Delete table"
            onClick={() => editor.chain().focus().deleteTable().run()}
            disabled={disabled}
          >
            Remove table
          </TextTb>
        </>
      ) : (
        <Tb
          title="Insert table"
          onClick={() =>
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
          disabled={disabled}
        >
          <TableIcon className="h-3.5 w-3.5" />
        </Tb>
      )}
      <Tb
        title="Horizontal rule"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        disabled={disabled}
      >
        <Minus className="h-3.5 w-3.5" />
      </Tb>
      <Tb
        title="Clear formatting"
        onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
        disabled={disabled}
      >
        <Eraser className="h-3.5 w-3.5" />
      </Tb>
    </>
  );
}

function Tb({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`grid h-7 w-7 place-items-center rounded text-foreground/75 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 ${
        active ? "bg-brand-blue-soft/70 text-brand-navy" : ""
      }`}
    >
      {children}
    </button>
  );
}

function TextTb({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="h-7 rounded px-1.5 text-[11px] font-medium text-foreground/75 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-0.5 h-4 w-px bg-border/80" />;
}
