import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const template = readFileSync(
  new URL("../../../db/kb/infra/kb-ingest.cfn.yaml", import.meta.url),
  "utf8",
);
const runtime = readFileSync(
  new URL("../../../infra/app/app-runtime.cfn.yaml", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../../../db/kb/0002_kb_async_ingest.sql", import.meta.url),
  "utf8",
);
const migrationRunner = readFileSync(
  new URL("../../../scripts/kb-apply-migration.mjs", import.meta.url),
  "utf8",
);
const workerPackager = readFileSync(
  new URL("../../../scripts/package-kb-ingest-workers.mjs", import.meta.url),
  "utf8",
);

test("ingest correlation table is retained, encrypted, recoverable, and TTL bounded", () => {
  assert.match(template, /AWSAgentToolkit: aws-cloudformation@2/);
  assert.match(
    template,
    /IngestJobsTable:\s*\n\s*Type: AWS::DynamoDB::Table\s*\n\s*DeletionPolicy: Retain\s*\n\s*UpdateReplacePolicy: Retain/,
  );
  assert.match(template, /DeletionProtectionEnabled: true/);
  assert.match(template, /PointInTimeRecoveryEnabled: true/);
  assert.match(template, /IndexName: StatusUpdated/);
  assert.match(template, /TimeToLiveSpecification:\s*\n\s*AttributeName: ttl\s*\n\s*Enabled: true/);
  assert.match(template, /SSEType: KMS/);
});

test("exact BDA service events become compact EventBridge to SQS messages", () => {
  assert.match(template, /source:\s*\n\s*- aws\.bedrock/);
  assert.match(template, /Bedrock Data Automation Job Succeeded/);
  assert.match(template, /Bedrock Data Automation Job Failed With Client Error/);
  assert.match(template, /Bedrock Data Automation Job Failed With Service Error/);
  assert.match(template, /\$\.detail\.job_id/);
  assert.match(
    template,
    /InputTemplate: !Sub '\{"version":1,"invocationArn":"arn:\$\{AWS::Partition\}:bedrock:\$\{AWS::Region\}:\$\{AWS::AccountId\}:data-automation-invocation\/<jobId>","outcome":"success","correlationId":<correlationId>\}'/,
  );
  assert.match(template, /"aws:SourceAccount": !Ref AWS::AccountId/);
  assert.match(template, /"aws:SourceArn":[\s\S]*BdaSuccessRule\.Arn/);
  assert.doesNotMatch(
    template.match(/InputTemplate:.*$/gm)?.join("\n") ?? "",
    /owner|file|text|s3/i,
  );
});

test("worker delivery is bounded, partially retryable, and redrives safely", () => {
  assert.match(template, /VisibilityTimeout: 900/);
  assert.match(template, /Timeout: 840/);
  assert.match(template, /maxReceiveCount: 5/);
  assert.match(template, /BatchSize: 2/);
  assert.match(template, /ReportBatchItemFailures/);
  assert.match(template, /MaximumConcurrency: 3/);
  assert.match(template, /ReservedConcurrentExecutions: 4/);
  assert.match(template, /DeadLetterConfig:\s*\n\s*Arn: !GetAtt IngestDeadLetterQueue\.Arn/);
  assert.match(template, /MaximumEventAgeInSeconds: 3600/);
  assert.match(template, /MaximumRetryAttempts: 12/);
  assert.match(template, /ScheduleExpression: rate\(5 minutes\)/);
  assert.match(template, /ApproximateNumberOfMessagesVisible/);
  assert.match(template, /ApproximateAgeOfOldestMessage/);
  assert.match(template, /MetricName: Errors/);
  assert.match(template, /MetricName: Throttles/);
  assert.match(template, /MetricName: FailedInvocations/);
});

test("worker identity stays least privilege and runtime receives producer contracts", () => {
  assert.match(template, /bedrock:GetDataAutomationStatus/);
  assert.match(template, /bedrock:InvokeDataAutomationAsync/);
  assert.match(template, /bedrock:InvokeModel/);
  assert.match(template, /\$\{AppDataBucketArn\}\/uploads\/\*/);
  assert.match(template, /rds-data:BeginTransaction/);
  assert.match(template, /KB_INGEST_JOBS_TABLE/);
  assert.match(template, /KB_INGEST_QUEUE_URL/);
  assert.match(runtime, /KbIngestAccessPolicyArn/);
  assert.match(runtime, /KB_INGEST_JOBS_TABLE: !Ref KbIngestJobsTableName/);
  assert.match(runtime, /KB_INGEST_QUEUE_URL: !Ref KbIngestQueueUrl/);
  assert.match(template, /Sid: QueryStaleJobs[\s\S]*?dynamodb:PutItem[\s\S]*?dynamodb:UpdateItem/);
  assert.match(
    template,
    /Sid: CorrelationTableRegistration[\s\S]*?dynamodb:PutItem[\s\S]*?dynamodb:UpdateItem/,
  );
  assert.doesNotMatch(template, /dynamodb:TransactWriteItems/);
  assert.match(template, /ReadQueuedBdaInput[\s\S]*\$\{AppDataBucketArn\}\/uploads\/\*/);
  assert.match(
    template,
    /WriteRestartedBdaOutput[\s\S]*\$\{AppDataBucketArn\}\/kb\/bda-output\/\*/,
  );
  assert.doesNotMatch(template, /sqs:GetQueueUrl/);
  assert.doesNotMatch(template, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(template, /\bVpcConfig\b|sw-dev/);
});

test("async migration is additive, owner-bound, and preserves forced RLS", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS bda_invocation_arn/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS bda_client_file_id/);
  assert.match(migration, /bda_input_key LIKE 'uploads\/' \|\| owner_sub \|\| '\/%'/);
  assert.match(
    migration,
    /bda_output_prefix = 'kb\/bda-output\/' \|\| owner_sub \|\| '\/' \|\| doc_id/,
  );
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*bda_invocation_arn/);
  assert.match(migration, /ALTER TABLE kb\.documents FORCE ROW LEVEL SECURITY/);
  assert.doesNotMatch(migration, /BYPASSRLS|DISABLE ROW LEVEL SECURITY/i);
});

test("migration runner uses only the reviewed ordered sequence before any AWS work", () => {
  const first = migrationRunner.indexOf('"db/kb/0001_kb_init.sql"');
  const second = migrationRunner.indexOf('"db/kb/0002_kb_async_ingest.sql"');
  assert.ok(first >= 0 && second > first);
  assert.doesNotMatch(migrationRunner, /readdirSync|MIGRATION_FILE/);
  assert.ok(
    migrationRunner.indexOf("if (dryRun)") < migrationRunner.indexOf('req("KB_CLUSTER_ARN")'),
  );
});

test("worker archive carries explicit Node ESM loader metadata", () => {
  assert.match(workerPackager, /package\.json/);
  assert.match(workerPackager, /"type":"module"/);
  assert.match(workerPackager, /unixPermissions: 0o100644/);
  assert.match(template, /Handler: sqs\.handler/);
  assert.match(template, /Handler: reconcile\.handler/);
});
