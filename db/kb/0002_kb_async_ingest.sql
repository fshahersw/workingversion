-- ============================================================================
-- KB 0002 — asynchronous Bedrock Data Automation ingest metadata.
--
-- Additive and idempotent. The dedicated DynamoDB ingest-jobs table is the
-- authoritative job-to-principal correlation store. These columns only keep
-- owner-scoped document metadata needed after that exact mapping is resolved.
-- No worker may discover a tenant by querying these columns globally.
-- ============================================================================

ALTER TABLE kb.documents
  ADD COLUMN IF NOT EXISTS bda_invocation_arn text,
  ADD COLUMN IF NOT EXISTS bda_input_key text,
  ADD COLUMN IF NOT EXISTS bda_output_prefix text,
  ADD COLUMN IF NOT EXISTS bda_output_s3_uri text,
  ADD COLUMN IF NOT EXISTS bda_client_file_id text,
  ADD COLUMN IF NOT EXISTS ingest_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS ingest_completed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'kb.documents'::regclass
      AND conname = 'kb_documents_status_check'
  ) THEN
    ALTER TABLE kb.documents
      ADD CONSTRAINT kb_documents_status_check
      CHECK (status IN ('queued', 'converting', 'embedding', 'ready', 'error'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'kb.documents'::regclass
      AND conname = 'kb_documents_bda_input_key_check'
  ) THEN
    ALTER TABLE kb.documents
      ADD CONSTRAINT kb_documents_bda_input_key_check
      CHECK (bda_input_key IS NULL OR bda_input_key LIKE 'uploads/%')
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'kb.documents'::regclass
      AND conname = 'kb_documents_bda_output_prefix_check'
  ) THEN
    ALTER TABLE kb.documents
      ADD CONSTRAINT kb_documents_bda_output_prefix_check
      CHECK (
        bda_output_prefix IS NULL
        OR bda_output_prefix LIKE 'kb/bda-output/%/'
      )
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'kb.documents'::regclass
      AND conname = 'kb_documents_bda_input_owner_check'
  ) THEN
    ALTER TABLE kb.documents
      ADD CONSTRAINT kb_documents_bda_input_owner_check
      CHECK (
        bda_input_key IS NULL
        OR bda_input_key LIKE 'uploads/' || owner_sub || '/%'
      )
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'kb.documents'::regclass
      AND conname = 'kb_documents_bda_output_owner_check'
  ) THEN
    ALTER TABLE kb.documents
      ADD CONSTRAINT kb_documents_bda_output_owner_check
      CHECK (
        bda_output_prefix IS NULL
        OR bda_output_prefix = 'kb/bda-output/' || owner_sub || '/' || doc_id || '/'
      )
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'kb.documents'::regclass
      AND conname = 'kb_documents_bda_client_file_id_check'
  ) THEN
    ALTER TABLE kb.documents
      ADD CONSTRAINT kb_documents_bda_client_file_id_check
      CHECK (
        bda_client_file_id IS NULL
        OR (
          length(bda_client_file_id) BETWEEN 1 AND 256
          AND bda_client_file_id !~ '[[:cntrl:]]'
        )
      )
      NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS kb_documents_owner_bda_invocation_idx
  ON kb.documents (owner_sub, bda_invocation_arn)
  WHERE bda_invocation_arn IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS kb_documents_owner_workspace_client_file_idx
  ON kb.documents (owner_sub, workspace_id, bda_client_file_id)
  WHERE bda_client_file_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS kb_documents_owner_ingest_status_idx
  ON kb.documents (owner_sub, workspace_id, status, updated_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON kb.documents TO kb_app;

-- Reassert the isolation invariant in case this migration is applied to a
-- restored schema whose table flags drifted. FORCE RLS remains default-deny
-- until withPrincipal() sets the transaction-local app.user principal.
ALTER TABLE kb.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb.documents FORCE ROW LEVEL SECURITY;
