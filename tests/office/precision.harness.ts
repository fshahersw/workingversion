import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import type { Editor } from "@tiptap/core";
import { executeCommands, type CommandEnvelope } from "../../src/writer/renderer/ai/commands";
import { renderMermaidPng } from "../../src/office/shared/mermaid-render";
import { putPlatformImage, handleOf, getPlatformImage } from "../../src/office/shared/image-store";

const attrs = {
  aiChanged: { default: false },
  docxIndex: { default: null },
  blockRevision: { default: null },
};
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    docParagraph: { group: "block", content: "inline*", attrs },
    docTable: { group: "block", content: "row+", attrs },
    row: { content: "cell+" },
    cell: { content: "docParagraph+" },
    text: { group: "inline" },
  },
  marks: {
    bold: {},
    italic: {},
    del: {},
    docTextStyle: { attrs: { color: { default: null }, fontAscii: { default: null } } },
  },
});
const text = (value: string, mark?: string) => schema.text(value, mark ? [schema.mark(mark)] : []);
const para = (...children: ReturnType<typeof text>[]) =>
  schema.node("docParagraph", null, children);

async function verify(kind: string) {
  if (kind === "diagram") {
    const source = "flowchart LR\n A[Evidence] --> B[Review] --> C[Brief]";
    const r = await renderMermaidPng(source);
    const image = await putPlatformImage({
      mime: "image/png",
      base64: r.base64,
      width: r.width,
      height: r.height,
      label: "Evidence review",
      diagram: { kind: "mermaid", source, svg: r.svg },
    });
    return {
      source: getPlatformImage(handleOf(image))?.diagram?.source,
      width: r.width,
      svg: r.svg.includes("<svg"),
      base64: r.base64.length,
    };
  }
  const paragraphs = [
    para(text("The "), text("motion ", "bold"), text("is granted", "italic"), text(".")),
  ];
  if (kind === "table")
    paragraphs.push(
      schema.node("docTable", null, [
        schema.node("row", null, [
          schema.node("cell", null, [para(text("motion "), text("is granted", "bold"))]),
        ]),
      ]),
    );
  let state = EditorState.create({
    schema,
    doc: schema.node("doc", null, paragraphs),
    plugins: [history()],
  });
  const before = state.doc.toJSON();
  const editor = {
    get state() {
      return state;
    },
    schema,
    storage: {},
    view: {
      dispatch: (tr: Parameters<EditorState["apply"]>[0]) => {
        state = state.apply(tr);
      },
    },
  } as unknown as Editor;
  let commands: CommandEnvelope["commands"];
  if (kind === "style")
    commands = [
      {
        updateMatchedTextStyle: {
          containsText: "motion is granted",
          style: { color: "#CC0000" },
          fields: ["color"],
        },
      },
    ];
  else if (kind === "atomic")
    commands = [
      { replaceAllText: { containsText: "The", replaceText: "A" } },
      {
        replaceAllText: {
          containsText: "motion is granted",
          replaceText: "application is denied",
          expectedOccurrences: 2,
        },
      },
    ];
  else
    commands = [
      {
        replaceAllText: {
          containsText: "motion is granted",
          replaceText: "application is denied",
          expectedOccurrences: kind === "table" ? 2 : 1,
        },
      },
    ];
  const result = executeCommands(editor, { commands });
  const after = state.doc.toJSON(),
    content = state.doc.textContent;
  const undone = undo(state, (tr) => {
    state = state.apply(tr);
  });
  return {
    before,
    after,
    content,
    result,
    undone,
    restored: JSON.stringify(before) === JSON.stringify(state.doc.toJSON()),
  };
}
declare global {
  interface Window {
    officeVerify: typeof verify;
  }
}
window.officeVerify = verify;
