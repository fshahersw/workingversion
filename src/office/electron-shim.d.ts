// Type-only view of the desktop modules the vendored Office preloads import.
// At build time the Vite resolver in vite.config.ts maps `electron` and the
// drop-open bridge to the browser shim of the importing app
// (src/office/<app>/web/host/{electron,drop-open}.ts); the shims share one
// shape, so TypeScript sees it here instead of through a per-app `paths` entry
// (a single `paths` target would send both apps' preloads to one shim at
// runtime, because vite-tsconfig-paths resolves before the scoped resolver).
declare module "electron" {
  type Shim = typeof import("./sheets/web/host/electron");
  export type IpcRendererEvent = import("./sheets/web/host/electron").IpcRendererEvent;
  export const ipcRenderer: Shim["ipcRenderer"];
  export const contextBridge: Shim["contextBridge"];
  export const webUtils: Shim["webUtils"];
}

declare module "@genoffice/electron-utils/drop-open" {
  export function installDropOpenBridge(): void;
}
