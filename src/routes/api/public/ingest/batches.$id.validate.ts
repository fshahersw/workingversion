// POST /api/public/ingest/batches/:id/validate — parse + fully validate the
// staged bundle. Idempotent: safe to re-run after fixing and re-uploading.
import { createFileRoute } from "@tanstack/react-router";

import { compact, parseCsv } from "@/lib/ingest/csv";
import {
  docketRow,
  incomingKey,
  manifest as manifestSchema,
  partyRow,
  slotKey,
  validateBatch,
  type DocketRow,
  type Reject,
} from "@/lib/ingest/schema";

export const Route = createFileRoute("/api/public/ingest/batches/$id/validate")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { clearRejects, getBatch, getText, headObject, json, listRejects, recordRejects, requireIngestAuth, updateBatch } =
          await import("@/lib/ingest/store.server");
        const denied = requireIngestAuth(request);
        if (denied) return denied;

        const batch = await getBatch(params.id);
        if (!batch) return json({ error: "not_found", message: "unknown batch" }, 404);
        if (["running", "completed"].includes(batch.status)) {
          return json({ error: "locked", message: `batch is ${batch.status}` }, 409);
        }

        await clearRejects(batch.batch_id);
        const slug = batch.matter_slug;
        const read = (name: string) => getText(incomingKey(slug, batch.batch_id, name));
        const [manifestRaw, docketRaw, partiesRaw] = await Promise.all([
          read("manifest.json"),
          read("docket.csv"),
          read("parties.csv"),
        ]);

        if (!manifestRaw) return json({ error: "manifest_missing", message: "manifest.json was not staged" }, 409);
        if (!docketRaw) return json({ error: "docket_missing", message: "docket.csv was not uploaded" }, 409);

        const m = manifestSchema.parse(JSON.parse(manifestRaw));
        const rejects: Reject[] = [];

        // -------- docket.csv ------------------------------------------------
        let rows: DocketRow[] = [];
        try {
          const table = parseCsv(docketRaw);
          table.rows.forEach((raw, i) => {
            const parsed = docketRow.safeParse(compact(raw));
            if (!parsed.success) {
              for (const issue of parsed.error.issues) {
                rejects.push({
                  record_id: raw["record_id"] || `row_${i + 2}`,
                  code: "invalid_field",
                  message: `${issue.path.join(".") || "row"}: ${issue.message}`,
                });
              }
            } else rows.push(parsed.data);
          });
        } catch (e) {
          return json({ error: "docket_unparseable", message: e instanceof Error ? e.message : String(e) }, 422);
        }

        // -------- parties.csv (optional) -----------------------------------
        let partyCount = 0;
        if (partiesRaw && partiesRaw.trim()) {
          try {
            const table = parseCsv(partiesRaw);
            table.rows.forEach((raw, i) => {
              const parsed = partyRow.safeParse(compact(raw));
              if (!parsed.success) {
                for (const issue of parsed.error.issues) {
                  rejects.push({ record_id: `parties_row_${i + 2}`, code: "invalid_party", message: `${issue.path.join(".")}: ${issue.message}` });
                }
              } else partyCount += 1;
            });
          } catch (e) {
            rejects.push({ code: "parties_unparseable", message: e instanceof Error ? e.message : String(e) });
          }
        }

        // -------- staged objects: existence + declared size -----------------
        const declared = rows.filter((r) => r.file_name);
        const sizes = await Promise.all(
          declared.map(async (r) => [r, await headObject(incomingKey(slug, batch.batch_id, r.file_name!))] as const),
        );
        const uploaded = new Set<string>();
        for (const [r, size] of sizes) {
          if (size === null) continue; // reported as file_missing by validateBatch
          uploaded.add(r.file_name!);
          if (r.size_bytes !== undefined && size !== r.size_bytes) {
            rejects.push({
              record_id: r.record_id,
              slot: slotKey(r),
              code: "size_mismatch",
              message: `staged object is ${size} bytes, manifest declares ${r.size_bytes}`,
            });
          }
        }

        rejects.push(...validateBatch(m, rows, uploaded));

        // -------- warnings (advisory; never block a batch) ------------------
        // Synthetic entry numbers minted for unnumbered minute/text entries
        // break docket ordering downstream: keep the real number and put the
        // "no document" signal in entry_label / availability_status instead.
        const synthetic = rows.filter((r) => r.entry_number >= 100000);
        const warnings = synthetic.slice(0, 25).map((r) => ({
          record_id: r.record_id,
          slot: slotKey(r),
          code: "synthetic_entry_number",
          message: `entry_number ${r.entry_number} looks synthetic (>= 100000). Use the real docket number and mark the row with entry_label / availability_status "text_only"; placeholder numbers are dropped from display ordering.`,
        }));
        if (synthetic.length > warnings.length) {
          warnings.push({
            record_id: "…",
            slot: "…",
            code: "synthetic_entry_number",
            message: `${synthetic.length - warnings.length} further row(s) also declare entry_number >= 100000.`,
          });
        }

        const counts = {
          docket_rows: rows.length,
          party_rows: partyCount,
          staged_files: uploaded.size,
          rejects: rejects.length,
          warnings: warnings.length,
        };
        await recordRejects(batch.batch_id, rejects);
        await updateBatch(batch.batch_id, {
          status: rejects.length ? "failed" : "validated",
          stage: "validate",
          counts,
          error: rejects.length ? `${rejects.length} validation error(s)` : null,
        });

        return json(
          {
            batch_id: batch.batch_id,
            status: rejects.length ? "failed" : "validated",
            counts,
            warnings,
            rejects: rejects.length ? await listRejects(batch.batch_id) : [],
          },
          rejects.length ? 422 : 200,
        );
      },
    },
  },
});
