import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { PdfWorkspace } from "@/office/pdf/PdfWorkspace";
export const Route = createFileRoute("/_authenticated/office/pdf/$docId")({
  ssr: false, head: () => ({ meta: [{ title: "PDF review — Seeger Weiss" }] }), component: PdfPage,
});
function PdfPage() {
  const { docId } = Route.useParams();
  return <AppShell><PdfWorkspace key={docId} docId={docId} /></AppShell>;
}
