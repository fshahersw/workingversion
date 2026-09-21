#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { readLambdaNativeTarget, assertLambdaBuildHost } from "./lambda-native-target.mjs";

const environment = process.env.LITAI_BUILD_ENVIRONMENT;
if (environment !== "testing" && environment !== "staging" && environment !== "prod") {
  throw new Error(
    "LITAI_BUILD_ENVIRONMENT must be testing, staging, or prod for a Lambda artifact",
  );
}

const nativeTarget = await readLambdaNativeTarget(process.cwd(), environment);
assertLambdaBuildHost(nativeTarget);

const corpusUrl = process.env.VITE_CORPUS_URL;
const corpusKey = process.env.VITE_CORPUS_KEY;
if (!corpusUrl || !corpusKey) {
  throw new Error(
    "VITE_CORPUS_URL and VITE_CORPUS_KEY must be supplied explicitly; Lambda builds never load .env",
  );
}
const parsedUrl = new URL(corpusUrl);
if (parsedUrl.protocol !== "https:") {
  throw new Error("VITE_CORPUS_URL must use HTTPS for a Lambda artifact");
}

process.env.LITAI_LAMBDA_BUILD = "true";
process.env.NODE_ENV = "production";
// A failed/restarted build must not retain a prior success marker for changed output.
await rm(resolve(process.cwd(), ".output/lambda-build.json"), { force: true });

// Vite 8: the argless programmatic build() builds only the CLIENT environment.
// The Lambda artifact needs the full app — client + the SSR/server environment
// and the nitro node-server output (.output/server) that TanStack Start + the
// nitro preset emit. createBuilder().buildApp() drives every declared
// environment, exactly like the `vite build` CLI does. createBuilder() with no
// inline config loads vite.config.ts from cwd, so the env set above still applies.
const { createBuilder } = await import("vite");
const builder = await createBuilder();
await builder.buildApp();
// Run with only emitted dependencies, on the exact Linux target that will run it.
execFileSync(process.execPath, ["scripts/verify-pdf-build.mjs"], { cwd: process.cwd(), env: process.env, stdio: "inherit" });

const metadata = {
  schema: 1,
  environment,
  corpusOrigin: parsedUrl.origin,
  nativeTarget,
  pdfArtifactVerified: true,
};
const outputPath = resolve(process.cwd(), ".output/lambda-build.json");
await mkdir(resolve(process.cwd(), ".output"), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
