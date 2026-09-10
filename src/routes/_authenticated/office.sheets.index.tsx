import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FilePlus2, FileUp, Loader2, Table2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import { DocRow, EmptyState } from "@/components/office/DocList";
import { OfficeTabs } from "@/components/office/OfficeTabs";
import { deleteOfficeDocFn, listOfficeDocsFn } from "@/lib/office/office.functions";
import { MAX_OFFICE_BYTES, type OfficeDocSummary } from "@/lib/office/types";

export const Route = createFileRoute("/_authenticated/office/sheets/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sheets — Office — Seeger Weiss" },
      {
        name: "description",
        content: "Excel workbooks edited in Sheets with the assistant at your side.",
      },
    ],
  }),
  component: SheetsPage,
});

function SheetsPage() {
  const navigate = useNavigate();
  const [docs, setDocs] = useState<OfficeDocSummary[] | null>(null);
  const [busy, setBusy] = useState<"new" | "import" | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setDocs(await listOfficeDocsFn({ data: { kind: "xlsx" } }));
    } catch {
      setDocs([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const open = (docId: string) => void navigate({ to: "/office/sheets/$docId", params: { docId } });

  const createNew = async () => {
    setBusy("new");
    try {
      const [{ blankXlsxBuffer }, { createWorkbook }] = await Promise.all([
        import("@/office/sheets/src/gateway/csv-import"),
        import("@/office/sheets/web/api"),
      ]);
      const d = await createWorkbook("Untitled.xlsx", await blankXlsxBuffer("Sheet1"));
      open(d.draftId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create a workbook");
      setBusy(null);
    }
  };

  const importFile = async (file: File) => {
    if (!/\.(xlsx|csv)$/i.test(file.name)) {
      toast.error("Choose an Excel workbook (.xlsx) or a CSV file.");
      return;
    }
    if (file.size > MAX_OFFICE_BYTES) {
      toast.error(`That file is over ${MAX_OFFICE_BYTES / 1024 / 1024} MB.`);
      return;
    }
    setBusy("import");
    try {
      const { uploadWorkbook } = await import("@/office/sheets/web/api");
      const d = await uploadWorkbook(file);
      open(d.draftId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not import that file");
      setBusy(null);
    }
  };

  const remove = async (docId: string) => {
    setDeleting(docId);
    try {
      await deleteOfficeDocFn({ data: { docId } });
      setDocs((list) => (list ? list.filter((d) => d.draftId !== docId) : list));
      toast.success("Workbook deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the workbook");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto flex h-full w-full max-w-[900px] flex-col px-4 py-6 sm:px-6">
        <OfficeTabs
          active="sheets"
          description="Excel workbooks edited in Sheets. Formulas, formats and everything you do not touch are preserved; every save is a numbered revision."
        />
        <div className="mt-4 flex items-center justify-end gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void importFile(f);
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy !== null}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
          >
            {busy === "import" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileUp className="h-3.5 w-3.5" strokeWidth={1.9} />
            )}
            Upload XLSX or CSV
          </button>
          <button
            type="button"
            onClick={() => void createNew()}
            disabled={busy !== null}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-navy px-3 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy === "new" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.9} />
            )}
            New workbook
          </button>
        </div>

        <div className="wr-app-scroll mt-4 min-h-0 flex-1 overflow-y-auto">
          {docs === null ? (
            <div className="flex items-center gap-2 px-1 py-6 text-[12.5px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : docs.length === 0 ? (
            <EmptyState
              icon={Table2}
              title="No workbooks yet"
              body="Start a blank workbook, or upload an Excel file or CSV to keep working on it in Sheets."
            />
          ) : (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {docs.map((d) => (
                <DocRow
                  key={d.draftId}
                  doc={d}
                  icon={Table2}
                  onOpen={() => open(d.draftId)}
                  onDelete={() => void remove(d.draftId)}
                  deleting={deleting === d.draftId}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </AppShell>
  );
}
