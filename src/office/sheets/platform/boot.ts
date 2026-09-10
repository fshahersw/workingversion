// Boot order for the platform Sheets editor, mirroring the Office web edition's
// editor.ts: open the engine session and install the host, expose the preload
// bridge (window.desktopApi / window.projectApi through the shimmed
// contextBridge), then load the renderer. The caller's AbortSignal cancels a
// boot that is no longer wanted (navigation, development double-mount).
import { initialize, teardown, type SheetsHostOptions } from "../web/host/session";

let preloadInstalled = false;

export async function bootSheets(
  options: SheetsHostOptions,
  signal?: AbortSignal,
): Promise<typeof import("./SheetsMount")> {
  await initialize(options, signal);
  if (!preloadInstalled) {
    // The preload defines window.desktopApi once (contextBridge shim refuses redefinition).
    await import("../src/preload/index");
    preloadInstalled = true;
  }
  return import("./SheetsMount");
}

export { teardown as teardownSheets };
