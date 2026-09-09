#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(
  repoRoot,
  readOutputArgument() ?? "infra/app/artifacts/app-runtime.zip",
);
const zipDate = new Date(1980, 0, 1, 0, 0, 0);
const maxUncompressedBytes = 200 * 1024 * 1024;

function readOutputArgument() {
  const index = process.argv.indexOf("--output");
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--output requires a repository-relative path");
  }
  return value;
}

function archivePath(path) {
  return path.split(sep).join("/");
}

async function collectFiles(root, prefix) {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Missing build directory: ${relative(repoRoot, root)}`);
  }

  const files = [];
  async function visit(directory, archiveDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const source = resolve(directory, entry.name);
      const target = posix.join(archiveDirectory, archivePath(entry.name));
      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not supported: ${relative(repoRoot, source)}`);
      }
      if (entry.isDirectory()) {
        await visit(source, target);
      } else if (entry.isFile()) {
        files.push({ source, target });
      }
    }
  }

  await visit(root, prefix);
  return files;
}

async function main() {
  const nitroMetadataPath = resolve(repoRoot, ".output/nitro.json");
  const nitroMetadata = JSON.parse(
    await readFile(nitroMetadataPath, "utf8").catch(() => {
      throw new Error("Missing .output/nitro.json; run the production build first");
    }),
  );
  if (nitroMetadata?.preset !== "node-server") {
    throw new Error(
      `Expected Nitro preset node-server, received ${String(nitroMetadata?.preset ?? "unknown")}`,
    );
  }

  const buildMetadataPath = resolve(repoRoot, ".output/lambda-build.json");
  const buildMetadata = await readFile(buildMetadataPath, "utf8").catch(() => {
    throw new Error(
      "Missing .output/lambda-build.json; run the controlled build:lambda script",
    );
  });
  const parsedBuildMetadata = JSON.parse(buildMetadata);
  if (
    parsedBuildMetadata?.schema !== 1 ||
    !["testing", "staging", "prod"].includes(parsedBuildMetadata?.environment) ||
    typeof parsedBuildMetadata?.corpusOrigin !== "string"
  ) {
    throw new Error("Invalid Lambda build metadata");
  }

  const runScriptPath = resolve(repoRoot, "infra/app/runtime/run.sh");
  const runScript = await readFile(runScriptPath);
  const runScriptText = runScript.toString("utf8");
  if (!runScriptText.startsWith("#!/bin/sh\n")) {
    throw new Error("run.sh must start with an LF-terminated #!/bin/sh shebang");
  }
  if (runScript.includes(13)) {
    throw new Error("run.sh contains CRLF line endings; Lambda requires LF");
  }

  const files = [
    ...(await collectFiles(resolve(repoRoot, ".output/server"), "server")),
    ...(await collectFiles(resolve(repoRoot, ".output/public"), "public")),
  ].sort((left, right) => left.target.localeCompare(right.target, "en"));
  const payloads = await Promise.all(
    files.map(async (file) => ({ ...file, bytes: await readFile(file.source) })),
  );
  const uncompressedBytes =
    runScript.length +
    Buffer.byteLength(buildMetadata, "utf8") +
    payloads.reduce((total, file) => total + file.bytes.length, 0);
  if (uncompressedBytes > maxUncompressedBytes) {
    throw new Error(
      `Lambda package contents are ${uncompressedBytes} bytes; the 200 MiB application budget reserves room for layers`,
    );
  }

  const zip = new JSZip();
  zip.file("run.sh", runScript, {
    createFolders: false,
    date: zipDate,
    unixPermissions: 0o100755,
  });
  zip.file("build-metadata.json", buildMetadata, {
    createFolders: false,
    date: zipDate,
    unixPermissions: 0o100644,
  });
  for (const file of payloads) {
    zip.file(file.target, file.bytes, {
      createFolders: false,
      date: zipDate,
      unixPermissions: 0o100644,
    });
  }

  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    platform: "UNIX",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  const inspected = await JSZip.loadAsync(bytes);
  const runEntry = inspected.file("run.sh");
  if (!runEntry || (Number(runEntry.unixPermissions) & 0o777) !== 0o755) {
    throw new Error("Generated ZIP does not preserve run.sh mode 0755");
  }
  const expectedEntries = [
    "build-metadata.json",
    "run.sh",
    ...payloads.map((file) => file.target),
  ].sort((left, right) => left.localeCompare(right, "en"));
  const actualEntries = Object.values(inspected.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error("Generated ZIP contents do not match the controlled build");
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);

  const digest = createHash("sha256").update(bytes).digest("hex");
  console.log(
    `Packaged ${actualEntries.length} files (${uncompressedBytes} bytes uncompressed) to ${relative(repoRoot, outputPath)} (${bytes.length} bytes, sha256 ${digest}).`,
  );
}

await main();
