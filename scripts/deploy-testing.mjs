#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paramsPath = resolve(repoRoot, "infra/app/parameters/testing-runtime.parameters.json");
const templatePath = "infra/app/app-runtime.cfn.yaml";
const zipRel = "infra/app/artifacts/app-runtime.zip";
const zipPath = resolve(repoRoot, zipRel);
const stackName = process.env.LITAI_TESTING_STACK || "litai-testing-runtime";
const region = process.env.AWS_REGION || "us-east-1";
const defaultProfile = "AdministratorAccess-475976462949";
const testingDomain = "testing.seegerweiss.com";
const testingCertArn =
  process.env.LITAI_TESTING_ACM_ARN ||
  "arn:aws:acm:us-east-1:475976462949:certificate/a6a6af35-de96-436d-b17e-3298929724fb";

export function readParameterFile(text) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("parameter file must be a JSON array");
  return parsed;
}

export function parameterValue(params, key) {
  const row = params.find((item) => item.ParameterKey === key);
  if (!row || typeof row.ParameterValue !== "string") {
    throw new Error(`Missing parameter ${key}`);
  }
  return row.ParameterValue;
}

export function setParameterValue(params, key, value) {
  const row = params.find((item) => item.ParameterKey === key);
  if (!row) {
    params.push({ ParameterKey: key, ParameterValue: value });
    return params;
  }
  row.ParameterValue = value;
  return params;
}

export function artifactObjectKey(sha256) {
  return `releases/${sha256}/app-runtime.zip`;
}

export function nextApiDeploymentSlot(current) {
  return current === "green" ? "blue" : "green";
}

function parseArgs(argv) {
  const unknown = argv.filter((arg) => !arg.startsWith("--") && arg !== "--");
  if (unknown.length > 0) throw new Error(`Unexpected arguments: ${unknown.join(" ")}`);
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const allowed = new Set([
    "--skip-build",
    "--flip-slot",
    "--attach-alias",
    "--refresh-env",
    "--dry-run",
    "--help",
    "-h",
  ]);
  for (const flag of flags) {
    if (!allowed.has(flag)) throw new Error(`Unknown flag ${flag}`);
  }
  return {
    skipBuild: flags.has("--skip-build"),
    flipSlot: flags.has("--flip-slot"),
    attachAlias: flags.has("--attach-alias"),
    refreshEnv: flags.has("--refresh-env"),
    dryRun: flags.has("--dry-run"),
    help: flags.has("--help") || flags.has("-h"),
  };
}

function printHelp() {
  console.log(`Deploy a new testing build to ${stackName}.

  bun run deploy:testing

  --skip-build     Reuse ${zipRel}
  --flip-slot      Toggle ApiDeploymentSlot (required when REST API shape changes)
  --attach-alias   Attach ${testingDomain} after ACM is ISSUED
  --refresh-env    Update the stack so CloudFormation re-resolves secrets
  --dry-run        Build or hash locally; print the plan; no AWS writes
`);
}

