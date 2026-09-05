CREATE TABLE public.research_conversations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New research',
  matter_id TEXT,
  matter_label TEXT,
  memory JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.research_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.research_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  client_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  rounds JSONB NOT NULL DEFAULT '[]'::jsonb,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  followups JSONB NOT NULL DEFAULT '[]'::jsonb,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX research_conversations_user_updated_idx ON public.research_conversations (user_id, updated_at DESC);
CREATE INDEX research_messages_conversation_idx ON public.research_messages (conversation_id, seq);
CREATE UNIQUE INDEX research_messages_client_idx ON public.research_messages (conversation_id, client_id) WHERE client_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_conversations TO authenticated;
GRANT ALL ON public.research_conversations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_messages TO authenticated;
GRANT ALL ON public.research_messages TO service_role;

ALTER TABLE public.research_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own conversations"
  ON public.research_conversations FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage their own research messages"
  ON public.research_messages FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$
LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER research_conversations_updated_at
  BEFORE UPDATE ON public.research_conversations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();