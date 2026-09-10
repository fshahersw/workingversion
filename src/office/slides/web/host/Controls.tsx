import { useState } from "react";
import { AssistantOptions } from "@genoffice/ui";
import { currentState } from "./session";
interface Preferences {
  swMode: "write" | "ask" | "review" | "research";
  swProfile: "standard" | "thorough";
}
interface Props {
  preferences: Preferences;
  busy: boolean;
  onChange: (next: Preferences) => Promise<void>;
  onLibrary?: () => void;
}
const MODE_NOTE: Record<Preferences["swMode"], string> = {
  write: "Edits the open deck on request.",
  ask: "Read-only · no content or formatting changes.",
  review: "Read-only · no content or formatting changes.",
  research: "Public question only · no deck content is sent.",
};
export function SwControls({ preferences, busy, onChange }: Props) {
  const [error, setError] = useState("");
  const change = async (next: Preferences) => {
    try {
      await onChange(next);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mode change failed.");
    }
  };
  const tabs: ReadonlyArray<readonly [Preferences["swMode"], string]> = [
    ["write", "Edit"],
    ["ask", "Ask"],
    ["review", "Review"],
  ];
  return (
    <>
      <div className="sw-task-tabs" role="tablist" aria-label="Assistant mode">
        {tabs.map(([id, label]) => (
          <button
            role="tab"
            key={id}
            title={MODE_NOTE[id]}
            aria-selected={preferences.swMode === id}
            disabled={busy || (id === "write" && currentState().readOnly)}
            onClick={() => void change({ ...preferences, swMode: id })}
          >
            {label}
          </button>
        ))}
      </div>
      <AssistantOptions>
        <select
          aria-label="Response depth"
          value={preferences.swProfile}
          disabled={busy}
          onChange={(e) =>
            void change({ ...preferences, swProfile: e.target.value as Preferences["swProfile"] })
          }
        >
          <option value="standard">Standard</option>
          <option value="thorough">Thorough</option>
        </select>
      </AssistantOptions>
      {preferences.swMode !== "write" && (
        <p className="sw-mode-note">{MODE_NOTE[preferences.swMode]}</p>
      )}
      {error && (
        <p role="alert" className="sw-mode-note">
          {error}
        </p>
      )}
    </>
  );
}
export const SwSheetControls = SwControls;
