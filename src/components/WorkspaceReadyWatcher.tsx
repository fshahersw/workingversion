// App-level watcher (mounted once at the root) that notifies the user when a
// workspace they left mid-save finishes indexing in the background. The
// Discovery view clears its pending entry when it sees "ready" itself, so this
// only fires for sets the user navigated away from -- exactly the "you can
// leave, we'll tell you when it's ready" case. Renders nothing.
import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

import { getWorkspaceStatusFn } from "@/lib/kb/workspace.functions";
import { discoveryTabFor, stashWorkspaceHandoff } from "@/lib/kb/workspace-handoff";
import {
  listPendingWorkspaces,
  removePendingWorkspace,
  type PendingWorkspace,
} from "@/lib/pile/pending-workspaces";

const POLL_MS = 4_000;

export function WorkspaceReadyWatcher() {
  const navigate = useNavigate();
  const navRef = useRef(navigate);
  navRef.current = navigate;

  useEffect(() => {
    let alive = true;
    let askedPermission = false;

    const open = (p: PendingWorkspace) => {
      stashWorkspaceHandoff(p.surface, p.itemId);
      void navRef.current({ to: "/docs", search: { tab: discoveryTabFor(p.surface) } });
    };

    const notifyReady = (p: PendingWorkspace) => {
      toast.success(`"${p.name}" is ready`, {
        description: "Indexed and ready to search.",
        action: { label: "Open", onClick: () => open(p) },
        duration: 10_000,
      });
      // Backgrounded tab: also raise a native notification so it surfaces without
      // the app in focus. Best-effort; silently skipped if unsupported/denied.
      try {
        if (
          typeof Notification !== "undefined" &&
          typeof document !== "undefined" &&
          document.hidden &&
          Notification.permission === "granted"
        ) {
          const n = new Notification("Workspace ready", {
            body: `"${p.name}" is ready to search.`,
          });
          n.onclick = () => {
            try {
              window.focus();
            } catch {
              /* ignore */
            }
            open(p);
            n.close();
          };
        }
      } catch {
        /* notifications unavailable */
      }
    };

    const tick = async () => {
      const pending = listPendingWorkspaces();
      if (!pending.length) return;
      if (
        !askedPermission &&
        typeof Notification !== "undefined" &&
        Notification.permission === "default"
      ) {
        askedPermission = true;
        try {
          void Notification.requestPermission();
        } catch {
          /* ignore */
        }
      }
      for (const p of pending) {
        try {
          const status = await getWorkspaceStatusFn({ data: { itemId: p.itemId } });
          if (!alive) return;
          if (!status) {
            // Not found (deleted, or not this principal's) -> stop tracking.
            removePendingWorkspace(p.itemId);
            continue;
          }
          if (status.status === "ready") {
            removePendingWorkspace(p.itemId);
            notifyReady(p);
          } else if (status.status === "error") {
            removePendingWorkspace(p.itemId);
            toast.error(`Couldn't finish preparing "${p.name}"`, {
              description: status.errorSummary || "Open the workspace to see what happened.",
              action: { label: "Open", onClick: () => open(p) },
            });
          }
        } catch {
          /* transient (auth refresh / network) -> retry on the next tick */
        }
      }
    };

    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return null;
}
