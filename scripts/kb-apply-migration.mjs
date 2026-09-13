#!/usr/bin/env node
// ============================================================================
// Apply a KB SQL migration to the Aurora cluster over the RDS Data API.
//
// The Data API is a public AWS endpoint, so this runs from anywhere with your
// AWS creds (no VPC, no psql, no CloudShell, no security-group changes). It
// splits the .sql file into individual statements (Data API forbids
// multi-statement calls), dollar-quote and comment aware, and runs each with
// the RDS-managed master secret. Then it optionally sets the kb_app role
// password from its secret and runs a smoke query as kb_app.
//
// Usage (from repo root, with AWS_PROFILE + AWS_REGION exported):
//   node scripts/kb-apply-migration.mjs --dry-run           # parse only, no AWS
//   KB_CLUSTER_ARN=... KB_SECRET_ARN=... node scripts/kb-apply-migration.mjs
//
// Env:
//   KB_CLUSTER_ARN        (required for a real run) Aurora cluster ARN
//   KB_DATABASE           default "kb"
//   KB_MASTER_SECRET_ARN  optional; auto-resolved from the cluster if unset
//   KB_SECRET_ARN          optional; if set, sets kb_app password + smoke test
//   KB_APP_SECRET_ARN      deprecated fallback for KB_SECRET_ARN
//   AWS_REGION            default "us-east-1"
// ============================================================================
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { RDSDataClient, ExecuteStatementCommand } from "@aws-sdk/client-rds-data";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fileIdx = args.indexOf("--file");
const explicitFile = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
const REGION = process.env.AWS_REGION ?? "us-east-1";
const ORDERED_MIGRATIONS = [
  "db/kb/0001_kb_init.sql",
  "db/kb/0002_kb_async_ingest.sql",
  "db/kb/0003_reference_courts.sql",
];

function migrationFiles() {
  if (fileIdx >= 0 && (!explicitFile || explicitFile.startsWith("--"))) {
    throw new Error("--file requires a SQL migration path");
  }
  if (!explicitFile) return [...ORDERED_MIGRATIONS];
  const normalized = explicitFile.replaceAll("\\", "/");
  if (!ORDERED_MIGRATIONS.includes(normalized)) {
    throw new Error(`--file must select one of: ${ORDERED_MIGRATIONS.join(", ")}`);
  }
  return [normalized];
}

/** Split SQL into top-level statements: tracks -- line comments, single-quoted
 *  literals, and $$ dollar-quoted bodies so semicolons inside them don't split. */
function splitSql(sql) {
  const out = [];
  let buf = "";
  let inLine = false; // -- comment to end of line
  let inSingle = false; // '...'
  let inDollar = false; // $$...$$
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (inLine) {
      buf += c;
      if (c === "\n") inLine = false;
      continue;
    }
    if (inSingle) {
      buf += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDollar) {
      buf += c;
      if (c === "$" && c2 === "$") {
        buf += c2;
        i++;
        inDollar = false;
      }
      continue;
    }
    // top level
    if (c === "-" && c2 === "-") {
      inLine = true;
      buf += c;
      continue;
    }
    if (c === "$" && c2 === "$") {
      inDollar = true;
      buf += c + c2;
      i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      buf += c;
      continue;
    }
    if (c === ";") {
      const stmt = buf.trim();
      if (hasSql(stmt)) out.push(stmt);
      buf = "";
      continue;
    }
    buf += c;
  }
  const tail = buf.trim();
  if (hasSql(tail)) out.push(tail);
  return out;
}

/** True if the statement has real SQL after stripping -- line comments. */
function hasSql(stmt) {
  const stripped = stmt
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .trim();
  return stripped.length > 0;
}

function aws(argv) {
  return execFileSync("aws", [...argv, "--region", REGION], {
    encoding: "utf8",
  }).trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const migrations = migrationFiles().map((file) => ({
    file,
    statements: splitSql(readFileSync(file, "utf8")),
  }));
  if (!migrations.length) {
    throw new Error("No ordered KB migrations were selected");
  }
  const statementCount = migrations.reduce(
    (total, migration) => total + migration.statements.length,
    0,
  );
  console.log(
    `Parsed ${statementCount} statement(s) from ${migrations.length} ordered migration(s)`,
  );

  if (dryRun) {
    for (const migration of migrations) {
      console.log(`  ${migration.file}`);
      migration.statements.forEach((statement, index) => {
        const first =
          statement.split("\n").find((line) => line.replace(/--.*/, "").trim()) ?? statement;
        console.log(`    ${String(index + 1).padStart(2)}. ${first.trim().slice(0, 72)}`);
      });
    }
    console.log("\n--dry-run: no AWS calls made.");
    return;
  }

  const clusterArn = req("KB_CLUSTER_ARN");
  const database = process.env.KB_DATABASE ?? "kb";
  const clusterId = clusterArn.split(":cluster:")[1];
  const masterSecretArn =
    process.env.KB_MASTER_SECRET_ARN ||
    aws([
      "rds",
      "describe-db-clusters",
      "--db-cluster-identifier",
      clusterId,
      "--query",
      "DBClusters[0].MasterUserSecret.SecretArn",
      "--output",
      "text",
    ]);

  const client = new RDSDataClient({ region: REGION });

  async function exec(secretArn, sql) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.send(
          new ExecuteStatementCommand({ resourceArn: clusterArn, secretArn, database, sql }),
        );
      } catch (e) {
        const msg = `${e?.name ?? ""} ${e?.message ?? ""}`;
        // Aurora scale-to-0 resume can take ~15s on the first call.
        if (attempt < 8 && /resum|not currently available|is not available|timeout/i.test(msg)) {
          if (attempt === 0) console.log("  (cluster resuming, retrying...)");
          await sleep(5000);
          continue;
        }
        throw e;
      }
    }
  }

  console.log(`Applying to ${clusterId} / ${database} via Data API...`);
  let applied = 0;
  for (const migration of migrations) {
    console.log(`  ${migration.file}`);
    for (const statement of migration.statements) {
      applied += 1;
      const first = statement.split("\n").find((line) => line.replace(/--.*/, "").trim()) ?? "";
      process.stdout.write(`    [${applied}/${statementCount}] ${first.trim().slice(0, 64)} ... `);
      await exec(masterSecretArn, statement);
      console.log("ok");
    }
  }
  console.log("Schema applied.");

  const appSecretArn = process.env.KB_SECRET_ARN || process.env.KB_APP_SECRET_ARN;
  if (appSecretArn) {
    const raw = aws([
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      appSecretArn,
      "--query",
      "SecretString",
      "--output",
      "text",
    ]);
    const pw = JSON.parse(raw).password;
    if (!/^[A-Za-z0-9]+$/.test(pw)) {
      throw new Error(
        "kb_app password has unexpected characters; aborting to avoid a broken ALTER.",
      );
    }
    process.stdout.write("  Setting kb_app login password ... ");
    await exec(masterSecretArn, `ALTER ROLE kb_app WITH LOGIN PASSWORD '${pw}'`);
    console.log("ok");

    process.stdout.write("  Smoke test as kb_app (select count from kb.documents) ... ");
    const res = await exec(appSecretArn, "select count(*) from kb.documents");
    const count = res.records?.[0]?.[0]?.longValue ?? "?";
    console.log(`ok, count=${count}`);
  }

  console.log("\nDone.");
}

function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

main().catch((e) => {
  console.error(`\nFAILED: ${e?.name ?? ""}: ${e?.message ?? e}`);
  process.exit(1);
});
