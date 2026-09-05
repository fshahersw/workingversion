-- Review Tables (Discovery, third tab). Fully additive: every object is
-- prefixed review_ and references nothing existing except auth.users.

CREATE TABLE public.review_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Untitled review',
  matter_id text,
  matter_label text,
  instructions text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_tables_owner_idx ON public.review_tables (owner, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.review_tables TO authenticated;
GRANT ALL ON public.review_tables TO service_role;
ALTER TABLE public.review_tables ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owners manage their review tables" ON public.review_tables
  FOR ALL TO authenticated USING (auth.uid() = owner) WITH CHECK (auth.uid() = owner);

CREATE TABLE public.review_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.review_tables(id) ON DELETE CASCADE,
  owner uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'text',
  -- text | long_text | yes_no | date | number | select | multi_select | list
  question text NOT NULL DEFAULT '',
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_columns_table_idx ON public.review_columns (table_id, position);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.review_columns TO authenticated;
GRANT ALL ON public.review_columns TO service_role;
ALTER TABLE public.review_columns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owners manage their review columns" ON public.review_columns
  FOR ALL TO authenticated USING (auth.uid() = owner) WITH CHECK (auth.uid() = owner);

CREATE TABLE public.review_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.review_tables(id) ON DELETE CASCADE,
  owner uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL,
  file_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  fingerprint text,
  page_count integer NOT NULL DEFAULT 0,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_rows_table_idx ON public.review_rows (table_id, position);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.review_rows TO authenticated;
GRANT ALL ON public.review_rows TO service_role;
ALTER TABLE public.review_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owners manage their review rows" ON public.review_rows
  FOR ALL TO authenticated USING (auth.uid() = owner) WITH CHECK (auth.uid() = owner);

CREATE TABLE public.review_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.review_tables(id) ON DELETE CASCADE,
  owner uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  column_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  cells_total integer NOT NULL DEFAULT 0,
  cells_done integer NOT NULL DEFAULT 0,
  cells_failed integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX review_runs_table_idx ON public.review_runs (table_id, started_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.review_runs TO authenticated;
GRANT ALL ON public.review_runs TO service_role;
ALTER TABLE public.review_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owners manage their review runs" ON public.review_runs
  FOR ALL TO authenticated USING (auth.uid() = owner) WITH CHECK (auth.uid() = owner);

CREATE TABLE public.review_cells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.review_tables(id) ON DELETE CASCADE,
  row_id uuid NOT NULL REFERENCES public.review_rows(id) ON DELETE CASCADE,
  column_id uuid NOT NULL REFERENCES public.review_columns(id) ON DELETE CASCADE,
  owner uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  value_json jsonb,
  display text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  -- pending | answered | not_found | needs_review | error
  confidence text,
  -- high | medium | low
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  rationale text,
  pages_searched jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  overridden boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  cache_key text,
  run_id uuid REFERENCES public.review_runs(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (row_id, column_id)
);
CREATE INDEX review_cells_table_idx ON public.review_cells (table_id);
CREATE INDEX review_cells_column_idx ON public.review_cells (column_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.review_cells TO authenticated;
GRANT ALL ON public.review_cells TO service_role;
ALTER TABLE public.review_cells ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owners manage their review cells" ON public.review_cells
  FOR ALL TO authenticated USING (auth.uid() = owner) WITH CHECK (auth.uid() = owner);

CREATE TABLE public.review_cell_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cell_id uuid NOT NULL REFERENCES public.review_cells(id) ON DELETE CASCADE,
  owner uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action text NOT NULL,
  previous_display text,
  next_display text,
  actor_email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_cell_history_cell_idx ON public.review_cell_history (cell_id, created_at DESC);

GRANT SELECT, INSERT, DELETE ON public.review_cell_history TO authenticated;
GRANT ALL ON public.review_cell_history TO service_role;
ALTER TABLE public.review_cell_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owners manage their review cell history" ON public.review_cell_history
  FOR ALL TO authenticated USING (auth.uid() = owner) WITH CHECK (auth.uid() = owner);

CREATE TRIGGER review_tables_updated_at BEFORE UPDATE ON public.review_tables
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER review_columns_updated_at BEFORE UPDATE ON public.review_columns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER review_cells_updated_at BEFORE UPDATE ON public.review_cells
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
