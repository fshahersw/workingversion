// Starter prompts for the Drafts assistant, scoped by mode and by whether a
// passage is selected. Ask and Review starters are read-only by construction
// (they never ask for edits), matching the desktop panel's contract.
import type { DraftMode } from "@/lib/agents/draft-prompts";

export type Starter = { label: string; prompt: string };

export function draftStarters(mode: DraftMode, hasSelection: boolean, empty: boolean): Starter[] {
  switch (mode) {
    case "write":
      if (empty) {
        return [
          {
            label: "Memo opening",
            prompt:
              "Draft the opening of an internal memorandum: heading block (To, From, Date, Re), a one-paragraph question presented and a short answer. Leave the facts for me to fill in where you do not have them.",
          },
          {
            label: "Statement of facts",
            prompt:
              "Draft a statement of facts section from what you can establish about the matter I describe next; mark anything you could not verify.",
          },
          {
            label: "Argument outline",
            prompt:
              "Draft a headed outline of the argument section, two levels deep, with a one-sentence thesis under each heading.",
          },
          {
            label: "Client letter",
            prompt:
              "Draft a client update letter in plain English summarizing where the matter stands and what happens next.",
          },
        ];
      }
      return hasSelection
        ? [
            {
              label: "Expand this",
              prompt:
                "Expand the selected passage into a fuller treatment, keeping its voice and adding supporting authority where the point needs it.",
            },
            {
              label: "Add authority",
              prompt:
                "Add supporting authority to the selected passage: find the controlling cases or rules and cite them where the assertions need support.",
            },
            {
              label: "Counterargument",
              prompt:
                "Draft the strongest counterargument to the selected passage, then a short reply to it.",
            },
          ]
        : [
            {
              label: "Next section",
              prompt:
                "Draft the next section that logically follows the text before the cursor, matching the document's structure and voice.",
            },
            {
              label: "Transition",
              prompt:
                "Write a short transition paragraph that connects the text before the cursor to what follows.",
            },
            {
              label: "Conclusion",
              prompt:
                "Draft a conclusion for this document that states the recommended course and the open items.",
            },
          ];
    case "edit":
      return [
        {
          label: "Tighten",
          prompt: "Tighten this passage: cut redundancy and hedging, keep every fact and citation.",
        },
        {
          label: "Plain English",
          prompt: "Rewrite this passage in plain English for a client, preserving the substance.",
        },
        { label: "More formal", prompt: "Rewrite this passage in a formal brief register." },
        {
          label: "Bullets",
          prompt: "Convert this passage into a concise bulleted list, one point per bullet.",
        },
      ];
    case "ask":
      return [
        {
          label: "Weak points",
          prompt:
            "What are the weakest assertions in this document and what would it take to support them? Do not edit the document.",
        },
        {
          label: "Missing cites",
          prompt:
            "Which statements in the document assert law or fact without a citation? Do not edit the document.",
        },
        {
          label: "Current status",
          prompt:
            "Is the procedural status described in the document still current? Check and tell me what changed. Do not edit the document.",
        },
      ];
    case "review":
      return hasSelection
        ? [
            {
              label: "Review passage",
              prompt:
                "Review the selected passage for unsupported assertions, inconsistencies and overstated legal characterizations. Do not change the text.",
            },
            {
              label: "Court's eye",
              prompt:
                "Read the selected passage as the judge would and flag what would draw skepticism. Do not change the text.",
            },
          ]
        : [
            {
              label: "Full review",
              prompt:
                "Review the whole document for unsupported assertions, internal inconsistencies, dates and figures that disagree, overstated characterizations and structure problems. Do not change the text.",
            },
            {
              label: "Opposing counsel",
              prompt:
                "Read this as opposing counsel and list what you would attack first. Do not change the text.",
            },
            {
              label: "Citations check",
              prompt:
                "List every citation in the document and flag any that look wrong, incomplete or unverified. Do not change the text.",
            },
          ];
    case "research":
      return [
        {
          label: "Controlling authority",
          prompt:
            "Research the controlling authority on the issue this document addresses and write it up as document-ready material with citations.",
        },
        {
          label: "Procedural posture",
          prompt:
            "Research the current procedural posture of the matter this document concerns and write a dated status passage I can place in the document.",
        },
        {
          label: "Regulatory record",
          prompt:
            "Research the regulatory record (recalls, warning letters, label changes, rules) relevant to this document and write it up with citations.",
        },
      ];
  }
}
