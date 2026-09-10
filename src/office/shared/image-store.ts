// Images produced by platform tools (generated art, rendered diagrams,
// matplotlib figures) are held in the browser for the current page session and
// addressed by an opaque `platform-image:<id>` handle. Each editor's own insert
// tool resolves the handle to bytes; nothing is uploaded until the user saves
// the document that embeds it.

export const PLATFORM_IMAGE_PREFIX = "platform-image:";

export type StoredImage = {
  id: string;
  mime: "image/png" | "image/jpeg";
  base64: string;
  width: number;
  height: number;
  label: string;
  createdAt: number;
};

const MAX_IMAGES = 40;
const store = new Map<string, StoredImage>();

export function isPlatformImage(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PLATFORM_IMAGE_PREFIX);
}

export function getPlatformImage(handle: string): StoredImage | null {
  return store.get(handle.replace(PLATFORM_IMAGE_PREFIX, "")) ?? null;
}

export function dataUrlOf(image: Pick<StoredImage, "mime" | "base64">): string {
  return `data:${image.mime};base64,${image.base64}`;
}

/** Decode dimensions from the bytes (falls back to 0x0 when the browser cannot decode). */
async function measure(mime: string, base64: string): Promise<{ width: number; height: number }> {
  try {
    const bin = atob(base64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

export async function putPlatformImage(input: {
  mime: "image/png" | "image/jpeg";
  base64: string;
  label: string;
  width?: number;
  height?: number;
}): Promise<StoredImage> {
  const id = crypto.randomUUID().slice(0, 8);
  const size =
    input.width && input.height
      ? { width: input.width, height: input.height }
      : await measure(input.mime, input.base64);
  const image: StoredImage = {
    id,
    mime: input.mime,
    base64: input.base64,
    width: size.width,
    height: size.height,
    label: input.label.slice(0, 120),
    createdAt: Date.now(),
  };
  store.set(id, image);
  // Bound memory: drop the oldest handles first.
  while (store.size > MAX_IMAGES) {
    const oldest = [...store.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    store.delete(oldest.id);
  }
  return image;
}

export function handleOf(image: StoredImage): string {
  return PLATFORM_IMAGE_PREFIX + image.id;
}

export function describeImage(image: StoredImage): string {
  const dims = image.width && image.height ? `${image.width}x${image.height}` : "size unknown";
  return `${handleOf(image)} (${dims}, ${image.mime === "image/png" ? "PNG" : "JPEG"})`;
}
