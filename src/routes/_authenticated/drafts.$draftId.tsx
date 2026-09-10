// Legacy path: /drafts/:id moved under the Office section (Library links,
// bookmarks, and the Writer adapter's "open in new tab" still use it).
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/drafts/$draftId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/office/drafts/$draftId",
      params: { draftId: params.draftId },
      replace: true,
    });
  },
});
