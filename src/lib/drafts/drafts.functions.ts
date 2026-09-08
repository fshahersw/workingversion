// Client-callable server functions for Drafts, gated by requireAuth and scoped
// to the authenticated Cognito principal. Chain order: middleware ->
// inputValidator -> handler.
import { createServerFn } from "@tanstack/react-start";

import type { SwUser } from "@/lib/auth/cognito.server";
import { requireAuth } from "@/lib/auth/require-auth";
import {
  isDraftKind,
  isDraftStyle,
  type DraftContent,
  type DraftKind,
  type DraftStyle,
  type JsonValue,
} from "./types";

function principalOf(context: unknown): string {
  return (context as { user: SwUser }).user.sub;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function requireDraftId(value: unknown): string {
  if (typeof value !== "string" || !ULID.test(value)) throw new Error("draftId required");
  return value;
}

function cleanContent(value: unknown): DraftContent {
  const c = value as Partial<DraftContent> | undefined;
  if (!c || c.format !== "tiptap" || c.doc === undefined || c.doc === null) {
    throw new Error("content required");
  }
  return {
    format: "tiptap",
    doc: c.doc as JsonValue,
    text: typeof c.text === "string" ? c.text : "",
  };
}

export const listDraftsFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d?: { kind?: DraftKind }) => ({
    ...(d && isDraftKind(d.kind) ? { kind: d.kind } : {}),
  }))
  .handler(async ({ context, data }) => {
    const { listDrafts } = await import("./drafts.server");
    return listDrafts(principalOf(context), data.kind);
  });

export const createDraftFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(
    (d: { kind: DraftKind; title?: string; style?: DraftStyle; folderId?: string }) => {
      if (!isDraftKind(d?.kind)) throw new Error("kind required");
      return {
        kind: d.kind,
        ...(typeof d.title === "string" ? { title: d.title } : {}),
        ...(isDraftStyle(d.style) ? { style: d.style } : {}),
        ...(typeof d.folderId === "string" ? { folderId: d.folderId } : {}),
      };
    },
  )
  .handler(async ({ context, data }) => {
    const { createDraft } = await import("./drafts.server");
    return createDraft(principalOf(context), data);
  });

export const getDraftFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { draftId: string }) => ({ draftId: requireDraftId(d?.draftId) }))
  .handler(async ({ context, data }) => {
    const { getDraft } = await import("./drafts.server");
    return getDraft(principalOf(context), data.draftId);
  });

export const saveDraftContentFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(
    (d: {
      draftId: string;
      expectedVersion: number;
      content: DraftContent;
      title?: string;
      force?: boolean;
    }) => {
      const expectedVersion = Number(d?.expectedVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        throw new Error("expectedVersion required");
      }
      return {
        draftId: requireDraftId(d?.draftId),
        expectedVersion,
        content: cleanContent(d?.content),
        ...(typeof d.title === "string" ? { title: d.title } : {}),
        ...(d.force === true ? { force: true } : {}),
      };
    },
  )
  .handler(async ({ context, data }) => {
    const { saveDraftContent } = await import("./drafts.server");
    return saveDraftContent(principalOf(context), data);
  });

export const updateDraftMetaFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(
    (d: { draftId: string; title?: string; style?: DraftStyle; convId?: string }) => ({
      draftId: requireDraftId(d?.draftId),
      ...(typeof d.title === "string" ? { title: d.title } : {}),
      ...(isDraftStyle(d.style) ? { style: d.style } : {}),
      ...(typeof d.convId === "string" ? { convId: d.convId } : {}),
    }),
  )
  .handler(async ({ context, data }) => {
    const { updateDraftMeta } = await import("./drafts.server");
    return updateDraftMeta(principalOf(context), data);
  });

export const deleteDraftFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { draftId: string }) => ({ draftId: requireDraftId(d?.draftId) }))
  .handler(async ({ context, data }) => {
    const { deleteDraft } = await import("./drafts.server");
    return deleteDraft(principalOf(context), data.draftId);
  });

/**
 * Import a DOCX: the client converts it to HTML with mammoth (browser) and
 * sends the original bytes here (base64, capped) so the source is kept with
 * the draft for download. Content is saved separately through saveDraftContentFn.
 */
export const attachDraftSourceFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { draftId: string; name: string; ext: "docx" | "pdf"; base64: string }) => {
    if (d?.ext !== "docx" && d?.ext !== "pdf") throw new Error("ext must be docx or pdf");
    if (typeof d.base64 !== "string" || !d.base64 || d.base64.length > 40 * 1024 * 1024) {
      throw new Error("file too large (30 MB max)");
    }
    return {
      draftId: requireDraftId(d.draftId),
      name: typeof d.name === "string" && d.name.trim() ? d.name.trim() : `source.${d.ext}`,
      ext: d.ext,
      base64: d.base64,
    };
  })
  .handler(async ({ context, data }) => {
    const { putDraftSource, setDraftSource } = await import("./drafts.server");
    const principal = principalOf(context);
    const bytes = new Uint8Array(Buffer.from(data.base64, "base64"));
    const contentType =
      data.ext === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const sourceKey = await putDraftSource(principal, data.draftId, data.ext, bytes, contentType);
    await setDraftSource(principal, { draftId: data.draftId, sourceName: data.name, sourceKey });
    return { sourceKey };
  });
