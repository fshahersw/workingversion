import { CharacterCount } from "@tiptap/extension-character-count";
import { Highlight } from "@tiptap/extension-highlight";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import { TextAlign } from "@tiptap/extension-text-align";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

/** Extensions shared by the Word editor and any headless conversions. */
export function draftExtensions(placeholder: string) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
    }),
    TableKit.configure({ table: { resizable: false } }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Highlight,
    CharacterCount,
    Placeholder.configure({ placeholder }),
    Markdown,
  ];
}
