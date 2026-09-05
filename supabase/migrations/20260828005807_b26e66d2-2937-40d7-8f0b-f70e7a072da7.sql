CREATE TABLE public.research_saved_answers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  conversation_id UUID REFERENCES public.research_conversations(id) ON DELETE SET NULL,
  matter_id TEXT,
  matter_label TEXT,
  question TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.research_pins (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  conversation_id UUID REFERENCES public.research_conversations(id) ON DELETE CASCADE,
  matter_id TEXT,
  quote TEXT NOT NULL,
  note TEXT,
  source_ref TEXT,
  citation TEXT,
  source_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.research_watches (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  question TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  matter_id TEXT,
  matter_label TEXT,
  seen_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.research_watch_hits (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  watch_id UUID NOT NULL REFERENCES public.research_watches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT,
  url TEXT,
  source_label TEXT,
  published_at TIMESTAMPTZ,
  seen BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.research_prompts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX research_saved_answers_user_idx ON public.research_saved_answers (user_id, created_at DESC);
CREATE INDEX research_saved_answers_matter_idx ON public.research_saved_answers (matter_id, created_at DESC);
CREATE INDEX research_pins_user_idx ON public.research_pins (user_id, created_at DESC);
CREATE INDEX research_watches_user_idx ON public.research_watches (user_id, updated_at DESC);
CREATE INDEX research_watch_hits_watch_idx ON public.research_watch_hits (watch_id, created_at DESC);
CREATE UNIQUE INDEX research_watch_hits_url_idx ON public.research_watch_hits (watch_id, url) WHERE url IS NOT NULL;
CREATE INDEX research_prompts_user_idx ON public.research_prompts (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_saved_answers TO authenticated;
GRANT ALL ON public.research_saved_answers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_pins TO authenticated;
GRANT ALL ON public.research_pins TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_watches TO authenticated;
GRANT ALL ON public.research_watches TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_watch_hits TO authenticated;
GRANT ALL ON public.research_watch_hits TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_prompts TO authenticated;
GRANT ALL ON public.research_prompts TO service_role;

ALTER TABLE public.research_saved_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_watch_hits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_prompts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own saved answers"
  ON public.research_saved_answers FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage their own pins"
  ON public.research_pins FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage their own watches"
  ON public.research_watches FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage their own watch hits"
  ON public.research_watch_hits FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage their own prompts"
  ON public.research_prompts FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER research_saved_answers_updated_at
  BEFORE UPDATE ON public.research_saved_answers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER research_watches_updated_at
  BEFORE UPDATE ON public.research_watches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();