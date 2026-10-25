-- Tenant access: a signed-in user sees only the businesses they belong to.
--
-- Closes the TODO in 20261025120000_init_records.sql ("before any real business data goes
-- into a hosted project, replace this with per-user/per-business policies tied to auth.uid()").
-- Additive only: the synthetic read policies stay, so demos and fixtures keep working.
--
--   * memberships(business_id, user_id, role): who belongs to which business.
--   * is_member(business_id): true when auth.uid() is a member. Every member_read policy uses it.
--   * create_business(name, profile): the sign-up step. Creates a private business
--     (is_synthetic = false) and makes the caller its owner, in one transaction.
--   * load_records(): members can load their own business, not only synthetic ones.
--
-- Writes still go through the service role or SECURITY DEFINER functions with their own checks.
-- Not here yet (follow-ups): inviting members, roles other than owner doing writes, and
-- confirm_change_proposal() accepting members (it still allows synthetic or service callers only).

create table public.memberships (
  business_id text not null references public.businesses(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at  timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

alter table public.memberships enable row level security;

-- A user can see their own memberships (to list their businesses). No direct writes.
create policy own_memberships on public.memberships
  for select to authenticated
  using (user_id = auth.uid());

-- SECURITY DEFINER so policies can call it without recursing into memberships' own RLS.
create or replace function public.is_member(p_business_id text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and exists (
       select 1 from public.memberships m
        where m.business_id = p_business_id
          and m.user_id = auth.uid()
     )
$$;

create policy member_read on public.businesses
  for select to authenticated
  using (public.is_member(id));

do $$
declare
  t text;
begin
  foreach t in array array[
    'parties', 'commitments', 'cash_events', 'signals', 'rules', 'work_items',
    'settlements', 'balance_snapshots', 'evidence', 'scenarios', 'forecast_runs',
    'intake_candidates', 'change_proposals', 'column_mappings'
  ]
  loop
    execute format($p$
      create policy member_read on public.%I
        for select to authenticated
        using (public.is_member(business_id))
    $p$, t);
  end loop;
end
$$;

-- Sign-up: create a private business owned by the caller. Limited to 5 owned businesses per user
-- so a script can't fill the database.
create or replace function public.create_business(p_name text, p_profile jsonb default '{}'::jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_id   text;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if v_user is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if v_name = '' or length(v_name) > 120 then
    raise exception 'INVALID_ARGUMENT' using errcode = 'PT400';
  end if;
  -- Serialize per user so parallel calls can't both pass the limit.
  perform pg_advisory_xact_lock(hashtext(v_user::text));
  if (select count(*) from public.memberships m where m.user_id = v_user and m.role = 'owner') >= 5 then
    raise exception 'TOO_MANY_BUSINESSES' using errcode = 'PT429';
  end if;

  v_id := 'biz-' || substr(md5(gen_random_uuid()::text), 1, 16);
  insert into public.businesses (id, name, profile, is_synthetic)
  values (v_id, v_name, coalesce(p_profile, '{}'::jsonb), false);
  insert into public.memberships (business_id, user_id, role)
  values (v_id, v_user, 'owner');
  return v_id;
end
$$;

-- load_records: same body as 20261025120000_init_records.sql, plus members of the business.
create or replace function public.load_records(p_business_id text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_snapshot jsonb;
begin
  select jsonb_build_object(
    'storeRevision', b.store_revision,
    'records', jsonb_build_object(
      'parties',     coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.parties t where t.business_id = b.id), '[]'::jsonb),
      'commitments', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.commitments t where t.business_id = b.id), '[]'::jsonb),
      'events',      coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.cash_events t where t.business_id = b.id), '[]'::jsonb),
      'signals',     coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.signals t where t.business_id = b.id), '[]'::jsonb),
      'rules',       coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.rules t where t.business_id = b.id), '[]'::jsonb),
      'settlements', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.settlements t where t.business_id = b.id), '[]'::jsonb),
      'balances',    coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.balance_snapshots t where t.business_id = b.id), '[]'::jsonb),
      'evidence',    coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.evidence t where t.business_id = b.id), '[]'::jsonb)
    )
  ) into v_snapshot
  from public.businesses b
  where b.id = p_business_id
    and (b.is_synthetic or public.is_service_caller() or public.is_member(b.id));

  if v_snapshot is null then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;
  return v_snapshot;
end
$$;

-- Grants. The init migration revokes defaults; every new object needs explicit grants.
revoke all on public.memberships from anon, authenticated;
grant select on public.memberships to authenticated;
revoke all on function public.is_member(text) from public, anon, authenticated;
grant execute on function public.is_member(text) to authenticated, service_role;
revoke all on function public.create_business(text, jsonb) from public, anon, authenticated;
grant execute on function public.create_business(text, jsonb) to authenticated, service_role;
revoke all on function public.load_records(text) from public, anon, authenticated;
grant execute on function public.load_records(text) to anon, authenticated, service_role;
