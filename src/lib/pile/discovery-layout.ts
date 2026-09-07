export const WORKING_SET_FILES_KEY = "sw.discovery.files-open";
export const DEPOSITION_TRANSCRIPT_KEY = "sw.discovery.transcript-open";

export function parseLayoutPreference(
  stored: string | null | undefined,
  fallback: boolean,
): boolean {
  if (stored === "true") return true;
  if (stored === "false") return false;
  return fallback;
}

export function readLayoutPreference(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    return parseLayoutPreference(window.localStorage.getItem(key), fallback);
  } catch {
    return fallback;
  }
}

export function writeLayoutPreference(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Layout preferences are optional.
  }
}
