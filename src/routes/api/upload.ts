// Upload a file into the code-interpreter sandbox so run_python can read it by
// name during this session. Text and binary both arrive base64-encoded and are
// written via writeFileB64 (relative path). Single-process dev: the sandbox
// session is a module singleton, so a file uploaded here is visible to a later
// /api/orchestrate run_python in the same process. Names are sanitized to a
// bare basename to keep everything in the sandbox working dir.
import { createFileRoute } from "@tanstack/react-router";
import { writeFileB64 } from "@/lib/agents/code-interpreter.server";

const MAX_B64_LEN = 8 * 1024 * 1024; // ~6MB decoded ceiling for inline upload

/** basename + strip anything but word chars, dot, dash; never leading dot/slash. */
function safeName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? "").trim();
  const cleaned = base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 120) || "upload.bin";
}

export const Route = createFileRoute("/api/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { name?: string; b64?: string; mime?: string } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
        }
        const name = safeName(body.name ?? "");
        const b64 = (body.b64 ?? "").replace(/^data:[^;]*;base64,/, "");
        if (!b64) return Response.json({ ok: false, error: "empty file" }, { status: 400 });
        if (b64.length > MAX_B64_LEN)
          return Response.json({ ok: false, error: "file too large (max ~6MB)" }, { status: 413 });
        try {
          await writeFileB64(name, b64);
          return Response.json({ ok: true, name });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : "upload failed" },
            { status: 500 },
          );
        }
      },
    },
  },
});