function awsEnv() {
  const env = { ...process.env, AWS_REGION: region };
  delete env.AWS_BEARER_TOKEN_BEDROCK;
  if (!env.AWS_PROFILE) env.AWS_PROFILE = defaultProfile;
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: options.env || awsEnv(),
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`);
  }
  return (result.stdout || "").trim();
}

function aws(args) {
  return run("aws", args);
}

function loadParams() {
  return readParameterFile(readFileSync(paramsPath, "utf8"));
}

function saveParams(params) {
  writeFileSync(paramsPath, `${JSON.stringify(params, null, 2)}\n`);
}

function buildArtifact(params) {
  const env = {
    ...process.env,
    LITAI_BUILD_ENVIRONMENT: "testing",
    VITE_CORPUS_URL: parameterValue(params, "CorpusUrl"),
    VITE_CORPUS_KEY: parameterValue(params, "CorpusPublishableKey"),
    LITAI_LAMBDA_BUILD: "true",
    NODE_ENV: "production",
  };
  delete env.AWS_BEARER_TOKEN_BEDROCK;
  run(process.execPath, ["scripts/build-lambda.mjs"], { env, stdio: "inherit" });
  run(process.execPath, ["scripts/package-lambda.mjs"], { env, stdio: "inherit" });
}

function zipDigest() {
  if (!existsSync(zipPath)) {
    throw new Error(`Missing ${zipRel}; run without --skip-build`);
  }
  return createHash("sha256").update(readFileSync(zipPath)).digest("hex");
}

function uploadZip(params, sha256) {
  const bucket = parameterValue(params, "ArtifactBucketName");
  const key = artifactObjectKey(sha256);
  const raw = aws([
    "s3api",
    "put-object",
    "--bucket",
    bucket,
    "--key",
    key,
    "--body",
    zipRel,
    "--server-side-encryption",
    "aws:kms",
    "--ssekms-key-id",
    parameterValue(params, "AppKmsKeyArn"),
    "--output",
    "json",
  ]);
  const uploaded = JSON.parse(raw);
  if (!uploaded.VersionId) throw new Error("S3 put-object returned no VersionId");
  return { key, version: uploaded.VersionId };
}

function assertCertIssued() {
  const status = aws([
    "acm",
    "describe-certificate",
    "--certificate-arn",
    testingCertArn,
    "--query",
    "Certificate.Status",
    "--output",
    "text",
  ]);
  if (status !== "ISSUED") {
    throw new Error(`ACM certificate is ${status}; not attaching ${testingDomain}`);
  }
}

function applyStackUpdate() {
  const changeSetName = `litai-testing-${Date.now()}`;
  try {
    aws([
      "cloudformation",
      "create-change-set",
      "--stack-name",
      stackName,
      "--change-set-name",
      changeSetName,
      "--change-set-type",
      "UPDATE",
      "--template-body",
      `file://${templatePath}`,
      "--parameters",
      `file://infra/app/parameters/testing-runtime.parameters.json`,
      "--capabilities",
      "CAPABILITY_NAMED_IAM",
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/didn'?t contain changes/i.test(message)) {
      console.log("CloudFormation already matches these parameters.");
      return false;
    }
    throw error;
  }
  try {
    aws([
      "cloudformation",
      "wait",
      "change-set-create-complete",
      "--stack-name",
      stackName,
      "--change-set-name",
      changeSetName,
    ]);
  } catch {
    // FAILED change sets (including no-op updates) are handled below.
  }
  const description = JSON.parse(
    aws([
      "cloudformation",
      "describe-change-set",
      "--stack-name",
      stackName,
      "--change-set-name",
      changeSetName,
      "--output",
      "json",
    ]),
  );
  if (description.Status === "FAILED") {
    const reason = description.StatusReason || "";
    aws([
      "cloudformation",
      "delete-change-set",
      "--stack-name",
      stackName,
      "--change-set-name",
      changeSetName,
    ]);
    if (/didn'?t contain changes/i.test(reason)) {
      console.log("CloudFormation already matches these parameters.");
      return false;
    }
    throw new Error(reason || "Change set failed");
  }
  aws([
    "cloudformation",
    "execute-change-set",
    "--stack-name",
    stackName,
    "--change-set-name",
    changeSetName,
  ]);
  aws(["cloudformation", "wait", "stack-update-complete", "--stack-name", stackName]);
  return true;
}

function printLiveUrl() {
  const url = aws([
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    stackName,
    "--query",
    "Stacks[0].Outputs[?OutputKey==`CloudFrontUrl`].OutputValue",
    "--output",
    "text",
  ]);
  console.log(`Live: ${url}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const params = loadParams();
  if (parameterValue(params, "Environment") !== "testing") {
    throw new Error("testing-runtime.parameters.json Environment must be testing");
  }

  if (!args.skipBuild) buildArtifact(params);
  const sha256 = zipDigest();
  const nextKey = artifactObjectKey(sha256);
  const sameArtifact = parameterValue(params, "ArtifactObjectKey") === nextKey;

  if (args.flipSlot) {
    const current = parameterValue(params, "ApiDeploymentSlot");
    setParameterValue(params, "ApiDeploymentSlot", nextApiDeploymentSlot(current));
  }
  if (args.attachAlias) {
    if (!args.dryRun) assertCertIssued();
    setParameterValue(params, "AppAliasDomain", testingDomain);
    setParameterValue(params, "AcmCertificateArn", testingCertArn);
  }

  const needsUpload = !sameArtifact;
  const needsUpdate = needsUpload || args.flipSlot || args.attachAlias || args.refreshEnv;

  console.log(`Artifact sha256 ${sha256}`);
  console.log(`${needsUpload ? "Upload" : "Reuse"} s3://${parameterValue(params, "ArtifactBucketName")}/${nextKey}`);
  if (!needsUpdate) {
    console.log("Already live. Pass --refresh-env, --flip-slot, or --attach-alias to force a stack update.");
    if (!args.dryRun) printLiveUrl();
    return;
  }

  if (args.dryRun) {
    console.log("Dry run; no AWS writes.");
    return;
  }

  if (needsUpload) {
    const uploaded = uploadZip(params, sha256);
    setParameterValue(params, "ArtifactObjectKey", uploaded.key);
    setParameterValue(params, "ArtifactObjectVersion", uploaded.version);
    console.log(`Uploaded version ${uploaded.version}`);
  }

  saveParams(params);
  const updated = applyStackUpdate();
  if (updated) console.log(`Updated ${stackName}`);
  printLiveUrl();
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
