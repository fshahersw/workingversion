// Legacy path: /drafts moved under the Office section.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/drafts/")({
  beforeLoad: () => {
    throw redirect({ to: "/office/drafts", replace: true });
  },
});
