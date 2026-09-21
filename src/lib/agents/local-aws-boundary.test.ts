import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { transform } from "esbuild";
import { localSyntheticEnabled } from "../local-development.ts";

for (const moduleName of ["code-interpreter", "bda"] as const) {
  test(`${moduleName} actual AWS factory rejects synthetic calls before construction or cached-client use`, async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const keys = ["LOCAL_SYNTHETIC_MODE", "NODE_ENV", "APP_ENVIRONMENT", "AWS_LAMBDA_FUNCTION_NAME", "AWS_EXECUTION_ENV", "ECS_CONTAINER_METADATA_URI", "ECS_CONTAINER_METADATA_URI_V4"];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    let constructions = 0, sends = 0;
    class Client {
      constructor(_options: unknown) { constructions++; }
      async send(_command: unknown) { sends++; return { status: "Success" }; }
    }
    class Command { constructor(_input: unknown) {} }
    globals.__localAwsBoundary = {
      localSyntheticEnabled, BedrockAgentCoreClient: Client, BedrockDataAutomationRuntimeClient: Client,
      StopCodeInterpreterSessionCommand: Command, GetDataAutomationStatusCommand: Command,
      loadBdaConfig: () => ({ region: "us-east-1" }),
    };
    try {
      // Exercise the full production modules; only imported services are replaced.
      // A constructor/request counter proves refusal precedes SDK initialization.
      const source = await readFile(new URL(`./${moduleName}.server.ts`, import.meta.url), "utf8");
      const code = (await transform(source, { loader: "ts", format: "esm", target: "es2022" })).code
        .replace(/^import[\s\S]*?from\s*["'][^"']+["'];\s*/gm, "");
      const injected = "const { localSyntheticEnabled, BedrockAgentCoreClient, BedrockDataAutomationRuntimeClient, StopCodeInterpreterSessionCommand, GetDataAutomationStatusCommand, loadBdaConfig } = globalThis.__localAwsBoundary;\n";
      const actual = await import(`data:text/javascript;base64,${Buffer.from(injected + code).toString("base64")}`);
      const call = () => moduleName === "bda" ? actual.getStatus("synthetic-arn") : actual.stopInterpreterSession("synthetic-session");
      for (const key of keys) delete process.env[key];
      Object.assign(process.env, { LOCAL_SYNTHETIC_MODE: "1", NODE_ENV: "development", APP_ENVIRONMENT: "local" });
      await assert.rejects(call(), /unavailable in the local synthetic workspace/);
      assert.equal(constructions, 0); assert.equal(sends, 0);

      // The ordinary production lane still reaches its configured SDK factory.
      delete process.env.LOCAL_SYNTHETIC_MODE;
      Object.assign(process.env, { NODE_ENV: "production", APP_ENVIRONMENT: "testing" });
      await call();
      assert.equal(constructions, 1); assert.equal(sends, 1);

      // A previously-created production client must not bypass the local guard.
      Object.assign(process.env, { LOCAL_SYNTHETIC_MODE: "1", NODE_ENV: "development", APP_ENVIRONMENT: "local" });
      await assert.rejects(call(), /unavailable in the local synthetic workspace/);
      assert.equal(constructions, 1); assert.equal(sends, 1);
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
      delete globals.__localAwsBoundary;
    }
  });
}
