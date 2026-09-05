// ============================================================================
// Ingest contract v1 — the single source of truth for what an automated ETL
// submission must look like. Mirrored (byte-for-byte in meaning) by
// schemas/ingest-manifest-v1.json and scripts/pipeline/validate_bundle.py.
//
// Core principle: the manifest is authoritative, filenames are not.
// ============================================================================
import { z } from "zod";

export const CONTRACT_VERSION = "1.0";

export const SLUG = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be kebab-case");
export const ISO_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be ISO YYYY-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(v)), "date is not a real calendar date");
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex chars");
const HTTPS = z.string().url().startsWith("https://", "URLs must be https");

/** Physical dockets that feed one matter. Replaces the old 900000 offset. */
export const DOCKET_SOURCE = z.enum(["main", "jpml", "state", "appellate"]);
export type DocketSource = z.infer<typeof DOCKET_SOURCE>;

export const AVAILABILITY = z.enum([
  "free_pdf", // public RECAP/IA PDF, file included in the bundle
  "locally_supplied", // firm's own copy, file included in the bundle
  "pacer_link", // paywalled, no file — link only
  "text_only", // docket text with no document (text/minute orders)
  "sealed", // sealed entry, no file
]);
export type Availability = z.infer<typeof AVAILABILITY>;

/** Availability values that REQUIRE a PDF in the bundle. */
export const REQUIRES_FILE: readonly Availability[] = ["free_pdf", "locally_supplied"];

export const DOC_TYPES = [
  "mdl", "case_management", "summary_judgment", "class_cert", "expert", "appeal",
  "opinion", "order", "motion", "brief", "pleading", "transcript", "exhibit",
  "notice", "stipulation", "minute", "correspondence", "sealing", "settlement",
  "discovery", "bellwether", "other",
] as const;

export const docketRow = z
  .object({
    record_id: z.string().optional(),
    docket_source: DOCKET_SOURCE,
    entry_number: z.coerce.number().int().min(0),
    entry_label: z.string().min(1),
    attachment_number: z.coerce.number().int().min(0).max(999),
    filed_date: ISO_DATE,
    description: z.string().default(""),
    document_title: z.string().optional(),
    document_type: z.string().optional(),
    doc_type: z.enum(DOC_TYPES).optional(),
    availability: AVAILABILITY,
    file_name: z.string().optional(),
    page_count: z.coerce.number().int().min(1).optional(),
    size_bytes: z.coerce.number().int().min(1).optional(),
    sha256: SHA256.optional(),
    sha1: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    md5: z.string().regex(/^[0-9a-f]{32}$/).optional(),
    is_sealed: z.coerce.boolean().default(false),
    recap_pdf_url: HTTPS.optional(),
    internet_archive_url: HTTPS.optional(),
    courtlistener_document_url: HTTPS.optional(),
    pacer_pdf_url: HTTPS.optional(),
    pacer_price_usd: z.coerce.number().min(0).optional(),
  })
  .superRefine((r, ctx) => {
    const needsFile = REQUIRES_FILE.includes(r.availability);
    if (needsFile) {
      for (const f of ["file_name", "sha256", "size_bytes", "page_count"] as const) {
        if (r[f] === undefined || r[f] === "") {
          ctx.addIssue({ code: "custom", path: [f], message: `${f} is required when availability=${r.availability}` });
        }
      }
    } else if (r.file_name) {
      ctx.addIssue({
        code: "custom",
        path: ["file_name"],
        message: `file_name must be empty when availability=${r.availability}`,
      });
    }
    if (r.attachment_number === 0 && !r.description.trim()) {
      ctx.addIssue({ code: "custom", path: ["description"], message: "main document (attachment 0) needs the docket text" });
    }
  });
export type DocketRow = z.infer<typeof docketRow>;

export const partyRow = z.object({
  party_role: z.string().optional(),
  party_name: z.string().min(1),
  representation: z.string().optional(),
  attorney_name: z.string().optional(),
  attorney_designations: z.string().optional(),
  attorney_phone: z.string().optional(),
  attorney_fax: z.string().optional(),
  attorney_email: z.string().email().optional().or(z.literal("")),
  firm_name: z.string().optional(),
  firm_address: z.string().optional(),
  attorney_full_details: z.string().optional(),
});
export type PartyRow = z.infer<typeof partyRow>;

export const manifest = z
  .object({
    contract_version: z.literal(CONTRACT_VERSION),
    idempotency_key: z.string().min(8).max(200),
    matter: z.object({
      slug: SLUG,
      short_name: z.string().min(1),
      caption: z.string().min(1),
      docket_number: z.string().min(1),
      court: z.string().min(1),
      mdl_number: z.string().nullable().optional(),
      judge: z.string().nullable().optional(),
      magistrate_judge: z.string().nullable().optional(),
      cause: z.string().nullable().optional(),
      nature_of_suit: z.string().nullable().optional(),
      jury_demand: z.string().nullable().optional(),
      jurisdiction_type: z.string().nullable().optional(),
      date_filed: ISO_DATE.nullable().optional(),
      courtlistener_docket_id: z.number().int().nullable().optional(),
      pacer_case_id: z.number().int().nullable().optional(),
      courtlistener_url: HTTPS.nullable().optional(),
      pacer_url: HTTPS.nullable().optional(),
      stage: z.string().nullable().optional(),
    }),
    dockets: z
      .array(
        z.object({
          source: DOCKET_SOURCE,
          docket_number: z.string().min(1),
          courtlistener_docket_id: z.number().int().nullable().optional(),
        }),
      )
      .min(1),
    batch: z.object({
      mode: z.enum(["full", "incremental"]).default("incremental"),
      filename_inference: z.boolean().default(false),
      submitted_by: z.string().optional(),
      callback_url: HTTPS.optional(),
    }),
    files: z
      .array(z.object({ file_name: z.string().min(1), size_bytes: z.number().int().min(1) }))
      .default([]),
    totals: z.object({
      document_slots: z.number().int().min(0),
      pdf_files: z.number().int().min(0),
      total_pages: z.number().int().min(0),
      total_bytes: z.number().int().min(0),
    }),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const d of m.dockets) {
      if (seen.has(d.source)) {
        ctx.addIssue({ code: "custom", path: ["dockets"], message: `duplicate docket source ${d.source}` });
      }
      seen.add(d.source);
    }
    const names = new Set<string>();
    for (const f of m.files) {
      if (names.has(f.file_name)) {
        ctx.addIssue({ code: "custom", path: ["files"], message: `duplicate file_name ${f.file_name}` });
      }
      names.add(f.file_name);
    }
  });
