-- The scheduled-job config is now populated; remove the temporary setup grant
-- so only service_role (and the security-definer function) can read it.
REVOKE ALL ON public.cron_config FROM sandbox_exec;
