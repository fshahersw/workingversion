/* eslint-disable @typescript-eslint/no-explicit-any -- vendored Office shim: the IPC surface is untyped by design */
/** Browser adapter for the retained typed preload. It exposes no Node or Electron privileges. */
export type EventMessage = { channel: string; args: unknown[] };
/** The preload types its listeners' first argument with Electron's event; the shim passes `{}`. */
export type IpcRendererEvent = Record<string, never>;
const listeners = new Map<string, Set<(...args: any[]) => void>>();
let call: (channel: string, args: any[]) => Promise<any> = async () => {
  throw Error("The document connection is not ready.");
};
let notify: (channel: string, args: any[]) => void = () => {};
export function installHost(invoke: typeof call, send: typeof notify) {
  call = invoke;
  notify = send;
}
export function emitHost(channel: string, ...args: any[]) {
  for (const callback of listeners.get(channel) ?? []) callback({}, ...args);
}
export const contextBridge = {
  exposeInMainWorld(name: string, value: unknown) {
    if (
      ![
        "slidesApi",
        "desktop",
        "desktopApi",
        "pdfApi",
        "projectApi",
        "__genofficeDebugHooks",
      ].includes(name)
    )
      throw Error("Unsupported browser bridge.");
    // Configurable and writable: the other Office editors expose the same
    // bridge names (projectApi, desktop) for their own hosts when the user
    // switches apps, and the Writer's platform adapter assigns them directly.
    Object.defineProperty(window, name, { value, configurable: true, writable: true });
  },
};
export const ipcRenderer = {
  invoke: (channel: string, ...args: any[]) => call(channel, args),
  send: (channel: string, ...args: any[]) => notify(channel, args),
  on: (channel: string, listener: (...args: any[]) => void) => {
    let set = listeners.get(channel);
    if (!set) listeners.set(channel, (set = new Set()));
    set.add(listener);
  },
  removeListener: (channel: string, listener: (...args: any[]) => void) =>
    listeners.get(channel)?.delete(listener),
};
const dropped = new Map<string, File>();
export const webUtils = {
  getPathForFile(file: File) {
    const token = "upload:" + crypto.randomUUID();
    dropped.set(token, file);
    return token;
  },
};
export function takeDropped(token: string) {
  const f = dropped.get(token);
  dropped.delete(token);
  return f;
}
