# Legal Archive service

Hosts the `fshahersw/externalcorpus` Legal Archive directory server and its
Corpus Workbench sidecar inside the platform, and keeps them current from the
repository's GitHub data releases. Nothing in the archive repository is
modified: the service runs its code as published and adds a gateway, a
refresher and infrastructure around it.

## Topology

```
browser ──> CloudFront ──> API Gateway ──> app Lambda ──(server side, app key)──┐
                                                                                 v
CloudFront /archive-api/* , /workbench-api/*  ──origin key──>  Office engine ALB
        ──path rule (priority 5)──> legal-archive target group ──> task ENI :8781
                                                                     │ gateway (nginx)
                                                                     │   Host rewrite, app-key check
                                                                     ├─> archive   127.0.0.1:8769  (server.py from /data/current)
                                                                     └─> workbench 127.0.0.1:8770  (corpus_workbench serve)
one ECS-managed EC2 instance (ASG 1/1)  ──  /data = persistent gp3 volume (XFS, reflinks)
refresher task (host network, nightly 03:00 America/New_York + on demand)
```

Two keys guard the archive, which has no authentication of its own:

- `X-Office-Origin-Key`: CloudFront adds it; the ALB path rule requires it (the request came through the distribution and its WAF).
- `X-Archive-App-Key`: the app Lambda adds it from the dedicated secret `<prefix>/<env>/legal-archive-app-key` (`{"ARCHIVE_APP_KEY": …}`); the gateway requires it. Browsers never learn it, so the archive cannot be called around the app's Cognito check. The deploy script creates that secret with a generated value when it is absent and never reads it; CloudFormation resolves it into the gateway task and the platform Lambda by name.

## Data volume layout

```
/data/releases/<utc stamp>/   full repository checkout with the release restored into it (bootstrap.py ROOT)
/data/current -> releases/…   the served release (atomic symlink swap)
/data/workbench-state/        Corpus Workbench SQLite FTS5 index, versions, citations
/data/.refresh.lock           only one refresher runs at a time
```

The served code and its data always come from the same release tree. The
archive's own start-up checks (`validation.json` hashes) and fail-closed
adapters are unchanged.

## Refresh pipeline (`archive/refresh.py`)

1. **Detect**: `git ls-remote` for the code head and the release's `data_manifest.json`; a fingerprint over both. Unchanged: exit.
2. **Stage**: `cp -a --reflink=always current staging` (instant, copy-on-write on XFS), fetch/checkout the code.
3. **Pull**: `bootstrap.py pull --skip-optional` installs only units whose listing hash changed (each part SHA-256 checked, every file hashed while written). Then `bootstrap.py verify` re-hashes everything installed.
4. **Live checks**: start `server.py` from staging on `127.0.0.1:8769` (the refresher runs in the host network namespace, the service task in its own, so no collision) and run the archive's `verify_round2.py`; it must report `passed`.
5. **Workbench sync**: `corpus_workbench sync --collection all` against the staging server within the time budget; partial collections stay labelled partial.
6. **Switch**: atomic symlink replace, previous tree kept (one), `ecs update-service --force-new-deployment`.
7. **Announce**: `RELEASE.json` in the tree, CloudWatch metrics in namespace `LegalArchive` (`RefreshRun`, `RefreshChanged`, `RefreshFailed`, `RefreshUnitsChanged`, `RefreshDurationSeconds`).

Any failure leaves `current` untouched and renames the staging tree to `releases/failed-<stamp>`. `refresh.py rollback` points `current` at the previous tree and redeploys.

## Deploy (testing)

```
bun run deploy:legal-archive --pull      # images, stacks, then the first pull (about an hour for ~87 GB)
bun run deploy:testing --refresh-env     # platform: CloudFront behaviors + LEGAL_ARCHIVE_URL + ARCHIVE_APP_KEY
```

The script zips this folder to the artifact bucket, deploys
`infra/legal-archive/legal-archive-build.cfn.yaml` (ECR + CodeBuild) and runs
the build, updates the office-engine stack so it exports its listener,
security group and full name, creates the dedicated app-key secret when
missing, then deploys `infra/legal-archive/legal-archive.cfn.yaml` using the
engine's VPC and first task subnet (the origin key is resolved by CloudFormation
from the platform's origin secret; the script handles no secret values). `--skip-build` reuses `:latest` images;
`--archive-commit=<sha>` pins the externalcorpus code baked into the seed copy
(the served code still comes from the release tree).

## Operate

```
# ad-hoc refresh (same as the nightly run)
aws ecs run-task --cluster litai-testing-legal-archive --task-definition <RefresherTaskDefinitionArn> --launch-type EC2 --region us-east-1
aws logs tail /ecs/litai-testing-legal-archive --follow --log-stream-names refresh/refresh/<task id> --region us-east-1

# status / rollback: run the refresher task with a command override
--overrides '{"containerOverrides":[{"name":"refresh","command":["refresh","status"]}]}'
--overrides '{"containerOverrides":[{"name":"refresh","command":["refresh","rollback"]}]}'

# shell on the instance (no SSH keys): SSM Session Manager
aws ssm start-session --target <instance id> --region us-east-1
```

Instance loss: the ASG launches a replacement, user data re-attaches the
volume (same AZ) and mounts it; tasks return within minutes. Volume loss:
restore the latest DLM snapshot (daily, 7 kept) into the same AZ and point the
stack's `DataVolume` at it, or let the refresher re-pull from GitHub onto a
fresh volume (the release is the source of truth).

## Limits stated

- Single instance, single AZ. Deployments stop the old task before starting the new one (about a minute, at 03:00).
- `verify_round2.py` targets `127.0.0.1:8769`; the refresher relies on that address being free in the host namespace.
- The workbench sync is bounded per run; import completeness per collection is visible in its `/api/health` and on the platform's Sources & Coverage page.
- The 43 GB of court-document originals are skipped by default (`SkipOptionalUnits=1`); the index over them is still served.
