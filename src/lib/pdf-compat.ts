type PromiseResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

/** PDF.js 5 uses this ES2024 API; older Safari releases do not provide it. */
export function ensurePromiseWithResolvers(): void {
  const promiseConstructor = Promise as PromiseConstructor & {
    withResolvers?: <T>() => PromiseResolvers<T>;
  };
  if (typeof promiseConstructor.withResolvers === "function") return;

  Object.defineProperty(promiseConstructor, "withResolvers", {
    configurable: true,
    writable: true,
    value: function withResolvers<T>(): PromiseResolvers<T> {
      let resolve: PromiseResolvers<T>["resolve"] = () => undefined;
      let reject: PromiseResolvers<T>["reject"] = () => undefined;
      const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
      });
      return { promise, resolve, reject };
    },
  });
}