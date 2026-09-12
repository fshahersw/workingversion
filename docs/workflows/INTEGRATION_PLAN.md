# Workflows production integration

## Scope and contract

Integrate the portable Workflows builder and legal mini apps into the authenticated Seeger Weiss AI platform. Use the existing application shell, Cognito principal, DynamoDB, S3, Bedrock and approved research tools. Runtime records must originate from real users; do not seed people, matters, files, runs or outputs. Preserve the MCO repository and the original production reference snapshot.

Baseline: `feat/frontier-ux` at `b5dd53050fb8b8731b46bcd3ffebe06ac38a1cf5`. Work branch: `codex/workflows-production`. This branch is a review candidate, not authorization to deploy or merge into the Lovable-connected branch.

## Acceptance

- Native authenticated route and navigation, with reusable templates, canvas, mini app forms, document intake, source evidence and artifact downloads.
- Server-owned definitions, immutable published versions, optimistic concurrency and access checks on every operation.
- Durable server runs with bounded inputs, cancellation, authenticated review, checkpoints, retry protection and a queue worker. No browser scheduler or browser authority over completed results.
- Grounded Bedrock analysis and existing approved read-only research services. Unconfigured connectors fail visibly; no simulated success. Never reuse a global Python interpreter across users.
- Real team grants use verified Cognito groups. Runtime templates contain no sample documents or identities.
- Tests for validation, ownership, reviews, concurrency, execution and source coverage; build and regression checks against baseline. Document infrastructure and staging prerequisites before merge.

## Work ledger

- Repository and portable package inspected. Existing 383 tests pass.
- Baseline type check and build are recorded separately from integration results.
- Workflows implementation and local validation completed; see [VALIDATION.md](./VALIDATION.md).
- Integration remains a draft review candidate. Live staging/service validation and production release approval are outstanding; see [STAGING.md](./STAGING.md).
- No AWS deployments, live case-data processing, or changes to the connected default branch have occurred.

## External behavior references

- [Lambda and SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html): delivery is at least once; use durable checkpoints and conditional leases.
- [DynamoDB optimistic locking](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBMapper.OptimisticLocking.html): conditional version checks prevent lost updates.
- [AgentCore session cleanup](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_StopCodeInterpreterSession.html): interpreter sessions need explicit lifecycle management.
