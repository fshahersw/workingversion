import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';

/** Use the same reviewed parameter file the runtime deployment consumes. */
export async function readLambdaNativeTarget(root, environment, override = process.env.LITAI_LAMBDA_ARCHITECTURE) {
  if (!['testing', 'staging', 'prod'].includes(environment)) throw new Error('Invalid Lambda build environment');
  const params = JSON.parse(await readFile(resolve(root, `infra/app/parameters/${environment}-runtime.parameters.json`), 'utf8'));
  return lambdaNativeTarget(params, override);
}

export function lambdaNativeTarget(params, override) {
  const architecture = params.find(p => p.ParameterKey === 'Architecture')?.ParameterValue;
  if (!['arm64', 'x86_64'].includes(architecture)) throw new Error('Runtime parameters must specify Architecture=arm64 or x86_64');
  if (override && override !== architecture) throw new Error('LITAI_LAMBDA_ARCHITECTURE must match the runtime Architecture parameter');
  const nodeArchitecture = architecture === 'x86_64' ? 'x64' : 'arm64';
  return { platform: 'linux', architecture, nodeArchitecture, libc: 'glibc', nativePackage: `@napi-rs/canvas-linux-${nodeArchitecture}-gnu` };
}

export function assertLambdaBuildHost(target, host = { platform: process.platform, arch: process.arch,
  glibc: process.report?.getReport()?.header?.glibcVersionRuntime }) {
  if (host.platform !== 'linux' || host.arch !== target.nodeArchitecture || !host.glibc) {
    throw new Error(`Lambda PDF dependencies require a Linux glibc ${target.nodeArchitecture} builder matching Architecture=${target.architecture}. Build in a matching Linux container/runner (with target dependencies installed there); do not deploy a ${host.platform}/${host.arch} preview artifact.`);
  }
}

export function assertLambdaNativeMetadata(metadata, expected) {
  const actual = metadata?.nativeTarget;
  if (!actual || Object.keys(expected).some(key => actual[key] !== expected[key])) {
    throw new Error('Lambda build metadata does not match the runtime native target. Rebuild with the matching Linux architecture before packaging/deploying.');
  }
  if (metadata.pdfArtifactVerified !== true) throw new Error('Lambda PDF artifact isolation probe did not pass. Rebuild the controlled Lambda artifact.');
}

/** Do not trust a package name or metadata to establish a binary's actual target. */
export function assertLambdaNativePayloads(payloads, target) {
  const required = `/node_modules/${target.nativePackage}/`;
  if (!payloads.some(p => p.target.includes(required) && p.target.endsWith('.node'))) {
    throw new Error(`Lambda artifact is missing the target native PDF dependency ${target.nativePackage}.`);
  }
  for (const { target: path, bytes } of payloads.filter(p => p.target.endsWith('.node'))) {
    // ELF64, little endian; e_machine identifies AArch64 (183) or x86-64 (62).
    const expectedMachine = target.nodeArchitecture === 'arm64' ? 183 : 62;
    if (bytes.length < 64 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46
      || bytes[4] !== 2 || bytes[5] !== 1 || bytes[18] + bytes[19] * 256 !== expectedMachine) {
      throw new Error(`Native dependency ${path} is not Linux ELF64 ${target.architecture}; refuse the incompatible Lambda artifact.`);
    }
  }
}

/** The --skip-build deployment path must validate the bytes it will upload too. */
export async function assertLambdaZipNativeTarget(bytes, target, environment) {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file('build-metadata.json');
  if (!entry) throw new Error('Lambda ZIP is missing controlled build metadata; rebuild before deploying.');
  const metadata = JSON.parse(await entry.async('string'));
  if (metadata.environment !== environment) throw new Error('Lambda ZIP environment does not match the deployment.');
  assertLambdaNativeMetadata(metadata, target);
  const payloads = await Promise.all(Object.values(zip.files).filter(entry => !entry.dir && entry.name.endsWith('.node'))
    .map(async entry => ({ target: entry.name, bytes: await entry.async('uint8array') })));
  assertLambdaNativePayloads(payloads, target);
}
