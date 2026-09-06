import { bedrockChat, bedrockEnabled, userText } from "@/lib/agents/bedrock.server";
import {
  BEDROCK_PILE_WRITER_MODEL,
  bedrockClaudeEnabled,
  streamBedrockClaude,
} from "@/lib/agents/bedrock-claude.server";

import { mapPool } from "@/lib/pile/async";

import {
  ASK_PACK_CHARS,
  FILE_DIGEST_CONCURRENCY,
  askBudget,
} from "./limits";
import type { PileHit, PileStructure } from "./types";

export type PileAskEmit = (event: string, data: unknown) => void;

export type PileAskPage = {
  fileName: string;
  page: number;
  text: string;
  ocr?: boolean;
};

export async function writePileAnswer(
  input: {
    query: string;
    pages: PileAskPage[];
    hits?: PileHit[];
    files?: { name: string; pageCount: number }[];
    structure?: PileStructure | null;
    instructions?: string | null;
  },
  emit: PileAskEmit,
  signal?: AbortSignal,
) {
  if (!bedrockEnabled()) throw new Error("AWS_BEARER_TOKEN_BEDROCK is not configured");
  const pages = input.pages
    .slice(0, askBudget(input.files?.length ?? 1).singlePack + 4)
    .map((p) => ({
    ...p,
    text: (p.text ?? "").slice(0, 3500),
  }));
  if (input.hits?.length) {
    emit("retrieve", {
      status: "done",
      hits: input.hits.map((h) => ({
        fileId: h.fileId,
        fileName: h.fileName,
        page: h.page,
        score: h.score,
        snippet: h.snippet,
        garbled: h.garbled,
        ocr: h.ocr,
      })),
    });
  }
  if (!pages.length) {
    emit("error", { message: "No readable pages in this pile yet." });
    return;
  }

  const context = pages
    .map(
      (p, i) =>
        `[S${i + 1}] ${p.fileName} p. ${p.page}${p.ocr ? " (VL OCR)" : ""}\n${p.text}`,
    )
    .join("\n\n");
  const inventory = (input.structure?.inventory ?? input.files ?? []).map((row) => {
    if ("docType" in row) return `- ${row.file} (${row.docType}, ${row.pages} pp)`;
    return `- ${row.name} (${row.pageCount} pp)`;
  });
  const system = [
    "You are a litigation analyst at Seeger Weiss LLP.",
    "Answer ONLY from the retrieved pages.",
    "Cite with [S1], [S2], … matching the numbered pages. Never invent a source number.",
    "Put a short verbatim quote in quotation marks immediately before each cite.",
    "This pile can contain multiple files. When the question spans documents, compare them: agreements vs. contradictions, who said what, and which file each fact comes from.",
    "If two files disagree, say so and cite both. Do not treat one PDF as the whole record.",
    "Some PACER text layers are noisy OCR. Quote only spans you can read; if a page is garbled, say it is not reliably readable.",
    inventory.length ? `FILES IN THIS PILE:\n${inventory.join("\n")}` : "",
    input.instructions ? `Attorney focus: ${input.instructions}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  emit("writer_start", {
    model: bedrockClaudeEnabled() ? BEDROCK_PILE_WRITER_MODEL : "nvidia.nemotron-super-3-120b",
  });
  let summary = "";
  const user = `QUESTION\n${input.query}\n\nRETRIEVED PAGES\n${context}`;

  if (bedrockClaudeEnabled()) {
    await streamBedrockClaude(
      {
        model: BEDROCK_PILE_WRITER_MODEL,
        system,
        messages: [{ role: "user", content: user }],
        maxTokens: 20000,
        effort: "low",
        ...(signal ? { signal } : {}),
      },
      {
        onText: (delta) => {
          summary += delta;
          emit("delta", { text: delta });
        },
      },
    );
  } else {
    const res = await bedrockChat({
      model: "nvidia.nemotron-super-3-120b",
      system,
      messages: [userText(user)],
      maxTokens: 12000,
      temperature: 0.1,
      ...(signal ? { signal } : {}),
    });
    summary = res.text;
    emit("delta", { text: res.text });
  }
  emit("done", { chars: summary.length, pages: pages.length });
}

// ---------------------------------------------------------------------------
// Multi-file: read each document on its own, then cross-analyze the digests.
// ---------------------------------------------------------------------------

export type PileAskFile = {
  fileId: string;
  fileName: string;
  pageCount: number;
  matched: boolean;
  /** Best per-file search score; used to pick the fan-out set on large piles. */
  topScore?: number;
  pages: PileAskPage[];
};

type FileDigest = {
  fileName: string;
  matched: boolean;
  refs: string[];
  text: string;
  error?: string;
};

const READER_MODEL = "nvidia.nemotron-super-3-120b";

/** Stream the final answer with whichever writer is configured. */
async function streamWriter(
  system: string,
  user: string,
  emit: PileAskEmit,
  signal?: AbortSignal,
): Promise<string> {
  let out = "";
  if (bedrockClaudeEnabled()) {
    await streamBedrockClaude(
      {
        model: BEDROCK_PILE_WRITER_MODEL,
        system,
        messages: [{ role: "user", content: user }],
        maxTokens: 20000,
        effort: "low",
        ...(signal ? { signal } : {}),
      },
      {
        onText: (delta) => {
          out += delta;
          emit("delta", { text: delta });
        },
      },
    );
  } else {
    const res = await bedrockChat({
      model: READER_MODEL,
      system,
      messages: [userText(user)],
      maxTokens: 12000,
      temperature: 0.1,
      ...(signal ? { signal } : {}),
    });
    out = res.text;
    emit("delta", { text: res.text });
  }
  return out;
}

/**
 * Fan-out / fan-in Ask. Each file is read on its own against the same question
 * (parallel, bounded, failure-isolated), then one writer call compares the
 * per-file digests: agreements, contradictions, single-source facts, gaps.
 */
export async function writeMultiFileAnswer(
  input: {
    query: string;
    files: PileAskFile[];
    hits?: PileHit[];
    structure?: PileStructure | null;
    instructions?: string | null;
  },
  emit: PileAskEmit,
  signal?: AbortSignal,
) {
  if (!bedrockEnabled()) throw new Error("AWS_BEARER_TOKEN_BEDROCK is not configured");

  // Global [S1..Sn] numbering shared by every reader and the writer, so a
  // citation in a per-file digest still points at the right page downstream.
  let n = 0;
  const numbered = input.files.map((f) => ({
    ...f,
    pages: f.pages.map((p) => ({ ...p, ref: `S${(n += 1)}`, text: (p.text ?? "").slice(0, 3500) })),
  }));
  const allPages = numbered.flatMap((f) => f.pages);
  if (!allPages.length) {
    emit("error", { message: "No readable pages in this pile yet." });
    return;
  }
  if (input.hits?.length) emit("retrieve", { status: "done", hits: input.hits });

  const budget = askBudget(numbered.length);
  // On large piles, reader calls go to the most query-relevant documents —
  // ranked by per-file search score, not upload order.
  const readable = numbered
    .filter((f) => f.pages.length)
    .sort(
      (a, b) =>
        Number(b.matched) - Number(a.matched) ||
        (b.topScore ?? 0) - (a.topScore ?? 0) ||
        a.fileName.localeCompare(b.fileName),
    );
  const fanout = readable.slice(0, budget.fanoutFiles);
  const fanoutPages = fanout.reduce((sum, f) => sum + f.pages.length, 0);
  emit("fanout", {
    files: fanout.map((f) => ({ fileId: f.fileId, fileName: f.fileName, pages: f.pages.length })),
    skipped: readable.length - fanout.length,
    total: readable.length,
    pages: fanoutPages,
  });

  const digests = await mapPool(
    fanout,
    FILE_DIGEST_CONCURRENCY,
    async (file): Promise<FileDigest> => {
      emit("file_read", { fileId: file.fileId, fileName: file.fileName, status: "running" });
      const context = file.pages
        .map((p) => `[${p.ref}] p. ${p.page}${p.ocr ? " (VL OCR)" : ""}\n${p.text}`)
        .join("\n\n");
      const system = [
        "You are a litigation analyst reading ONE document from a larger pile.",
        "Report only what THIS document says about the question, in 3-7 tight bullets.",
        "Every bullet must end with its source tag, e.g. [S4]. Never invent a tag.",
        "If this document does not address the question, reply exactly: NOT ADDRESSED.",
        "Quote key operative language verbatim where it matters. Do not speculate.",
      ].join(" ");
      const user = `QUESTION\n${input.query}\n\nDOCUMENT: ${file.fileName} (${file.pageCount} pp)\n\nRETRIEVED PAGES\n${context}`;
      try {
        const res = await bedrockChat({
          model: READER_MODEL,
          system,
          messages: [userText(user)],
          maxTokens: 8000,
          temperature: 0.1,
          ...(signal ? { signal } : {}),
        });
        const text = res.text.trim();
        const matched = !!text && !/^NOT ADDRESSED/i.test(text);
        emit("file_read", {
          fileId: file.fileId,
          fileName: file.fileName,
          status: "done",
          matched,
        });
        return { fileName: file.fileName, matched, refs: file.pages.map((p) => p.ref), text };
      } catch (err) {
        const message = err instanceof Error ? err.message : "read failed";
        emit("file_read", {
          fileId: file.fileId,
          fileName: file.fileName,
          status: "error",
          detail: message,
        });
        return {
          fileName: file.fileName,
          matched: false,
          refs: file.pages.map((p) => p.ref),
          text: "",
          error: message,
        };
      }
    },
    signal,
  );

  const digestBlock = digests
    .map((d) =>
      d.error
        ? `### ${d.fileName}\n(could not be read: ${d.error})`
        : `### ${d.fileName}\n${d.matched ? d.text : "Does not address the question."}`,
    )
    .join("\n\n");

  // Evidence pack scales with file count (budget.writerPack), always bounded
  // by the ASK_PACK_CHARS character ceiling so the writer never overflows.
  const writerPages = readable.flatMap((f) => f.pages);
  const contextParts: string[] = [];
  let contextChars = 0;
  for (const p of writerPages.slice(0, budget.writerPack)) {
    const part = `[${p.ref}] ${p.fileName} p. ${p.page}${p.ocr ? " (VL OCR)" : ""}\n${p.text.slice(0, 2400)}`;
    if (contextChars + part.length > ASK_PACK_CHARS) break;
    contextParts.push(part);
    contextChars += part.length;
  }
  const context = contextParts.join("\n\n");

  const inventory = numbered.map(
    (f) => `- ${f.fileName} (${f.pageCount} pp, ${f.matched ? "matched" : "no keyword match"})`,
  );
  const system = [
    "You are a litigation analyst at Seeger Weiss LLP synthesizing across multiple documents.",
    "Each document was read separately; you receive per-document digests plus the underlying pages.",
    "Answer the question by cross-analyzing them: what the documents agree on, where they contradict each other, what only one document says, and what none of them answer.",
    "Attribute every fact to its document and cite [S1], [S2], … exactly as numbered. Never invent a source number.",
    "Put a short verbatim quote in quotation marks immediately before each cite.",
    "Do not let the longest document speak for the record. Name documents that are silent on the question.",
    "Some PACER text layers are noisy OCR; if a page is not reliably readable, say so.",
    `FILES IN THIS PILE:\n${inventory.join("\n")}`,
    input.instructions ? `Attorney focus: ${input.instructions}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  emit("writer_start", {
    model: bedrockClaudeEnabled() ? BEDROCK_PILE_WRITER_MODEL : READER_MODEL,
    mode: "cross-file",
    files: fanout.length,
  });
  const user = `QUESTION\n${input.query}\n\nPER-DOCUMENT DIGESTS\n${digestBlock}\n\nRETRIEVED PAGES\n${context}`;
  const summary = await streamWriter(system, user, emit, signal);
  emit("done", { chars: summary.length, pages: allPages.length, files: fanout.length });
}
