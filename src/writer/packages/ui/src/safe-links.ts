/** Allow citations and known workspace links; never execute a model-supplied scheme. */
const workspacePath = /^\/office\/(?:drafts|sheets|slides|pdf)\/[0-9A-HJKMNP-TV-Z]{26}(?:#[a-zA-Z0-9_.-]+)?$/;
export function safeAssistantLink(value: unknown, currentOrigin = typeof window === 'undefined' ? undefined : window.location.origin): { href: string; external: boolean } | null {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  if (workspacePath.test(value)) {
    return { href: value, external: false };
  }
  try {
    const url = new URL(value);
    if (url.origin === currentOrigin && !url.username && !url.password && !url.search && workspacePath.test(url.pathname + url.hash)) {
      return { href: url.pathname + url.hash, external: false };
    }
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return { href: url.href, external: true };
  } catch { return null; }
}

export function safeAssistantImage(value: unknown): boolean {
  return typeof value === 'string' && value.length < 6_000_000 && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/]+=*$/.test(value);
}

export function activityDuration(startedAt?: number, finishedAt?: number): string | null {
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt! < startedAt!) return null;
  const seconds = (finishedAt! - startedAt!) / 1000;
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
