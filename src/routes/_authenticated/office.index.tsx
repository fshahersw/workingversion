// /office -> the Drafts tab.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/office/")({
  beforeLoad: () => {
    throw redirect({ to: "/office/drafts", replace: true });
  },
});
