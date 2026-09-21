// Run only synthetic data against local storage. No AWS credential chain is used.
import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, delimiter } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { localSyntheticEnabled } from '../src/lib/local-development.ts';

const root = resolve(import.meta.dirname, '..');
const runtime = resolve(root, '.integration.local/runtime');
const data = resolve(root, '.integration.local/data');
const port = Number(process.env.LOCAL_OFFICE_PORT || 5189);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
if (process.env.NODE_ENV === 'production' || process.env.APP_ENVIRONMENT && process.env.APP_ENVIRONMENT !== 'local') throw new Error('Local launcher refuses a hosted environment');
process.env.LOCAL_SYNTHETIC_MODE = '1';
localSyntheticEnabled();
const provider = process.env.OFFICE_LOCAL_PROVIDER;
if (!['anthropic', 'fireworks'].includes(provider)) throw new Error('Choose OFFICE_LOCAL_PROVIDER=anthropic or fireworks before starting local Office');
if (!process.env[`${provider.toUpperCase()}_API_KEY`] || !process.env[`OFFICE_LOCAL_${provider.toUpperCase()}_MODEL`]) {
  throw new Error('The selected local provider requires a process-only API key and explicit model ID');
}
const origin = `http://127.0.0.1:${port}`;
Object.assign(process.env, {
  NODE_ENV: 'development', APP_ENVIRONMENT: 'local', AWS_REGION: 'us-east-1',
  LOCAL_DYNAMO_ENDPOINT: 'http://127.0.0.1:8180', LOCAL_S3_ENDPOINT: 'http://127.0.0.1:4568',
  SW_DDB_TABLE: 'sw-local-app', SW_S3_BUCKET: 'sw-local-office',
  OFFICE_ENGINE_URL: 'http://127.0.0.1:8790', OFFICE_ENGINE_PUBLIC_URL: 'http://127.0.0.1:8790',
  OFFICE_ENGINE_JWT_ISSUER: origin, OFFICE_PLATFORM_URL: origin,
  OFFICE_ENGINE_ALLOWED_ORIGINS: origin, AWS_EC2_METADATA_DISABLED: 'true',
  AWS_ACCESS_KEY_ID: 'localsynthetic', AWS_SECRET_ACCESS_KEY: 'localsynthetic',
});
delete process.env.AWS_SESSION_TOKEN;
delete process.env.AWS_PROFILE;
delete process.env.AWS_DEFAULT_PROFILE;
// Refuse cloud signing configuration inherited accidentally from a developer shell.
for (const key of ['OFFICE_ENGINE_JWT_SECRET_ARN', 'OFFICE_ENGINE_JWT_PRIVATE_KEY']) {
  if (process.env[key]) throw new Error(`Unset ${key} before starting a synthetic workspace`);
}
await mkdir(data, { recursive: true });
await mkdir(resolve(data, 'dynamo'), { recursive: true });
const require = createRequire(import.meta.url);
const S3rver = require(resolve(root, '.integration.local/storage/node_modules/s3rver'));
const storage = new S3rver({ address: '127.0.0.1', port: 4568, silent: true,
  directory: resolve(data, 's3'), configureBuckets: [{ name: 'sw-local-office', configs: [
    `<CORSConfiguration><CORSRule><AllowedOrigin>${origin}</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader></CORSRule></CORSConfiguration>`,
  ] }],
});
const children = [];
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  children.forEach(child => child.kill());
  await storage.close().catch(() => {});
  process.exit(code);
}
function start(command, args, cwd = root, env = process.env) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.on('error', error => { console.error(error.message); void close(1); });
  child.on('exit', () => { if (!closing) void close(1); });
  return child;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void close());
try {
  const jdk = (await readdir(resolve(runtime, 'jdk'), { withFileTypes: true })).find(item => item.isDirectory())?.name;
  if (!jdk) throw new Error('Install a verified JDK 21 into .integration.local/runtime/jdk first');
  const dynamo = resolve(runtime, 'dynamodb');
  start(resolve(runtime, 'jdk', jdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), [
    `-Djava.library.path=${resolve(dynamo, 'DynamoDBLocal_lib')}`,
    '-cp', `${resolve(dynamo, 'DynamoDBLocal.jar')}${delimiter}${resolve(dynamo, 'DynamoDBLocal_lib/*')}`,
    resolve(root, 'scripts/LoopbackDynamo.java'), '-port', '8180', '-sharedDb', '-disableTelemetry',
    '-cors', origin, '-dbPath', resolve(data, 'dynamo'),
  ]);
  await storage.run();
  const client = new DynamoDBClient({ region: 'us-east-1', endpoint: process.env.LOCAL_DYNAMO_ENDPOINT,
    credentials: { accessKeyId: 'localsynthetic', secretAccessKey: 'localsynthetic' }, maxAttempts: 1 });
  let ready = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    try { await client.send(new DescribeTableCommand({ TableName: 'sw-local-app' })); ready = true; break; }
    catch (error) {
      if (error.name === 'ResourceNotFoundException') {
        await client.send(new CreateTableCommand({ TableName: 'sw-local-app', BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK'].map(AttributeName => ({ AttributeName, AttributeType: 'S' })),
          KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
          GlobalSecondaryIndexes: [1, 2].map(n => ({ IndexName: `GSI${n}`, Projection: { ProjectionType: 'ALL' },
            KeySchema: [{ AttributeName: `GSI${n}PK`, KeyType: 'HASH' }, { AttributeName: `GSI${n}SK`, KeyType: 'RANGE' }] })),
        })); ready = true; break;
      }
      if (!['ECONNREFUSED', 'TimeoutError', 'Error', 'AggregateError'].includes(error.name) && error.code !== 'ECONNREFUSED') throw error;
      await delay(500);
    }
  }
  client.destroy();
  if (!ready) throw new Error('DynamoDB Local did not start');
  start(process.execPath, ['server/start.mjs'], resolve(root, 'services/office-engine'), { ...process.env, HOST: '127.0.0.1', PORT: '8790' });
  // Normal Vite dev client injects TanStack's client environment definitions.
  // The outage-test harness intentionally disables that client and is not a preview server.
  start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort']);
  console.log(`Local synthetic workspace: ${origin}/office — storage and engine on loopback only`);
} catch (error) { console.error(error.message); await close(1); }
