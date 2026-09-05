// Upload ingestion endpoint (action-based). The heavy lifting lives in
// ingest.server.ts; this route just validates + dispatches.
//  - action "start":  { name, b64, mime } -> ready attachment (sandbox path) OR
//                     a processing handle (BDA path).
//  - action "status": { invocationArn, key, name, kind, size } -> ready | processing | error.
import { createFileRoute } from "@tanstack/react-router";
import { startIngest, pollIngest, MAX_UPLOAD_BYTES } from "@/lib/agents/ingest.server";

export const Route = createFileRoute("/api/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: {
          action?: string;
          name?: string;
          b64?: string;
          mime?: string;
          invocationArn?: string;
          key?: string;
          kind?: string;
          size?: number;
        } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ status: "error", error: "invalid JSON" }, { status: 400 });
        }

        if (body.action === "start") {
          const b64 = (body.b64 ?? "").replace(/^data:[^;]*;base64,/, "");
          if (!b64) return Response.json({ status: "error", error: "empty file" }, { status: 400 });
          if (b64.length > MAX_UPLOAD_BYTES * 1.4)
            return Response.json({ status: "error", error: "file too large (max ~25MB)" }, { status: 413 });
          const res = await startIngest({ name: body.name ?? "upload.bin", b64, mime: body.mime });
          return Response.json(res, { status: res.status === "error" ? 500 : 200 });
        }

        if (body.action === "status") {
          if (!body.invocationArn || !body.key || !body.name || !body.kind)
            return Response.json({ status: "error", error: "missing fields" }, { status: 400 });
          const res = await pollIngest({
            invocationArn: body.invocationArn,
            key: body.key,
            name: body.name,
            kind: body.kind,
            size: body.size ?? 0,
          });
          return Response.json(res, { status: res.status === "error" ? 500 : 200 });
        }

        return Response.json({ status: "error", error: "unknown action" }, { status: 400 });
      },
    },
  },
});
