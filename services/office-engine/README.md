# Office engine service

Hosts the retained document engines for the Seeger Weiss platform: one Node
worker thread per open document, running the Sheets workbook engine (driving
the Rust `xlsx-sidecar`) or the Slides deck engine (pptx-engine + pptx-render
with harfbuzz text shaping). The platform on Lambda cannot keep stateful worker
sessions, so this runs as an always-on service (ECS Fargate in AWS, a plain
Node process locally).

What it does and does not do:

- Verifies platform-minted RS256 tokens (15 min, scoped to one user and one
  document) against the platform JWKS at `/api/public/office/jwks`.
- Loads a document from a presigned S3 URL the platform issues at open time.
  `POST /engine/open` carries `kind` (`xlsx` | `pptx`), which selects the
  worker bundle, the operation allow-list prefix and the save contract
  (`server/engine-pool.mjs` `KINDS`).
- Runs document operations (workbook reads/formulas/recalc/save-edits; slide
  reads/edits/structure/save) with the same operation allow-list as the Office
  edition (`server/boundary.mjs`).
- On save, PUTs the new package to the platform
  (`/api/public/office/engine/docs/:id/content`) with the user's token,
  `If-Match`, an idempotency key and the kind's MIME type. The platform owns
  revisions.
- Holds no database, no bucket credentials, and never calls a model.

## Layout

```
server/                HTTP app, token auth, engine pool, worker hosts (Electron shim)
server/host/worker.ts  Sheets worker (workbook:* channels, xlsx-sidecar)
server/host/worker-slides.ts  Slides worker (slides:* channels, in-process pptx engine)
server/stubs/          inert replacements for desktop-only modules (AI IPC, cloud search)
vendor/sheets/         retained Sheets engine sources (main, gateway, domain, shared)
vendor/slides/         retained Slides engine sources (main incl. ops/, shared)
vendor/packages/       the @genoffice packages the engines import (full pptx-engine,
                       pptx-render, bundled Carlito fonts from ui/)
native/xlsx-engine     Rust sidecar crate (pinned toolchain 1.94.1)
tests/                 package-fidelity gate (xlsx change-plan writer, pptx text edit)
build.mjs              esbuild: .build/native-worker.cjs, .build/slides-worker.cjs,
                       .build/engine.cjs, .build/fidelity.cjs
Dockerfile             Linux x86_64 image: rust build stage + node runtime + fonts
```

## Slides notes

- Text layout is shaped with real font files. The image installs Liberation
  (Arial/Times/Courier metrics), Carlito/Caladea (Calibri/Cambria metrics) and
  DejaVu; the engine also carries the bundled Carlito faces. Non-Latin scripts
  fall back to DejaVu until `fonts-noto-cjk` / `fonts-noto-core` are added to
  the Dockerfile (larger image).
- Desktop-only paths (native file dialogs, OS clipboard, presenter audience
  window, video/3D insertion, cloud page generation) are served by the browser
  host in the platform (`src/office/slides/web/host/session.ts`) or reported
  as unavailable; the engine never opens dialogs.
- PDF export and printing are browser-side raster output of the rendered
  slides (`rendered-pdf.mjs`), the same as the Office web edition.

## Local development

```powershell
cd services/office-engine
npm install --ignore-scripts
node build.mjs
# Windows binary from the Office checkout, or build one: npm run build:native
$env:OFFICE_PLATFORM_URL="http://localhost:8080"
$env:OFFICE_ENGINE_ALLOWED_ORIGINS="http://localhost:8080"
$env:HOST="127.0.0.1"; $env:PORT="8790"
$env:XLSX_SIDECAR_PATH="<path>\xlsx-sidecar.exe"
node server/start.mjs
```

Platform `.env`: `OFFICE_ENGINE_URL=http://127.0.0.1:8790`. Without
`OFFICE_ENGINE_JWT_PRIVATE_KEY` the platform dev server signs with an ephemeral
key per process; restart the engine if the dev server restarts and tokens stop
verifying.

## Container

```bash
docker build -t office-engine:local services/office-engine
docker run --rm -p 8790:8790 -e OFFICE_PLATFORM_URL=https://<app-domain> office-engine:local
```

The Rust stage compiles the sidecar's bzip2/zstd C sources with the image's
gcc; no prebuilt binary is checked in.

## AWS deployment

1. Push the image to ECR and deploy `infra/office-engine/office-engine.cfn.yaml`
   (VPC, subnets, an ACM certificate for the ALB, the platform origin URL).
2. Add a CloudFront behavior to the platform distribution: path pattern
   `/engine/*`, origin = the stack's `LoadBalancerDnsName` (HTTPS only),
   forward all headers and query strings, no caching, and (recommended) an
   origin custom header `X-Office-Origin-Key` matching the stack's
   `OriginKeyHeaderValue` so the ALB rejects direct calls.
3. Platform runtime environment (Lambda):
   - `OFFICE_ENGINE_URL` and `OFFICE_ENGINE_PUBLIC_URL` = the platform origin
     (the browser reaches the engine through the `/engine/*` behavior).
   - `OFFICE_ENGINE_JWT_PRIVATE_KEY` = PKCS#8 PEM from Secrets Manager
     (`{{resolve:secretsmanager:...}}`), `OFFICE_ENGINE_JWT_KID` = a stable key id.
   - `OFFICE_ENGINE_JWT_ISSUER` = the platform origin (must equal what the
     engine receives as `OFFICE_PLATFORM_URL`).
4. Generate the key pair once per environment:
   `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out office-engine.pem`
   and store the PEM as the secret. Only the platform holds it; the engine
   reads the public half through JWKS.

## Limits

Per task: 24 open documents (`OFFICE_ENGINE_MAX_SESSIONS`), 4 per user, 45 s
per operation, idle sessions closed after 30 minutes, 30 MB packages. ALB
stickiness keeps a browser on the task that holds its session. Measured
locally, Slides read and edit operations round-trip in 3–12 ms; deployed, add
the browser-to-ALB latency.

## Tests

```powershell
node build.mjs && node --test server/fidelity.test.mjs
```

The gate applies one surgical edit per fixture (five workbooks, one two-slide
deck) and asserts every other package entry survives byte-identical. It also
runs inside the Docker build.
