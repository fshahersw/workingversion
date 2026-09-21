# Local Office development and the AWS boundary

The same application and Office engine run locally with synthetic identity, DynamoDB Local and S3rver. This is a development transport for testing; deployed inference still defaults to Bedrock. No provider key belongs in browser code, source control, screenshots or test reports.

## Setup on Windows

Use Node 24 (22.18+ supports the TypeScript helper), Bun for the existing lockfile, a Rust MSVC toolchain and its C++ build tools. From the repository:

```powershell
bun install --frozen-lockfile --ignore-scripts
powershell -File scripts/setup-local-office.ps1
cd services/office-engine
npm ci --ignore-scripts
npm run build
npm run build:native
cd ../..
```

The setup script downloads a portable JDK 21 and official DynamoDB Local, verifies their vendor SHA256 checksums, and installs S3rver 3.7.1 into an ignored directory. It changes no system Java or AWS configuration. The tested DynamoDB Local version is 3.3.1. Its Java wrapper binds every connector to 127.0.0.1 before starting and fails if a future version changes that API.

Set credentials only in the launching process. Replace placeholders without saving them in a tracked file:

```powershell
$env:ANTHROPIC_API_KEY = '<test key>'
$env:OFFICE_LOCAL_ANTHROPIC_WORKSPACE_ID = '<workspace ID if required>'
$env:OFFICE_LOCAL_PROVIDER = 'anthropic'
$env:OFFICE_LOCAL_ANTHROPIC_MODEL = 'claude-sonnet-4-6'
$env:OFFICE_LOCAL_ANTHROPIC_FAST_MODEL = 'claude-haiku-4-5-20251001'
$env:OFFICE_LOCAL_ANTHROPIC_THOROUGH_MODEL = 'claude-opus-4-6'
$env:OFFICE_ROUTER = 'typesafe'
$env:TYPESAFE_API_KEY = '<test key>'
npm run dev:office:local
```

The preview is `http://127.0.0.1:5189/office`. The launcher sets `LOCAL_SYNTHETIC_MODE=1`, requires both local storage endpoints, starts the native engine on port 8790, DynamoDB Local on 8180, S3rver on 4568, and the app on 5189. All listen on loopback. It uses a fixed synthetic user and dummy storage credentials; it does not use an AWS profile. Data lives in `.integration.local/data`. Shut down with Ctrl+C. Use synthetic documents only.

For Fireworks, set `OFFICE_LOCAL_PROVIDER=fireworks`, `FIREWORKS_API_KEY`, and explicit `OFFICE_LOCAL_FIREWORKS_MODEL`/`FAST_MODEL` IDs. Tested IDs: `accounts/fireworks/models/kimi-k2p6` and `accounts/fireworks/models/glm-5p3-flash`. Image requests require a separately verified image-capable model plus `OFFICE_LOCAL_FIREWORKS_VISION=1`; the adapter refuses silently dropping visual evidence. Provider availability and model IDs should be rechecked before a later run.

`OFFICE_LOCAL_FIREWORKS_REASONING_EFFORT` optionally sends the documented provider setting (`none`, `low`, `medium`, or `high`). Choose a value supported by the actual model. GLM-5.3-Flash's [model card](https://huggingface.co/zai-org/GLM-5.3-Flash#note) documents `low`, `high`, and `max`, with omitted/other values defaulting to its maximum; its thinking cannot simply be disabled. The local acceptance configuration uses `low`. This is an effort selection, not a guaranteed token or latency cap. An earlier run with the omitted setting consumed all 8,192 output tokens without producing an action.

The local capability manifest removes unavailable AWS Python, image-generation and firm-knowledge tools. It also removes visual capture/analysis tools for a Fireworks configuration without verified vision support. Native workbook data, formula, formatting and chart operations remain available. A text-only model must not claim visual inspection. Production tool availability is unchanged.

Local public web search can use the configured Anthropic key with the provider's server search tool; under Fireworks this additionally requires explicit `OFFICE_LOCAL_SEARCH_PROVIDER=anthropic`. Exhausted provider credits are a service failure, not zero search results. Public source reads use bounded, revision-identified excerpts and continuation offsets. Use only synthetic documents: prompts and selected local document context are sent to the configured test provider.

## Production configuration

Do not deploy `LOCAL_SYNTHETIC_MODE`, `OFFICE_LOCAL_PROVIDER`, local storage endpoints, or the temporary keys. Local mode refuses `NODE_ENV=production`, a nonlocal `APP_ENVIRONMENT`, Lambda and ECS runtime markers. Supplying keys alone never enables synthetic authentication. Requests also require a loopback URL and same-origin browser access. Normal Cognito, SDK credential chains, S3 and DynamoDB behavior remain the production path.

JEV is a router, not a replacement for the document engine or the reasoning model. Set `OFFICE_ROUTER=typesafe` and supply `TYPESAFE_API_KEY` through the existing server secret mechanism to enable it. The code defaults to pinned `jev-1.13.0`, uses an 800 ms classification budget and evaluates task class, whether the saved document changes, and legal judgment. Ambiguous/failed decisions go to the main model. It does not grant tools or bypass write-mode policy.

Production Bedrock IDs and model availability remain controlled by existing `OFFICE_*` and `WRITER_*` configuration. Direct Anthropic/Fireworks IDs are deliberately not transformed into Bedrock IDs. Validate actual region/model access, IAM, JWT key secret, persistence, native dependencies and end-to-end latency in AWS staging before release. Local tests do not establish AWS runtime parity or universal Microsoft Office compatibility.

The controlled Lambda build reads `Architecture` from the selected environment's runtime parameters and requires a matching Linux/glibc builder (currently arm64 for testing). It runs the isolated emitted PDF dependency check before publishing build metadata. Packaging and the testing deployment's `--skip-build` path also inspect native ELF binaries and target metadata. A Windows preview build cannot be packaged as Lambda output; build and install dependencies in the matching Linux runner first.

## Repeatable checks

```powershell
bun test src/lib src/writer/packages/agent-core src/writer/packages/ui/src/assistant-display.test.tsx
node node_modules/typescript/bin/tsc --noEmit
npm run build
# With the local stack running:
node scripts/office-roundtrip-local.mjs
```

The roundtrip script uses disposable documents and the real API/JWT/engine/save pipeline. Its report and downloaded OOXML files stay under `.integration.local/results`. The opt-in chat integration test additionally requires the local environment described in its header. No checks in this guide deploy anything.
