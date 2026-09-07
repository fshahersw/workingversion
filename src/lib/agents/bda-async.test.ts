import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("./bda.server.ts", import.meta.url), "utf8");

test("notified BDA invocation requires a deterministic token and enables EventBridge", () => {
  assert.match(source, /clientToken:\s*requireClientToken/);
  assert.match(
    source,
    /notificationConfiguration:\s*\{\s*eventBridgeConfiguration:\s*\{\s*eventBridgeEnabled:\s*true/s,
  );
  assert.match(source, /eventBridgeEnabled && !options\.clientToken/);
});

test("BDA status and result handling do not surface raw service errors or foreign pointers", () => {
  assert.doesNotMatch(source, /error:\s*`\$\{r\.errorType[^]*r\.errorMessage/);
  assert.match(source, /Document conversion failed\./);
  assert.match(source, /outside the configured bucket/);
  assert.match(source, /expectedOutputPrefix/);
});