export type Manifest = z.infer<typeof manifest>;

export type Reject = { record_id?: string; slot?: string; code: string; message: string };

export const slotKey = (r: { docket_source: string; entry_number: number; attachment_number: number }) =>
  `${r.docket_source}:${r.entry_number}:${r.attachment_number}`;

/** Canonical storage keys — derived from the manifest, never from upload names. */
export const canonicalPdfKey = (slug: string, r: DocketRow) =>
  `${slug}/pdf/${r.docket_source}/${String(r.entry_number).padStart(5, "0")}-${String(r.attachment_number).padStart(3, "0")}.pdf`;
export const canonicalTextKey = (slug: string, r: DocketRow) =>
  canonicalPdfKey(slug, r).replace("/pdf/", "/text/").replace(/\.pdf$/, ".txt");
export const incomingKey = (slug: string, batchId: string, fileName: string) =>
  `${slug}/incoming/${batchId}/${fileName}`;

/**
 * Cross-row validation for a whole batch. Returns rejects; empty means clean.
 * Pure — used identically by the endpoint and by any dry-run caller.
 */
export function validateBatch(m: Manifest, rows: DocketRow[], uploaded: Set<string>): Reject[] {
  const out: Reject[] = [];
  const sources = new Set(m.dockets.map((d) => d.source));
  const slots = new Map<string, string | undefined>();
  const files = new Map<string, string | undefined>();
  const entryMeta = new Map<string, { date: string; label: string }>();
  let pdfCount = 0;
  let pages = 0;
  let bytes = 0;

  for (const r of rows) {
    const slot = slotKey(r);
    if (!sources.has(r.docket_source)) {
      out.push({ record_id: r.record_id, slot, code: "unknown_docket_source", message: `${r.docket_source} is not declared in manifest.dockets` });
    }
    if (slots.has(slot)) {
      out.push({ record_id: r.record_id, slot, code: "duplicate_slot", message: `slot already declared by record ${slots.get(slot) ?? "(no record_id)"}` });
    }
    slots.set(slot, r.record_id);

    // Attachments carry their own printed label ("12-1"), so only the filed
    // date must agree across every row of one entry.
    const ek = `${r.docket_source}:${r.entry_number}`;
    const prev = entryMeta.get(ek);
    if (!prev) entryMeta.set(ek, { date: r.filed_date, label: r.entry_label });
    else if (prev.date !== r.filed_date) {
      out.push({ record_id: r.record_id, slot, code: "entry_conflict", message: `rows disagree on filed_date for entry ${ek}` });
    }

    if (r.file_name) {
      if (files.has(r.file_name)) {
        out.push({ record_id: r.record_id, slot, code: "duplicate_file_name", message: `file_name ${r.file_name} declared twice` });
      }
      files.set(r.file_name, r.record_id);
      if (!uploaded.has(r.file_name)) {
        out.push({ record_id: r.record_id, slot, code: "file_missing", message: `declared file ${r.file_name} was not uploaded` });
      }
      pdfCount += 1;
      pages += r.page_count ?? 0;
      bytes += r.size_bytes ?? 0;
    }
  }

  for (const name of uploaded) {
    if (!files.has(name)) {
      out.push({ code: "file_undeclared", message: `uploaded file ${name} is not declared in the docket rows` });
    }
  }

  // Every attachment needs its main row present in the same batch (full mode)
  // so the docket entry can be created; incremental batches may reference an
  // entry that already exists in the corpus (checked server-side at commit).
  if (m.batch.mode === "full") {
    for (const r of rows) {
      if (r.attachment_number > 0 && !slots.has(`${r.docket_source}:${r.entry_number}:0`)) {
        out.push({ record_id: r.record_id, slot: slotKey(r), code: "orphan_attachment", message: `no main document (attachment 0) for entry ${r.docket_source}:${r.entry_number}` });
      }
    }
  }

  const t = m.totals;
  if (t.document_slots !== rows.length) out.push({ code: "totals_mismatch", message: `manifest declares ${t.document_slots} slots, docket rows contain ${rows.length}` });
  if (t.pdf_files !== pdfCount) out.push({ code: "totals_mismatch", message: `manifest declares ${t.pdf_files} PDFs, rows declare ${pdfCount}` });
  if (t.total_pages !== pages) out.push({ code: "totals_mismatch", message: `manifest declares ${t.total_pages} pages, rows sum to ${pages}` });
  if (t.total_bytes !== bytes) out.push({ code: "totals_mismatch", message: `manifest declares ${t.total_bytes} bytes, rows sum to ${bytes}` });

  return out;
}
