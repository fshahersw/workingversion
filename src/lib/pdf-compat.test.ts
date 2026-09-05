import assert from "node:assert/strict";
import { test } from "node:test";

import { ensurePromiseWithResolvers } from "./pdf-compat.ts";

test("installs Promise.withResolvers when the browser does not provide it", async () => {
  const promiseConstructor = Promise as PromiseConstructor & {
    withResolvers?: <T>() => {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  };
  const original = promiseConstructor.withResolvers;

  try {
    Reflect.deleteProperty(promiseConstructor, "withResolvers");
    ensurePromiseWithResolvers();
    assert.equal(typeof promiseConstructor.withResolvers, "function");

    const deferred = promiseConstructor.withResolvers?.<string>();
    assert.ok(deferred);
    deferred.resolve("ready");
    assert.equal(await deferred.promise, "ready");
  } finally {
    if (original) {
      Object.defineProperty(promiseConstructor, "withResolvers", {
        configurable: true,
        writable: true,
        value: original,
      });
    } else {
      Reflect.deleteProperty(promiseConstructor, "withResolvers");
    }
  }
});