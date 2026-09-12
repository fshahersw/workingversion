import type { DepState } from "@/lib/use-deposition";

export function DepositionIntakeSummary({
  transcripts,
  files,
  ocr,
}: Pick<DepState, "transcripts" | "files" | "ocr">) {
  const names = new Map<string, number>();
  for (const t of transcripts)
    if (t.witness) {
      const key = t.witness.trim().toLowerCase();
      names.set(key, (names.get(key) ?? 0) + 1);
    }
  const attention = transcripts.filter(
    (t) => !t.witness || !t.citeReady || !t.blocks.length,
  ).length;
  return (
    <details className="shrink-0 border-b border-slate-200 bg-white text-xs">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 text-slate-700">
        <span className="font-semibold">Transcript coverage</span>
        <span>
          {transcripts.length} files · {files.reduce((n, f) => n + f.pages, 0).toLocaleString()}{" "}
          source pages
        </span>
        <span className={attention ? "text-amber-800" : "text-slate-500"}>
          {attention ? `${attention} need intake review` : "Page and line references detected"}
        </span>
        {ocr && (
          <span className="text-blue-700">
            OCR {ocr.done}/{ocr.total}
          </span>
        )}
        <span className="ml-auto text-slate-500">Details ⌄</span>
      </summary>
      <div className="max-h-44 overflow-auto border-t border-slate-100 px-3 py-2">
        <table className="w-full text-left">
          <thead className="text-[11px] text-slate-500">
            <tr>
              <th className="pb-1 font-medium">Transcript / identified witness</th>
              <th className="font-medium">Testimony blocks</th>
              <th className="font-medium">Source checks</th>
            </tr>
          </thead>
          <tbody>
            {transcripts.map((t) => {
              const f = files.find((file) => file.name === t.fileName);
              const notes = [
                !t.witness ? "Witness not identified" : "",
                !t.citeReady ? "Original page/line references unavailable" : "",
                !t.blocks.length ? "No Q&A blocks identified" : "",
                f?.empty ? `${f.empty} pages initially empty / OCR candidates` : "",
                t.witness && (names.get(t.witness.trim().toLowerCase()) ?? 0) > 1
                  ? "Same witness label in multiple files; sources kept separate"
                  : "",
              ].filter(Boolean);
              return (
                <tr key={t.fileId} className="border-t border-slate-100 align-top">
                  <td className="max-w-72 py-2 pr-4">
                    <p className="truncate font-medium" title={t.fileName}>
                      {t.fileName}
                    </p>
                    <p className="text-slate-500">{t.witness || "Review witness identity"}</p>
                  </td>
                  <td className="py-2 tabular-nums">{t.blocks.length}</td>
                  <td className="py-2 text-slate-600">
                    {notes.join(" · ") ||
                      "Page/line references available; quotes checked against this source"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-slate-500">
          Separate volumes and matching witness labels remain distinct sources. A detected name or
          page number still requires review against the original transcript.
        </p>
      </div>
    </details>
  );
}
