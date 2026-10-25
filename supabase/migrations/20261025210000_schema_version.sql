-- Schema readiness (issue #187). The API compares this with the newest migration file in the repo and
-- reports GET /ready as 503 when the database is behind the code. Service role only.

create or replace function public.schema_version()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select max(version) from supabase_migrations.schema_migrations;
$$;

revoke all on function public.schema_version() from public, anon, authenticated;
grant execute on function public.schema_version() to service_role;
