// Boot order for the platform Slides editor, mirroring the Office web edition's
// editor.ts: open the engine session and install the host, expose the preload
// bridge (window.slidesApi / window.projectApi through the shimmed
// contextBridge), then load the renderer. The caller's AbortSignal cancels a
// boot that is no longer wanted (navigation, development double-mount).
import { initialize, teardown, type SlidesHostOptions } from "../web/host/session";

let preloadInstalled = false;

export async function bootSlides(
  options: SlidesHostOptions,
  signal?: AbortSignal,
): Promise<typeof import("./SlidesMount")> {
  await initialize(options, signal);
  if (!preloadInstalled) {
    // The preload defines window.slidesApi once per page load.
    await import("../src/preload/index");
    preloadInstalled = true;
  }
  return import("./SlidesMount");
}

export { teardown as teardownSlides };
