# Per-User Document Knowledge Base (KB) — Overview

Status: **live** on the AWS-native stack (branch `feat/frontier-ux`, unpushed).
Last updated: 2026-09-06.

## What this is

A per-user, secure, durable document knowledge base for the **Discovery → Working
Set** surface. It turns the previously ephemeral, client-only "pile" of uploaded
documents into **saved, reloadable, queryable workspaces**:

- **Save** a working set as a named workspace and it persists everything needed to
  bring it back — the extracted text, the search index, the embeddings, and the
  original files.
- **Browse** saved workspaces in the **Library**, organized by surface
  (Working Sets / Depositions / Tabular Review) and folders.
- **Open** a workspace for one-click reload back into a fully queryable state —
  no re-upload, no re-extraction, no re-embedding.

It is built entirely on **AWS-native production services** (Cognito, DynamoDB, S3,
Aurora PostgreSQL + pgvector, Amazon Bedrock). No Supabase, no Voyage, no external
egress. Every row is isolated to the authenticated user by Postgres row-level
security.

## Why

The Working Set was client-only (browser IndexedDB + an in-memory BM25 index),
which meant: nothing survived across devices, nothing was durable, retrieval was
lexical-bound, and there was a shared-workstation confidentiality gap. The KB makes
uploaded documents:

- **Durable + cross-device** — persisted server-side, reloadable anywhere.
- **Frontier-quality retrieval** — hybrid (vector + keyword) search with a
  cross-encoder rerank, embeddings computed once at ingest.
- **Isolated** — FORCE row-level security keyed on the verified Cognito principal.
- **The foundation for shared workspaces** — a later phase invites collaborators
  into the same workspace.

## The user-facing flow

1. In **Discovery → Working Set** (`/docs`), drop documents. They extract and index
   locally (instant), exactly as before.
2. Click **Save workspace**, give it a name (and optional folder). This persists the
   workspace (see [ARCHITECTURE](ARCHITECTURE.md#the-four-artifact-workspace-model)).
3. Open the **Library**. The **Working Sets** tab lists saved workspaces.
4. Click **Open** on a workspace — it reloads into `/docs`, instantly searchable and
   askable again.

## Current status (what works today)

- Aurora Serverless v2 + pgvector cluster provisioned via CloudFormation (private,
  Data API, scale-to-0, deletion protection).
- Ingest: canonical conversion → table-aware chunking → Titan v2 embeddings →
  Aurora, RLS-scoped.
- Retrieval: hybrid (pgvector + BM25 RRF) + Bedrock rerank (`cohere.rerank-v3-5:0`).
- Save-as-workspace (bytes + pages + chunks + record), Library browse by surface,
  one-click reload.
- Saved Working Set Ask uses server-side hybrid search + rerank; the browser
  does not repost page text. Unsaved or edited piles stay on the local index.
- Cold-start retry so the first request after scale-to-0 idle waits instead of
  failing.

## Deferred / not yet built

- Byte download + folder-management UI in the Library.
- Search-within-a-saved-workspace surface in the Library.
- Depositions / Tabular Review save+reload (schema is already surface-aware).
- Async BDA lane (SQS + Lambda + EventBridge) for scanned / oversized PDFs.
- Shared workspaces / invite (P5d).

## Where things live

- **Code:** `C:\Users\fshaher\.claude\projects\unifiedproductionbackend\lit-ai-extracted\lit-ai-main`
  (branch `feat/frontier-ux`).
- **AWS:** account `475976462949`, `us-east-1`. CloudFormation stack **`sw-kb`**
  (private Aurora `sw-kb-kb`).
- **KB source modules:** `src/lib/kb/`.
- **Docs:** this folder (`docs/kb/`) plus the pre-build design in
  [`docs/kb-ingest-design.md`](../kb-ingest-design.md) and the DB README in
  [`db/kb/README.md`](../../db/kb/README.md).

## Read next

- [ARCHITECTURE.md](ARCHITECTURE.md) — components, data flow, endpoints, models,
  security, file map.
- [PROGRESS.md](PROGRESS.md) — phase-by-phase build log, commits, decisions.
- [OPERATIONS.md](OPERATIONS.md) — provisioning, migration, env, cost, troubleshooting.
