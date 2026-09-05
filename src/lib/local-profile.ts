// Local-only user profile (name, position, avatar). Replaces the removed
// Lovable Cloud `profiles` table + avatars bucket. Persisted in localStorage
// so the new auth workflow can swap in later without UI changes.

export type LocalProfile = {
  full_name: string | null;
  title: string | null;
  avatar_data_url: string | null;
};

const KEY = "sw:profile";

export const EMPTY_PROFILE: LocalProfile = {
  full_name: null,
  title: null,
  avatar_data_url: null,
};

export function readProfile(): LocalProfile {
  if (typeof window === "undefined") return EMPTY_PROFILE;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY_PROFILE;
    const parsed = JSON.parse(raw) as Partial<LocalProfile>;
    return {
      full_name: parsed.full_name ?? null,
      title: parsed.title ?? null,
      avatar_data_url: parsed.avatar_data_url ?? null,
    };
  } catch {
    return EMPTY_PROFILE;
  }
}

export function writeProfile(p: LocalProfile): LocalProfile {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
  return p;
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the image file."));
    reader.readAsDataURL(file);
  });
}
