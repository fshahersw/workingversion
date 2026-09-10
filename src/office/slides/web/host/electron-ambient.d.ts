// The vendored Sheets preload annotates IPC listeners with Electron's global
// `Electron.IpcRendererEvent` type. The browser edition has no Electron types,
// so declare the one shape it uses.
declare namespace Electron {
  interface IpcRendererEvent {
    sender?: unknown;
    ports?: unknown[];
  }
}
