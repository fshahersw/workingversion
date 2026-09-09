#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const environment = process.env.LITAI_BUILD_ENVIRONMENT;
if (environment !== "testing" && environment !== "staging" && environment !== "prod") {
  throw new Error(
    "LITAI_BUILD_ENVIRONMENT must be testing, staging, or prod for a Lambda artifact",
  );
}

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

const { build } = await import("vite");
await build();

const metadata = {
  schema: 1,
  environment,
  corpusOrigin: parsedUrl.origin,
};
const outputPath = resolve(process.cwd(), ".output/lambda-build.json");
await mkdir(resolve(process.cwd(), ".output"), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
