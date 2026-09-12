/** Host name of a URL without `www.`; null for internal / relative sources. */
export function hostOf(url?: string): string | null {
  if (!url || url.startsWith("/")) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
