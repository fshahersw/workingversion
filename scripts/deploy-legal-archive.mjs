#!/usr/bin/env node
// Deploy the Legal Archive (externalcorpus directory + Corpus Workbench) to testing.
//
//   bun run deploy:legal-archive              images + service stack (no data pull)
//   bun run deploy:legal-archive --pull       ...and run the refresher task once (first pull, ~1 h)
//   bun run deploy:legal-archive --skip-build reuse the images already tagged in ECR (:latest)
//   bun run deploy:legal-archive --dry-run    print the plan; no AWS writes
//
// Order of operations (each step is idempotent):
//   1. zip services/legal-archive -> s3://<artifact bucket>/legal-archive/source.zip
//   2. deploy the build stack (ECR repositories + CodeBuild) and run the build
//   3. update the office-engine stack so it exports its listener/SG/full name (no resource change)
//   4. make sure ARCHIVE_APP_KEY exists in the corpus secret (the gateway's second key)
//   5. deploy the service stack: instance, data volume, tasks, ALB path rule, nightly schedule
//   6. optionally run the refresher once and print where its log streams
// The platform's own stack (CloudFront behaviors, LEGAL_ARCHIVE_URL, ARCHIVE_APP_KEY env)
// is deployed separately with `bun run deploy:testing --refresh-env`.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const region = process.env.LITAI_AWS_REGION || "us-east-1";
const defaultProfile = "AdministratorAccess-475976462949";
const namePrefix = "litai";
const environment = "testing";
const runtimeParamsPath = resolve(repoRoot, "infra/app/parameters/testing-runtime.parameters.json");
const officeStack = `${namePrefix}-${environment}-office-engine`;
const buildStack = `${namePrefix}-${environment}-legal-archive-build`;
const serviceStack = `${namePrefix}-${environment}-legal-archive`;
const sourceDir = resolve(repoRoot, "services/legal-archive");
const sourceKey = "legal-archive/source.zip";
const zipPath = resolve(repoRoot, "infra/legal-archive/artifacts/source.zip");

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const allowed = new Set(["--pull", "--skip-build", "--dry-run", "--help", "-h", "--archive-commit"]);
  for (const f of flags) if (!allowed.has(f.split("=")[0])) throw new Error(`Unknown flag ${f}`);
  const commitFlag = argv.find((a) => a.startsWith("--archive-commit="));
  return {
    pull: flags.has("--pull"),
    skipBuild: flags.has("--skip-build"),
    dryRun: flags.has("--dry-run"),
    help: flags.has("--help") || flags.has("-h"),
    archiveCommit: commitFlag ? commitFlag.split("=")[1] : "main",
  };
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
    env: awsEnv(),
    encoding: "utf8",
    shell: process.platform === "win32" && command !== process.execPath,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`);
  }
  return (result.stdout || "").trim();
}

const aws = (args) => run("aws", args);
const awsJson = (args) => JSON.parse(aws([...args, "--output", "json"]));

function paramValue(params, key) {
  const row = params.find((p) => p.ParameterKey === key);
  if (!row || typeof row.ParameterValue !== "string") throw new Error(`Missing parameter ${key}`);
  return row.ParameterValue;
}

function stackOutputs(name) {
  const stacks = awsJson(["cloudformation", "describe-stacks", "--stack-name", name]).Stacks;
  const out = {};
  for (const o of stacks[0].Outputs || []) out[o.OutputKey] = o.OutputValue;
  return out;
}

function stackParameters(name) {
  const stacks = awsJson(["cloudformation", "describe-stacks", "--stack-name", name]).Stacks;
  const out = {};
  for (const p of stacks[0].Parameters || []) out[p.ParameterKey] = p.ParameterValue;
  return out;
}

function stackExists(name) {
  try {
    aws(["cloudformation", "describe-stacks", "--stack-name", name]);
    return true;
  } catch {
    return false;
  }
}

async function zipSource() {
  const zip = new JSZip();
  const fixedDate = new Date(1980, 0, 1, 0, 0, 0);
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = relative(sourceDir, full).replace(/\\/g, "/");
      if (statSync(full).isDirectory()) walk(full);
      else zip.file(rel, readFileSync(full), { date: fixedDate, unixPermissions: entry.endsWith(".sh") ? 0o755 : 0o644 });
    }
  };
  walk(sourceDir);
  const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE", compressionOptions: { level: 9 } });
  mkdirSync(dirname(zipPath), { recursive: true });
  writeFileSync(zipPath, bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

function deployStack(name, template, parameters, capabilities = ["CAPABILITY_NAMED_IAM"]) {
  const args = ["cloudformation", "deploy", "--stack-name", name, "--template-file", template, "--no-fail-on-empty-changeset", "--capabilities", ...capabilities];
  if (parameters && Object.keys(parameters).length) {
    args.push("--parameter-overrides", ...Object.entries(parameters).map(([k, v]) => `${k}=${v}`));
  }
  run("aws", args, { stdio: "inherit" });
}

function startBuild(project, imageTag, archiveCommit) {
  const build = awsJson([
    "codebuild", "start-build", "--project-name", project,
    "--environment-variables-override", `name=IMAGE_TAG,value=${imageTag},type=PLAINTEXT`, `name=ARCHIVE_COMMIT,value=${archiveCommit},type=PLAINTEXT`,
  ]).build;
  const id = build.id;
  console.log(`CodeBuild ${id} started`);
  const started = Date.now();
  for (;;) {
    const status = awsJson(["codebuild", "batch-get-builds", "--ids", id]).builds[0].buildStatus;
    if (status === "SUCCEEDED") return;
    if (status !== "IN_PROGRESS") throw new Error(`CodeBuild ${id} ended with ${status}`);
    if (Date.now() - started > 50 * 60 * 1000) throw new Error(`CodeBuild ${id} still running after 50 minutes`);
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{}, 20000)"]);
    process.stdout.write(".");
  }
}

function ensureAppKey(secretArn, dryRun) {
  const current = JSON.parse(awsJson(["secretsmanager", "get-secret-value", "--secret-id", secretArn]).SecretString);
  if (typeof current.ARCHIVE_APP_KEY === "string" && current.ARCHIVE_APP_KEY.length >= 32) return current.ARCHIVE_APP_KEY;
  const key = randomBytes(36).toString("base64url");
  if (dryRun) {
    console.log("dry-run: would add ARCHIVE_APP_KEY to the corpus secret");
    return key;
  }
  aws(["secretsmanager", "put-secret-value", "--secret-id", secretArn, "--secret-string", JSON.stringify({ ...current, ARCHIVE_APP_KEY: key })]);
  console.log("Added ARCHIVE_APP_KEY to the corpus secret");
  return key;
}

function originKey(originSecretArn) {
  const secret = JSON.parse(awsJson(["secretsmanager", "get-secret-value", "--secret-id", originSecretArn]).SecretString);
  if (!secret.officeEngineOriginKey) throw new Error("officeEngineOriginKey missing from the origin secret");
  return secret.officeEngineOriginKey;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  const runtimeParams = JSON.parse(readFileSync(runtimeParamsPath, "utf8"));
  const bucket = paramValue(runtimeParams, "ArtifactBucketName");
  const corpusSecretArn = paramValue(runtimeParams, "CorpusServiceSecretArn");
  const originSecretArn = paramValue(runtimeParams, "OriginAccessSecretArn");

  // 1. source zip
  const digest = await zipSource();
  const imageTag = digest.slice(0, 12);
  console.log(`Source zip sha256 ${digest} -> image tag ${imageTag}`);
  if (args.dryRun) {
    console.log(`dry-run: would upload s3://${bucket}/${sourceKey}, deploy ${buildStack}, build, update ${officeStack} outputs, deploy ${serviceStack}${args.pull ? ", run the refresher" : ""}`);
    return;
  }

  // 2. images
  const buildOutputs = (() => {
    if (!args.skipBuild) {
      aws(["s3", "cp", zipPath, `s3://${bucket}/${sourceKey}`]);
      deployStack(buildStack, "infra/legal-archive/legal-archive-build.cfn.yaml", {
        NamePrefix: namePrefix, Environment: environment, ArtifactBucketName: bucket, SourceObjectKey: sourceKey, ArchiveCommit: args.archiveCommit,
      });
      const outputs = stackOutputs(buildStack);
      startBuild(outputs.ProjectName, imageTag, args.archiveCommit);
      console.log("\nimages pushed");
      return { ...outputs, tag: imageTag };
    }
    if (!stackExists(buildStack)) throw new Error(`${buildStack} does not exist; run without --skip-build first`);
    return { ...stackOutputs(buildStack), tag: "latest" };
  })();

  // 3. office-engine outputs the archive stack attaches to
  deployStack(officeStack, "infra/office-engine/office-engine.cfn.yaml", null);
  const office = stackOutputs(officeStack);
  const officeParams = stackParameters(officeStack);
  for (const k of ["ListenerArn", "AlbSecurityGroupId", "LoadBalancerFullName"]) if (!office[k]) throw new Error(`${officeStack} has no output ${k}`);

  // 4. second key for the gateway
  ensureAppKey(corpusSecretArn, false);

  // 5. network: the archive instance shares the engine's VPC and first task subnet
  const vpcId = officeParams.VpcId;
  const subnetId = officeParams.PrivateSubnetIds.split(",")[0].trim();
  const subnet = awsJson(["ec2", "describe-subnets", "--subnet-ids", subnetId]).Subnets[0];
  const parameters = {
    NamePrefix: namePrefix,
    Environment: environment,
    VpcId: vpcId,
    SubnetId: subnetId,
    AvailabilityZone: subnet.AvailabilityZone,
    AssociatePublicIp: officeParams.AssignPublicIp === "ENABLED" ? "true" : "false",
    AlbListenerArn: office.ListenerArn,
    AlbSecurityGroupId: office.AlbSecurityGroupId,
    AlbFullName: office.LoadBalancerFullName,
    OriginKeyHeaderValue: originKey(originSecretArn),
    ArchiveImageUri: `${buildOutputs.ArchiveRepositoryUri}:${buildOutputs.tag}`,
    GatewayImageUri: `${buildOutputs.GatewayRepositoryUri}:${buildOutputs.tag}`,
    AppKeySecretArn: corpusSecretArn,
  };
  deployStack(serviceStack, "infra/legal-archive/legal-archive.cfn.yaml", parameters);
  const service = stackOutputs(serviceStack);
  console.log(`Service stack ready: cluster ${service.ClusterName}, service ${service.ServiceName}, volume ${service.DataVolumeId}`);

  // 6. first pull / ad-hoc refresh
  if (args.pull) {
    const task = awsJson(["ecs", "run-task", "--cluster", service.ClusterName, "--task-definition", service.RefresherTaskDefinitionArn, "--launch-type", "EC2", "--count", "1"]);
    const arn = task.tasks?.[0]?.taskArn;
    if (!arn) throw new Error(`run-task returned no task: ${JSON.stringify(task.failures || task)}`);
    const taskId = arn.split("/").pop();
    console.log(`Refresher task ${taskId} started. Follow it with:`);
    console.log(`  aws logs tail /ecs/${namePrefix}-${environment}-legal-archive --follow --log-stream-names refresh/refresh/${taskId} --region ${region}`);
  }
  console.log("\nNext: bun run deploy:testing --refresh-env  (CloudFront /archive-api + /workbench-api behaviors, LEGAL_ARCHIVE_URL, ARCHIVE_APP_KEY)");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
