import type { Source } from "@/lib/chat-types";

/**
 * Turns a completed research answer into shareable work product: markdown with
 * a numbered authority table, plain text, or a Word memo.
 */

const FIRM = "Seeger Weiss LLP";

export function citedRefs(answer: string): string[] {
  const set = new Set<string>();
  for (const m of answer.matchAll(/\[?\b([SsDd]\d{1,3})\b\]?/g)) {
    set.add(m[1]!.toUpperCase());
  }
  return [...set];
}

/** Sources actually cited in the answer, in first-appearance order. */
export function usedSources(answer: string, sources: Source[]): Source[] {
  const order = citedRefs(answer);
  const byRef = new Map(sources.map((s) => [s.ref.toUpperCase(), s]));
  const out: Source[] = [];
  for (const ref of order) {
    const s = byRef.get(ref);
    if (s) out.push(s);
  }
  return out;
}

function authorityLines(sources: Source[]): string[] {
  return sources.map((s, i) => {
    const bits = [s.citation || s.authority || s.ref];
    if (s.authority && s.authority !== s.citation) bits.push(s.authority);
    if (s.effective_date) bits.push(s.effective_date);
    if (s.source_url && !s.source_url.startsWith("/")) bits.push(s.source_url);
    return `${i + 1}. [${s.ref}] ${bits.filter(Boolean).join(" — ")}`;
  });
}

export function answerToMarkdown(args: {
  question: string;
  answer: string;
  sources: Source[];
  matterLabel?: string | null;
}): string {
  const used = usedSources(args.answer, args.sources);
  const head = [
    `# ${FIRM} — Research memorandum`,
    "",
    args.matterLabel ? `**Matter:** ${args.matterLabel}` : null,
    `**Date:** ${new Date().toLocaleDateString()}`,
    `**Question:** ${args.question}`,
    "",
    "---",
    "",
  ].filter(Boolean) as string[];

  const tail = used.length
    ? ["", "## Authorities", "", ...authorityLines(used)]
    : [];

  return [...head, args.answer.trim(), ...tail].join("\n");
}

export function answerToPlainText(args: {
  question: string;
  answer: string;
  sources: Source[];
  matterLabel?: string | null;
}): string {
  return answerToMarkdown(args)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1");
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function slugify(text: string, max = 48): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, max) || "research-memo"
  );
}

export function downloadMarkdown(args: {
  question: string;
  answer: string;
  sources: Source[];
  matterLabel?: string | null;
}) {
  const md = answerToMarkdown(args);
  download(
    new Blob([md], { type: "text/markdown;charset=utf-8" }),
    `${slugify(args.question)}.md`,
  );
}

/** Lightweight markdown → Word paragraph mapping (headings, bullets, prose). */
export async function downloadDocx(args: {
  question: string;
  answer: string;
  sources: Source[];
  matterLabel?: string | null;
}) {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import(
    "docx"
  );

  const used = usedSources(args.answer, args.sources);
  const children: InstanceType<typeof Paragraph>[] = [];

  const inline = (text: string) => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
    return parts.map((p) =>
      p.startsWith("**") && p.endsWith("**")
        ? new TextRun({ text: p.slice(2, -2), bold: true })
        : new TextRun(p),
    );
  };

  children.push(
    new Paragraph({
      text: `${FIRM} — Research memorandum`,
      heading: HeadingLevel.HEADING_1,
    }),
  );
  if (args.matterLabel) {
    children.push(new Paragraph({ children: inline(`**Matter:** ${args.matterLabel}`) }));
  }
  children.push(
    new Paragraph({ children: inline(`**Date:** ${new Date().toLocaleDateString()}`) }),
    new Paragraph({ children: inline(`**Question:** ${args.question}`) }),
    new Paragraph({ text: "" }),
  );

  for (const raw of args.answer.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      children.push(new Paragraph({ text: "" }));
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level =
        heading[1]!.length === 1
          ? HeadingLevel.HEADING_1
          : heading[1]!.length === 2
            ? HeadingLevel.HEADING_2
            : HeadingLevel.HEADING_3;
      children.push(new Paragraph({ text: heading[2]!, heading: level }));
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      children.push(
        new Paragraph({ children: inline(bullet[1]!), bullet: { level: 0 } }),
      );
      continue;
    }
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      children.push(
        new Paragraph({ children: inline(numbered[1]!), bullet: { level: 0 } }),
      );
      continue;
    }
    children.push(new Paragraph({ children: inline(line) }));
  }

  if (used.length) {
    children.push(
      new Paragraph({ text: "Authorities", heading: HeadingLevel.HEADING_2 }),
    );
    for (const line of authorityLines(used)) {
      children.push(new Paragraph({ text: line }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  download(blob, `${slugify(args.question)}.docx`);
}
