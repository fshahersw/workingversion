import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { lambdaNativeTarget, assertLambdaBuildHost, assertLambdaNativeMetadata, assertLambdaNativePayloads, assertLambdaZipNativeTarget } from './lambda-native-target.mjs';

const params = architecture => [{ ParameterKey: 'Architecture', ParameterValue: architecture }];
const arm = lambdaNativeTarget(params('arm64'));
const x64 = lambdaNativeTarget(params('x86_64'));
const metadata = target => ({ schema: 1, environment: 'testing', corpusOrigin: 'https://example.invalid', nativeTarget: target, pdfArtifactVerified: true });
const elf = machine => { const bytes = new Uint8Array(64); bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes[18] = machine; return bytes; };
const payload = (target, bytes) => ({ target: `server/node_modules/${target.nativePackage}/skia.node`, bytes });

test('build target comes from runtime parameters and rejects contradictory overrides', () => {
  assert.equal(arm.nodeArchitecture, 'arm64'); assert.equal(x64.nodeArchitecture, 'x64');
  assert.throws(() => lambdaNativeTarget([]), /Architecture/);
  assert.throws(() => lambdaNativeTarget(params('arm64'), 'x86_64'), /must match/);
  assert.deepEqual(lambdaNativeTarget(params('arm64'), 'arm64'), arm);
});

test('Lambda builder refuses Windows, wrong CPU and musl before Vite runs', () => {
  for (const host of [{ platform: 'win32', arch: 'x64' }, { platform: 'linux', arch: 'x64', glibc: '2.34' }, { platform: 'linux', arch: 'arm64' }]) {
    assert.throws(() => assertLambdaBuildHost(arm, host), /matching Architecture=arm64/);
  }
  assert.doesNotThrow(() => assertLambdaBuildHost(arm, { platform: 'linux', arch: 'arm64', glibc: '2.34' }));
  assert.doesNotThrow(() => assertLambdaBuildHost(x64, { platform: 'linux', arch: 'x64', glibc: '2.34' }));
  if (process.platform === 'win32') {
    assert.throws(() => execFileSync(process.execPath, ['scripts/build-lambda.mjs'], {
      env: { ...process.env, LITAI_BUILD_ENVIRONMENT: 'testing', LITAI_LAMBDA_ARCHITECTURE: '' }, stdio: 'pipe',
    }), error => { assert.match(String(error.stderr), /Linux glibc arm64 builder/); return true; });
  }
});

test('packaging needs verified target metadata and actual matching ELF bytes', () => {
  assert.throws(() => assertLambdaNativeMetadata({ ...metadata(arm), nativeTarget: x64 }, arm), /does not match/);
  assert.throws(() => assertLambdaNativeMetadata({ ...metadata(arm), pdfArtifactVerified: false }, arm), /probe/);
  assert.doesNotThrow(() => assertLambdaNativeMetadata(metadata(arm), arm));
  assert.throws(() => assertLambdaNativePayloads([], arm), /missing/);
  assert.throws(() => assertLambdaNativePayloads([payload(arm, new Uint8Array([0x4d, 0x5a]))], arm), /ELF64/);
  assert.throws(() => assertLambdaNativePayloads([payload(arm, elf(62))], arm), /ELF64/);
  assert.doesNotThrow(() => assertLambdaNativePayloads([payload(arm, elf(183))], arm));
  assert.doesNotThrow(() => assertLambdaNativePayloads([payload(x64, elf(62))], x64));
  assert.throws(() => assertLambdaNativePayloads([payload(arm, elf(183)), { target: 'server/node_modules/other/win32.node', bytes: new Uint8Array(64) }], arm), /ELF64/);
});

test('skip-build upload boundary rejects stale, foreign and mislabeled ZIP artifacts', async () => {
  async function zip(meta, files) { const archive = new JSZip(); if (meta) archive.file('build-metadata.json', JSON.stringify(meta)); for (const file of files) archive.file(file.target, file.bytes); return archive.generateAsync({ type: 'uint8array' }); }
  await assert.rejects(assertLambdaZipNativeTarget(await zip(null, []), arm, 'testing'), /metadata/);
  await assert.rejects(assertLambdaZipNativeTarget(await zip({ ...metadata(arm), environment: 'prod' }, [payload(arm, elf(183))]), arm, 'testing'), /environment/);
  await assert.rejects(assertLambdaZipNativeTarget(await zip(metadata(x64), [payload(x64, elf(62))]), arm, 'testing'), /does not match/);
  await assert.rejects(assertLambdaZipNativeTarget(await zip(metadata(arm), [payload(arm, elf(62))]), arm, 'testing'), /ELF64/);
  await assertLambdaZipNativeTarget(await zip(metadata(arm), [payload(arm, elf(183))]), arm, 'testing');
});
